import assert from "node:assert/strict";
import test from "node:test";

import { buildElevenTimeline, compileElevenV3Prompt } from "../lib/eleven-tts.ts";

function controlSpec(text = "面朝大海，春暖花开。") {
  const tokens = Array.from(text).map((char, index) => ({
    id: `token-${index}`,
    index,
    char,
  }));
  return {
    tokens,
    sentences: [{
      id: "sentence-1",
      rhythm: "relaxed",
      tokens,
      focus: [{ tokenIndexes: [0, 1, 2, 3], level: "primary" }],
      pauses: [{ afterTokenIndex: 3, type: "short" }],
      prolongations: [{ tokenIndex: 8, degree: 1 }],
      prosody: [{
        type: "valley",
        activeSpan: { start: 0, end: 8 },
        coreZone: { start: 2, end: 7 },
        strength: 2,
      }],
      endingIntonation: { type: "falling", strength: 1 },
    }],
  };
}

function alignmentFor(text) {
  const characters = Array.from(text);
  return {
    alignment: {
      characters,
      character_start_times_seconds: characters.map((_, index) => index * 0.01),
      character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.01),
    },
  };
}

test("prompt compiler compresses the control spec into minimal sufficient directions", () => {
  const spec = controlSpec();
  const prompt = compileElevenV3Prompt(spec);

  assert.match(prompt.text, /naturally continuous/);
  assert.match(prompt.text, /settling into one low contour/);
  assert.match(prompt.text, /面朝大海.*carry the emotional focus/);
  assert.doesNotMatch(prompt.text, /\[emphasized\]|\[short pause\]|\[drawn out\]|continue naturally/);
  assert.equal(prompt.text.match(/\[[^\]]+\]/g)?.length, 2);
  assert.equal(prompt.sourceTokens.length, spec.tokens.length);

  const promptCharacters = Array.from(prompt.text);
  for (const token of spec.tokens) {
    assert.equal(promptCharacters[prompt.sourceOffsets.get(token.index)], token.char);
  }
});

test("prompt compiler does not duplicate source newlines or pause signals", () => {
  const text = "从明天起\n做一个幸福的人";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const spec = {
    tokens,
    sentences: [
      {
        id: "sentence-1",
        rhythm: "relaxed",
        tokens: tokens.slice(0, 5),
        focus: [], pauses: [{ afterTokenIndex: 3, type: "short" }], prolongations: [], prosody: [],
        endingIntonation: { type: "falling" },
      },
      {
        id: "sentence-2",
        rhythm: "relaxed",
        tokens: tokens.slice(5),
        focus: [], pauses: [], prolongations: [{ tokenIndex: 7, degree: 2 }], prosody: [],
        endingIntonation: { type: "level" },
      },
    ],
  };
  const prompt = compileElevenV3Prompt(spec);

  assert.equal((prompt.text.match(/\n/g) ?? []).length, 1);
  assert.doesNotMatch(prompt.text, /\n\n|short pause|continue naturally/);
  assert.equal((prompt.text.match(/——/g) ?? []).length, 1);
  assert.ok((prompt.text.match(/\[[^\]]+\]/g) ?? []).length <= 3);
});

test("raw Eleven alignment maps every immutable token to a unique monotonic timestamp", () => {
  const spec = controlSpec();
  const prompt = compileElevenV3Prompt(spec);
  const timeline = buildElevenTimeline(spec, prompt, alignmentFor(prompt.text));

  assert.equal(timeline.tokens.length, spec.tokens.length);
  assert.deepEqual(timeline.tokens.map((token) => token.tokenIndex), spec.tokens.map((token) => token.index));
  assert.equal(new Set(timeline.tokens.map((token) => token.startMs)).size, timeline.tokens.length);
  assert.ok(timeline.tokens.every((token, index) => index === 0 || token.startMs >= timeline.tokens[index - 1].startMs));
  assert.equal(timeline.sentences[0].sentenceId, "sentence-1");
  assert.equal(timeline.sentences[0].endMs, timeline.durationMs);
});

test("normalized fallback aligns repeated source characters monotonically after tags are removed", () => {
  const spec = controlSpec("人人，人。");
  spec.sentences[0].focus = [];
  spec.sentences[0].pauses = [];
  spec.sentences[0].prolongations = [];
  spec.sentences[0].prosody = [];
  const prompt = compileElevenV3Prompt(spec);
  const characters = Array.from("人人，人。");
  const timeline = buildElevenTimeline(spec, prompt, {
    normalized_alignment: {
      characters,
      character_start_times_seconds: characters.map((_, index) => index * 0.1),
      character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.1),
    },
  });

  assert.deepEqual(timeline.tokens.slice(0, 2).map((token) => token.startMs), [0, 100]);
  assert.equal(timeline.tokens[3].startMs, 300);
});

test("timeline rejects an Eleven response that omits a spoken source token", () => {
  const spec = controlSpec("面朝大海");
  const prompt = compileElevenV3Prompt(spec);
  const characters = Array.from("面朝海");
  assert.throws(
    () => buildElevenTimeline(spec, prompt, {
      normalized_alignment: {
        characters,
        character_start_times_seconds: characters.map((_, index) => index * 0.1),
        character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.1),
      },
    }),
    /缺少正文 token/,
  );
});

test("sentence timeline provides contiguous seek boundaries for single-sentence playback", () => {
  const tokens = Array.from("甲。乙。").map((char, index) => ({ id: `token-${index}`, index, char }));
  const spec = {
    tokens,
    sentences: [
      {
        id: "sentence-1",
        rhythm: "solemn",
        tokens: tokens.slice(0, 2),
        focus: [], pauses: [], prolongations: [], prosody: [],
        endingIntonation: { type: "falling" },
      },
      {
        id: "sentence-2",
        rhythm: "light",
        tokens: tokens.slice(2),
        focus: [], pauses: [], prolongations: [], prosody: [],
        endingIntonation: { type: "level" },
      },
    ],
  };
  const prompt = compileElevenV3Prompt(spec);
  const timeline = buildElevenTimeline(spec, prompt, alignmentFor(prompt.text));

  assert.equal(timeline.sentences.length, 2);
  assert.equal(timeline.sentences[0].endMs, timeline.sentences[1].startMs);
  assert.equal(timeline.sentences[1].endMs, timeline.durationMs);
});
