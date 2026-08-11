import assert from "node:assert/strict";
import test from "node:test";

import { importControlSpec } from "../lib/control-spec-import.ts";

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
        source_control_ref: "analysis.acoustic_evidence.duration_outliers.token-0",
      }],
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
  assert.deepEqual(imported.sentences[0].prolongations[0], {
    id: "sentence-1-prolong-1",
    sourceControlRef: "analysis.acoustic_evidence.duration_outliers.token-0",
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
