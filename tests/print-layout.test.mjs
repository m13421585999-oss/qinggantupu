import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_A4_PRINT_SETTINGS,
  paginateMeasuredPrintBlocks,
  safePrintFilename,
} from "../lib/print-layout.ts";

function blocks(count, heightPx = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sentence-${index + 1}`,
    heightPx,
  }));
}

function paginate(count) {
  return paginateMeasuredPrintBlocks(blocks(count), {
    firstPageCapacityPx: 450,
    continuationPageCapacityPx: 550,
    blockGapPx: 10,
  });
}

test("short print manuscript produces exactly one A4 page", () => {
  const pages = paginate(4);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].blockIds, ["sentence-1", "sentence-2", "sentence-3", "sentence-4"]);
});

test("medium print manuscript produces two to four pages without duplicates or loss", () => {
  const pages = paginate(18);
  const ids = pages.flatMap((page) => page.blockIds);
  assert.ok(pages.length >= 2 && pages.length <= 4);
  assert.equal(ids.length, 18);
  assert.equal(new Set(ids).size, 18);
  assert.deepEqual(ids, blocks(18).map((block) => block.id));
  assert.ok(pages.every((page) => page.usedHeightPx <= page.capacityPx));
});

test("long print manuscript remains stable beyond five pages", () => {
  const pages = paginate(52);
  const ids = pages.flatMap((page) => page.blockIds);
  assert.ok(pages.length > 5);
  assert.deepEqual(ids, blocks(52).map((block) => block.id));
  assert.ok(pages.every((page) => !page.hasOversizedBlock));
});

test("single-sentence widow is balanced when the previous page can donate a companion", () => {
  const pages = paginateMeasuredPrintBlocks(blocks(7), {
    firstPageCapacityPx: 320,
    continuationPageCapacityPx: 320,
    blockGapPx: 10,
  });
  assert.deepEqual(pages.map((page) => page.blockIds.length), [3, 2, 2]);
  assert.deepEqual(pages.flatMap((page) => page.blockIds), blocks(7).map((block) => block.id));
});

test("an exceptional over-height sentence is isolated and explicitly flagged", () => {
  const pages = paginateMeasuredPrintBlocks([
    { id: "normal", heightPx: 120 },
    { id: "oversized", heightPx: 480 },
    { id: "following", heightPx: 120 },
  ], {
    firstPageCapacityPx: 300,
    continuationPageCapacityPx: 300,
    blockGapPx: 10,
  });
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[1].blockIds, ["oversized"]);
  assert.equal(pages[1].hasOversizedBlock, true);
});

test("compact page density can cap each physical page at eight complete sentence rows", () => {
  const pages = paginateMeasuredPrintBlocks(blocks(24, 20), {
    firstPageCapacityPx: 1000,
    continuationPageCapacityPx: 1000,
    blockGapPx: 2,
    maxBlocksPerPage: 8,
  });
  assert.deepEqual(pages.map((page) => page.blockIds.length), [8, 8, 8]);
  assert.deepEqual(pages.flatMap((page) => page.blockIds), blocks(24, 20).map((block) => block.id));
});

test("A4 export contract uses physical paper dimensions, structured pages and 2.5x PDF rendering", async () => {
  const [component, graph, css] = await Promise.all([
    readFile(new URL("../components/A4PrintPreview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/print/PrintGraphTrack.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.equal(DEFAULT_A4_PRINT_SETTINGS.widthMm, 210);
  assert.equal(DEFAULT_A4_PRINT_SETTINGS.heightMm, 297);
  assert.equal(DEFAULT_A4_PRINT_SETTINGS.renderDpr, 2.5);
  assert.equal(DEFAULT_A4_PRINT_SETTINGS.compactLegendItems?.length, 6);
  assert.match(css, /\.a4-page\s*\{[\s\S]*?width:\s*210mm;[\s\S]*?height:\s*297mm;[\s\S]*?--a4-margin-top, 15mm/);
  assert.match(component, /data-print-measure-id/);
  assert.match(component, /paginateMeasuredPrintBlocks/);
  assert.match(component, /new jsPDF\(\{[\s\S]*?unit:\s*"mm"[\s\S]*?format:\s*"a4"/);
  assert.match(component, /pixelRatio:\s*settings\.renderDpr/);
  assert.match(graph, /splitGraphUnitsByMeasuredWidth/);
  assert.match(graph, /extendProsodyCurveToTokenEdges/);
  assert.match(component, /className="a4-first-page-header"/);
  assert.doesNotMatch(component, /showHero/);
  assert.match(component, /backgroundColor:\s*"#fbf7ef"/);
  assert.match(graph, /className="print-spoken-token"[\s\S]*?className="print-token-pinyin"[\s\S]*?className=\{`print-token-char/);
  assert.match(graph, /PRINT_CURVE_HEIGHT = 40/);
  assert.match(css, /\.a4-page\s*\{[\s\S]*?#fbf7ef/);
  assert.match(css, /\.a4-first-page-header\s*\{[\s\S]*?min-height:\s*18mm/);
  assert.match(css, /\.print-spoken-token\s*\{[\s\S]*?grid-template-rows:\s*5\.7mm 9\.2mm/);
  assert.match(css, /\.print-token-pinyin\s*\{[\s\S]*?font-size:\s*10pt/);
  assert.match(css, /\.print-token-manuscript\s*\{[\s\S]*?font-size:\s*20pt/);
  assert.match(css, /\.print-prosody-curve,[\s\S]*?height:\s*10\.6mm[\s\S]*?background:\s*transparent/);
  assert.equal(safePrintFilename("《活着》", "pdf"), "《活着》-朗诵情感图谱.pdf");
});

test("print settings persist with the work while page screenshots remain derived", async () => {
  const [schema, worker, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_flaky_white_tiger.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /printSettingsJson:\s*text\("print_settings_json"\)/);
  assert.match(worker, /printSettings:\s*normalizePrintSettings/);
  assert.match(worker, /print_settings_json = \?/);
  assert.match(migration, /ADD `print_settings_json` text DEFAULT/);
  assert.doesNotMatch(schema, /page_\d+\.(png|jpg)/i);
});
