import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildElevenTimeline,
  buildElevenV3Request,
  compileElevenV3Prompt,
  ELEVEN_V3_MINIMAL_AUDIO_TAGS,
  ELEVEN_V3_PROSODY_MOTION_DIRECTIONS,
} from "../lib/eleven-tts.ts";

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
      rhythm: {
        type: "relaxed",
        source_control_ref: "current-control-spec/rhythm/relaxed",
      },
      tokens,
      focus: [{ tokenIndexes: [0, 1, 2, 3], level: "primary" }],
      pauses: [{ afterTokenIndex: 3, type: "short" }],
      prolongations: [{ tokenIndex: 8, degree: 1 }],
      prosody: [{
        type: "valley",
        activeSpan: { start: 0, end: 8 },
        coreZone: { start: 2, end: 7 },
        strength: 2,
        source_control_ref: "current-control-spec/prosody/valley",
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

function stripAudioTags(text) {
  return text
    .replace(/^\[[^\]]+\]\n/u, "")
    .replace(/\s*\[[^\]]+\]\s*/gu, "");
}

test("Eleven with-timestamps request explicitly selects v3 and Natural stability", () => {
  const request = buildElevenV3Request("面朝大海，春暖花开。");

  assert.equal(request.model_id, "eleven_v3");
  assert.equal(request.language_code, "zh");
  assert.equal(request.voice_settings.stability, 0.5);
  assert.deepEqual(Object.keys(request.voice_settings), ["stability"]);
  assert.equal(request.text, "面朝大海，春暖花开。");
  assert.doesNotMatch(JSON.stringify(request), /api.?key|xi-api-key/i);
});

test("prompt compiler keeps medium-density phrase motion without splitting the sentence", () => {
  const spec = controlSpec();
  const prompt = compileElevenV3Prompt(spec);

  assert.equal(prompt.text, "[softly]\n面朝大海， [building] 春暖花开。");
  assert.doesNotMatch(
    prompt.text,
    /carry the emotional focus|continue naturally|control_spec|tts_execution_plan|source_control_refs/u,
  );
  assert.equal(prompt.text.match(/\[[^\]]+\]/g)?.length, 2);
  assert.equal(stripAudioTags(prompt.text), "面朝大海，春暖花开。");
  assert.doesNotMatch(prompt.text, /\n\n/u);
  assert.equal(prompt.sourceTokens.length, spec.tokens.length);
  assert.equal(prompt.executionPlan.validation.state, "valid");
  assert.ok(prompt.executionPlan.controls.every((control) => control.sourceControlRefs.length > 0));
  assert.deepEqual(
    prompt.executionPlan.controls.map((control) => control.kind),
    ["audio_tag", "audio_tag"],
  );

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
  const spokenBody = prompt.text.replace(/^\[[^\]]+\]\n/u, "");

  assert.equal((spokenBody.match(/\n/g) ?? []).length, 1);
  assert.doesNotMatch(spokenBody, /\n\n|short pause|continue naturally/);
  assert.equal((prompt.text.match(/——/g) ?? []).length, 0);
  assert.ok((prompt.text.match(/\[[^\]]+\]/g) ?? []).length <= 3);
  const prolongation = prompt.executionPlan.controls.find((control) => control.kind === "prolongation");
  assert.equal(prolongation, undefined);
  const promptWithoutInsertedTags = prompt.text.replace(/ ?\[[^\]\r\n]+\] ?/gu, "");
  assert.equal(promptWithoutInsertedTags, text);
});

test("only one strong high-confidence prolongation becomes a standard dash", () => {
  const text = "甲乙丙丁戊";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-prolongation",
      tokens,
      focus: [], pauses: [], prosody: [],
      prolongations: [
        { tokenIndex: 0, degree: 2, confidence: 0.99, local_duration_ratio: 2.5 },
        { tokenIndex: 1, degree: 3, confidence: 0.7, local_duration_ratio: 2.4 },
        { tokenIndex: 2, degree: 3, confidence: 0.95, local_duration_ratio: 1.8 },
        {
          tokenIndex: 3,
          degree: 3,
          confidence: 0.95,
          local_duration_ratio: 2.4,
          source: "acoustic",
          source_control_ref: "current-control-spec/prolongation/strong",
        },
      ],
    }],
  });
  const prolongations = prompt.executionPlan.controls.filter(
    (control) => control.kind === "prolongation",
  );

  assert.equal(prompt.text, "甲乙丙丁——戊");
  assert.equal(prolongations.length, 1);
  assert.equal(prolongations[0].tokenIndex, 3);
  assert.equal(prolongations[0].emittedText, "——");
  assert.deepEqual(prolongations[0].sourceControlRefs, [
    "current-control-spec/prolongation/strong",
  ]);
  assert.deepEqual(prolongations[0].evidence, {
    source: "acoustic",
    localDurationRatio: 2.4,
    confidence: 0.95,
  });
});

test("hidden performance profiles only select short whitelisted state cues", () => {
  const text = "第一句。第二句。第三句。第四句。第五句。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const sentenceTokens = Array.from({ length: 5 }, (_, position) => tokens.slice(position * 4, position * 4 + 4));
  const spec = {
    performance_profile: {
      source_control_ref: "current-control-spec/profile/global",
      delivery_mode: "lyrical_recitation",
      emotion_tone: ["安静"],
      continuity: "connected",
      voice_quality: "slightly_breathy",
      focus_style: "soft",
      expression_amplitude: "low",
      avoid: ["不要喊叫"],
    },
    tokens,
    sentences: sentenceTokens.map((items, position) => ({
      id: `sentence-${position + 1}`,
      rhythm: "relaxed",
      tokens: items,
      performance_profile: position === 2 ? {
        source_control_ref: "current-control-spec/profile/sentence-3",
        emotion_tone: ["克制"],
        voice_quality: "solid",
        focus_style: "supported",
      } : undefined,
      focus: [],
      pauses: [],
      prolongations: [],
      prosody: [],
      endingIntonation: { type: "level", strength: 1 },
    })),
  };

  const prompt = compileElevenV3Prompt(spec);
  const tags = [...prompt.text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);

  assert.equal(tags[0], "slightly breathy");
  assert.ok(tags.includes("focused"));
  assert.ok(tags.length <= 1 + spec.sentences.length);
  assert.ok(tags.every((tag) => ELEVEN_V3_MINIMAL_AUDIO_TAGS.includes(tag)));
  assert.ok(tags.every((tag) => !/[\p{Script=Han},;，；]/u.test(tag) && tag.length <= 20));
  assert.doesNotMatch(prompt.text, /\]\s*\n\s*\[/u);
  assert.equal(stripAudioTags(prompt.text), text);
  assert.equal((prompt.text.match(/\n/g) ?? []).length, 1);
  assert.ok(prompt.executionPlan.controls.every((control) => control.sourceControlRefs.length > 0));
});

test("a new work with no control intent receives no invented TTS control", () => {
  const text = "任意新文稿保持原样。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-new",
      tokens,
      focus: [],
      pauses: [],
      prolongations: [],
      prosody: [],
    }],
  });

  assert.equal(prompt.text, text);
  assert.deepEqual(prompt.executionPlan.controls, []);
  assert.equal(prompt.executionPlan.validation.checks.length, 10);
});

test("fields without an explicit current control spec source never invent cues", () => {
  const text = "无来源时保持原文。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    performance_profile: {
      delivery_mode: "lyrical_recitation",
      emotion_tone: ["温柔"],
      voice_quality: "slightly_breathy",
    },
    tokens,
    sentences: [{
      id: "sentence-untraced",
      rhythm: "relaxed",
      tokens,
      performance_profile: {
        emotion_tone: ["明亮"],
      },
      focus: [{
        tokenIndexes: [0, 1],
        level: "primary",
        preferred_realization: "supported",
      }],
      pauses: [],
      prolongations: [],
      prosody: [{
        type: "peak",
        active_span: { start: 0, end: 7 },
        core_zone: { start: 2, end: 5 },
        strength: 3,
        confidence: 1,
      }],
    }],
  });

  assert.equal(prompt.text, text);
  assert.deepEqual(prompt.executionPlan.controls, []);
});

test("every generic special control preserves its current control spec reference", () => {
  const text = "风起云涌灯火渐明";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-dynamic",
      tokens,
      focus: [],
      pauses: [{
        afterTokenIndex: 4,
        type: "short",
        source_control_ref: "current-control-spec/pause/p1",
      }],
      prolongations: [{
        tokenIndex: 2,
        degree: 3,
        source: "acoustic",
        confidence: 0.95,
        local_duration_ratio: 2.4,
        source_control_ref: "current-control-spec/prolongation/p1",
      }],
      prosody: [{
        type: "rising",
        activeSpan: { start: 0, end: 7 },
        coreZone: { start: 3, end: 6 },
        strength: 3,
        confidence: 1,
        source_control_ref: "current-control-spec/prosody/p1",
      }],
    }],
  });

  assert.equal(prompt.text, "[building] 风起云——涌灯，火渐明");
  assert.deepEqual(
    prompt.executionPlan.controls.map((control) => ({
      kind: control.kind,
      refs: control.sourceControlRefs,
    })),
    [
      { kind: "audio_tag", refs: ["current-control-spec/prosody/p1"] },
      { kind: "prolongation", refs: ["current-control-spec/prolongation/p1"] },
      { kind: "pause", refs: ["current-control-spec/pause/p1"] },
    ],
  );
});

test("prosody motion follows ordered phrase boundaries instead of a fixed template", () => {
  const text = "甲乙丙，丁戊己";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-contour",
      tokens,
      focus: [], pauses: [], prolongations: [],
      prosody: [
        {
          type: "falling",
          active_span: { start: 0, end: 2 },
          core_zone: { start: 1, end: 2 },
          strength: 2,
          confidence: 0.9,
          source_control_ref: "current-control-spec/prosody/falling",
        },
        {
          type: "rising",
          active_span: { start: 4, end: 6 },
          core_zone: { start: 5, end: 6 },
          strength: 2,
          confidence: 0.9,
          source_control_ref: "current-control-spec/prosody/rising",
        },
      ],
    }],
  });

  assert.equal(prompt.text, "[settling] 甲乙丙， [building] 丁戊己");
  assert.deepEqual(
    prompt.executionPlan.controls.map((control) => control.sourceControlRefs),
    [
      ["current-control-spec/prosody/falling"],
      ["current-control-spec/prosody/rising"],
    ],
  );
  assert.equal(stripAudioTags(prompt.text), text);
});

test("peak and valley compile in the correct direction at semantic phrase boundaries", () => {
  assert.deepEqual(ELEVEN_V3_PROSODY_MOTION_DIRECTIONS, {
    rising: { entry: "building" },
    falling: { entry: ["softening", "settling"] },
    peak: { entry: "building", exit: "settling" },
    valley: { entry: "softening", exit: "building" },
  });
  const text = "远山渐高，云开日出，余音渐远。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-motion",
      tokens,
      focus: [], pauses: [], prolongations: [],
      prosody: [{
        type: "peak",
        active_span: { start: 0, end: 13 },
        core_zone: { start: 4, end: 8 },
        strength: 3,
        confidence: 0.95,
        source_control_ref: "current-control-spec/prosody/peak",
      }],
    }],
  });
  const motionControls = prompt.executionPlan.controls.filter(
    (control) => control.kind === "audio_tag" && control.scope === "local",
  );

  assert.equal(motionControls.length, 2);
  assert.deepEqual(motionControls.map((control) => control.emittedText), ["[building]", "[settling]"]);
  assert.deepEqual(motionControls.map((control) => control.tokenIndex), [0, 10]);
  assert.doesNotMatch(prompt.text, /\n\n/u);
  assert.equal(stripAudioTags(prompt.text), text);

  const valleyPrompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-valley",
      tokens,
      focus: [], pauses: [], prolongations: [],
      prosody: [{
        type: "valley",
        active_span: { start: 0, end: 13 },
        core_zone: { start: 4, end: 8 },
        strength: 3,
        confidence: 0.95,
        source_control_ref: "current-control-spec/prosody/valley",
      }],
    }],
  });
  const valleyControls = valleyPrompt.executionPlan.controls.filter(
    (control) => control.kind === "audio_tag" && control.scope === "local",
  );
  assert.deepEqual(
    valleyControls.map((control) => control.emittedText),
    ["[softening]", "[building]"],
  );
  assert.deepEqual(valleyControls.map((control) => control.tokenIndex), [0, 10]);
});

test("a motion cue identical to the active delivery state is emitted only once", () => {
  const text = "山河渐明。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    performance_profile: {
      voice_quality: "breathy_to_supported",
      source_control_ref: "current-control-spec/profile",
    },
    tokens,
    sentences: [{
      id: "sentence-deduplicate",
      tokens,
      focus: [], pauses: [], prolongations: [],
      prosody: [{
        type: "rising",
        active_span: { start: 0, end: 3 },
        core_zone: { start: 2, end: 3 },
        strength: 2,
        confidence: 0.9,
        source_control_ref: "current-control-spec/prosody/rising",
      }],
    }],
  });
  const tags = prompt.executionPlan.controls.filter((control) => control.kind === "audio_tag");

  assert.equal(prompt.text, "[building]\n山河渐明。");
  assert.equal(tags.length, 1);
  assert.deepEqual(tags[0].sourceControlRefs, [
    "current-control-spec/profile",
    "current-control-spec/prosody/rising",
  ]);
});

test("conflicting delivery and motion cues merge into one cue at the same boundary", () => {
  const text = "山河渐明。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [{
      id: "sentence-conflict",
      performance_profile: {
        emotion_tone: ["温暖"],
        source_control_ref: "current-control-spec/profile/gentle",
      },
      tokens,
      focus: [], pauses: [], prolongations: [],
      prosody: [{
        type: "rising",
        active_span: { start: 0, end: 3 },
        core_zone: { start: 2, end: 3 },
        strength: 3,
        confidence: 1,
        source_control_ref: "current-control-spec/prosody/building",
      }],
    }],
  });
  const tags = prompt.executionPlan.controls.filter((control) => control.kind === "audio_tag");

  assert.equal(prompt.text, "[building] 山河渐明。");
  assert.equal(tags.length, 1);
  assert.deepEqual(tags[0].sourceControlRefs, [
    "current-control-spec/prosody/building",
    "current-control-spec/profile/gentle",
  ]);
});

test("sentence cues never replace source punctuation with a newline", () => {
  const text = "从明天起，做一个幸福的人。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [
      {
        id: "sentence-clause-1",
        tokens: tokens.slice(0, 5),
        focus: [], pauses: [], prolongations: [], prosody: [],
      },
      {
        id: "sentence-clause-2",
        performance_profile: {
          emotion_tone: ["明亮"],
          source_control_ref: "current-control-spec/profile/bright",
        },
        tokens: tokens.slice(5),
        focus: [], pauses: [], prolongations: [], prosody: [],
      },
    ],
  });

  assert.equal(prompt.text, "从明天起， [brightly] 做一个幸福的人。");
  assert.equal(stripAudioTags(prompt.text), text);
  assert.doesNotMatch(prompt.text, /，\s*\n/u);
});

test("audio tags preserve every original punctuation mark, source line break, and sentence boundary", () => {
  const text = "从明天起，做一个幸福的人。\n风起时，云仍在走！";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const firstClauseEnd = text.indexOf("，") + 1;
  const firstSentenceEnd = text.indexOf("。") + 1;
  const prompt = compileElevenV3Prompt({
    tokens,
    sentences: [
      {
        id: "sentence-clause-a",
        tokens: tokens.slice(0, firstClauseEnd),
        focus: [], pauses: [], prolongations: [], prosody: [],
      },
      {
        id: "sentence-clause-b",
        tokens: tokens.slice(firstClauseEnd, firstSentenceEnd),
        performance_profile: {
          emotion_tone: ["明亮"],
          source_control_ref: "current-control-spec/profile/clause-b",
        },
        focus: [], pauses: [], prolongations: [], prosody: [],
      },
      {
        id: "sentence-source-line-2",
        tokens: tokens.slice(firstSentenceEnd),
        focus: [], pauses: [], prolongations: [],
        prosody: [{
          type: "rising",
          active_span: { start: firstSentenceEnd + 1, end: tokens.length - 2 },
          core_zone: { start: firstSentenceEnd + 4, end: tokens.length - 3 },
          strength: 2,
          confidence: 0.9,
          source_control_ref: "current-control-spec/prosody/source-line-2",
        }],
      },
    ],
  });

  const promptWithoutInsertedTags = prompt.text.replace(/ ?\[[^\]\r\n]+\] ?/gu, "");
  assert.equal(promptWithoutInsertedTags, text);
  assert.equal((prompt.text.match(/\n/g) ?? []).length, (text.match(/\n/g) ?? []).length);
  for (const token of tokens.filter((token) => /[\p{P}\r\n]/u.test(token.char))) {
    assert.equal(Array.from(prompt.text)[prompt.sourceOffsets.get(token.index)], token.char);
  }
  assert.ok(prompt.executionPlan.validation.checks.some(
    (check) => check.code === "source_structure_preserved",
  ));
  assert.ok(prompt.executionPlan.validation.checks.some(
    (check) => check.code === "audio_tags_are_insertions_only",
  ));
});

test("dynamic timing keeps a global pace cue and prioritizes expanded phrase timing", () => {
  const text = "甲乙丙，丁戊己。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    timing_profile: {
      source: "acoustic",
      source_control_ref: "analysis.timing_profile",
      global_pace: {
        value: "medium",
        speaking_rate_chars_per_sec: 4.1,
        confidence: 0.94,
        source_control_ref: "analysis.timing_profile.global_pace",
      },
      pause_hierarchy: [{
        after_token_index: 5,
        level: "marked",
        observed_gap_ms: 420,
        relative_ratio: 1.45,
        confidence: 0.9,
        source_control_ref: "analysis.timing_profile.pause_hierarchy.0",
      }],
      phrase_duration_profile: [{
        start_index: 4,
        end_index: 6,
        speaking_rate_chars_per_sec: 2.2,
        relative_expansion: 1.86,
        expansion: "strongly_expanded",
        confidence: 0.92,
        source_control_ref: "analysis.timing_profile.phrase_duration_profile.1",
      }],
      prolongation_strength: [{
        token_index: 5,
        local_duration_ratio: 2.4,
        strength: "clear",
        phrase_expansion: "strongly_expanded",
        confidence: 0.94,
        source_control_ref: "analysis.timing_profile.prolongation_strength.0",
      }],
    },
    tokens,
    sentences: [{
      id: "sentence-timing",
      tokens,
      focus: [],
      pauses: [{
        afterTokenIndex: 5,
        type: "short",
        source_control_ref: "current-control-spec/pause/1",
      }],
      prolongations: [{
        tokenIndex: 5,
        degree: 3,
        source: "acoustic",
        local_duration_ratio: 2.4,
        confidence: 0.94,
        source_control_ref: "current-control-spec/prolongation/1",
      }],
      prosody: [{
        type: "rising",
        activeSpan: { start: 4, end: 6 },
        coreZone: { start: 5, end: 6 },
        strength: 3,
        confidence: 0.95,
        source_control_ref: "current-control-spec/prosody/1",
      }],
    }],
  });

  assert.equal(prompt.text, "[steady]\n甲乙丙， [slowly] 丁戊，己。");
  assert.doesNotMatch(prompt.text, /——/u);
  assert.equal(prompt.executionPlan.timingProfile?.source, "acoustic");
  const pace = prompt.executionPlan.controls[0];
  assert.equal(pace.emittedText, "[steady]");
  assert.equal(pace.evidence?.globalPace, "medium");
  const phraseCue = prompt.executionPlan.controls.find((control) =>
    control.evidence?.phraseExpansion === "strongly_expanded");
  assert.equal(phraseCue?.emittedText, "[slowly]");
  const pause = prompt.executionPlan.controls.find((control) => control.kind === "pause");
  assert.equal(pause?.evidence?.pauseLevel, "marked");
});

test("only dynamically strong prolongation survives the timing profile", () => {
  const text = "甲乙丙。";
  const tokens = Array.from(text).map((char, index) => ({ id: `token-${index}`, index, char }));
  const prompt = compileElevenV3Prompt({
    timingProfile: {
      source: "acoustic",
      sourceControlRef: "analysis.timing_profile",
      globalPace: {
        value: "moderately_slow",
        speakingRateCharsPerSec: 3.2,
        confidence: 0.95,
        sourceControlRef: "analysis.timing_profile.global_pace",
      },
      pauseHierarchy: [],
      phraseDurationProfile: [],
      prolongationStrength: [{
        tokenIndex: 1,
        localDurationRatio: 2.45,
        strength: "strong",
        phraseExpansion: "baseline",
        confidence: 0.9,
        sourceControlRef: "analysis.timing_profile.prolongation_strength.0",
      }],
    },
    tokens,
    sentences: [{
      id: "sentence-strong-prolongation",
      tokens,
      focus: [], pauses: [], prosody: [],
      prolongations: [{
        tokenIndex: 1,
        degree: 3,
        source: "acoustic",
        localDurationRatio: 2.45,
        confidence: 0.9,
        source_control_ref: "current-control-spec/prolongation/1",
      }],
    }],
  });

  assert.equal(prompt.text, "[unhurried]\n甲乙——丙。");
  const prolongation = prompt.executionPlan.controls.find((control) =>
    control.kind === "prolongation");
  assert.equal(prolongation?.evidence?.timingStrength, "strong");
  assert.deepEqual(prolongation?.sourceControlRefs, [
    "current-control-spec/prolongation/1",
    "analysis.timing_profile.prolongation_strength.0",
  ]);
});

test("golden sample wording is absent from runtime compiler and general rules", () => {
  const runtime = [
    readFileSync(new URL("../lib/eleven-tts.ts", import.meta.url), "utf8"),
    readFileSync(
      new URL("../analysis-service/app/rules/recitation_expression_v1.md", import.meta.url),
      "utf8",
    ),
  ].join("\n");

  for (const phrase of ["面朝大海", "春暖花开", "从明天起", "周游世界", "粮食和蔬菜"]) {
    assert.doesNotMatch(runtime, new RegExp(phrase, "u"));
  }
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
