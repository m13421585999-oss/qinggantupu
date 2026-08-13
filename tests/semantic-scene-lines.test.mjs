import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildGraphTokenUnits } from "../lib/graph-track.ts";
import {
  splitGraphUnitsByMeasuredWidth,
  splitGraphUnitsIntoSemanticLines,
} from "../lib/semantic-scene-lines.ts";

function sentence(text, pauses = []) {
  return {
    id: "semantic-lines",
    tokens: Array.from(text).map((char, index) => ({
      id: `semantic-token-${index}`,
      index,
      char,
      startMs: index * 100,
      endMs: (index + 1) * 100,
      confidence: 1,
    })),
    pauses,
    prolongations: [],
    endingIntonation: { type: "falling" },
  };
}

test("short scene remains one continuous reading line", () => {
  const units = buildGraphTokenUnits(sentence("从明天起，做一个幸福的人。"));
  const lines = splitGraphUnitsIntoSemanticLines(units);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, units.length);
});

test("long scene splits at a semantic punctuation boundary without orphan characters", () => {
  const units = buildGraphTokenUnits(sentence("从明天起做一个幸福的人，喂马劈柴周游世界，关心粮食和蔬菜。"));
  const lines = splitGraphUnitsIntoSemanticLines(units, { singleLineCapacity: 14 });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length > 2);
  assert.ok(lines[1].length > 2);
  assert.match(lines[0].at(-1).suffixPunctuation.map((token) => token.char).join(""), /，/u);
});

test("explicit pause is a preferred fallback when source punctuation is absent", () => {
  const text = "面朝大海春暖花开走向辽阔晨光";
  const pauseIndex = text.indexOf("暖");
  const units = buildGraphTokenUnits(sentence(text, [{
    id: "semantic-pause",
    afterTokenIndex: pauseIndex,
    type: "long",
  }]));
  const lines = splitGraphUnitsIntoSemanticLines(units, { singleLineCapacity: 8 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].at(-1).token.index, pauseIndex);
});

function measuredWidths(units, base = 38) {
  return new Map(units.map((unit) => [
    unit.token.index,
    base
      + (unit.prolongation ? 48 : 0)
      + (unit.pause ? 20 : 0)
      + unit.suffixPunctuation.length * 18
      + (unit.endingTone ? 20 : 0),
  ]));
}

test("measured viewer layout keeps a scene on one line whenever decorations fit", () => {
  const units = buildGraphTokenUnits(sentence("从明天起，做一个幸福的人。"));
  const lines = splitGraphUnitsByMeasuredWidth(units, {
    maxLineWidth: 1000,
    unitWidths: measuredWidths(units),
    unitGap: 4,
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], units);
});

test("minimum-font measured layout includes attached decorations and splits at punctuation", () => {
  const fixture = sentence("从明天起做一个幸福的人，喂马劈柴周游世界，关心粮食和蔬菜。", [{
    id: "pause-after-world",
    afterTokenIndex: 21,
    type: "long",
  }]);
  fixture.prolongations = [{ id: "held", tokenIndex: 20, degree: 2 }];
  const units = buildGraphTokenUnits(fixture);
  const lines = splitGraphUnitsByMeasuredWidth(units, {
    maxLineWidth: 540,
    unitWidths: measuredWidths(units),
    unitGap: 3,
  });
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.length >= 3));
  assert.ok(lines.slice(0, -1).some((line) => /[，、；。]/u.test(
    line.at(-1).suffixPunctuation.map((token) => token.char).join(""),
  )));
});

test("measured layout does not split inside focus or prosody core when a safe alternative fits", () => {
  const units = buildGraphTokenUnits(sentence("山河明亮，春风缓缓吹向远方。"));
  const protectedBoundary = units.find((unit) => unit.token.char === "缓").token.index;
  const lines = splitGraphUnitsByMeasuredWidth(units, {
    maxLineWidth: 290,
    unitWidths: measuredWidths(units),
    unitGap: 3,
    protectedBoundaryIndexes: [protectedBoundary],
  });
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.length >= 3));
  assert.ok(lines.slice(0, -1).every((line) => line.at(-1).token.index !== protectedBoundary));
});

test("viewer keeps the fixed artboard, visual asset dimensions and player safety contract", async () => {
  const [wrapper, studio, css] = await Promise.all([
    readFile(new URL("../components/ViewerScaleWrapper.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/RecitationStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(wrapper, /VIEWER_ARTBOARD_WIDTH = 1600/);
  assert.match(wrapper, /VIEWER_PLAYER_SAFE_AREA = 124/);
  assert.match(wrapper, /designHeight \* scale/);
  assert.match(wrapper, /ResizeObserver/);
  assert.match(studio, /<ViewerScaleWrapper artboardRef=\{exportTargetRef\}>/);
  assert.match(studio, /semanticLines=\{isViewerScene\}/);
  assert.match(studio, /VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE = 56/);
  assert.match(studio, /VIEWER_MANUSCRIPT_MIN_FONT_SIZE = 38/);
  assert.match(studio, /splitGraphUnitsByMeasuredWidth/);
  assert.match(studio, /element\.getBoundingClientRect\(\)\.width/);
  assert.match(studio, /viewerSceneImageUrl/);
  assert.match(studio, /trackRect\.width \/ track\.offsetWidth/);
  assert.match(studio, /position: "relative"/);
  assert.match(studio, /transform: "none"/);
  assert.match(css, /\.viewer-artboard\s*\{[\s\S]*?width:\s*1600px;/);
  assert.match(css, /\.viewer-artboard \.viewer-hero\s*\{[\s\S]*?width:\s*1500px;[\s\S]*?height:\s*300px;/);
  assert.match(css, /\.viewer-artboard \.viewer-sentence-wrap \.graph-sentence\s*\{[\s\S]*?width:\s*1500px;[\s\S]*?min-height:\s*320px;/);
  assert.match(css, /\.scene-visual-frame\s*\{[\s\S]*?width:\s*260px;[\s\S]*?height:\s*190px;/);
  assert.match(studio, /标准朗诵 · 整篇/);
  assert.doesNotMatch(studio, /className="viewer-footnote"/);
  assert.match(studio, /prepareViewerImagesForExport/);
  assert.match(css, /\.mode-viewer \.mode-switch,[\s\S]*?display:\s*none;/);
  assert.match(css, /\.mode-viewer \.player-compact\s*\{[\s\S]*?width:\s*min\(1500px,/);
});
