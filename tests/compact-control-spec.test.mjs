import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactControlSpec,
  buildCompactTokens,
  splitCompactSentenceRanges,
} from "../lib/compact-control-spec.ts";

function assertContiguousCoverage(sourceText, ranges) {
  assert.equal(ranges.map((range) => range.text).join(""), sourceText);
  assert.ok(ranges.every((range) => range.text.trim()), "blank lines never become sentence rows");
  ranges.forEach((range, index) => {
    assert.equal(range.startIndex, index === 0 ? 0 : ranges[index - 1].endIndex + 1);
    assert.equal(range.text, Array.from(sourceText).slice(range.startIndex, range.endIndex + 1).join(""));
  });
}

test("compact sentence splitting preserves mixed punctuation, CRLF, and blank lines", () => {
  const sourceText = "  第一行。 \n\n第二行！Third line?\r\n最后一行.";
  const ranges = splitCompactSentenceRanges(sourceText);

  assert.deepEqual(ranges.map((range) => range.text), [
    "  第一行。 \n\n",
    "第二行！",
    "Third line?\r\n",
    "最后一行.",
  ]);
  assertContiguousCoverage(sourceText, ranges);
});

test("western periods split sentences without breaking decimals or internal abbreviation periods", () => {
  const sourceText = "数值3.14不拆。U.S.A. finished.";
  const ranges = splitCompactSentenceRanges(sourceText);

  assert.deepEqual(ranges.map((range) => range.text), [
    "数值3.14不拆。",
    "U.S.A. ",
    "finished.",
  ]);
  assertContiguousCoverage(sourceText, ranges);
});

test("leading and trailing blank lines attach to spoken rows instead of creating blank rows", () => {
  const sourceText = "\n\n起句。\n\n尾句\n\n";
  const ranges = splitCompactSentenceRanges(sourceText);

  assert.deepEqual(ranges.map((range) => range.text), ["\n\n起句。\n\n", "尾句\n\n"]);
  assertContiguousCoverage(sourceText, ranges);
});

test("compact tokens use Unicode characters and neutral audio-free timings", () => {
  const tokens = buildCompactTokens("你😀好。");
  const expectedCharacters = Array.from("你😀好。");

  assert.deepEqual(tokens.map((token) => token.char), expectedCharacters);
  assert.deepEqual(tokens.map((token) => token.index), [0, 1, 2, 3]);
  assert.ok(tokens.every((token) => token.startMs === 0 && token.endMs === 0));
  assert.ok(tokens.every((token) => token.confidence === 0));
});

test("manual compact control spec satisfies the backend token validation contract", () => {
  const sourceText = "你😀好。\n下一句！";
  const spec = buildCompactControlSpec("work-compact", sourceText);
  const sourceCharacters = Array.from(sourceText);

  assert.equal(spec.source, "human");
  assert.equal(spec.schemaVersion, "2.0");
  assert.equal(spec.tokens.length, sourceCharacters.length);
  spec.tokens.forEach((token, index) => {
    assert.equal(token.index, index);
    assert.equal(token.char, sourceCharacters[index]);
  });
  assert.ok(spec.sentences.length > 0, "the backend requires at least one sentence");
  assert.deepEqual(
    spec.sentences.flatMap((sentence) => sentence.tokens.map((token) => token.index)),
    sourceCharacters.map((_, index) => index),
  );
  assert.equal(spec.sentences.map((sentence) => sentence.text).join(""), sourceText);
  assert.ok(spec.sentences.every((sentence) => (
    sentence.focus.length === 0
    && sentence.pauses.length === 0
    && sentence.prolongations.length === 0
    && sentence.prosody.length === 0
    && sentence.macroProsodyPath === undefined
    && sentence.prosodyPointOverrides === undefined
  )));
});

test("compact control spec rejects missing work identity and whitespace-only manuscripts", () => {
  assert.throws(() => buildCompactControlSpec("", "正文。"), /作品编号/);
  assert.throws(() => buildCompactControlSpec("work-compact", " \n\t "), /非空正文/);
});
