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

test("Full A4 only renders the four primary recitation cues in the token renderer", async () => {
  const editor = await read("components/FullA4Editor.tsx");
  // The FullTokenUnit function must explicitly branch on the four cues.
  assert.match(editor, /function FullTokenUnit/);
  assert.match(editor, /shortPause/);
  assert.match(editor, /full-ending-tone/);
  // The renderer must no longer emit V/v, /// or the prolongation glyph.
  assert.doesNotMatch(editor, /full-breath-major/);
  assert.doesNotMatch(editor, /full-breath-minor/);
  assert.doesNotMatch(editor, /full-prolongation/);
  assert.doesNotMatch(editor, /full-pause-long/);
  // The renderer must not show the long pause glyph at all.
  assert.doesNotMatch(editor, /pause\.type === "long" \? "\/\/\/"/);
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

test("Full page legend only lists the four primary cues", async () => {
  const editor = await read("components/FullA4Editor.tsx");
  // Legend now lists short pause, tone, focus, curve only.
  const legendMatch = editor.match(/function FullPageLegend\(\)\s*\{[\s\S]*?<\/footer>/);
  assert.ok(legendMatch, "FullPageLegend must exist and render a footer");
  const legend = legendMatch[0];
  assert.match(legend, /短停/);
  assert.match(legend, /语调/);
  assert.match(legend, /重音/);
  assert.match(legend, /语势曲线/);
  assert.doesNotMatch(legend, /换气/);
  assert.doesNotMatch(legend, /偷气/);
  assert.doesNotMatch(legend, /长停/);
});
