import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildGraphTokenUnits } from "../lib/graph-track.ts";
import { splitGraphUnitsIntoSemanticLines } from "../lib/semantic-scene-lines.ts";

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
  assert.match(studio, /viewerSceneImageUrl/);
  assert.match(studio, /trackRect\.width \/ track\.offsetWidth/);
  assert.match(studio, /position: "relative"/);
  assert.match(studio, /transform: "none"/);
  assert.match(css, /\.viewer-artboard\s*\{[\s\S]*?width:\s*1600px;/);
  assert.match(css, /\.viewer-artboard \.viewer-hero\s*\{[\s\S]*?width:\s*1500px;[\s\S]*?height:\s*420px;/);
  assert.match(css, /\.viewer-artboard \.viewer-sentence-wrap \.graph-sentence\s*\{[\s\S]*?width:\s*1500px;[\s\S]*?min-height:\s*320px;/);
  assert.match(css, /\.scene-visual-frame\s*\{[\s\S]*?width:\s*280px;[\s\S]*?height:\s*220px;/);
  assert.match(css, /\.mode-viewer \.mode-switch,[\s\S]*?display:\s*none;/);
  assert.match(css, /\.mode-viewer \.player-compact\s*\{[\s\S]*?width:\s*min\(1500px,/);
});
