import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_LEGEND_ITEM_IDS,
  DEFAULT_COMPACT_LEGEND_ITEMS,
  normalizeCompactLegendItems,
  usedCompactLegendItems,
} from "../lib/compact-legend.ts";

test("compact legend keeps the established six-item footer for older works", () => {
  assert.deepEqual(normalizeCompactLegendItems(undefined), DEFAULT_COMPACT_LEGEND_ITEMS);
  assert.equal(DEFAULT_COMPACT_LEGEND_ITEMS.length, 6);
});

test("compact legend filters invalid values, removes duplicates and restores canonical order", () => {
  assert.deepEqual(
    normalizeCompactLegendItems([
      "virtual-scene",
      "pause-short",
      "invalid-item",
      "virtual-scene",
      "intonation-rising",
    ]),
    ["pause-short", "intonation-rising", "virtual-scene"],
  );
  assert.equal(COMPACT_LEGEND_ITEM_IDS.length, 15);
});

test("compact legend preserves an explicit empty selection", () => {
  assert.deepEqual(normalizeCompactLegendItems([]), []);
});

test("automatic compact legend includes only cues used by the manuscript", () => {
  const sentence = {
    focus: [{ tokenIndexes: [1] }],
    pauses: [
      { type: "short", afterTokenIndex: 1 },
      { type: "long", afterTokenIndex: 2 },
    ],
    breaths: [{ type: "breath_major" }],
    prolongations: [{ tokenIndex: 3 }],
    endingIntonation: { type: "rising" },
    sceneTechniqueMarks: [{ type: "virtual" }],
    deliveryTechniqueMarks: [
      { type: "virtual_voice" },
      { type: "close_view" },
    ],
  };
  assert.deepEqual(usedCompactLegendItems([sentence]), [
    "breath-major",
    "pause-short",
    "pause-long",
    "focus",
    "prosody-curve",
    "intonation-rising",
    "prolong",
    "staccato",
    "virtual-scene",
    "virtual-voice",
    "close-view",
  ]);
  assert.deepEqual(usedCompactLegendItems([sentence], { showProsodyCurve: false }), [
    "breath-major",
    "pause-short",
    "pause-long",
    "focus",
    "intonation-rising",
    "prolong",
    "staccato",
    "virtual-scene",
    "virtual-voice",
    "close-view",
  ]);
});
