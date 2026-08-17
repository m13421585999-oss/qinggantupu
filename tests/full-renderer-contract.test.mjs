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

test("Full marker slot lives inside the spoken-token grid and not in the pinyin layer", async () => {
  const css = await read("app/globals.css");
  // The spoken-token becomes a 2-column grid so pinyin/char are in column 1
  // and the marker slot is in column 2 / row 2.
  assert.match(css, /\.full-spoken-token\s*\{[^}]*grid-template-columns:\s*auto\s+auto/s);
  assert.match(css, /grid-template-areas:\s*"pinyin pinyin"\s*"char marker"/s);
  assert.match(css, /\.full-token-pinyin\s*\{[^}]*grid-area:\s*pinyin/s);
  assert.match(css, /\.full-token-char\s*\{[^}]*grid-area:\s*char/s);
  assert.match(css, /\.full-token-marker\s*\{[^}]*grid-area:\s*marker/s);
  // Pinyin and char still share the same column so pinyin only centres over
  // the character, never over the marker column.
  assert.match(css, /"pinyin pinyin"[\s\S]*"char marker"/);
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
