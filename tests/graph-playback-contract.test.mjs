import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildGraphTokenUnits,
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

function renderedTrackText(units) {
  return units.map((unit) => {
    const ending = unit.endingTone === "rising"
      ? "↗"
      : unit.endingTone === "falling"
        ? "↘"
        : unit.endingTone === "level"
          ? "→"
          : "";
    const pause = unit.pause?.type === "long" ? "///" : unit.pause ? "/" : "";
    return [
      unit.prefixPunctuation.map((token) => token.char).join(""),
      unit.token.char,
      unit.prolongation ? "——" : "",
      ending,
      pause,
      unit.suffixPunctuation.map((token) => token.char).join(""),
    ].join("");
  }).join("");
}

test("punctuation and recitation marks attach to character hosts in manuscript order", () => {
  const sentence = sentenceFixture();
  const units = buildGraphTokenUnits(sentence);
  const spokenTokens = sentence.tokens.filter((token) => !/[\p{P}\s]/u.test(token.char));
  assert.equal(units.length, spokenTokens.length, "only spoken characters create token units");
  assert.ok(units.every((unit) => !/[\p{P}\s]/u.test(unit.token.char)));

  const sea = units.find((unit) => unit.token.index === 3);
  assert.ok(sea?.prolongation);
  assert.equal(sea?.pause, undefined, "the source comma replaces the pause mark after 大海");
  assert.equal(sea?.suffixPunctuation.map((token) => token.char).join(""), "，");
  assert.deepEqual(sea?.sourceTokenIndexes, [3, 4]);

  const warm = units.find((unit) => unit.token.index === 6);
  assert.equal(warm?.pause?.type, "long", "a pause without source punctuation stays attached");
  assert.equal(warm?.suffixPunctuation.length, 0);

  const open = units.find((unit) => unit.token.index === 8);
  assert.ok(open?.prolongation);
  assert.equal(open?.endingTone, "rising");
  assert.equal(open?.suffixPunctuation.map((token) => token.char).join(""), "。");

  assert.equal(units.filter((unit) => unit.pause).length, 1);
  assert.equal(renderedTrackText(units), "面朝大海——，春暖///花开——↗。");
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
  const units = buildGraphTokenUnits(sentence);
  assert.equal(units.length, 3);
  assert.equal(units.filter((unit) => unit.pause).length, 0);
  assert.equal(renderedTrackText(units), "甲、乙，丙→。");
});

test("viewer chrome explains every graph symbol and the shared-audio promise", async () => {
  const studio = await readFile(new URL("../components/RecitationStudio.tsx", import.meta.url), "utf8");
  assert.match(studio, /红字：表达焦点/);
  assert.match(studio, /\/<\/b> 短停/);
  assert.match(studio, /长停/);
  assert.match(studio, /拖音/);
  assert.match(studio, /↗ ↘ →<\/b> 句尾语调/);
  assert.match(studio, /曲线：宏观语势/);
  assert.match(studio, /声音与图谱同源/);
  assert.match(studio, /播放整篇/);
  assert.match(studio, /听本句/);
  assert.match(studio, /标准 AI 朗诵/);
});

test("mobile uses a portrait rotation gate and preserves the desktop structure in landscape", async () => {
  const [layout, css] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /className="mobile-portrait-gate"/);
  assert.match(layout, /请将手机旋转至横屏/);
  assert.match(layout, /与电脑端一致的完整朗诵图谱/);
  assert.match(css, /\.mobile-portrait-gate\s*\{\s*display:\s*none;/s);
  assert.match(
    css,
    /@media \(max-width:\s*900px\) and \(orientation:\s*portrait\)[\s\S]*?\.app-orientation-shell\s*\{\s*display:\s*none;/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*900px\) and \(orientation:\s*portrait\)[\s\S]*?\.mobile-portrait-gate\s*\{[\s\S]*?display:\s*grid;/,
  );
  assert.match(css, /@media \(max-width:\s*900px\) and \(orientation:\s*landscape\)/);
  assert.match(css, /@media \(max-width:\s*620px\) and \(orientation:\s*portrait\)/);
  assert.doesNotMatch(css, /@media \(max-width:\s*620px\)\s*\{/);
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

test("graph decorations stay attached while sentence playback waits for seek completion", async () => {
  const [studio, css] = await Promise.all([
    readFile(new URL("../components/RecitationStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /buildGraphTokenUnits/);
  assert.match(studio, /className="graph-token-unit"/);
  assert.match(studio, /className="attached-decorations"/);
  assert.match(studio, /data-attached-to-index/);
  assert.match(studio, /data-source-token-index/);
  assert.match(studio, /data-boundary-after-index/);
  assert.match(studio, /data-marker="prolongation"/);
  assert.match(studio, /data-marker="ending-intonation"/);
  assert.match(studio, /buildTeachingProsodyPoints/);
  assert.match(studio, /monotoneSplinePath/);
  assert.match(studio, /data-prosody-anchor="true"/);
  assert.match(studio, /className="prosody-anchor-hit-target"[\s\S]*?data-export-exclude="true"/);
  assert.match(studio, /setPointerCapture\(event\.pointerId\)/);
  assert.match(studio, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(studio, /onPointerCancel=\{\(event\) => cancelDraggedPoint\(event\.pointerId\)\}/);
  assert.match(studio, /onLostPointerCapture=\{\(event\) => cancelDraggedPoint\(event\.pointerId\)\}/);
  assert.match(studio, /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/);
  assert.match(studio, /data-token-index=\{point\.tokenIndex\}/);
  assert.match(studio, /point\.tokenIndex === activeTokenIndex/);
  assert.match(studio, /className="curve-fill"/);
  assert.match(studio, /linearGradient/);
  assert.match(studio, /className="curve-path acoustic-path"[\s\S]*?fill="none"[\s\S]*?stroke="#b6452e"/);
  assert.match(studio, /data-prosody-anchor="true"[\s\S]*?fill=\{playing \? "#a93627"/);
  assert.match(studio, /stroke=\{playing \? "#fff5e8"/);
  assert.match(studio, /rect\.left - trackRect\.left \+ rect\.width \/ 2/);
  assert.doesNotMatch(studio, /event-path/);
  assert.match(studio, /addEventListener\("seeked"/);
  assert.match(studio, /await seekAudioBeforePlayback/);
  assert.doesNotMatch(studio, /trackColumns|buildGraphTrackColumns|track-marker-cell/);
  assert.match(css, /\.token-unit-flow\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.graph-token-unit\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.prolong-mark::after\s*\{[^}]*border-top:\s*2\.5px/s);
  assert.match(css, /\.pause-mark\s*\{[^}]*font-weight:\s*700/s);
  assert.match(css, /\.tone-arrow\s*\{[^}]*font-weight:\s*700/s);
  assert.match(css, /\.curve-path\s*\{[^}]*stroke-width:\s*2\.25/s);
  assert.match(css, /\.token-prosody-anchor\s*\{[^}]*opacity:\s*0\.9/s);
  assert.match(css, /\.token-prosody-anchor\.playing\s*\{[^}]*stroke-width:\s*2/s);
  assert.match(css, /\.prosody-anchor-hit-target\s*\{[^}]*touch-action:\s*none/s);
  assert.doesNotMatch(css, /\.acoustic-prosody-curve\.editing\s*\{[^}]*touch-action:\s*none/s);
  assert.doesNotMatch(css, /\.track-marker-cell|\.track-spacer-cell|--track-columns/);
  assert.doesNotMatch(css, /\.pause-mark\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(css, /\.tone-arrow\s*\{[^}]*position:\s*absolute/s);
});
