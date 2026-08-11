import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildGraphTrackColumns,
  graphTrackMinimumWidth,
  graphTrackTemplate,
} from "../lib/graph-track.ts";
import {
  SENTENCE_PRE_ROLL_MS,
  SENTENCE_TAIL_PADDING_MS,
  sentencePlaybackWindow,
} from "../lib/sentence-playback.ts";

function sentenceFixture() {
  const text = "面朝大海，春暖花开。";
  const tokens = Array.from(text).map((char, index) => ({
    id: `token-${index}`,
    index,
    char,
    startMs: index * 200,
    endMs: (index + 1) * 200,
    confidence: 1,
  }));
  const endingIndex = tokens.at(-1).index;
  return {
    id: "sentence-1",
    tokens,
    prolongations: [{ id: "prolong-3", tokenIndex: 3 }],
    pauses: [
      { id: "pause-3", afterTokenIndex: 3, type: "short" },
      { id: "pause-ending", afterTokenIndex: endingIndex, type: "long" },
    ],
    endingIntonation: { type: "rising" },
  };
}

test("graph markers occupy token and boundary columns in document order", () => {
  const columns = buildGraphTrackColumns(sentenceFixture());
  const tokenThreePosition = columns.findIndex(
    (column) => column.kind === "token" && column.token.index === 3,
  );
  assert.deepEqual(
    columns.slice(tokenThreePosition, tokenThreePosition + 3).map((column) => column.kind),
    ["token", "prolongation", "pause"],
  );

  const endingTokenPosition = columns.findLastIndex((column) => column.kind === "token");
  assert.deepEqual(
    columns.slice(endingTokenPosition, endingTokenPosition + 3).map((column) => column.kind),
    ["token", "ending", "pause"],
    "the ending arrow must immediately follow the final punctuation",
  );
  assert.ok(graphTrackTemplate(columns).split(" ").length >= columns.length);
  assert.ok(graphTrackMinimumWidth(columns) > sentenceFixture().tokens.length * 20);
});

test("sentence playback adds pre-roll and tail padding without changing timestamps", () => {
  assert.equal(SENTENCE_PRE_ROLL_MS, 180);
  assert.equal(SENTENCE_TAIL_PADDING_MS, 120);
  const timing = { startMs: 500, endMs: 1800 };
  assert.deepEqual(sentencePlaybackWindow(timing, 5000), { startMs: 320, endMs: 1920 });
  assert.deepEqual(timing, { startMs: 500, endMs: 1800 });
  assert.deepEqual(
    sentencePlaybackWindow({ startMs: 100, endMs: 1950 }, 2000),
    { startMs: 0, endMs: 2000 },
  );
});

test("graph markers use inline flow and sentence playback waits for seek completion", async () => {
  const [studio, css] = await Promise.all([
    readFile(new URL("../components/RecitationStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /data-boundary-after-index/);
  assert.match(studio, /data-marker="prolongation"/);
  assert.match(studio, /data-marker="ending-intonation"/);
  assert.match(studio, /addEventListener\("seeked"/);
  assert.match(studio, /await seekAudioBeforePlayback/);
  assert.match(css, /\.track-marker-cell\s*\{[^}]*position:\s*static/s);
  assert.match(css, /\.prolong-mark\s*\{[^}]*border-bottom:\s*2\.5px/s);
  assert.match(css, /\.curve-path\s*\{[^}]*stroke-width:\s*2\.25/s);
  assert.doesNotMatch(css, /\.pause-mark\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(css, /\.tone-arrow\s*\{[^}]*position:\s*absolute/s);
});
