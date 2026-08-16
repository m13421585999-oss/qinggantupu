import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("compact editor is a sibling edition and keeps the full studio branch intact", async () => {
  const studio = await readFile(new URL("components/RecitationStudio.tsx", root), "utf8");
  assert.match(studio, /type StudioEdition = "full" \| "compact"/);
  assert.match(studio, /studioEdition === "full" \? \([\s\S]*?<StudioView/);
  assert.match(studio, /<CompactRecitationEditor/);
  assert.match(studio, /buildCompactControlSpec\(saved\.id, saved\.sourceText\)/);
  assert.match(studio, /url\.searchParams\.set\("edition", "compact"\)/);
  assert.match(studio, /studioEdition === "full" && step >= 2/);
});

test("compact editor exposes formal V and v markers plus one editable node per spoken token", async () => {
  const component = await readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8");
  assert.match(component, /"breath_major"/);
  assert.match(component, /"breath_minor"/);
  assert.match(component, /compact-breath-major/);
  assert.match(component, /compact-breath-minor/);
  assert.match(component, /buildTeachingProsodyPoints/);
  assert.match(component, /className="compact-token-pinyin"/);
  assert.match(component, /compact-curve-node is-editable/);
  assert.match(component, /onPointerMove/);
  assert.match(component, /prosodyVisualLevelFromPointerY/);
  assert.match(component, /upsertProsodyPointOverride/);
});

test("compact editor paginates measured sentence rows and exports one A4 PDF", async () => {
  const component = await readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(component, /data-compact-measure-id/);
  assert.match(component, /paginateMeasuredPrintBlocks\(measured/);
  assert.doesNotMatch(component, /maxBlocksPerPage:/);
  assert.doesNotMatch(component, /is-eight-row-page/);
  assert.match(component, /data-compact-pdf-page/);
  assert.match(component, /pixelRatio: COMPACT_RENDER_DPR/);
  assert.match(component, /new jsPDF\(\{[\s\S]*?unit: "mm"[\s\S]*?format: "a4"/);
  assert.match(component, /pdf\.addPage\("a4", "portrait"\)/);
  assert.match(component, /pdf\.save\(safePrintFilename\(work\.title, "pdf"\)\)/);
  assert.match(css, /\.compact-a4-page \{[\s\S]*?width: 210mm;[\s\S]*?height: 297mm;/);
  assert.match(css, /--compact-a4-margin, 11mm/);
  assert.match(css, /\.compact-token-manuscript\s*\{[\s\S]*?font-size: 22\.6pt/);
  assert.match(css, /\.compact-token-pinyin\s*\{[\s\S]*?font-size: 12\.5pt/);
  assert.match(css, /\.compact-sentence-number\s*\{[\s\S]*?font-size: 7\.3pt/);
  assert.match(css, /\.compact-page-body\s*\{[\s\S]*?gap: 0\.6mm/);
  assert.match(css, /\.compact-prosody-curve,[\s\S]*?height: 11\.5mm/);
  assert.match(css, /\.compact-page-legend\s*\{[\s\S]*?font-size: 8\.25pt/);
  assert.match(component, /replace\(\/\^《\+/);
  assert.match(css, /compact-a4-background\.png/);
  assert.match(css, /\.compact-a4-page::before/);
  assert.match(component, /stroke="#526f82"/);
  assert.match(component, /\{"\/\/\/"\}/);
  assert.match(component, /compact-legend-focus/);
  assert.match(component, /> 语势曲线</);
});
