"use strict";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(path) {
  return readFile(resolve(root, path), "utf8");
}

test("Full A4 renders every shared marker used by Compact", async () => {
  const editor = await read("components/FullA4Editor.tsx");
  assert.match(editor, /function FullTokenUnit/);
  assert.match(editor, /const pause = pauseAt\(sentence, unit\.token\.index\)/);
  assert.match(editor, /full-ending-tone/);
  assert.match(editor, /full-breath-\$\{breath\.type/);
  assert.match(editor, /breath\.type === "breath_major" \? "V" : "v"/);
  assert.match(editor, /full-prolong-mark/);
  assert.match(editor, /className="full-prolong-mark"[\s\S]{0,160}>—<\/span>/);
  assert.match(editor, /full-pause-\$\{pause\.type\}/);
  assert.match(editor, /pause\.type === "long" \? "\/\/\/" : "\/"/);
  assert.match(editor, /full-scene-technique-slot/);
  assert.match(editor, /deliveryTechniqueAt\(sentence, unit\.token\.index, "virtual_voice"\)/);
  assert.match(editor, /className=\{`full-distance-marker/);
  assert.match(editor, /<DistanceViewGlyph type=\{distanceView\.type\}/);
  assert.match(editor, /is-virtual-voice/);
  assert.doesNotMatch(
    editor,
    /className="full-prolong-mark"[\s\S]{0,160}data-export-exclude/,
  );
  assert.doesNotMatch(
    editor,
    /className=\{`full-breath[\s\S]{0,180}data-export-exclude/,
  );
});

test("Full marker is a boundary gutter outside the spoken-token, keeping pinyin centered over its character", async () => {
  const css = await read("app/globals.css");
  // The spoken-token is a single indivisible column: pinyin on top, character
  // below, both sharing one horizontal center.
  assert.match(css, /\.full-spoken-token\s*\{[^}]*grid-template-columns:\s*auto\s*;/s);
  assert.match(css, /grid-template-areas:\s*"pinyin"\s*"char"/s);
  assert.match(css, /\.full-token-pinyin\s*\{[^}]*grid-area:\s*pinyin/s);
  assert.match(css, /\.full-token-char\s*\{[^}]*grid-area:\s*char/s);
  // The marker is a sibling gutter pinned to the character row, not a grid
  // column, so /, ↗, ↘ never shift pinyin away from its character.
  assert.doesNotMatch(css, /\.full-token-marker\s*\{[^}]*grid-area:\s*marker/s);
  assert.match(css, /\.full-token-marker\s*\{[^}]*height:\s*11mm/s);
});

test("characterRef stays attached only to the real character element", async () => {
  const editor = await read("components/FullA4Editor.tsx");
  // The characterRef callback only writes into the .full-token-char DOM,
  // never into a marker slot, spoken-token wrapper, or unit wrapper.
  assert.match(editor, /className=\{`full-token-char/);
  assert.match(editor, /characterRef\?:\s*\(element:\s*HTMLElement\s*\|\s*null\)\s*=>\s*void/);
  // The marker slot must not accept any characterRef.
  assert.doesNotMatch(editor, /full-token-marker[\s\S]{0,200}characterRef/);
});

test("Full primary markers are sized 1em so they match the manuscript weight", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.full-ending-tone,\s*\.full-pause\s*\{[^}]*font-size:\s*1em/s);
});

test("Full prolongation is a character-after cue instead of an underline", async () => {
  const css = await read("app/globals.css");
  const rule = css.match(/\.full-prolong-mark\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /display:\s*inline-flex/);
  assert.doesNotMatch(rule[1], /position:\s*absolute/);
  assert.doesNotMatch(rule[1], /border-top/);
});

test("Full page legend is evidence-driven and supports every shared cue", async () => {
  const editor = await read("components/FullA4Editor.tsx");
  const legendMatch = editor.match(/function FullPageLegend\([^)]*\)\s*\{[\s\S]*?<\/footer>/);
  assert.ok(legendMatch, "FullPageLegend must exist and render a footer");
  const legend = legendMatch[0];
  assert.match(legend, /items\.map/);
  assert.match(legend, /FULL_LEGEND_LABELS/);
  assert.match(editor, /usedCompactLegendItems/);
  for (const label of ["换气", "偷气", "短停", "长停", "重音", "语势曲线", "拖音", "实景", "虚景", "虚声", "远景", "近景"]) {
    assert.match(editor, new RegExp(label));
  }
});

test("Full freezes edition rows and puts exactly one measured line in each page slot", async () => {
  const [editor, studio, schema] = await Promise.all([
    read("components/FullA4Editor.tsx"),
    read("components/RecitationStudio.tsx"),
    read("lib/recitation-schema.ts"),
  ]);
  assert.match(schema, /editionLayouts\?: RecitationEditionLayouts/);
  assert.match(studio, /withCompactSentences\(current\.controlSpec, nextSentences\)/);
  assert.match(editor, /resolveFullLayoutRows\(spec\)/);
  assert.match(editor, /data-full-line-measure-id/);
  assert.match(editor, /lineTokenIndexes=\{lineBlock\?\.tokenIndexes\}/);
  assert.match(editor, /完整版独立排成/);
  assert.match(editor, /mergeFullLayoutRowsAtToken/);
  assert.match(editor, /并入上一行/);
  assert.match(editor, /并入下一行/);
  assert.match(studio, /withFullLayoutRows\(current\.controlSpec, rows\)/);
});

test("Full line measurement uses the printable content width instead of the whole A4 sheet", async () => {
  const css = await read("app/globals.css");
  const measureRules = [...css.matchAll(/^\.full-measure-layer\s*\{([^}]*)\}/gm)];
  assert.equal(measureRules.length, 1, "the measurement layer must have one authoritative width rule");
  assert.match(
    measureRules[0][1],
    /width:\s*calc\(210mm\s*-\s*\(var\(--full-a4-margin,\s*14mm\)\s*\*\s*2\)\)/,
  );
});

test("Spring keeps its scene-technique row and restores the prosody curve only in Full", async () => {
  const [fullEditor, compactEditor] = await Promise.all([
    read("components/FullA4Editor.tsx"),
    read("components/CompactRecitationEditor.tsx"),
  ]);
  assert.match(fullEditor, /showSceneTechniqueRow=\{springSceneTechniqueMode\}/);
  assert.match(fullEditor, /showProsodyCurve\s*\n/);
  assert.doesNotMatch(fullEditor, /showProsodyCurve=\{!springSceneTechniqueMode\}/);
  assert.match(compactEditor, /springSceneTechniqueMode \? null : \(/);
});
