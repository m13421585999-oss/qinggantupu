type JsonObject = Record<string, unknown>;

export const ELEVEN_V3_MODEL_ID = "eleven_v3" as const;
export const ELEVEN_V3_NATURAL_STABILITY = 0.5 as const;

export interface ElevenV3RequestBody {
  text: string;
  model_id: typeof ELEVEN_V3_MODEL_ID;
  language_code: "zh";
  voice_settings: {
    stability: typeof ELEVEN_V3_NATURAL_STABILITY;
  };
}

/**
 * Build the exact request body sent to ElevenLabs. Eleven v3 uses the Natural
 * stability preset (0.5); v3-unsupported similarity/speed controls are omitted.
 */
export function buildElevenV3Request(text: string): ElevenV3RequestBody {
  return {
    text,
    model_id: ELEVEN_V3_MODEL_ID,
    language_code: "zh",
    voice_settings: { stability: ELEVEN_V3_NATURAL_STABILITY },
  };
}

export interface CompiledTtsPrompt {
  text: string;
  sourceOffsets: Map<number, number>;
  sourceTokens: Array<{ id: string; index: number; char: string }>;
  sentenceTokenIndexes: Array<{ sentenceId: string; tokenIndexes: number[] }>;
  executionPlan: TtsExecutionPlan;
}

export interface PromptControlTrace {
  id: string;
  kind: "audio_tag" | "prolongation" | "pause";
  scope: "global" | "sentence" | "local";
  emittedText: string;
  sentenceId?: string;
  tokenIndex?: number;
  sourceControlRefs: string[];
  evidence?: {
    source: "acoustic";
    localDurationRatio?: number;
    timingStrength?: "subtle" | "clear" | "strong";
    phraseExpansion?: "compressed" | "baseline" | "expanded" | "strongly_expanded";
    speakingRateCharsPerSec?: number;
    globalPace?: "slow" | "moderately_slow" | "medium" | "brisk";
    pauseLevel?: "light" | "marked" | "paragraph";
    observedGapMs?: number;
    relativeRatio?: number;
    confidence: number;
  };
}

export interface PromptValidationCheck {
  code:
    | "source_complete_once"
    | "source_structure_preserved"
    | "audio_tags_are_insertions_only"
    | "tags_are_short_english_cues"
    | "all_special_controls_traced"
    | "sentence_tag_budget"
    | "no_duplicate_tags"
    | "no_duplicate_pause_signals"
    | "prolongations_have_acoustic_evidence"
    | "global_pace_preserved";
  passed: true;
}

export interface TtsExecutionPlan {
  controls: PromptControlTrace[];
  timingProfile?: JsonObject;
  validation: {
    state: "valid";
    checks: PromptValidationCheck[];
  };
}

export interface TtsTimeline {
  granularity: "character";
  durationMs: number;
  tokens: Array<{
    tokenId: string;
    tokenIndex: number;
    startMs: number;
    endMs: number;
    confidence: number;
  }>;
  sentences: Array<{
    sentenceId: string;
    startMs: number;
    endMs: number;
  }>;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function rhythmKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const rhythm = object(value);
  const label = rhythm.type ?? rhythm.label;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

type MinimalCue =
  | "slowly"
  | "unhurried"
  | "steady"
  | "briskly"
  | "calm"
  | "softly"
  | "brightly"
  | "solemnly"
  | "restrained"
  | "firmly"
  | "focused"
  | "resonant"
  | "quietly"
  | "gentle"
  | "thoughtful"
  | "building"
  | "settling"
  | "softening"
  | "slightly breathy"
  | "short pause"
  | "long pause";

export const ELEVEN_V3_MINIMAL_AUDIO_TAGS: readonly MinimalCue[] = [
  "slowly",
  "unhurried",
  "steady",
  "briskly",
  "calm",
  "softly",
  "brightly",
  "solemnly",
  "restrained",
  "firmly",
  "focused",
  "resonant",
  "quietly",
  "gentle",
  "thoughtful",
  "building",
  "settling",
  "softening",
  "slightly breathy",
  "short pause",
  "long pause",
] as const;

const GLOBAL_PACE_CUES: Record<string, MinimalCue> = {
  slow: "slowly",
  moderately_slow: "unhurried",
  medium: "steady",
  brisk: "briskly",
};

export const ELEVEN_V3_PROSODY_MOTION_DIRECTIONS = {
  rising: { entry: "building" },
  falling: { entry: ["softening", "settling"] },
  peak: { entry: "building", exit: "settling" },
  valley: { entry: "softening", exit: "building" },
} as const;

const GLOBAL_RHYTHM_CUES: Record<string, MinimalCue> = {
  light: "brightly",
  solemn: "solemnly",
  relaxed: "calm",
  tense: "firmly",
  soaring: "resonant",
  low: "quietly",
};

const SENTENCE_RHYTHM_CUES: Record<string, MinimalCue> = {
  light: "brightly",
  solemn: "solemnly",
  relaxed: "calm",
  tense: "firmly",
  soaring: "resonant",
  low: "quietly",
};

const FOCUS_REALIZATION_CUES: Record<string, MinimalCue> = {
  stronger: "firmly",
  supported: "firmly",
  soft_emphasis: "gentle",
  soft: "gentle",
  slower: "thoughtful",
  lower_weighted: "restrained",
  breathy: "slightly breathy",
  breathy_to_supported: "building",
  voice_shift: "thoughtful",
  combined: "firmly",
};

const VOICE_QUALITY_CUES: Record<string, MinimalCue | undefined> = {
  neutral: undefined,
  solid: "firmly",
  slightly_breathy: "slightly breathy",
  breathy: "slightly breathy",
  mixed: "gentle",
  breathy_to_supported: "building",
  breathy_to_mixed: "gentle",
  mixed_to_solid: "building",
  solid_to_soft: "settling",
};

const DELIVERY_MODE_CUES: Record<string, MinimalCue> = {
  natural_narration: "calm",
  lyrical_recitation: "softly",
  stage_recitation: "resonant",
};

const EXPRESSION_AMPLITUDE_CUES: Record<string, MinimalCue | undefined> = {
  low: "restrained",
  medium: undefined,
  high: "resonant",
};

const EMOTION_CUE_RULES: Array<{ pattern: RegExp; cue: MinimalCue }> = [
  { pattern: /克制|含蓄|restrain|reserved/u, cue: "restrained" },
  { pattern: /沉思|思索|内省|thoughtful|contemplative|reflective/u, cue: "thoughtful" },
  { pattern: /庄重|凝重|肃穆|solemn/u, cue: "solemnly" },
  { pattern: /温暖|温柔|亲切|warm|tender|gentle/u, cue: "gentle" },
  { pattern: /轻柔|柔和|soft|delicate/u, cue: "softly" },
  { pattern: /明亮|喜悦|欢快|bright|joy|cheerful/u, cue: "brightly" },
  { pattern: /平静|从容|calm|composed/u, cue: "calm" },
  { pattern: /紧张|专注|坚定|focused|tense|firm/u, cue: "firmly" },
  { pattern: /开阔|高亢|昂扬|resonant|soaring|expansive/u, cue: "resonant" },
  { pattern: /安静|低沉|静谧|quiet|low/u, cue: "quietly" },
];

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function profile(value: unknown) {
  const source = object(value);
  return object(source.performanceProfile ?? source.performance_profile);
}

function timingProfile(value: unknown) {
  const source = object(value);
  return object(source.timingProfile ?? source.timing_profile);
}

function stringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function explicitSourceControlRefs(value: unknown): string[] {
  const entry = object(value);
  return [...new Set(stringArray(
    entry.sourceControlRefs
      ?? entry.source_control_refs
      ?? entry.sourceControlRef
      ?? entry.source_control_ref,
  ))];
}

function cueSourceControlRefs(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(explicitSourceControlRefs))];
}

function sourceControlRefs(value: unknown, fallback: string): string[] {
  const explicit = explicitSourceControlRefs(value);
  return explicit.length ? explicit : [fallback];
}

function cueForEmotion(value: string) {
  return EMOTION_CUE_RULES.find((rule) => rule.pattern.test(value.toLowerCase()))?.cue;
}

interface CueEvidence {
  score: number;
  refs: Set<string>;
}

interface CueDecision {
  cue: MinimalCue;
  score: number;
  sourceControlRefs: string[];
  evidence?: PromptControlTrace["evidence"];
}

function globalPaceCue(spec: JsonObject): CueDecision | undefined {
  const timing = timingProfile(spec);
  if (timing.source !== "acoustic") return undefined;
  const pace = object(timing.globalPace ?? timing.global_pace);
  const value = String(pace.value ?? "");
  const cue = GLOBAL_PACE_CUES[value];
  const refs = cueSourceControlRefs(pace);
  const rate = finiteNumber(
    pace.speakingRateCharsPerSec ?? pace.speaking_rate_chars_per_sec,
    0,
  );
  if (!cue || !refs.length || rate <= 0) return undefined;
  return {
    cue,
    score: 100,
    sourceControlRefs: refs,
    evidence: {
      source: "acoustic",
      speakingRateCharsPerSec: rate,
      globalPace: value as NonNullable<PromptControlTrace["evidence"]>["globalPace"],
      confidence: Math.max(0, Math.min(1, finiteNumber(pace.confidence, 0.8))),
    },
  };
}

function addCueScore(
  scores: Map<MinimalCue, CueEvidence>,
  cue: MinimalCue | undefined,
  score: number,
  refs: string[],
) {
  if (!cue || !refs.length) return;
  const evidence = scores.get(cue) ?? { score: 0, refs: new Set<string>() };
  evidence.score += score;
  refs.forEach((ref) => evidence.refs.add(ref));
  scores.set(cue, evidence);
}

function cueIsAvoided(cue: MinimalCue, values: string[]) {
  const avoid = values.join(" ").toLowerCase();
  if (!avoid) return false;
  if (cue === "slightly breathy" && /breathy|气声|虚声/u.test(avoid)) return true;
  if (cue === "resonant" && /shout|喊|过度高亢|过度用力|too loud/u.test(avoid)) return true;
  if (cue === "brightly" && /过亮|过度欢快|too bright/u.test(avoid)) return true;
  if (cue === "building" && /过度推进|过度上扬|exaggerated rise/u.test(avoid)) return true;
  if (cue === "softening" && /过度收弱|过度虚化|too soft/u.test(avoid)) return true;
  return false;
}

function strongestAllowedCue(
  scores: Map<MinimalCue, CueEvidence>,
  avoid: string[],
): CueDecision | undefined {
  const selected = [...scores.entries()]
    .filter(([cue]) => !cueIsAvoided(cue, avoid))
    .sort((left, right) => right[1].score - left[1].score)[0];
  if (!selected) return undefined;
  return {
    cue: selected[0],
    score: selected[1].score,
    sourceControlRefs: [...selected[1].refs],
  };
}

interface RhythmDecision {
  value: string;
  sourceControlRefs: string[];
}

function documentRhythm(spec: JsonObject, sentences: JsonObject[]): RhythmDecision | undefined {
  const document = object(spec.documentProfile ?? spec.document_profile);
  const explicit = document.baseRhythm ?? document.base_rhythm;
  const explicitValue = rhythmKey(explicit);
  const explicitRefs = explicitValue
    ? sourceControlRefs(document, "control_spec.document_profile.base_rhythm")
    : [];
  if (explicitValue && explicitRefs.length) {
    return {
      value: explicitValue,
      sourceControlRefs: explicitRefs,
    };
  }

  const counts = new Map<string, { count: number; refs: Set<string> }>();
  sentences.forEach((sentence, position) => {
    const rhythm = rhythmKey(sentence.rhythm);
    if (!rhythm) return;
    const sentenceId = String(sentence.id ?? `sentence-${position + 1}`);
    const refs = sourceControlRefs(
      sentence.rhythm,
      `control_spec.sentences.${sentenceId}.rhythm`,
    );
    const current = counts.get(rhythm) ?? { count: 0, refs: new Set<string>() };
    current.count += 1;
    refs.forEach((ref) => current.refs.add(ref));
    counts.set(rhythm, current);
  });
  const selected = [...counts.entries()].sort((left, right) => right[1].count - left[1].count)[0];
  return selected ? { value: selected[0], sourceControlRefs: [...selected[1].refs] } : undefined;
}

function globalDeliveryCue(spec: JsonObject, sentences: JsonObject[]): CueDecision | undefined {
  const scores = new Map<MinimalCue, CueEvidence>();
  const hidden = profile(spec);
  const document = object(spec.documentProfile ?? spec.document_profile);
  const rhythm = documentRhythm(spec, sentences);
  if (rhythm) {
    addCueScore(scores, GLOBAL_RHYTHM_CUES[rhythm.value], 3, rhythm.sourceControlRefs);
  }

  const hiddenDeliveryMode = hidden.deliveryMode ?? hidden.delivery_mode;
  const deliveryMode = String(hiddenDeliveryMode ?? document.deliveryMode ?? document.delivery_mode ?? "");
  if (deliveryMode) {
    const deliverySource = hiddenDeliveryMode !== undefined ? hidden : document;
    addCueScore(
      scores,
      DELIVERY_MODE_CUES[deliveryMode],
      2,
      sourceControlRefs(deliverySource, hiddenDeliveryMode !== undefined
        ? "control_spec.performance_profile.delivery_mode"
        : "control_spec.document_profile.delivery_mode"),
    );
  }

  const voiceQuality = String(
    hidden.voiceQuality ?? hidden.voice_quality
      ?? document.voiceQuality ?? document.voice_quality
      ?? "",
  );
  if (voiceQuality) {
    const voiceSource = hidden.voiceQuality !== undefined || hidden.voice_quality !== undefined
      ? hidden
      : document;
    addCueScore(
      scores,
      VOICE_QUALITY_CUES[voiceQuality],
      5.2,
      sourceControlRefs(voiceSource, voiceSource === hidden
        ? "control_spec.performance_profile.voice_quality"
        : "control_spec.document_profile.voice_quality"),
    );
  }

  const hiddenEmotionTone = hidden.emotionTone ?? hidden.emotion_tone;
  const emotionTone = stringArray(hiddenEmotionTone ?? document.emotionalTone ?? document.emotional_tone);
  emotionTone.forEach((tone) => {
    const emotionSource = hiddenEmotionTone !== undefined ? hidden : document;
    addCueScore(
      scores,
      cueForEmotion(tone),
      4.8,
      sourceControlRefs(emotionSource, hiddenEmotionTone !== undefined
        ? "control_spec.performance_profile.emotion_tone"
        : "control_spec.document_profile.emotional_tone"),
    );
  });

  const focusStyle = String(hidden.focusStyle ?? hidden.focus_style ?? "");
  if (focusStyle) addCueScore(
    scores,
    FOCUS_REALIZATION_CUES[focusStyle],
    3.2,
    sourceControlRefs(hidden, "control_spec.performance_profile.focus_style"),
  );
  const amplitude = String(hidden.expressionAmplitude ?? hidden.expression_amplitude ?? "");
  if (amplitude) addCueScore(
    scores,
    EXPRESSION_AMPLITUDE_CUES[amplitude],
    3.5,
    sourceControlRefs(hidden, "control_spec.performance_profile.expression_amplitude"),
  );

  return strongestAllowedCue(scores, stringArray(hidden.avoid));
}

function sentenceCueCandidate(
  sentence: JsonObject,
  baseRhythm: string | undefined,
  previousRhythm: string | undefined,
  sentenceRef: string,
) {
  const scores = new Map<MinimalCue, CueEvidence>();
  const hidden = profile(sentence);
  const rhythmRefs = sourceControlRefs(sentence.rhythm, `${sentenceRef}.rhythm`);

  const rhythm = rhythmKey(sentence.rhythm);
  if (rhythm && rhythm !== baseRhythm) {
    addCueScore(
      scores,
      SENTENCE_RHYTHM_CUES[rhythm],
      3.2 + (rhythm !== previousRhythm ? 0.8 : 0),
      rhythmRefs,
    );
  } else if (rhythm && rhythm !== previousRhythm) {
    addCueScore(
      scores,
      SENTENCE_RHYTHM_CUES[rhythm],
      3.4,
      rhythmRefs,
    );
  }

  const voiceQuality = String(hidden.voiceQuality ?? hidden.voice_quality ?? "");
  if (voiceQuality) addCueScore(
    scores,
    VOICE_QUALITY_CUES[voiceQuality],
    4.2,
    sourceControlRefs(hidden, `${sentenceRef}.performance_profile.voice_quality`),
  );
  stringArray(hidden.emotionTone ?? hidden.emotion_tone)
    .forEach((tone) => addCueScore(
      scores,
      cueForEmotion(tone),
      4,
      sourceControlRefs(hidden, `${sentenceRef}.performance_profile.emotion_tone`),
    ));
  const focusStyle = String(hidden.focusStyle ?? hidden.focus_style ?? "");
  if (focusStyle) addCueScore(
    scores,
    FOCUS_REALIZATION_CUES[focusStyle],
    2.8,
    sourceControlRefs(hidden, `${sentenceRef}.performance_profile.focus_style`),
  );
  const amplitude = String(hidden.expressionAmplitude ?? hidden.expression_amplitude ?? "");
  if (amplitude) addCueScore(
    scores,
    EXPRESSION_AMPLITUDE_CUES[amplitude],
    3.1,
    sourceControlRefs(hidden, `${sentenceRef}.performance_profile.expression_amplitude`),
  );
  const continuity = String(hidden.continuity ?? sentence.continuity ?? "");
  if (continuity === "segmented") addCueScore(
    scores,
    "thoughtful",
    2.7,
    sourceControlRefs(
      hidden.continuity !== undefined ? hidden : sentence,
      `${sentenceRef}.continuity`,
    ),
  );

  const focusEntries = Array.isArray(sentence.focus) ? sentence.focus.map(object) : [];
  focusEntries
    .filter((focus) => String(focus.level ?? "primary") === "primary")
    .slice(0, 1)
    .forEach((focus, position) => {
      const realization = String(focus.preferredRealization ?? focus.preferred_realization ?? "free");
      const confidence = Math.max(0, Math.min(1, finiteNumber(focus.confidence, 0.7)));
      addCueScore(
        scores,
        FOCUS_REALIZATION_CUES[realization],
        1.1 + confidence * 0.6,
        sourceControlRefs(
          focus,
          `${sentenceRef}.focus.${String(focus.id ?? position + 1)}`,
        ),
      );
    });

  const avoid = [
    ...stringArray(hidden.avoid),
    ...stringArray(sentence.avoid),
  ];
  const selected = strongestAllowedCue(scores, avoid);
  if (!selected || selected.score < 2.7) return undefined;
  return { ...selected, rhythm };
}

function planSentenceCues(
  spec: JsonObject,
  sentences: JsonObject[],
  globalCue: CueDecision | undefined,
) {
  const baseRhythm = documentRhythm(spec, sentences)?.value;
  const planned = new Map<number, CueDecision>();
  let previousRhythm = baseRhythm;
  let activeCue = globalCue?.cue;

  sentences.forEach((sentence, position) => {
    const sentenceId = String(sentence.id ?? `sentence-${position + 1}`);
    const candidate = sentenceCueCandidate(
      sentence,
      baseRhythm,
      previousRhythm,
      `control_spec.sentences.${sentenceId}`,
    );
    previousRhythm = rhythmKey(sentence.rhythm) ?? previousRhythm;
    const desired = candidate
      ?? (globalCue && activeCue !== globalCue.cue ? globalCue : undefined);
    if (!desired || desired.cue === activeCue) return;
    planned.set(position, desired);
    activeCue = desired.cue;
  });

  return planned;
}

interface PhraseBoundary {
  tokenIndex: number;
  sentenceOffset: number;
}

interface MotionCueDecision extends CueDecision {
  tokenIndex: number;
}

interface MotionEventPlan {
  score: number;
  cues: MotionCueDecision[];
}

function phraseBoundaries(
  sentenceIndexes: number[],
  tokenByIndex: Map<number, { char: string }>,
  pauseIndexes: number[],
) {
  const boundaryIndexes = new Set<number>();
  const firstSpokenOffset = sentenceIndexes.findIndex((index) =>
    isSpokenCharacter(tokenByIndex.get(index)?.char ?? ""));
  if (firstSpokenOffset >= 0) boundaryIndexes.add(sentenceIndexes[firstSpokenOffset]);

  sentenceIndexes.forEach((index, offset) => {
    if (offset === 0 || !isSpokenCharacter(tokenByIndex.get(index)?.char ?? "")) return;
    const previous = tokenByIndex.get(sentenceIndexes[offset - 1])?.char ?? "";
    if (!isSpokenCharacter(previous)) boundaryIndexes.add(index);
  });

  pauseIndexes.forEach((pauseIndex) => {
    const pauseOffset = sentenceIndexes.indexOf(pauseIndex);
    if (pauseOffset < 0) return;
    const nextSpoken = sentenceIndexes.slice(pauseOffset + 1)
      .find((index) => isSpokenCharacter(tokenByIndex.get(index)?.char ?? ""));
    if (nextSpoken !== undefined) boundaryIndexes.add(nextSpoken);
  });

  return [...boundaryIndexes]
    .map((tokenIndex) => ({
      tokenIndex,
      sentenceOffset: sentenceIndexes.indexOf(tokenIndex),
    }))
    .filter((boundary) => boundary.sentenceOffset >= 0)
    .sort((left, right) => left.sentenceOffset - right.sentenceOffset);
}

function phraseTimingCues(
  spec: JsonObject,
  sentenceIndexes: number[],
  boundaries: PhraseBoundary[],
): MotionCueDecision[] {
  const timing = timingProfile(spec);
  if (timing.source !== "acoustic") return [];
  const global = object(timing.globalPace ?? timing.global_pace);
  const globalPace = String(global.value ?? "");
  const entries = Array.isArray(timing.phraseDurationProfile)
    ? timing.phraseDurationProfile
    : Array.isArray(timing.phrase_duration_profile) ? timing.phrase_duration_profile : [];
  const sentenceMin = sentenceIndexes[0];
  const sentenceMax = sentenceIndexes.at(-1)!;
  return entries.map(object).flatMap((entry) => {
    const start = integer(entry.startIndex ?? entry.start_index);
    const end = integer(entry.endIndex ?? entry.end_index);
    const expansion = String(entry.expansion ?? "");
    const confidence = Math.max(0, Math.min(1, finiteNumber(entry.confidence, 0.8)));
    const refs = cueSourceControlRefs(entry);
    if (
      start === undefined
      || end === undefined
      || start < sentenceMin
      || end > sentenceMax
      || confidence < 0.6
      || !refs.length
    ) return [];

    let cue: MinimalCue | undefined;
    if (expansion === "strongly_expanded" && globalPace !== "slow") {
      cue = "slowly";
    } else if (
      expansion === "expanded"
      && globalPace !== "slow"
      && globalPace !== "moderately_slow"
    ) {
      cue = "unhurried";
    }
    if (!cue || cue === GLOBAL_PACE_CUES[globalPace]) return [];

    const boundary = boundaries.find((candidate) => candidate.tokenIndex === start)
      ?? boundaries.find((candidate) => candidate.tokenIndex >= start && candidate.tokenIndex <= end);
    if (!boundary) return [];
    return [{
      cue,
      score: expansion === "strongly_expanded" ? 20 + confidence : 15 + confidence,
      tokenIndex: boundary.tokenIndex,
      sourceControlRefs: refs,
      evidence: {
        source: "acoustic" as const,
        phraseExpansion: expansion as NonNullable<PromptControlTrace["evidence"]>["phraseExpansion"],
        speakingRateCharsPerSec: finiteNumber(
          entry.speakingRateCharsPerSec ?? entry.speaking_rate_chars_per_sec,
          0,
        ),
        globalPace: globalPace as NonNullable<PromptControlTrace["evidence"]>["globalPace"],
        confidence,
      },
    }];
  });
}

function mergeSentenceLocalCues(
  timingCues: MotionCueDecision[],
  motionCues: MotionCueDecision[],
  focusCues: MotionCueDecision[],
) {
  const selected: MotionCueDecision[] = [];
  const add = (candidate: MotionCueDecision) => {
    const sameBoundary = selected.find((cue) => cue.tokenIndex === candidate.tokenIndex);
    if (sameBoundary) {
      if (sameBoundary.cue === candidate.cue) {
        sameBoundary.sourceControlRefs = [...new Set([
          ...sameBoundary.sourceControlRefs,
          ...candidate.sourceControlRefs,
        ])];
        sameBoundary.evidence ??= candidate.evidence;
      }
      return;
    }
    if (selected.length < 2) selected.push({
      ...candidate,
      sourceControlRefs: [...candidate.sourceControlRefs],
    });
  };

  [...timingCues].sort((left, right) => right.score - left.score).forEach(add);
  [...motionCues].sort((left, right) => right.score - left.score).forEach(add);
  [...focusCues].sort((left, right) => right.score - left.score).forEach(add);
  return selected.sort((left, right) => left.tokenIndex - right.tokenIndex);
}

function softFallingPreferred(spec: JsonObject, sentence: JsonObject) {
  const sentenceProfile = profile(sentence);
  const documentProfile = profile(spec);
  const document = object(spec.documentProfile ?? spec.document_profile);
  const voiceQuality = String(
    sentenceProfile.voiceQuality ?? sentenceProfile.voice_quality
      ?? documentProfile.voiceQuality ?? documentProfile.voice_quality
      ?? document.voiceQuality ?? document.voice_quality
      ?? "",
  );
  const focusStyle = String(
    sentenceProfile.focusStyle ?? sentenceProfile.focus_style
      ?? documentProfile.focusStyle ?? documentProfile.focus_style
      ?? "",
  );
  const amplitude = String(
    sentenceProfile.expressionAmplitude ?? sentenceProfile.expression_amplitude
      ?? documentProfile.expressionAmplitude ?? documentProfile.expression_amplitude
      ?? "",
  );
  const emotion = [
    ...stringArray(sentenceProfile.emotionTone ?? sentenceProfile.emotion_tone),
    ...stringArray(documentProfile.emotionTone ?? documentProfile.emotion_tone),
    ...stringArray(document.emotionalTone ?? document.emotional_tone),
  ].join(" ").toLowerCase();
  const rhythm = rhythmKey(sentence.rhythm);
  return ["slightly_breathy", "breathy", "mixed", "breathy_to_mixed", "solid_to_soft"]
    .includes(voiceQuality)
    || ["soft", "breathy", "lower_weighted"].includes(focusStyle)
    || amplitude === "low"
    || rhythm === "relaxed"
    || rhythm === "low"
    || /温柔|柔和|轻柔|安静|克制|含蓄|沉思|soft|gentle|quiet|restrain|reflect/u.test(emotion);
}

function allowedMotionCue(
  cue: MinimalCue,
  avoid: string[],
  fallback?: MinimalCue,
) {
  if (!cueIsAvoided(cue, avoid)) return cue;
  return fallback && !cueIsAvoided(fallback, avoid) ? fallback : undefined;
}

function prosodyMotionPlans(
  spec: JsonObject,
  sentence: JsonObject,
  sentenceIndexes: number[],
  boundaries: PhraseBoundary[],
  sentenceRef: string,
) {
  const sentenceMin = sentenceIndexes[0];
  const sentenceMax = sentenceIndexes.at(-1)!;
  const avoid = [
    ...stringArray(profile(spec).avoid),
    ...stringArray(profile(sentence).avoid),
    ...stringArray(sentence.avoid),
  ];
  const fallCue = allowedMotionCue(
    softFallingPreferred(spec, sentence)
      ? ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.falling.entry[0]
      : ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.falling.entry[1],
    avoid,
    ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.falling.entry[1],
  );
  const settleCue = allowedMotionCue(
    ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.peak.exit,
    avoid,
    ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.valley.entry,
  );
  const softenCue = allowedMotionCue(
    ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.valley.entry,
    avoid,
    ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.peak.exit,
  );
  const buildCue = allowedMotionCue(
    ELEVEN_V3_PROSODY_MOTION_DIRECTIONS.rising.entry,
    avoid,
  );
  const events = (Array.isArray(sentence.prosody) ? sentence.prosody : [])
    .map(object)
    .flatMap((event, position) => {
      const type = String(event.type ?? "");
      if (!(["peak", "valley", "rising", "falling"] as string[]).includes(type)) return [];
      const active = object(event.activeSpan ?? event.active_span);
      const core = object(event.coreZone ?? event.core_zone);
      const start = Math.max(
        sentenceMin,
        Math.min(sentenceMax, integer(active.start ?? active.start_index) ?? sentenceMin),
      );
      const end = Math.max(
        start,
        Math.min(sentenceMax, integer(active.end ?? active.end_index) ?? sentenceMax),
      );
      const coreStart = Math.max(
        start,
        Math.min(end, integer(core.start ?? core.start_index) ?? start),
      );
      const coreEnd = Math.max(
        coreStart,
        Math.min(end, integer(core.end ?? core.end_index) ?? coreStart),
      );
      const strength = Math.max(1, Math.min(3, integer(event.strength) ?? 1));
      const confidence = Math.max(0, Math.min(1, finiteNumber(event.confidence, 0.7)));
      const refs = sourceControlRefs(
        event,
        `${sentenceRef}.prosody.${String(event.id ?? position + 1)}`,
      );
      if (confidence < 0.45 || !refs.length) return [];
      return [{
        type,
        start,
        end,
        coreStart,
        coreEnd,
        score: strength + confidence,
        refs,
      }];
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);

  return events.flatMap((event): MotionEventPlan[] => {
    const startBoundary = boundaries
      .filter((boundary) => boundary.tokenIndex <= event.start)
      .at(-1);
    if (!startBoundary) return [];
    const transitionBoundary = boundaries.find((boundary) =>
      boundary.tokenIndex > event.coreEnd
      && boundary.tokenIndex <= event.end
      && boundary.tokenIndex !== startBoundary.tokenIndex)
      ?? boundaries.find((boundary) =>
        boundary.tokenIndex >= event.coreStart
        && boundary.tokenIndex <= event.end
        && boundary.tokenIndex !== startBoundary.tokenIndex);
    const cues: MotionCueDecision[] = [];
    const add = (cue: MinimalCue | undefined, boundary: PhraseBoundary | undefined) => {
      if (!cue || !boundary || cues.length >= 2) return;
      cues.push({
        cue,
        score: event.score,
        tokenIndex: boundary.tokenIndex,
        sourceControlRefs: event.refs,
      });
    };
    if (event.type === "rising") add(buildCue, startBoundary);
    else if (event.type === "falling") add(fallCue, startBoundary);
    else if (event.type === "peak") {
      add(buildCue, startBoundary);
      add(settleCue, transitionBoundary);
    } else if (event.type === "valley") {
      add(softenCue, startBoundary);
      add(buildCue, transitionBoundary);
    }
    return cues.length ? [{ score: event.score, cues }] : [];
  });
}

const FOCUS_MOTION_CUES: Record<string, MinimalCue | undefined> = {
  stronger: "firmly",
  supported: "firmly",
  soft_emphasis: "softly",
  soft: "softly",
  slower: "softening",
  lower_weighted: "softening",
  breathy: "softly",
  breathy_to_supported: "building",
  voice_shift: "building",
  combined: "firmly",
};

function focusMotionCues(
  sentence: JsonObject,
  sentenceIndexes: number[],
  boundaries: PhraseBoundary[],
  sentenceRef: string,
): MotionCueDecision[] {
  const sentenceMin = sentenceIndexes[0];
  const sentenceMax = sentenceIndexes.at(-1)!;
  return (Array.isArray(sentence.focus) ? sentence.focus : [])
    .map(object)
    .flatMap((focus, position) => {
      if (String(focus.level ?? "primary") !== "primary") return [];
      const indexes = (Array.isArray(focus.tokenIndexes)
        ? focus.tokenIndexes
        : Array.isArray(focus.token_indexes) ? focus.token_indexes : [])
        .map(integer)
        .filter((index): index is number => index !== undefined);
      const focusStart = indexes.find((index) => index >= sentenceMin && index <= sentenceMax);
      if (focusStart === undefined) return [];
      const style = String(
        focus.preferredRealization
          ?? focus.preferred_realization
          ?? focus.focusStyle
          ?? focus.focus_style
          ?? "",
      );
      const cue = FOCUS_MOTION_CUES[style];
      const confidence = Math.max(0, Math.min(1, finiteNumber(focus.confidence, 0.7)));
      if (!cue || confidence < 0.55) return [];
      const boundary = boundaries
        .filter((candidate) => candidate.tokenIndex <= focusStart)
        .at(-1);
      if (!boundary) return [];
      return [{
        cue,
        score: 2.8 + confidence,
        tokenIndex: boundary.tokenIndex,
        sourceControlRefs: sourceControlRefs(
          focus,
          `${sentenceRef}.focus.${String(focus.id ?? position + 1)}`,
        ),
      }];
    });
}

function planSentenceMotionCues(plans: MotionEventPlan[]) {
  const ranked = [...plans].sort((left, right) => right.score - left.score);
  const selected: MotionCueDecision[] = [];
  const add = (candidate: MotionCueDecision | undefined) => {
    if (!candidate || selected.length >= 2) return;
    const sameBoundary = selected.find((cue) => cue.tokenIndex === candidate.tokenIndex);
    if (sameBoundary) {
      if (sameBoundary.cue === candidate.cue) {
        sameBoundary.sourceControlRefs = [...new Set([
          ...sameBoundary.sourceControlRefs,
          ...candidate.sourceControlRefs,
        ])];
      }
      return;
    }
    selected.push({ ...candidate, sourceControlRefs: [...candidate.sourceControlRefs] });
  };

  ranked.forEach((plan) => add(plan.cues[0]));
  ranked.forEach((plan) => add(plan.cues[1]));
  return selected.sort((left, right) => left.tokenIndex - right.tokenIndex);
}

function isSpokenCharacter(value: string) {
  return /[\p{L}\p{N}]/u.test(value);
}

function prolongationText() {
  return "——";
}

function validateExecutionPlan(
  text: string,
  sourceTokens: CompiledTtsPrompt["sourceTokens"],
  sourceOffsets: Map<number, number>,
  renderedSourceIndexes: number[],
  sentenceTokenIndexes: CompiledTtsPrompt["sentenceTokenIndexes"],
  controls: PromptControlTrace[],
  activeTimingProfile: JsonObject,
): TtsExecutionPlan["validation"] {
  const checks: PromptValidationCheck[] = [];
  const assertCheck = (condition: boolean, code: PromptValidationCheck["code"], message: string) => {
    if (!condition) throw new Error(`TTS Prompt 自检失败：${message}`);
    checks.push({ code, passed: true });
  };

  const promptCharacters = Array.from(text);
  const sourceCompleteOnce = renderedSourceIndexes.length === sourceTokens.length
    && renderedSourceIndexes.every((index, position) => index === position)
    && sourceTokens.every((token) => {
      const offset = sourceOffsets.get(token.index);
      return offset !== undefined && promptCharacters[offset] === token.char;
    });
  assertCheck(sourceCompleteOnce, "source_complete_once", "正文没有被完整且唯一地写入。" );

  const sentenceCoverage = sentenceTokenIndexes.flatMap((sentence) => sentence.tokenIndexes);
  const punctuationPreserved = sourceTokens
    .filter((token) => /[\p{P}\r\n]/u.test(token.char))
    .every((token) => {
      const offset = sourceOffsets.get(token.index);
      return offset !== undefined && promptCharacters[offset] === token.char;
    });
  const allowedBreakAfterIndexes = new Set(
    sentenceTokenIndexes.flatMap((sentence, position) => {
      const hasSentencePause = controls.some((control) =>
        control.kind === "pause"
        && control.scope === "sentence"
        && control.sentenceId === sentence.sentenceId
        && /^\[(?:short|long) pause\]$/u.test(control.emittedText));
      const lastIndex = sentence.tokenIndexes.at(-1);
      const nextSentence = sentenceTokenIndexes[position + 1];
      const nextHasBaseCue = nextSentence
        ? controls.some((control) =>
          control.kind === "audio_tag"
          && control.scope === "sentence"
          && control.sentenceId === nextSentence.sentenceId)
        : false;
      return (hasSentencePause || nextHasBaseCue) && lastIndex !== undefined ? [lastIndex] : [];
    }),
  );
  const noInsertedLineBreaks = sourceTokens.slice(0, -1).every((token, position) => {
    const currentOffset = sourceOffsets.get(token.index);
    const nextOffset = sourceOffsets.get(sourceTokens[position + 1].index);
    if (currentOffset === undefined || nextOffset === undefined) return false;
    const gapStart = currentOffset + Array.from(token.char).length;
    const gap = promptCharacters.slice(gapStart, nextOffset).join("");
    return !/[\r\n]/u.test(gap) || allowedBreakAfterIndexes.has(token.index);
  });
  assertCheck(
    sentenceCoverage.length === sourceTokens.length
      && sentenceCoverage.every((index, position) => index === sourceTokens[position].index)
      && punctuationPreserved
      && noInsertedLineBreaks,
    "source_structure_preserved",
    "原文标点、句界或语法连续性被改变。",
  );

  const promptTags = [...text.matchAll(/\[[^\]\r\n]+\]/gu)].map((match) => match[0]);
  const tracedAudioTags = controls
    .filter((control) => /^\[[^\]\r\n]+\]$/u.test(control.emittedText))
    .map((control) => control.emittedText);
  const audioTagsAreInsertionsOnly = promptTags.length === tracedAudioTags.length
    && promptTags.every((tag, position) => tag === tracedAudioTags[position])
    && controls.filter((control) => /^\[[^\]\r\n]+\]$/u.test(control.emittedText)).every((control) =>
      control.scope === "global"
        ? control.tokenIndex === undefined
        : control.tokenIndex !== undefined && sourceOffsets.has(control.tokenIndex));
  assertCheck(
    audioTagsAreInsertionsOnly,
    "audio_tags_are_insertions_only",
    "Audio Tag 不是可追溯的纯插入控制。",
  );

  const tags = controls
    .filter((control) => /^\[[^\]\r\n]+\]$/u.test(control.emittedText))
    .map((control) => control.emittedText.slice(1, -1));
  const tagsAreSafe = tags.every((tag) =>
    ELEVEN_V3_MINIMAL_AUDIO_TAGS.includes(tag as MinimalCue)
    && tag.length <= 20
    && !/[\p{Script=Han},;，；]/u.test(tag));
  assertCheck(tagsAreSafe, "tags_are_short_english_cues", "Audio Tag 含有非白名单内容。" );

  assertCheck(
    controls.every((control) => control.sourceControlRefs.length > 0
      && control.sourceControlRefs.every((ref) => Boolean(ref.trim()))),
    "all_special_controls_traced",
    "存在没有 source_control_ref 的特殊控制。",
  );

  const sentenceBaseTagCounts = new Map<string, number>();
  const sentenceMotionTagCounts = new Map<string, number>();
  controls.filter((control) => control.kind === "audio_tag" && control.scope !== "global")
    .forEach((control) => {
      const sentenceId = control.sentenceId ?? "unknown";
      const target = control.scope === "sentence"
        ? sentenceBaseTagCounts
        : sentenceMotionTagCounts;
      target.set(sentenceId, (target.get(sentenceId) ?? 0) + 1);
    });
  const globalTagCount = controls.filter(
    (control) => control.kind === "audio_tag" && control.scope === "global",
  ).length;
  assertCheck(
    globalTagCount <= 2
      && [...sentenceBaseTagCounts.values()].every((count) => count <= 2)
      && [...sentenceMotionTagCounts.values()].every((count) => count <= 2),
    "sentence_tag_budget",
    "同一句出现了过多 Audio Tag。",
  );

  const tagControls = controls.filter((control) => /^\[[^\]\r\n]+\]$/u.test(control.emittedText));
  const tagPositions = new Set<string>();
  assertCheck(
    tagControls.every((control) => {
      const key = [
        control.sentenceId ?? "document",
        control.tokenIndex ?? "start",
        control.emittedText,
      ].join(":");
      if (tagPositions.has(key)) return false;
      tagPositions.add(key);
      return true;
    }),
    "no_duplicate_tags",
    "同一位置存在重复标签。",
  );

  const localPositions = new Set<string>();
  const localSignalsUnique = controls
    .filter((control) => control.kind === "pause" || control.kind === "prolongation")
    .every((control) => {
      const key = `${control.sentenceId}:${control.tokenIndex}`;
      if (localPositions.has(key)) return false;
      localPositions.add(key);
      return true;
    });
  assertCheck(localSignalsUnique, "no_duplicate_pause_signals", "同一位置叠加了多个停顿或拖音信号。" );

  assertCheck(
    controls.filter((control) => control.kind === "prolongation").every((control) =>
      control.evidence?.source === "acoustic"
      && (control.evidence.timingStrength !== undefined
        ? control.evidence.timingStrength === "strong"
          && (control.evidence.localDurationRatio ?? 0) >= 2.35
          && control.evidence.confidence >= 0.88
        : (control.evidence.localDurationRatio ?? 0) >= 2.35
          && control.evidence.confidence >= 0.88)),
    "prolongations_have_acoustic_evidence",
    "拖音缺少足够的 local_duration_ratio 或 confidence 声学证据。",
  );

  const timingGlobal = object(activeTimingProfile.globalPace ?? activeTimingProfile.global_pace);
  const timingPace = String(timingGlobal.value ?? "");
  const expectedPaceCue = GLOBAL_PACE_CUES[timingPace];
  const globalPacePreserved = activeTimingProfile.source !== "acoustic"
    || Boolean(expectedPaceCue && controls.some((control) =>
      control.kind === "audio_tag"
      && control.scope === "global"
      && control.emittedText === `[${expectedPaceCue}]`
      && control.sourceControlRefs.length > 0));
  assertCheck(
    globalPacePreserved,
    "global_pace_preserved",
    "当前参考朗诵的全局速度没有进入 Eleven Prompt。",
  );

  return { state: "valid", checks };
}

/**
 * Compile the confirmed control spec into an Eleven v3 prompt while recording the
 * exact prompt offset of every immutable source token. Added audio tags and pause
 * punctuation are deliberately kept outside the source-token mapping.
 */
export function compileElevenV3Prompt(specValue: unknown): CompiledTtsPrompt {
  const spec = object(specValue);
  const globalTokens = Array.isArray(spec.tokens) ? spec.tokens.map(object) : [];
  const sentences = Array.isArray(spec.sentences) ? spec.sentences.map(object) : [];
  if (!globalTokens.length || !sentences.length) {
    throw new Error("控制谱缺少可生成的 tokens 或 sentences。");
  }

  const canonicalTokens = globalTokens.map((token, position) => {
    const index = integer(token.index);
    const char = typeof token.char === "string" ? token.char : "";
    if (index !== position || !char) {
      throw new Error(`控制谱 token ${position} 的 index 或 char 无效。`);
    }
    return { id: String(token.id ?? `token-${position}`), index: position, char };
  });
  const tokenByIndex = new Map(canonicalTokens.map((token) => [token.index, token]));
  const activeTimingProfile = timingProfile(spec);
  const hasAcousticTimingProfile = activeTimingProfile.source === "acoustic";
  const timingPauseEntries = Array.isArray(activeTimingProfile.pauseHierarchy)
    ? activeTimingProfile.pauseHierarchy
    : Array.isArray(activeTimingProfile.pause_hierarchy) ? activeTimingProfile.pause_hierarchy : [];
  const timingPausesByIndex = new Map<number, JsonObject>();
  timingPauseEntries.map(object).forEach((entry) => {
    const index = integer(entry.afterTokenIndex ?? entry.after_token_index ?? entry.after_index);
    if (index !== undefined) timingPausesByIndex.set(index, entry);
  });
  const timingProlongationEntries = Array.isArray(activeTimingProfile.prolongationStrength)
    ? activeTimingProfile.prolongationStrength
    : Array.isArray(activeTimingProfile.prolongation_strength)
      ? activeTimingProfile.prolongation_strength
      : [];
  const timingProlongationsByIndex = new Map<number, JsonObject>();
  timingProlongationEntries.map(object).forEach((entry) => {
    const index = integer(entry.tokenIndex ?? entry.token_index);
    if (index !== undefined) timingProlongationsByIndex.set(index, entry);
  });

  let text = "";
  let expectedIndex = 0;
  const renderedSourceIndexes: number[] = [];
  const controls: PromptControlTrace[] = [];
  const sourceOffsets = new Map<number, number>();
  const sentenceTokenIndexes: CompiledTtsPrompt["sentenceTokenIndexes"] = [];
  const append = (value: string | undefined) => {
    if (value) text += value;
  };
  const ensureNewlines = (count: number) => {
    const trailing = text.match(/\n+$/u)?.[0].length ?? 0;
    if (trailing < count) append("\n".repeat(count - trailing));
  };
  const appendPhraseTag = (tag: string) => append(tag);
  const addControl = (
    control: Omit<PromptControlTrace, "id">,
  ) => {
    if (!control.sourceControlRefs.length) {
      throw new Error("TTS Prompt 控制缺少 source_control_ref。");
    }
    controls.push({ id: `prompt-control-${controls.length + 1}`, ...control });
  };

  const performanceGlobalCue = globalDeliveryCue(spec, sentences);
  const paceCue = globalPaceCue(spec);
  const sentenceCues = planSentenceCues(spec, sentences, performanceGlobalCue);
  const globalCues = [performanceGlobalCue, paceCue]
    .filter((cue): cue is CueDecision => Boolean(cue))
    .filter((cue, position, entries) =>
      entries.findIndex((candidate) => candidate.cue === cue.cue) === position)
    .slice(0, 2);
  if (globalCues.length) {
    append(globalCues.map((cue) => `[${cue.cue}]`).join(" "));
    globalCues.forEach((cue) => addControl({
      kind: "audio_tag",
      scope: "global",
      emittedText: `[${cue.cue}]`,
      sourceControlRefs: cue.sourceControlRefs,
      evidence: cue.evidence,
    }));
    ensureNewlines(1);
  }

  sentences.forEach((sentence, sentencePosition) => {
    const rawSentenceTokens = Array.isArray(sentence.tokens) ? sentence.tokens.map(object) : [];
    if (!rawSentenceTokens.length) {
      throw new Error(`第 ${sentencePosition + 1} 句没有 tokens。`);
    }
    const indexes = rawSentenceTokens.map((token) => integer(token.index));
    if (indexes.some((index) => index === undefined)) {
      throw new Error(`第 ${sentencePosition + 1} 句包含无效 token index。`);
    }
    const sentenceIndexes = indexes as number[];
    if (sentenceIndexes[0] !== expectedIndex) {
      throw new Error(`第 ${sentencePosition + 1} 句没有从 token ${expectedIndex} 连续开始。`);
    }
    sentenceIndexes.forEach((index, offset) => {
      const canonical = tokenByIndex.get(index);
      const sentenceToken = rawSentenceTokens[offset];
      if (!canonical || index !== expectedIndex + offset || sentenceToken.char !== canonical.char) {
        throw new Error(`第 ${sentencePosition + 1} 句的 token ${index} 与完整正文不一致。`);
      }
    });
    expectedIndex += sentenceIndexes.length;

    const sentenceId = String(sentence.id ?? `sentence-${sentencePosition + 1}`);
    sentenceTokenIndexes.push({ sentenceId, tokenIndexes: sentenceIndexes });
    const sentenceCue = sentenceCues.get(sentencePosition);

    const sentenceRef = `control_spec.sentences.${sentenceId}`;
    const pauses = new Map<number, {
      type: "short" | "long";
      level: "light" | "marked" | "paragraph";
      refs: string[];
      evidence?: PromptControlTrace["evidence"];
    }>();
    const pauseEntries = Array.isArray(sentence.pauses) ? sentence.pauses.map(object) : [];
    pauseEntries.forEach((pause, position) => {
      const index = integer(pause.afterTokenIndex ?? pause.after_index);
      const pauseId = String(pause.id ?? position + 1);
      if (index !== undefined) {
        const timingPause = timingPausesByIndex.get(index);
        const timingLevel = String(timingPause?.level ?? "");
        const level = pause.type === "long"
          ? "paragraph" as const
          : (["light", "marked", "paragraph"] as string[]).includes(timingLevel)
            ? timingLevel as "light" | "marked" | "paragraph"
            : "marked" as const;
        const timingRefs = timingPause ? cueSourceControlRefs(timingPause) : [];
        pauses.set(index, {
          type: pause.type === "long" ? "long" : "short",
          level,
          refs: [...new Set([
            ...sourceControlRefs(pause, `${sentenceRef}.pauses.${pauseId}`),
            ...timingRefs,
          ])],
          evidence: timingPause ? {
            source: "acoustic",
            pauseLevel: level,
            observedGapMs: finiteNumber(
              timingPause.observedGapMs ?? timingPause.observed_gap_ms ?? timingPause.gap_ms,
              0,
            ),
            relativeRatio: finiteNumber(
              timingPause.relativeRatio ?? timingPause.relative_ratio,
              1,
            ),
            confidence: Math.max(0, Math.min(1, finiteNumber(timingPause.confidence, 0.8))),
          } : undefined,
        });
      }
    });

    timingPauseEntries.map(object).forEach((timingPause, position) => {
      const index = integer(
        timingPause.afterTokenIndex
          ?? timingPause.after_token_index
          ?? timingPause.after_index,
      );
      if (index === undefined || !sentenceIndexes.includes(index) || pauses.has(index)) return;
      const levelValue = String(timingPause.level ?? "");
      if (!( ["light", "marked", "paragraph"] as string[]).includes(levelValue)) return;
      const level = levelValue as "light" | "marked" | "paragraph";
      pauses.set(index, {
        type: level === "paragraph" ? "long" : "short",
        level,
        refs: sourceControlRefs(
          timingPause,
          `analysis.timing_profile.pause_hierarchy.${position}`,
        ),
        evidence: {
          source: "acoustic",
          pauseLevel: level,
          observedGapMs: finiteNumber(
            timingPause.observedGapMs ?? timingPause.observed_gap_ms ?? timingPause.gap_ms,
            0,
          ),
          relativeRatio: finiteNumber(
            timingPause.relativeRatio ?? timingPause.relative_ratio,
            1,
          ),
          confidence: Math.max(0, Math.min(1, finiteNumber(timingPause.confidence, 0.8))),
        },
      });
    });

    const boundaries = phraseBoundaries(
      sentenceIndexes,
      tokenByIndex,
      [...pauses.keys()],
    );
    const plannedMotionCues = planSentenceMotionCues(prosodyMotionPlans(
      spec,
      sentence,
      sentenceIndexes,
      boundaries,
      sentenceRef,
    ));
    const plannedTimingCues = phraseTimingCues(spec, sentenceIndexes, boundaries);
    const plannedFocusCues = focusMotionCues(
      sentence,
      sentenceIndexes,
      boundaries,
      sentenceRef,
    );
    const firstBoundaryIndex = boundaries[0]?.tokenIndex;
    const globalCueTraces = sentencePosition === 0
      ? controls.filter((control) => control.kind === "audio_tag" && control.scope === "global")
      : [];
    let sentenceCueToEmit = sentenceCue
      ? { ...sentenceCue, sourceControlRefs: [...sentenceCue.sourceControlRefs] }
      : undefined;
    let motionCues = mergeSentenceLocalCues(
      plannedTimingCues,
      plannedMotionCues,
      plannedFocusCues,
    ).map((cue) => ({
      ...cue,
      sourceControlRefs: [...cue.sourceControlRefs],
    }));
    const startMotionCue = motionCues.find((cue) => cue.tokenIndex === firstBoundaryIndex);
    const controlsShareStartBoundary = firstBoundaryIndex === sentenceIndexes[0];
    if (controlsShareStartBoundary && sentencePosition === 0 && globalCueTraces.length) {
      if (sentenceCueToEmit) {
        const matchingGlobal = globalCueTraces.find(
          (control) => control.emittedText === `[${sentenceCueToEmit!.cue}]`,
        );
        if (matchingGlobal) {
          matchingGlobal.sourceControlRefs = [...new Set([
            ...matchingGlobal.sourceControlRefs,
            ...sentenceCueToEmit.sourceControlRefs,
          ])];
          sentenceCueToEmit = undefined;
        }
      }
      if (startMotionCue) {
        const matchingGlobal = globalCueTraces.find(
          (control) => control.emittedText === `[${startMotionCue.cue}]`,
        );
        if (matchingGlobal) {
          matchingGlobal.sourceControlRefs = [...new Set([
            ...matchingGlobal.sourceControlRefs,
            ...startMotionCue.sourceControlRefs,
          ])];
          motionCues = motionCues.filter((cue) => cue !== startMotionCue);
        }
      }
    } else if (controlsShareStartBoundary && sentenceCueToEmit && startMotionCue) {
      if (sentenceCueToEmit.cue === startMotionCue.cue) {
        sentenceCueToEmit.sourceControlRefs = [...new Set([
          ...sentenceCueToEmit.sourceControlRefs,
          ...startMotionCue.sourceControlRefs,
        ])];
        motionCues = motionCues.filter((cue) => cue !== startMotionCue);
      }
    }
    if (sentenceCueToEmit) {
      const tag = `[${sentenceCueToEmit.cue}]`;
      const previousSourceCharacter = tokenByIndex.get(sentenceIndexes[0] - 1)?.char ?? "";
      const startsCompleteSemanticSentence = sentencePosition === 0
        || /[。！？!?\r\n]/u.test(previousSourceCharacter);
      if (startsCompleteSemanticSentence) {
        if (text) ensureNewlines(1);
        append(tag);
        ensureNewlines(1);
      } else {
        appendPhraseTag(tag);
      }
      addControl({
        kind: "audio_tag",
        scope: "sentence",
        emittedText: tag,
        sentenceId,
        tokenIndex: sentenceIndexes[0],
        sourceControlRefs: sentenceCueToEmit.sourceControlRefs,
        evidence: sentenceCueToEmit.evidence,
      });
    }

    const prolongations = new Map<number, {
      degree: number;
      confidence?: number;
      localDurationRatio?: number;
      timingStrength?: "subtle" | "clear" | "strong";
      phraseExpansion?: "compressed" | "baseline" | "expanded" | "strongly_expanded";
      source: string;
      hasExplicitSourceRef: boolean;
      refs: string[];
    }>();
    const prolongEntries = Array.isArray(sentence.prolongations)
      ? sentence.prolongations.map(object)
      : [];
    prolongEntries.forEach((prolongation, position) => {
      const index = integer(prolongation.tokenIndex ?? prolongation.token_index);
      const degree = integer(prolongation.degree ?? prolongation.strength) ?? 1;
      const confidenceValue = prolongation.confidence;
      const ratioValue = prolongation.localDurationRatio ?? prolongation.local_duration_ratio;
      const explicitRefs = stringArray(
        prolongation.sourceControlRefs
          ?? prolongation.source_control_refs
          ?? prolongation.sourceControlRef
          ?? prolongation.source_control_ref,
      );
      const prolongationId = String(prolongation.id ?? position + 1);
      if (index !== undefined) {
        const timingEntry = timingProlongationsByIndex.get(index);
        const timingStrength = String(timingEntry?.strength ?? "");
        const phraseExpansion = String(
          timingEntry?.phraseExpansion ?? timingEntry?.phrase_expansion ?? "",
        );
        const timingRefs = timingEntry ? cueSourceControlRefs(timingEntry) : [];
        const timingConfidence = timingEntry?.confidence;
        const timingRatio = timingEntry?.localDurationRatio ?? timingEntry?.local_duration_ratio;
        prolongations.set(index, {
          degree,
          confidence: timingConfidence !== undefined
            ? Math.max(0, Math.min(1, finiteNumber(timingConfidence, 0)))
            : confidenceValue === undefined
              ? undefined
              : Math.max(0, Math.min(1, finiteNumber(confidenceValue, 0))),
          localDurationRatio: timingRatio !== undefined
            ? finiteNumber(timingRatio, 0)
            : ratioValue === undefined
              ? undefined
              : finiteNumber(ratioValue, 0),
          timingStrength: (["subtle", "clear", "strong"] as string[]).includes(timingStrength)
            ? timingStrength as "subtle" | "clear" | "strong"
            : undefined,
          phraseExpansion: (["compressed", "baseline", "expanded", "strongly_expanded"] as string[])
            .includes(phraseExpansion)
            ? phraseExpansion as "compressed" | "baseline" | "expanded" | "strongly_expanded"
            : undefined,
          source: timingEntry ? "acoustic" : String(prolongation.source ?? ""),
          hasExplicitSourceRef: timingRefs.length > 0 || explicitRefs.length > 0,
          refs: [...new Set([
            ...sourceControlRefs(prolongation, `${sentenceRef}.prolongations.${prolongationId}`),
            ...timingRefs,
          ])],
        });
      }
    });

    const renderedProlongations = new Map([...prolongations.entries()]
      .filter(([index, value]) =>
        value.degree >= 3
        && value.source === "acoustic"
        && value.hasExplicitSourceRef
        && (pauses.get(index)?.level ?? "light") === "light"
        && (hasAcousticTimingProfile
          ? value.timingStrength === "strong"
            && value.confidence !== undefined
            && value.confidence >= 0.88
            && value.localDurationRatio !== undefined
            && value.localDurationRatio >= 2.35
          : value.confidence !== undefined
            && value.confidence >= 0.88
            && value.localDurationRatio !== undefined
            && value.localDurationRatio >= 2.35)
        && isSpokenCharacter(tokenByIndex.get(index)?.char ?? ""))
      .sort((left, right) => right[1].degree - left[1].degree || left[0] - right[0])
      .slice(0, 1));
    const pauseCandidates = [...pauses.entries()]
      .filter(([index, pause]) => {
        const offset = sentenceIndexes.indexOf(index);
        const current = tokenByIndex.get(index)?.char ?? "";
        const next = tokenByIndex.get(sentenceIndexes[offset + 1])?.char ?? "";
        return pause.level !== "light"
          && offset >= 0
          && offset < sentenceIndexes.length - 1
          && !renderedProlongations.has(index)
          && !/[，。！？、；：,!?;:\s]/u.test(current)
          && !/[，。！？、；：,!?;:\s]/u.test(next);
      })
      .sort((left, right) => {
        const levelScore = (value: "light" | "marked" | "paragraph") =>
          value === "paragraph" ? 2 : value === "marked" ? 1 : 0;
        return levelScore(right[1].level) - levelScore(left[1].level)
          || finiteNumber(right[1].evidence?.relativeRatio, 1)
            - finiteNumber(left[1].evidence?.relativeRatio, 1);
      })
      .slice(0, 2)
      .sort((left, right) => left[0] - right[0]);
    const explicitPauses = new Map(pauseCandidates);
    const pauseProtectedBoundaries = new Set<number>();
    explicitPauses.forEach((_, index) => {
      const offset = sentenceIndexes.indexOf(index);
      const nextSpoken = sentenceIndexes.slice(offset + 1)
        .find((candidate) => isSpokenCharacter(tokenByIndex.get(candidate)?.char ?? ""));
      if (nextSpoken !== undefined) pauseProtectedBoundaries.add(nextSpoken);
    });
    motionCues = motionCues.filter((cue) => !pauseProtectedBoundaries.has(cue.tokenIndex));
    const motionCuesByIndex = new Map<number, MotionCueDecision[]>();
    motionCues.forEach((cue) => {
      const entries = motionCuesByIndex.get(cue.tokenIndex) ?? [];
      entries.push(cue);
      motionCuesByIndex.set(cue.tokenIndex, entries);
    });

    sentenceIndexes.forEach((index) => {
      (motionCuesByIndex.get(index) ?? []).forEach((motionCue) => {
        const tag = `[${motionCue.cue}]`;
        appendPhraseTag(tag);
        addControl({
          kind: "audio_tag",
          scope: "local",
          emittedText: tag,
          sentenceId,
          tokenIndex: index,
          sourceControlRefs: motionCue.sourceControlRefs,
          evidence: motionCue.evidence,
        });
      });
      const token = tokenByIndex.get(index)!;
      sourceOffsets.set(index, Array.from(text).length);
      renderedSourceIndexes.push(index);
      append(token.char);

      const prolongation = renderedProlongations.get(index);
      if (prolongation) {
        const suffix = prolongationText();
        append(suffix);
        addControl({
          kind: "prolongation",
          scope: "local",
          emittedText: suffix,
          sentenceId,
          tokenIndex: index,
          sourceControlRefs: prolongation.refs,
          evidence: {
            source: "acoustic",
            localDurationRatio: prolongation.localDurationRatio!,
            ...(prolongation.timingStrength
              ? { timingStrength: prolongation.timingStrength }
              : {}),
            ...(prolongation.phraseExpansion
              ? { phraseExpansion: prolongation.phraseExpansion }
              : {}),
            confidence: prolongation.confidence!,
          },
        });
      } else if (explicitPauses.has(index)) {
        const pause = explicitPauses.get(index)!;
        const punctuation = pause.level === "paragraph" ? "……" : "，";
        append(punctuation);
        addControl({
          kind: "pause",
          scope: "local",
          emittedText: punctuation,
          sentenceId,
          tokenIndex: index,
          sourceControlRefs: pause.refs,
          evidence: pause.evidence,
        });
      }
    });

    if (sentencePosition < sentences.length - 1) {
      const lastSpokenIndex = [...sentenceIndexes]
        .reverse()
        .find((index) => isSpokenCharacter(tokenByIndex.get(index)?.char ?? ""));
      const finalSourceCharacter = tokenByIndex.get(sentenceIndexes.at(-1)!)?.char ?? "";
      const closesCompleteSentence = /[。！？!?\r\n]/u.test(finalSourceCharacter);
      const boundaryPause = lastSpokenIndex === undefined
        ? undefined
        : pauses.get(lastSpokenIndex);
      if (
        closesCompleteSentence
        && lastSpokenIndex !== undefined
        && boundaryPause
        && boundaryPause.level !== "light"
      ) {
        const pauseTag = boundaryPause.level === "paragraph"
          ? "[long pause]"
          : "[short pause]";
        ensureNewlines(1);
        append(pauseTag);
        addControl({
          kind: "pause",
          scope: "sentence",
          emittedText: pauseTag,
          sentenceId,
          tokenIndex: lastSpokenIndex,
          sourceControlRefs: boundaryPause.refs,
          evidence: boundaryPause.evidence,
        });
        ensureNewlines(1);
      }
    }
  });

  if (expectedIndex !== canonicalTokens.length) {
    throw new Error(`句子仅覆盖 ${expectedIndex}/${canonicalTokens.length} 个正文 token。`);
  }

  const validation = validateExecutionPlan(
    text,
    canonicalTokens,
    sourceOffsets,
    renderedSourceIndexes,
    sentenceTokenIndexes,
    controls,
    activeTimingProfile,
  );
  return {
    text,
    sourceOffsets,
    sourceTokens: canonicalTokens,
    sentenceTokenIndexes,
    executionPlan: {
      controls,
      timingProfile: hasAcousticTimingProfile ? activeTimingProfile : undefined,
      validation,
    },
  };
}

function readAlignment(responseValue: unknown) {
  const response = object(responseValue);
  const candidates = [response.alignment, response.normalized_alignment];
  for (const candidate of candidates) {
    const alignment = object(candidate);
    const characters = Array.isArray(alignment.characters)
      ? alignment.characters.map(String)
      : [];
    const starts = Array.isArray(alignment.character_start_times_seconds)
      ? alignment.character_start_times_seconds.map(Number)
      : [];
    const ends = Array.isArray(alignment.character_end_times_seconds)
      ? alignment.character_end_times_seconds.map(Number)
      : [];
    if (
      characters.length
      && starts.length === characters.length
      && ends.length === characters.length
      && starts.every(Number.isFinite)
      && ends.every(Number.isFinite)
    ) {
      return { characters, starts, ends };
    }
  }
  throw new Error("Eleven TTS 未返回完整字符时间戳。");
}

function directPromptMapping(prompt: CompiledTtsPrompt, characters: string[]) {
  const promptCharacters = Array.from(prompt.text);
  if (
    promptCharacters.length !== characters.length
    || promptCharacters.some((character, index) => character !== characters[index])
  ) return undefined;
  return new Map(prompt.sourceTokens.map((token) => [token.index, prompt.sourceOffsets.get(token.index)!]));
}

function fallbackSourceMapping(prompt: CompiledTtsPrompt, characters: string[]) {
  const visible: Array<{ character: string; providerIndex: number }> = [];
  let inTag = false;
  characters.forEach((character, providerIndex) => {
    if (character === "[") { inTag = true; return; }
    if (inTag) {
      if (character === "]") inTag = false;
      return;
    }
    visible.push({ character, providerIndex });
  });

  const mapping = new Map<number, number>();
  let cursor = 0;
  prompt.sourceTokens.forEach((token) => {
    const position = visible.findIndex(
      (item, index) => index >= cursor && item.character === token.char,
    );
    if (position >= 0) {
      mapping.set(token.index, visible[position].providerIndex);
      cursor = position + 1;
    }
  });
  return mapping;
}

/** Build a strict source-token timeline from Eleven's raw/normalized alignment. */
export function buildElevenTimeline(
  specValue: unknown,
  prompt: CompiledTtsPrompt,
  responseValue: unknown,
): TtsTimeline {
  const spec = object(specValue);
  if (!Array.isArray(spec.tokens)) throw new Error("控制谱缺少 tokens。");
  const { characters, starts, ends } = readAlignment(responseValue);
  const mapping = directPromptMapping(prompt, characters)
    ?? fallbackSourceMapping(prompt, characters);
  const missingSpoken = prompt.sourceTokens.filter(
    (token) => isSpokenCharacter(token.char) && !mapping.has(token.index),
  );
  if (missingSpoken.length) {
    const preview = missingSpoken.slice(0, 5).map((token) => `${token.index}:${token.char}`).join("、");
    throw new Error(`Eleven 字符时间戳缺少正文 token（${preview}），已拒绝保存错位音频。`);
  }

  const matchedTimes = new Map<number, { startMs: number; endMs: number }>();
  prompt.sourceTokens.forEach((token) => {
    const providerIndex = mapping.get(token.index);
    if (providerIndex === undefined) return;
    const startMs = Math.max(0, Math.round(starts[providerIndex] * 1000));
    const endMs = Math.max(startMs, Math.round(ends[providerIndex] * 1000));
    matchedTimes.set(token.index, { startMs, endMs });
  });

  const timelineTokens: TtsTimeline["tokens"] = [];
  let previousStart = 0;
  prompt.sourceTokens.forEach((token, position) => {
    let timing = matchedTimes.get(token.index);
    if (!timing) {
      const previous = [...timelineTokens].reverse()[0];
      const next = prompt.sourceTokens.slice(position + 1)
        .map((candidate) => matchedTimes.get(candidate.index))
        .find(Boolean);
      const boundary = previous?.endMs ?? next?.startMs ?? previousStart;
      timing = { startMs: boundary, endMs: boundary };
    }
    if (timing.startMs < previousStart) {
      throw new Error(`Eleven token ${token.index} 时间戳不是单调递增。`);
    }
    previousStart = timing.startMs;
    timelineTokens.push({
      tokenId: token.id,
      tokenIndex: token.index,
      startMs: timing.startMs,
      endMs: timing.endMs,
      confidence: 1,
    });
  });

  const tokenTimeByIndex = new Map(timelineTokens.map((token) => [token.tokenIndex, token]));
  const providerDurationMs = Math.max(...ends.map((value) => Math.round(value * 1000)), 0);
  const sentences = prompt.sentenceTokenIndexes.map((sentence, position) => {
    const sentenceTokens = sentence.tokenIndexes.map((index) => tokenTimeByIndex.get(index)!);
    const spoken = sentenceTokens.filter((token) => token.endMs > token.startMs);
    if (!spoken.length) throw new Error(`第 ${position + 1} 句没有可用的 Eleven 时间戳。`);
    const nextSentence = prompt.sentenceTokenIndexes[position + 1];
    const nextStart = nextSentence
      ? tokenTimeByIndex.get(nextSentence.tokenIndexes[0])?.startMs
      : undefined;
    return {
      sentenceId: sentence.sentenceId,
      startMs: spoken[0].startMs,
      endMs: Math.max(spoken.at(-1)!.endMs, nextStart ?? providerDurationMs),
    };
  });

  return {
    granularity: "character",
    durationMs: Math.max(providerDurationMs, timelineTokens.at(-1)?.endMs ?? 0),
    tokens: timelineTokens,
    sentences,
  };
}
