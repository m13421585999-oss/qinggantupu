import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTimingProfile,
  normalizeTimingProfile,
  withDynamicTimingProfile,
} from "../lib/timing-profile.ts";

function analysisPackage() {
  return {
    work: { full_text: "甲乙，丙丁。" },
    alignment_quality: { character_coverage: 0.97 },
    tokens: [
      { index: 0, char: "甲", start_ms: 0, end_ms: 300 },
      { index: 1, char: "乙", start_ms: 300, end_ms: 700 },
      { index: 2, char: "，", start_ms: 700, end_ms: 700 },
      { index: 3, char: "丙", start_ms: 1200, end_ms: 1500 },
      { index: 4, char: "丁", start_ms: 1500, end_ms: 2000 },
      { index: 5, char: "。", start_ms: 2000, end_ms: 2000 },
    ],
    segments: [{ id: "sentence-1", start_index: 0, end_index: 5 }],
    acoustic_evidence: {
      tokens: [
        { token_index: 0, silence_gap_after_ms: 0 },
        { token_index: 1, silence_gap_after_ms: 500 },
        { token_index: 3, silence_gap_after_ms: 0 },
        { token_index: 4, silence_gap_after_ms: 0 },
      ],
      pauses: [{ after_index: 1, gap_ms: 500 }],
      duration_outliers: [{
        token_index: 4,
        local_duration_ratio: 2.5,
        confidence: 0.95,
      }],
    },
  };
}

test("timing profile is derived only from the current acoustic timeline", () => {
  const timing = deriveTimingProfile(analysisPackage());

  assert.equal(timing?.source, "acoustic");
  assert.equal(timing?.globalPace.value, "slow");
  assert.equal(timing?.globalPace.speakingRateCharsPerSec, 2.5);
  assert.deepEqual(timing?.pauseHierarchy.map((pause) => ({
    after: pause.afterTokenIndex,
    level: pause.level,
    gap: pause.observedGapMs,
  })), [{ after: 1, level: "marked", gap: 500 }]);
  assert.equal(timing?.prolongationStrength[0].tokenIndex, 4);
  assert.equal(timing?.prolongationStrength[0].strength, "strong");
  assert.ok(timing?.phraseDurationProfile.every((phrase) =>
    phrase.sourceControlRef.startsWith("analysis.timing_profile.")));
});

test("stored snake-case timing profiles normalize without touching control tokens", () => {
  const timing = deriveTimingProfile(analysisPackage());
  const snakeCase = {
    source: timing.source,
    source_control_ref: timing.sourceControlRef,
    global_pace: {
      value: timing.globalPace.value,
      speaking_rate_chars_per_sec: timing.globalPace.speakingRateCharsPerSec,
      confidence: timing.globalPace.confidence,
      source_control_ref: timing.globalPace.sourceControlRef,
    },
    pause_hierarchy: timing.pauseHierarchy.map((pause) => ({
      after_token_index: pause.afterTokenIndex,
      level: pause.level,
      observed_gap_ms: pause.observedGapMs,
      relative_ratio: pause.relativeRatio,
      confidence: pause.confidence,
      source_control_ref: pause.sourceControlRef,
    })),
    phrase_duration_profile: timing.phraseDurationProfile.map((phrase) => ({
      start_index: phrase.startIndex,
      end_index: phrase.endIndex,
      speaking_rate_chars_per_sec: phrase.speakingRateCharsPerSec,
      relative_expansion: phrase.relativeExpansion,
      expansion: phrase.expansion,
      confidence: phrase.confidence,
      source_control_ref: phrase.sourceControlRef,
    })),
    prolongation_strength: timing.prolongationStrength.map((prolongation) => ({
      token_index: prolongation.tokenIndex,
      local_duration_ratio: prolongation.localDurationRatio,
      strength: prolongation.strength,
      phrase_expansion: prolongation.phraseExpansion,
      confidence: prolongation.confidence,
      source_control_ref: prolongation.sourceControlRef,
    })),
  };

  const normalized = normalizeTimingProfile(snakeCase);
  const spec = { tokens: [{ index: 0, char: "甲" }] };
  const enriched = withDynamicTimingProfile(spec, analysisPackage());

  assert.equal(normalized?.globalPace.value, "slow");
  assert.deepEqual(enriched.tokens, spec.tokens);
  assert.equal(enriched.timingProfile.globalPace.value, "slow");
});
