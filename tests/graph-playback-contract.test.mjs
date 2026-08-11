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
  return {
    id: "sentence-1",
    tokens,
    prolongations: [
      { id: "prolong-3", tokenIndex: 3 },
      { id: "prolong-8", tokenIndex: 8 },
    ],
    pauses: [
      { id: "pause-3", afterTokenIndex: 3, type: "short" },
      { id: "pause-4", afterTokenIndex: 4, type: "long" },
      { id: "pause-6", afterTokenIndex: 6, type: "long" },
      { id: "pause-ending", afterTokenIndex: 9, type: "long" },
    ],
    endingIntonation: { type: "rising" },
  };
}

function renderedTrackText(columns) {
  return columns.map((column) => {
    if (column.kind === "token") return column.token.char;
    if (column.kind === "prolongation") return "——";
    if (column.kind === "pause") return column.mark.type === "long" ? "///" : "/";
    return column.tone === "rising" ? "↗" : column.tone === "falling" ? "↘" : "→";
  }).join("");
}

test("source punctuation suppresses pause marks while preserving inline marker order", () => {
  const columns = buildGraphTrackColumns(sentenceFixture());
  const tokenThreePosition = columns.findIndex(
    (column) => column.kind === "token" && column.token.index === 3,
  );
  assert.deepEqual(
    columns.slice(tokenThreePosition, tokenThreePosition + 3).map((column) => column.kind),
    ["token", "prolongation", "token"],
    "a source comma must replace the pause mark after 大海",
  );

  const extraPausePosition = columns.findIndex(
    (column) => column.kind === "token" && column.token.index === 6,
  );
  assert.deepEqual(
    columns.slice(extraPausePosition, extraPausePosition + 3).map((column) => column.kind),
    ["token", "pause", "token"],
    "a pause without source punctuation remains visible",
  );

  const lastSpokenTokenPosition = columns.findIndex(
    (column) => column.kind === "token" && column.token.index === 8,
  );
  assert.deepEqual(
    columns.slice(lastSpokenTokenPosition, lastSpokenTokenPosition + 4).map((column) => column.kind),
    ["token", "prolongation", "ending", "token"],
    "the ending arrow belongs before the original sentence punctuation",
  );
  assert.equal(columns.filter((column) => column.kind === "pause").length, 1);
  assert.equal(renderedTrackText(columns), "面朝大海——，春暖///花开——↗。");
  assert.ok(graphTrackTemplate(columns).split(" ").length >= columns.length);
  assert.ok(graphTrackMinimumWidth(columns) > sentenceFixture().tokens.length * 20);
});

test("comma enumeration comma and period each fully replace adjacent pause marks", () => {
  const text = "甲、乙，丙。";
  const tokens = Array.from(text).map((char, index) => ({
    id: `punctuation-token-${index}`,
    index,
    char,
    startMs: index * 100,
    endMs: (index + 1) * 100,
    confidence: 1,
  }));
  const sentence = {
    id: "punctuation-sentence",
    tokens,
    prolongations: [],
    pauses: tokens.map((token) => ({
      id: `pause-${token.index}`,
      afterTokenIndex: token.index,
      type: "short",
    })),
    endingIntonation: { type: "level" },
  };
  const columns = buildGraphTrackColumns(sentence);
  assert.equal(columns.filter((column) => column.kind === "pause").length, 0);
  assert.equal(renderedTrackText(columns), "甲、乙，丙→。");
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
