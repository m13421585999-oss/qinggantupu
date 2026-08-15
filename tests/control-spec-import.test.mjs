import assert from "node:assert/strict";
import test from "node:test";

import { importControlSpec } from "../lib/control-spec-import.ts";

function compactBreathFixture(breaths, field = "breaths") {
  const sourceText = "我们。";
  return {
    sourceText,
    raw: {
      tokens: [
        {
          index: 0,
          char: "我",
          machine_pinyin: "wo3",
          display_pinyin: "wǒ",
          start_ms: 0,
          end_ms: 120,
        },
        {
          index: 1,
          char: "们",
          machine_pinyin: "men5",
          display_pinyin: "men",
          start_ms: 120,
          end_ms: 240,
        },
        { index: 2, char: "。", start_ms: 240, end_ms: 240 },
      ],
      sentences: [{
        text: sourceText,
        start_index: 0,
        end_index: 2,
        focus: [],
        pauses: [],
        prolongations: [],
        prosody: [],
        ending_intonation: { type: "level", strength: 1 },
        [field]: breaths,
      }],
    },
  };
}

test("control spec import normalizes major and minor creator breath markers", () => {
  const fixture = compactBreathFixture([
    {
      after_token_index: 0,
      mark: "V",
      source_control_ref: "compact/breath/major",
    },
    { afterTokenIndex: 1, mark: "v" },
  ], "breath_marks");
  const imported = importControlSpec(fixture.raw, fixture.sourceText, "work-breaths");

  assert.deepEqual(imported.sentences[0].breaths, [
    {
      id: "sentence-1-breath-0",
      sourceControlRef: "compact/breath/major",
      afterTokenId: "token-0",
      afterTokenIndex: 0,
      type: "breath_major",
      source: "human",
    },
    {
      id: "sentence-1-breath-1",
      sourceControlRef: undefined,
      afterTokenId: "token-1",
      afterTokenIndex: 1,
      type: "breath_minor",
      source: "human",
    },
  ]);
  assert.equal(imported.tokens.map((token) => token.char).join(""), fixture.sourceText);
});

test("control spec import rejects malformed breath marker boundaries and types", () => {
  const invalidIndex = compactBreathFixture([
    { afterTokenIndex: 99, type: "breath_major" },
  ]);
  assert.throws(
    () => importControlSpec(invalidIndex.raw, invalidIndex.sourceText, "work-breath-invalid-index"),
    /换气引用了无效 token index/,
  );

  const invalidType = compactBreathFixture([
    { afterTokenIndex: 0, type: "breath_medium" },
  ]);
  assert.throws(
    () => importControlSpec(invalidType.raw, invalidType.sourceText, "work-breath-invalid-type"),
    /不支持的换气类型/,
  );

  const invalidContainer = compactBreathFixture("V");
  assert.throws(
    () => importControlSpec(invalidContainer.raw, invalidContainer.sourceText, "work-breath-invalid-array"),
    /换气标识必须是数组/,
  );
});

test("control spec import preserves hidden performance profiles without changing source text", () => {
  const sourceText = "我。";
  const imported = importControlSpec({
    performance_profile: {
      source_control_ref: "current-spec/performance/global",
      delivery_mode: "lyrical_recitation",
      emotion_tone: ["温暖", "克制"],
      continuity: "connected",
      voice_quality: "slightly_breathy",
      focus_style: "soft",
      expression_amplitude: "medium",
      avoid: ["避免喊叫"],
    },
    timing_profile: {
      source: "acoustic",
      source_control_ref: "analysis.timing_profile",
      global_pace: {
        value: "slow",
        speaking_rate_chars_per_sec: 2.6,
        confidence: 0.96,
        source_control_ref: "analysis.timing_profile.global_pace",
      },
      pause_hierarchy: [{
        after_token_index: 0,
        level: "marked",
        observed_gap_ms: 360,
        relative_ratio: 1.3,
        confidence: 0.9,
        source_control_ref: "analysis.timing_profile.pause_hierarchy.0",
      }],
      phrase_duration_profile: [{
        start_index: 0,
        end_index: 0,
        speaking_rate_chars_per_sec: 2.6,
        relative_expansion: 1,
        expansion: "baseline",
        confidence: 0.96,
        source_control_ref: "analysis.timing_profile.phrase_duration_profile.0",
      }],
      prolongation_strength: [{
        token_index: 0,
        local_duration_ratio: 2.35,
        strength: "strong",
        phrase_expansion: "baseline",
        confidence: 0.94,
        source_control_ref: "analysis.timing_profile.prolongation_strength.0",
      }],
    },
    tokens: [
      {
        index: 0,
        char: "我",
        machine_pinyin: "wo3",
        display_pinyin: "wǒ",
        start_ms: 0,
        end_ms: 180,
      },
      { index: 1, char: "。", start_ms: 180, end_ms: 180 },
    ],
    sentences: [{
      text: sourceText,
      start_index: 0,
      end_index: 1,
      rhythm: { type: "relaxed" },
      performance_profile: {
        source_control_ref: "current-spec/performance/sentence-1",
        emotion_tone: ["思索"],
        continuity: "connected",
        voice_quality: "breathy_to_supported",
        focus_style: "breathy_to_supported",
        expression_amplitude: "low",
      },
      focus: [{
        source_control_ref: "current-spec/focus/1",
        focus_span: { start: 0, end: 0 },
        focus_core: { start: 0, end: 0 },
        focus_style: "breathy_to_supported",
        confidence: 0.9,
      }],
      pauses: [],
      prolongations: [{
        token_index: 0,
        degree: 3,
        duration_ms: 230,
        local_duration_ratio: 2.35,
        confidence: 0.94,
        source: "acoustic",
        source_control_ref: "analysis.acoustic_evidence.prolongations.token-0",
      }],
      macro_prosody_path: {
        source: "acoustic",
        points: [{ token_index: 0, macro_pitch_center: 0.3, normalized_level: 0.2 }],
        segments: [{
          start_index: 0,
          end_index: 0,
          type: "level",
          start_level: 0.2,
          end_level: 0.2,
        }],
      },
      prosody_point_overrides: [
        { token_index: 0, visual_level: 7, source: "human" },
        { token_index: 99, visual_level: 2, source: "human" },
      ],
      prosody: [],
      ending_intonation: { type: "level", strength: 1 },
      confidence: 0.8,
    }],
  }, sourceText, "work-test");

  assert.equal(imported.tokens.map((token) => token.char).join(""), sourceText);
  assert.equal(imported.performanceProfile?.voiceQuality, "slightly_breathy");
  assert.equal(imported.performanceProfile?.sourceControlRef, "current-spec/performance/global");
  assert.deepEqual(imported.performanceProfile?.emotionTone, ["温暖", "克制"]);
  assert.equal(imported.timingProfile?.globalPace.value, "slow");
  assert.equal(imported.timingProfile?.pauseHierarchy[0].afterTokenIndex, 0);
  assert.equal(imported.timingProfile?.prolongationStrength[0].strength, "strong");
  assert.equal(imported.sentences[0].performanceProfile?.focusStyle, "breathy_to_supported");
  assert.equal(imported.sentences[0].focus[0].sourceControlRef, "current-spec/focus/1");
  assert.deepEqual(imported.sentences[0].voiceQuality, {
    start: "breathy",
    transition: "breathy_to_supported",
    end: "solid",
  });
  assert.equal(imported.sentences[0].focus[0].preferredRealization, "combined");
  assert.equal(imported.sentences[0].macroProsodyPath?.points[0].macroPitchCenter, 0.3);
  assert.deepEqual(imported.sentences[0].prosodyPointOverrides, [
    { tokenIndex: 0, visualLevel: 7, source: "human" },
  ]);
  assert.deepEqual(imported.sentences[0].prolongations[0], {
    id: "sentence-1-prolong-1",
    sourceControlRef: "analysis.acoustic_evidence.prolongations.token-0",
    tokenId: "token-0",
    tokenIndex: 0,
    degree: 3,
    localDurationRatio: 2.35,
    confidence: 0.94,
    observedDurationMs: 230,
    source: "acoustic",
    purpose: undefined,
  });
});
