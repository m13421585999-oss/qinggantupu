import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditionSentenceRows,
  ensureEditionLayouts,
  mergeFullLayoutRowsAtToken,
  resolveFullLayoutRows,
  usesChushibiaoVirtualVoiceSpacing,
  withCompactSentences,
  withFullLayoutRows,
} from "../lib/edition-layout.ts";

test("extra virtual-voice spacing is restricted to the requested Chushibiao work", () => {
  assert.equal(usesChushibiaoVirtualVoiceSpacing("work_ca868cbb-c50d-4a60-84a3-e6b4706012c8"), true);
  assert.equal(usesChushibiaoVirtualVoiceSpacing("work-other"), false);
});

function sentence(id, order, tokens) {
  return {
    id,
    order,
    text: tokens.map((token) => token.char).join(""),
    function: "",
    rhythm: "relaxed",
    continuity: "connected",
    prosody: [],
    endingIntonation: { type: "level", strength: 1 },
    focus: [],
    voiceQuality: { start: "neutral", end: "neutral" },
    pauses: [],
    prolongations: [],
    tokens,
    teachingCue: "",
    avoid: [],
    confidence: 1,
    timeRange: { startMs: 0, endMs: 0 },
  };
}

function fixture() {
  const tokens = Array.from("甲乙丙丁戊", (char, index) => ({
    id: `token-${index}`,
    index,
    char,
    startMs: 0,
    endMs: 0,
    confidence: 1,
  }));
  const sentences = [
    sentence("sentence-1", 1, tokens.slice(0, 3)),
    sentence("sentence-2", 2, tokens.slice(3)),
  ];
  return {
    schemaVersion: "2.0",
    id: "spec-layout",
    workId: "work-layout",
    version: 1,
    source: "human",
    documentProfile: {
      deliveryMode: "natural_narration",
      recitationDegree: 1,
      baseRhythm: "relaxed",
      emotionalTone: [],
      energy: "medium",
      control: "medium",
      interactionDistance: "conversational",
      voiceQuality: "neutral",
      globalArc: [],
    },
    tokens,
    sentences,
    analysisProvenance: { knowledgeAssetIds: [], pipelineVersion: "test", generatedAt: "now" },
    validation: { state: "valid", issues: [] },
    createdAt: "now",
  };
}

test("compact row restructuring preserves the frozen Full row boundaries", () => {
  const original = ensureEditionLayouts(fixture());
  const [first, second] = original.sentences;
  const compactSentences = [
    sentence(first.id, 1, first.tokens.slice(0, 2)),
    sentence(second.id, 2, [...first.tokens.slice(2), ...second.tokens]),
  ];
  const updated = withCompactSentences(original, compactSentences);

  assert.deepEqual(
    updated.editionLayouts.full.rows.map((row) => row.tokenIndexes),
    [[0, 1, 2], [3, 4]],
  );
  assert.deepEqual(
    updated.editionLayouts.compact.rows.map((row) => row.tokenIndexes),
    [[0, 1], [2, 3, 4]],
  );
});

test("Full rows resolve shared Compact annotations by token after row ownership changes", () => {
  const original = ensureEditionLayouts(fixture());
  const [first, second] = original.sentences;
  const compactFirst = sentence(first.id, 1, first.tokens.slice(0, 2));
  const compactSecond = sentence(second.id, 2, [...first.tokens.slice(2), ...second.tokens]);
  compactSecond.focus = [{
    id: "focus-shared",
    tokenIds: ["token-2"],
    tokenIndexes: [2],
    level: "primary",
    preferredRealization: "free",
    allowedRealizations: ["free"],
    avoid: [],
  }];
  compactSecond.prosodyPointOverrides = [{ tokenIndex: 2, visualLevel: 6, source: "human" }];
  compactSecond.deliveryTechniqueMarks = [{
    id: "virtual-voice-shared",
    tokenId: "token-2",
    tokenIndex: 2,
    type: "virtual_voice",
    source: "human",
  }];
  const updated = withCompactSentences(original, [compactFirst, compactSecond]);

  const rows = buildEditionSentenceRows(updated, resolveFullLayoutRows(updated));
  assert.equal(rows[0].sentence.text, "甲乙丙");
  assert.deepEqual(rows[0].sentence.focus[0].tokenIndexes, [2]);
  assert.deepEqual(rows[0].sentence.prosodyPointOverrides, [
    { tokenIndex: 2, visualLevel: 6, source: "human" },
  ]);
  assert.deepEqual(rows[0].sentence.deliveryTechniqueMarks, [{
    id: "virtual-voice-shared",
    tokenId: "token-2",
    tokenIndex: 2,
    type: "virtual_voice",
    source: "human",
  }]);
});

test("Full visual-line edits preserve Compact rows and shared sentences", () => {
  const original = ensureEditionLayouts(fixture());
  const compactRows = structuredClone(original.editionLayouts.compact.rows);
  const sentences = original.sentences;
  const rows = mergeFullLayoutRowsAtToken(original, [
    { rowId: "sentence-1", tokenIndexes: [0, 1] },
    { rowId: "sentence-1", tokenIndexes: [2] },
    { rowId: "sentence-2", tokenIndexes: [3, 4] },
  ], 2, "previous");

  assert.ok(rows);
  const updated = withFullLayoutRows(original, rows);
  assert.deepEqual(updated.editionLayouts.full.rows[0].lineBreakAfterTokenIndexes, undefined);
  assert.deepEqual(updated.editionLayouts.compact.rows, compactRows);
  assert.equal(updated.sentences, sentences);
});

test("Full visual-line edits can move a row suffix into the following Full row", () => {
  const original = ensureEditionLayouts(fixture());
  const rows = mergeFullLayoutRowsAtToken(original, [
    { rowId: "sentence-1", tokenIndexes: [0, 1, 2] },
    { rowId: "sentence-2", tokenIndexes: [3, 4] },
  ], 1, "next");

  assert.ok(rows);
  const updated = withFullLayoutRows(original, rows);
  assert.deepEqual(
    updated.editionLayouts.full.rows.map((row) => row.tokenIndexes),
    [[0], [1, 2, 3, 4]],
  );
  assert.deepEqual(
    updated.editionLayouts.compact.rows.map((row) => row.tokenIndexes),
    [[0, 1, 2], [3, 4]],
  );
});
