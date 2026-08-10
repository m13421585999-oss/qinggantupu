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

function rhythmKey(value: unknown) {
  const rhythm = object(value);
  return String(typeof value === "string" ? value : rhythm.type ?? rhythm.label ?? "relaxed");
}

type MinimalCue =
  | "softly"
  | "brightly"
  | "solemnly"
  | "restrained"
  | "focused"
  | "resonant"
  | "quietly"
  | "gentle"
  | "thoughtful"
  | "building"
  | "settling"
  | "slightly breathy";

export const ELEVEN_V3_MINIMAL_AUDIO_TAGS: readonly MinimalCue[] = [
  "softly",
  "brightly",
  "solemnly",
  "restrained",
  "focused",
  "resonant",
  "quietly",
  "gentle",
  "thoughtful",
  "building",
  "settling",
  "slightly breathy",
] as const;

const GLOBAL_RHYTHM_CUES: Record<string, MinimalCue> = {
  light: "brightly",
  solemn: "solemnly",
  relaxed: "softly",
  tense: "focused",
  soaring: "resonant",
  low: "quietly",
};

const SENTENCE_RHYTHM_CUES: Record<string, MinimalCue> = {
  light: "brightly",
  solemn: "solemnly",
  relaxed: "gentle",
  tense: "focused",
  soaring: "resonant",
  low: "quietly",
};

const PROSODY_CUES: Record<string, MinimalCue> = {
  peak: "building",
  valley: "thoughtful",
  rising: "building",
  falling: "settling",
};

const FOCUS_REALIZATION_CUES: Record<string, MinimalCue> = {
  stronger: "focused",
  supported: "focused",
  soft_emphasis: "gentle",
  soft: "gentle",
  slower: "thoughtful",
  lower_weighted: "restrained",
  breathy: "slightly breathy",
  breathy_to_supported: "building",
  voice_shift: "thoughtful",
  combined: "focused",
};

const VOICE_QUALITY_CUES: Record<string, MinimalCue | undefined> = {
  neutral: undefined,
  solid: "focused",
  slightly_breathy: "slightly breathy",
  breathy: "slightly breathy",
  mixed: "gentle",
  breathy_to_supported: "building",
  breathy_to_mixed: "gentle",
  mixed_to_solid: "building",
  solid_to_soft: "settling",
};

const DELIVERY_MODE_CUES: Record<string, MinimalCue> = {
  natural_narration: "gentle",
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
  { pattern: /紧张|专注|坚定|focused|tense|firm/u, cue: "focused" },
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

function stringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function cueForEmotion(value: string) {
  return EMOTION_CUE_RULES.find((rule) => rule.pattern.test(value.toLowerCase()))?.cue;
}

function addCueScore(scores: Map<MinimalCue, number>, cue: MinimalCue | undefined, score: number) {
  if (cue) scores.set(cue, (scores.get(cue) ?? 0) + score);
}

function cueIsAvoided(cue: MinimalCue, values: string[]) {
  const avoid = values.join(" ").toLowerCase();
  if (!avoid) return false;
  if (cue === "slightly breathy" && /breathy|气声|虚声/u.test(avoid)) return true;
  if (cue === "resonant" && /shout|喊|过度高亢|过度用力|too loud/u.test(avoid)) return true;
  if (cue === "brightly" && /过亮|过度欢快|too bright/u.test(avoid)) return true;
  if (cue === "building" && /过度推进|过度上扬|exaggerated rise/u.test(avoid)) return true;
  return false;
}

function strongestAllowedCue(
  scores: Map<MinimalCue, number>,
  avoid: string[],
): [MinimalCue, number] | undefined {
  return [...scores.entries()]
    .filter(([cue]) => !cueIsAvoided(cue, avoid))
    .sort((left, right) => right[1] - left[1])[0];
}

function documentRhythm(spec: JsonObject, sentences: JsonObject[]) {
  const profile = object(spec.documentProfile ?? spec.document_profile);
  const explicit = profile.baseRhythm ?? profile.base_rhythm;
  if (explicit !== undefined && explicit !== null) return rhythmKey(explicit);

  const counts = new Map<string, number>();
  sentences.forEach((sentence) => {
    const rhythm = rhythmKey(sentence.rhythm);
    counts.set(rhythm, (counts.get(rhythm) ?? 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "relaxed";
}

function globalDeliveryCue(spec: JsonObject, sentences: JsonObject[]) {
  const scores = new Map<MinimalCue, number>();
  const hidden = profile(spec);
  const document = object(spec.documentProfile ?? spec.document_profile);
  const rhythmCue = GLOBAL_RHYTHM_CUES[documentRhythm(spec, sentences)] ?? "softly";
  addCueScore(scores, rhythmCue, 3);

  const deliveryMode = String(
    hidden.deliveryMode ?? hidden.delivery_mode
      ?? document.deliveryMode ?? document.delivery_mode
      ?? "",
  );
  addCueScore(scores, DELIVERY_MODE_CUES[deliveryMode], 2);

  const voiceQuality = String(
    hidden.voiceQuality ?? hidden.voice_quality
      ?? document.voiceQuality ?? document.voice_quality
      ?? "",
  );
  addCueScore(scores, VOICE_QUALITY_CUES[voiceQuality], 5.2);

  const emotionTone = stringArray(
    hidden.emotionTone ?? hidden.emotion_tone
      ?? document.emotionalTone ?? document.emotional_tone,
  );
  emotionTone.forEach((tone) => addCueScore(scores, cueForEmotion(tone), 4.8));

  const focusStyle = String(hidden.focusStyle ?? hidden.focus_style ?? "");
  addCueScore(scores, FOCUS_REALIZATION_CUES[focusStyle], 3.2);
  const amplitude = String(hidden.expressionAmplitude ?? hidden.expression_amplitude ?? "");
  addCueScore(scores, EXPRESSION_AMPLITUDE_CUES[amplitude], 3.5);

  return strongestAllowedCue(scores, stringArray(hidden.avoid))?.[0] ?? rhythmCue;
}

function sentenceCueCandidate(
  sentence: JsonObject,
  baseRhythm: string,
  previousRhythm: string,
) {
  const scores = new Map<MinimalCue, number>();
  const hidden = profile(sentence);

  const rhythm = rhythmKey(sentence.rhythm);
  if (rhythm !== baseRhythm) {
    addCueScore(scores, SENTENCE_RHYTHM_CUES[rhythm], 3.2 + (rhythm !== previousRhythm ? 0.8 : 0));
  } else if (rhythm !== previousRhythm) {
    addCueScore(scores, SENTENCE_RHYTHM_CUES[rhythm], 3.4);
  }

  const prosody = Array.isArray(sentence.prosody) ? sentence.prosody.map(object) : [];
  const prosodyTypes = new Set(prosody.map((event) => String(event.type ?? "")));
  const prosodyWeight = prosody.reduce((weight, event) => {
    const strength = Math.max(1, Math.min(3, integer(event.strength) ?? 1));
    const confidence = Math.max(0, Math.min(1, finiteNumber(event.confidence, 0.7)));
    return Math.max(weight, 1.2 + strength * 0.65 + confidence * 0.45);
  }, 0);
  if (prosodyTypes.has("valley") || (prosodyTypes.has("falling") && prosodyTypes.has("rising"))) {
    addCueScore(scores, "thoughtful", prosodyWeight + 0.7);
  } else {
    prosody.forEach((event) => addCueScore(
      scores,
      PROSODY_CUES[String(event.type ?? "")],
      prosodyWeight,
    ));
  }

  const voiceQuality = String(hidden.voiceQuality ?? hidden.voice_quality ?? "");
  addCueScore(scores, VOICE_QUALITY_CUES[voiceQuality], 4.2);
  stringArray(hidden.emotionTone ?? hidden.emotion_tone)
    .forEach((tone) => addCueScore(scores, cueForEmotion(tone), 4));
  const focusStyle = String(hidden.focusStyle ?? hidden.focus_style ?? "");
  addCueScore(scores, FOCUS_REALIZATION_CUES[focusStyle], 2.8);
  const amplitude = String(hidden.expressionAmplitude ?? hidden.expression_amplitude ?? "");
  addCueScore(scores, EXPRESSION_AMPLITUDE_CUES[amplitude], 3.1);
  const continuity = String(hidden.continuity ?? sentence.continuity ?? "");
  if (continuity === "segmented") addCueScore(scores, "thoughtful", 2.7);

  const focusEntries = Array.isArray(sentence.focus) ? sentence.focus.map(object) : [];
  focusEntries
    .filter((focus) => String(focus.level ?? "primary") === "primary")
    .slice(0, 1)
    .forEach((focus) => {
      const realization = String(focus.preferredRealization ?? focus.preferred_realization ?? "free");
      const confidence = Math.max(0, Math.min(1, finiteNumber(focus.confidence, 0.7)));
      addCueScore(scores, FOCUS_REALIZATION_CUES[realization], 1.1 + confidence * 0.6);
    });

  const ending = object(sentence.endingIntonation ?? sentence.ending_intonation);
  const endingStrength = Math.max(1, Math.min(3, integer(ending.strength) ?? 1));
  if (endingStrength >= 2) {
    if (ending.type === "rising") addCueScore(scores, "building", 0.5 + endingStrength * 0.3);
    else if (ending.type === "falling") addCueScore(scores, "settling", 0.5 + endingStrength * 0.3);
  }

  const avoid = [
    ...stringArray(hidden.avoid),
    ...stringArray(sentence.avoid),
  ];
  const selected = strongestAllowedCue(scores, avoid);
  if (!selected || selected[1] < 2.7) return undefined;
  return { cue: selected[0], score: selected[1], rhythm };
}

function planSentenceCues(spec: JsonObject, sentences: JsonObject[], globalCue: MinimalCue) {
  const baseRhythm = documentRhythm(spec, sentences);
  const cueBudget = Math.min(4, Math.max(1, Math.ceil(sentences.length / 4)));
  const planned = new Map<number, MinimalCue>();
  let previousRhythm = baseRhythm;
  let lastCue = globalCue;
  let lastCuePosition = -3;

  sentences.forEach((sentence, position) => {
    const candidate = sentenceCueCandidate(sentence, baseRhythm, previousRhythm);
    previousRhythm = rhythmKey(sentence.rhythm);
    if (!candidate || planned.size >= cueBudget) return;
    if (candidate.cue === lastCue) return;
    const spacedEnough = position - lastCuePosition >= 2;
    if (position === 0 || (!spacedEnough && candidate.score < 4.5)) return;
    planned.set(position, candidate.cue);
    lastCue = candidate.cue;
    lastCuePosition = position;
  });

  return planned;
}

function isSpokenCharacter(value: string) {
  return /[\p{L}\p{N}]/u.test(value);
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

  let text = "";
  let expectedIndex = 0;
  const sourceOffsets = new Map<number, number>();
  const sentenceTokenIndexes: CompiledTtsPrompt["sentenceTokenIndexes"] = [];
  const append = (value: string | undefined) => {
    if (value) text += value;
  };
  const ensureNewlines = (count: number) => {
    const trailing = text.match(/\n+$/u)?.[0].length ?? 0;
    if (trailing < count) append("\n".repeat(count - trailing));
  };

  const globalCue = globalDeliveryCue(spec, sentences);
  const sentenceCues = planSentenceCues(spec, sentences, globalCue);
  append(`[${globalCue}]`);
  ensureNewlines(2);

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
    if (sentenceCue) {
      ensureNewlines(2);
      append(`[${sentenceCue}]`);
      ensureNewlines(1);
    }

    const pauses = new Map<number, "short" | "long">();
    const pauseEntries = Array.isArray(sentence.pauses) ? sentence.pauses.map(object) : [];
    pauseEntries.forEach((pause) => {
      const index = integer(pause.afterTokenIndex ?? pause.after_index);
      if (index !== undefined) pauses.set(index, pause.type === "long" ? "long" : "short");
    });

    const prolongations = new Map<number, number>();
    const prolongEntries = Array.isArray(sentence.prolongations)
      ? sentence.prolongations.map(object)
      : [];
    prolongEntries.forEach((prolongation) => {
      const index = integer(prolongation.tokenIndex ?? prolongation.token_index);
      const degree = integer(prolongation.degree ?? prolongation.strength) ?? 1;
      if (index !== undefined) prolongations.set(index, degree);
    });

    const renderedProlongations = new Set([...prolongations.entries()]
      .filter(([, degree]) => degree >= 2)
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 2)
      .map(([index]) => index));
    const pauseCandidates = [...pauses.entries()]
      .sort((left, right) => (right[1] === "long" ? 1 : 0) - (left[1] === "long" ? 1 : 0));
    const explicitPause = pauseCandidates.find(([index]) => {
      const offset = sentenceIndexes.indexOf(index);
      const current = tokenByIndex.get(index)?.char ?? "";
      const next = tokenByIndex.get(sentenceIndexes[offset + 1])?.char ?? "";
      return offset >= 0
        && offset < sentenceIndexes.length - 1
        && !/[，。！？、；：,!?;:\s]/u.test(current)
        && !/[，。！？、；：,!?;:\s]/u.test(next);
    });

    sentenceIndexes.forEach((index) => {
      const token = tokenByIndex.get(index)!;
      sourceOffsets.set(index, Array.from(text).length);
      append(token.char);

      if (renderedProlongations.has(index)) append("——");
      else if (explicitPause?.[0] === index) append(explicitPause[1] === "long" ? "……" : "，");
    });
    if (
      sentencePosition < sentences.length - 1
      && !/\s/u.test(tokenByIndex.get(sentenceIndexes.at(-1)!)?.char ?? "")
    ) ensureNewlines(1);
  });

  if (expectedIndex !== canonicalTokens.length) {
    throw new Error(`句子仅覆盖 ${expectedIndex}/${canonicalTokens.length} 个正文 token。`);
  }

  return { text, sourceOffsets, sourceTokens: canonicalTokens, sentenceTokenIndexes };
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
