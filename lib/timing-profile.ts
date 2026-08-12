import type {
  GlobalPace,
  PhraseExpansion,
  ProlongationTimingStrength,
  TimingProfile,
} from "./recitation-schema";

type JsonObject = Record<string, unknown>;

const SPOKEN_CHARACTER = /[\p{L}\p{N}]/u;
const SEMANTIC_BOUNDARY = /[，、；：。！？,.!?;:\n\r]/u;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function quantile(values: number[], position: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const offset = (sorted.length - 1) * clamp(position, 0, 1);
  const lower = Math.floor(offset);
  const upper = Math.ceil(offset);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (offset - lower);
}

function weightedMedian(values: Array<{ value: number; weight: number }>) {
  const valid = values
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && item.weight > 0)
    .sort((left, right) => left.value - right.value);
  if (!valid.length) return 0;
  const total = valid.reduce((sum, item) => sum + item.weight, 0);
  let accumulated = 0;
  for (const item of valid) {
    accumulated += item.weight;
    if (accumulated >= total / 2) return item.value;
  }
  return valid.at(-1)!.value;
}

function paceForRate(rate: number): GlobalPace {
  // General Mandarin delivery bands; the value always comes from this work's
  // aligned phrase durations and is never selected by work title or wording.
  if (rate <= 2.8) return "slow";
  if (rate <= 3.6) return "moderately_slow";
  if (rate <= 4.8) return "medium";
  return "brisk";
}

function expansionForRatio(ratio: number): PhraseExpansion {
  if (ratio < 0.82) return "compressed";
  if (ratio < 1.18) return "baseline";
  if (ratio < 1.55) return "expanded";
  return "strongly_expanded";
}

interface SourceToken {
  index: number;
  char: string;
  startMs: number;
  endMs: number;
}

interface SegmentRange {
  id: string;
  startIndex: number;
  endIndex: number;
}

interface PhraseMeasurement {
  sentenceId?: string;
  startIndex: number;
  endIndex: number;
  spokenCount: number;
  speakingRateCharsPerSec: number;
}

function sourceTokens(analysis: JsonObject): SourceToken[] {
  return (Array.isArray(analysis.tokens) ? analysis.tokens : [])
    .map(object)
    .flatMap((token) => {
      const index = integer(token.index);
      const char = typeof token.char === "string" ? token.char : "";
      const startMs = finiteNumber(token.start_ms ?? token.startMs);
      const endMs = finiteNumber(token.end_ms ?? token.endMs);
      if (index === undefined || !char || startMs === undefined || endMs === undefined) return [];
      return [{ index, char, startMs, endMs }];
    })
    .sort((left, right) => left.index - right.index);
}

function segmentRanges(analysis: JsonObject, tokens: SourceToken[]): SegmentRange[] {
  const source = Array.isArray(analysis.segments)
    ? analysis.segments
    : Array.isArray(analysis.sentences) ? analysis.sentences : [];
  const parsed = source.map(object).flatMap((segment, position) => {
    const startIndex = integer(segment.start_index ?? segment.startIndex);
    const endIndex = integer(segment.end_index ?? segment.endIndex);
    if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) return [];
    return [{
      id: String(segment.id ?? `sentence-${position + 1}`),
      startIndex,
      endIndex,
    }];
  });
  if (parsed.length) return parsed;
  if (!tokens.length) return [];
  return [{ id: "sentence-1", startIndex: tokens[0].index, endIndex: tokens.at(-1)!.index }];
}

function acousticEvidence(analysis: JsonObject) {
  const acoustic = object(analysis.acoustic_evidence ?? analysis.acousticEvidence);
  const tokenEvidence = Array.isArray(acoustic.tokens)
    ? acoustic.tokens
    : Array.isArray(analysis.token_acoustics) ? analysis.token_acoustics : [];
  const pauses = Array.isArray(acoustic.pauses)
    ? acoustic.pauses
    : Array.isArray(analysis.pauses) ? analysis.pauses : [];
  const prolongations = Array.isArray(acoustic.prolongations)
    ? acoustic.prolongations
    : [];
  return { tokenEvidence, pauses, prolongations };
}

function analysisConfidence(analysis: JsonObject) {
  const quality = object(analysis.alignment_quality ?? analysis.alignmentQuality);
  const coverage = finiteNumber(
    quality.character_coverage
      ?? quality.characterCoverage
      ?? quality.coverage,
  );
  return clamp(coverage ?? 0.85, 0.45, 0.99);
}

function previousSpoken(tokens: SourceToken[], position: number) {
  for (let index = position - 1; index >= 0; index -= 1) {
    if (SPOKEN_CHARACTER.test(tokens[index].char)) return tokens[index].index;
  }
  return undefined;
}

function lastSpokenInRange(tokens: SourceToken[], start: number, end: number) {
  return tokens
    .filter((token) => token.index >= start && token.index <= end && SPOKEN_CHARACTER.test(token.char))
    .at(-1)?.index;
}

function phraseMeasurements(
  tokens: SourceToken[],
  segments: SegmentRange[],
  boundaryAfterIndexes: Set<number>,
): PhraseMeasurement[] {
  const byIndex = new Map(tokens.map((token) => [token.index, token]));
  const measurements: PhraseMeasurement[] = [];
  for (const segment of segments) {
    const spoken = tokens
      .filter((token) =>
        token.index >= segment.startIndex
        && token.index <= segment.endIndex
        && SPOKEN_CHARACTER.test(token.char))
      .map((token) => token.index);
    if (!spoken.length) continue;
    let phraseStart = 0;
    spoken.forEach((tokenIndex, position) => {
      if (!boundaryAfterIndexes.has(tokenIndex) && position !== spoken.length - 1) return;
      const phraseIndexes = spoken.slice(phraseStart, position + 1);
      phraseStart = position + 1;
      const first = byIndex.get(phraseIndexes[0]);
      const last = byIndex.get(phraseIndexes.at(-1)!);
      if (!first || !last) return;
      const elapsedSeconds = Math.max((last.endMs - first.startMs) / 1000, 0.001);
      measurements.push({
        sentenceId: segment.id,
        startIndex: first.index,
        endIndex: last.index,
        spokenCount: phraseIndexes.length,
        speakingRateCharsPerSec: phraseIndexes.length / elapsedSeconds,
      });
    });
  }
  return measurements;
}

export function deriveTimingProfile(analysisValue: unknown): TimingProfile | undefined {
  const analysis = object(analysisValue);
  const tokens = sourceTokens(analysis);
  if (!tokens.length) return undefined;
  const segments = segmentRanges(analysis, tokens);
  const evidence = acousticEvidence(analysis);
  const evidenceByIndex = new Map(
    evidence.tokenEvidence.map(object).flatMap((item) => {
      const index = integer(item.token_index ?? item.tokenIndex);
      return index === undefined ? [] : [[index, item] as const];
    }),
  );

  const pauseCandidates = new Map<number, {
    gapMs: number;
    sourceControlRef: string;
    levelHint?: "paragraph";
  }>();
  const addPause = (
    afterTokenIndex: number | undefined,
    gapMs: number | undefined,
    sourceRef: string,
    levelHint?: "paragraph",
  ) => {
    if (afterTokenIndex === undefined || gapMs === undefined || gapMs <= 0) return;
    const existing = pauseCandidates.get(afterTokenIndex);
    if (!existing || gapMs > existing.gapMs) {
      pauseCandidates.set(afterTokenIndex, {
        gapMs,
        sourceControlRef: sourceRef,
        levelHint: levelHint ?? existing?.levelHint,
      });
    } else if (levelHint) {
      existing.levelHint = levelHint;
    }
  };

  evidence.pauses.map(object).forEach((pause) => {
    const after = integer(pause.after_index ?? pause.afterTokenIndex);
    addPause(
      after,
      finiteNumber(pause.gap_ms ?? pause.observed_gap_ms ?? pause.observedGapMs),
      nonEmptyString(pause.source_control_ref ?? pause.sourceControlRef)
        ?? `analysis.acoustic_evidence.pauses.after-${after ?? "unknown"}`,
      String(pause.relative_level ?? pause.relativeLevel) === "long"
        ? "paragraph"
        : undefined,
    );
  });
  tokens.forEach((token, position) => {
    if (!SEMANTIC_BOUNDARY.test(token.char)) return;
    const after = previousSpoken(tokens, position);
    const acoustic = after === undefined ? {} : evidenceByIndex.get(after) ?? {};
    addPause(
      after,
      finiteNumber(acoustic.silence_gap_after_ms ?? acoustic.silenceGapAfterMs),
      `analysis.acoustic_evidence.tokens.${after ?? "unknown"}.silence_gap_after_ms`,
    );
  });
  segments.slice(0, -1).forEach((segment) => {
    const after = lastSpokenInRange(tokens, segment.startIndex, segment.endIndex);
    const acoustic = after === undefined ? {} : evidenceByIndex.get(after) ?? {};
    addPause(
      after,
      finiteNumber(acoustic.silence_gap_after_ms ?? acoustic.silenceGapAfterMs),
      `analysis.segments.${segment.id}.boundary_gap`,
    );
  });

  const boundaryAfterIndexes = new Set(pauseCandidates.keys());
  tokens.forEach((token, position) => {
    if (!SEMANTIC_BOUNDARY.test(token.char)) return;
    const after = previousSpoken(tokens, position);
    if (after !== undefined) boundaryAfterIndexes.add(after);
  });
  segments.forEach((segment) => {
    const after = lastSpokenInRange(tokens, segment.startIndex, segment.endIndex);
    if (after !== undefined) boundaryAfterIndexes.add(after);
  });

  const phrases = phraseMeasurements(tokens, segments, boundaryAfterIndexes);
  if (!phrases.length) return undefined;
  const globalRate = weightedMedian(phrases.map((phrase) => ({
    value: phrase.speakingRateCharsPerSec,
    weight: phrase.spokenCount,
  })));
  if (!globalRate) return undefined;
  const globalPace = paceForRate(globalRate);
  const confidence = analysisConfidence(analysis);
  const phraseDurationProfile = phrases.map((phrase, position) => {
    const relativeExpansion = globalRate / Math.max(phrase.speakingRateCharsPerSec, 0.001);
    return {
      sentenceId: phrase.sentenceId,
      startIndex: phrase.startIndex,
      endIndex: phrase.endIndex,
      speakingRateCharsPerSec: Number(phrase.speakingRateCharsPerSec.toFixed(3)),
      relativeExpansion: Number(relativeExpansion.toFixed(3)),
      expansion: expansionForRatio(relativeExpansion),
      confidence,
      sourceControlRef: `analysis.timing_profile.phrase_duration_profile.${position}`,
    };
  });

  const pauseValues = [...pauseCandidates.values()].map((entry) => entry.gapMs);
  const pauseMedian = quantile(pauseValues, 0.5) || 1;
  const markedFloor = quantile(pauseValues, 0.45);
  const paragraphFloor = quantile(pauseValues, 0.82);
  const pauseHierarchy = [...pauseCandidates.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([afterTokenIndex, entry]) => {
      const paragraph = entry.levelHint === "paragraph" || (
        pauseValues.length >= 3
        && entry.gapMs >= paragraphFloor
        && entry.gapMs >= pauseMedian * 1.18
      );
      const marked = entry.gapMs >= markedFloor;
      return {
        afterTokenIndex,
        level: paragraph ? "paragraph" as const : marked ? "marked" as const : "light" as const,
        observedGapMs: Math.round(entry.gapMs),
        relativeRatio: Number((entry.gapMs / pauseMedian).toFixed(3)),
        confidence,
        sourceControlRef: entry.sourceControlRef,
      };
    });

  const phraseForToken = (tokenIndex: number) => phraseDurationProfile.find((phrase) =>
    tokenIndex >= phrase.startIndex && tokenIndex <= phrase.endIndex);
  const prolongationStrength = evidence.prolongations.map(object).flatMap((entry) => {
    const tokenIndex = integer(entry.token_index ?? entry.tokenIndex);
    const localDurationRatio = finiteNumber(
      entry.effective_voiced_duration_ratio
      ?? entry.effectiveVoicedDurationRatio
      ?? entry.local_duration_ratio
      ?? entry.localDurationRatio,
    );
    if (tokenIndex === undefined || localDurationRatio === undefined || localDurationRatio <= 1) return [];
    const phrase = phraseForToken(tokenIndex);
    const phraseExpansion = phrase?.expansion ?? "baseline";
    const entryConfidence = clamp(
      finiteNumber(entry.confidence)
        ?? 0.58 + Math.max(0, localDurationRatio - 1.45) / 1.5,
      0.45,
      0.98,
    );
    const clearThreshold = 2.2;
    const strongThreshold = 2.8;
    const strength: ProlongationTimingStrength =
      localDurationRatio >= strongThreshold && entryConfidence >= 0.8
        ? "strong"
        : localDurationRatio >= clearThreshold && entryConfidence >= 0.65
          ? "clear"
          : "subtle";
    return [{
      tokenIndex,
      localDurationRatio: Number(localDurationRatio.toFixed(3)),
      strength,
      phraseExpansion,
      confidence: Number(entryConfidence.toFixed(3)),
      sourceControlRef: nonEmptyString(entry.source_control_ref ?? entry.sourceControlRef)
        ?? `analysis.acoustic_evidence.prolongations.token-${tokenIndex}`,
    }];
  });

  return {
    source: "acoustic",
    sourceControlRef: "analysis.timing_profile",
    globalPace: {
      value: globalPace,
      speakingRateCharsPerSec: Number(globalRate.toFixed(3)),
      confidence,
      sourceControlRef: "analysis.timing_profile.global_pace",
    },
    pauseHierarchy,
    phraseDurationProfile,
    prolongationStrength,
  };
}

export function normalizeTimingProfile(value: unknown): TimingProfile | undefined {
  const source = object(value);
  if (source.source !== "acoustic") return undefined;
  const global = object(source.globalPace ?? source.global_pace);
  const paceValue = String(global.value ?? "");
  if (!(["slow", "moderately_slow", "medium", "brisk"] as string[]).includes(paceValue)) {
    return undefined;
  }
  const rate = finiteNumber(global.speakingRateCharsPerSec ?? global.speaking_rate_chars_per_sec);
  if (rate === undefined || rate <= 0) return undefined;
  const confidence = clamp(finiteNumber(global.confidence) ?? 0.8, 0, 1);
  const sourceControlRef = nonEmptyString(source.sourceControlRef ?? source.source_control_ref)
    ?? "analysis.timing_profile";
  const globalSourceRef = nonEmptyString(global.sourceControlRef ?? global.source_control_ref)
    ?? `${sourceControlRef}.global_pace`;

  const pauseHierarchy = (Array.isArray(source.pauseHierarchy)
    ? source.pauseHierarchy
    : Array.isArray(source.pause_hierarchy) ? source.pause_hierarchy : [])
    .map(object)
    .flatMap((entry, position) => {
      const afterTokenIndex = integer(entry.afterTokenIndex ?? entry.after_token_index ?? entry.after_index);
      const level = String(entry.level ?? "");
      const observedGapMs = finiteNumber(entry.observedGapMs ?? entry.observed_gap_ms ?? entry.gap_ms);
      if (
        afterTokenIndex === undefined
        || observedGapMs === undefined
        || !(["light", "marked", "paragraph"] as string[]).includes(level)
      ) return [];
      return [{
        afterTokenIndex,
        level: level as TimingProfile["pauseHierarchy"][number]["level"],
        observedGapMs: Math.round(observedGapMs),
        relativeRatio: finiteNumber(entry.relativeRatio ?? entry.relative_ratio) ?? 1,
        confidence: clamp(finiteNumber(entry.confidence) ?? confidence, 0, 1),
        sourceControlRef: nonEmptyString(entry.sourceControlRef ?? entry.source_control_ref)
          ?? `${sourceControlRef}.pause_hierarchy.${position}`,
      }];
    });

  const phraseDurationProfile = (Array.isArray(source.phraseDurationProfile)
    ? source.phraseDurationProfile
    : Array.isArray(source.phrase_duration_profile) ? source.phrase_duration_profile : [])
    .map(object)
    .flatMap((entry, position) => {
      const startIndex = integer(entry.startIndex ?? entry.start_index);
      const endIndex = integer(entry.endIndex ?? entry.end_index);
      const phraseRate = finiteNumber(entry.speakingRateCharsPerSec ?? entry.speaking_rate_chars_per_sec);
      const expansion = String(entry.expansion ?? "");
      if (
        startIndex === undefined
        || endIndex === undefined
        || endIndex < startIndex
        || phraseRate === undefined
        || !(["compressed", "baseline", "expanded", "strongly_expanded"] as string[]).includes(expansion)
      ) return [];
      return [{
        sentenceId: nonEmptyString(entry.sentenceId ?? entry.sentence_id),
        startIndex,
        endIndex,
        speakingRateCharsPerSec: phraseRate,
        relativeExpansion: finiteNumber(entry.relativeExpansion ?? entry.relative_expansion) ?? 1,
        expansion: expansion as PhraseExpansion,
        confidence: clamp(finiteNumber(entry.confidence) ?? confidence, 0, 1),
        sourceControlRef: nonEmptyString(entry.sourceControlRef ?? entry.source_control_ref)
          ?? `${sourceControlRef}.phrase_duration_profile.${position}`,
      }];
    });

  const prolongationStrength = (Array.isArray(source.prolongationStrength)
    ? source.prolongationStrength
    : Array.isArray(source.prolongation_strength) ? source.prolongation_strength : [])
    .map(object)
    .flatMap((entry) => {
      const tokenIndex = integer(entry.tokenIndex ?? entry.token_index);
      const ratio = finiteNumber(entry.localDurationRatio ?? entry.local_duration_ratio);
      const strength = String(entry.strength ?? "");
      const phraseExpansion = String(entry.phraseExpansion ?? entry.phrase_expansion ?? "baseline");
      if (
        tokenIndex === undefined
        || ratio === undefined
        || !(["subtle", "clear", "strong"] as string[]).includes(strength)
        || !(["compressed", "baseline", "expanded", "strongly_expanded"] as string[]).includes(phraseExpansion)
      ) return [];
      return [{
        tokenIndex,
        localDurationRatio: ratio,
        strength: strength as ProlongationTimingStrength,
        phraseExpansion: phraseExpansion as PhraseExpansion,
        confidence: clamp(finiteNumber(entry.confidence) ?? confidence, 0, 1),
        sourceControlRef: nonEmptyString(entry.sourceControlRef ?? entry.source_control_ref)
          ?? `analysis.acoustic_evidence.prolongations.token-${tokenIndex}`,
      }];
    });

  return {
    source: "acoustic",
    sourceControlRef,
    globalPace: {
      value: paceValue as GlobalPace,
      speakingRateCharsPerSec: rate,
      confidence,
      sourceControlRef: globalSourceRef,
    },
    pauseHierarchy,
    phraseDurationProfile,
    prolongationStrength,
  };
}

export function withDynamicTimingProfile(
  controlSpecValue: unknown,
  analysisPackageValue?: unknown,
): JsonObject {
  const controlSpec = object(controlSpecValue);
  const derived = analysisPackageValue === undefined
    ? undefined
    : deriveTimingProfile(analysisPackageValue);
  const stored = normalizeTimingProfile(controlSpec.timingProfile ?? controlSpec.timing_profile);
  const timingProfile = derived ?? stored;
  return timingProfile ? { ...controlSpec, timingProfile } : controlSpec;
}
