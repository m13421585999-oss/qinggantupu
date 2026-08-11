import type {
  ControlSpec,
  EndingTone,
  FocusRealization,
  FocusStyle,
  FocusTarget,
  HiddenPerformanceProfile,
  MacroProsodyPath,
  PauseMark,
  ProlongMark,
  ProsodyEvent,
  ProsodyType,
  RecitationSentence,
  Rhythm,
  TimingProfile,
  TimedToken,
  TokenSpan,
  VoiceQuality,
} from "./recitation-schema";
import { normalizeTimingProfile } from "./timing-profile.ts";

type JsonObject = Record<string, unknown>;

const rhythmAliases: Record<string, Rhythm> = {
  light: "light",
  "轻快": "light",
  solemn: "solemn",
  "凝重": "solemn",
  relaxed: "relaxed",
  "舒缓": "relaxed",
  tense: "tense",
  "紧张": "tense",
  soaring: "soaring",
  "高亢": "soaring",
  low: "low",
  "低沉": "low",
};

const prosodyAliases: Record<string, ProsodyType> = {
  peak: "peak",
  crest: "peak",
  "波峰": "peak",
  valley: "valley",
  trough: "valley",
  "波谷": "valley",
  rising: "rising",
  "起潮": "rising",
  falling: "falling",
  "落潮": "falling",
};

const endingAliases: Record<string, EndingTone> = {
  rising: "rising",
  rise: "rising",
  "上扬": "rising",
  "↗": "rising",
  falling: "falling",
  fall: "falling",
  "下抑": "falling",
  "↘": "falling",
  level: "level",
  "平直": "level",
  "平收": "level",
  "→": "level",
};

const deliveryModeAliases: Record<string, NonNullable<HiddenPerformanceProfile["deliveryMode"]>> = {
  natural_narration: "natural_narration",
  "自然叙述": "natural_narration",
  lyrical_recitation: "lyrical_recitation",
  "抒情朗诵": "lyrical_recitation",
  stage_recitation: "stage_recitation",
  "舞台朗诵": "stage_recitation",
};

const continuityAliases: Record<string, NonNullable<HiddenPerformanceProfile["continuity"]>> = {
  connected: "connected",
  "连贯": "connected",
  balanced: "balanced",
  "均衡": "balanced",
  segmented: "segmented",
  "分段": "segmented",
};

const voiceQualityAliases: Record<string, VoiceQuality> = {
  neutral: "neutral",
  solid: "solid",
  slightly_breathy: "slightly_breathy",
  breathy: "breathy",
  mixed: "mixed",
  breathy_to_supported: "breathy_to_supported",
  breathy_to_mixed: "breathy_to_mixed",
  mixed_to_solid: "mixed_to_solid",
  solid_to_soft: "solid_to_soft",
};

const focusStyleAliases: Record<string, FocusStyle> = {
  supported: "supported",
  soft: "soft",
  slower: "slower",
  lower_weighted: "lower_weighted",
  breathy: "breathy",
  breathy_to_supported: "breathy_to_supported",
};

const expressionAmplitudeAliases: Record<string, NonNullable<HiddenPerformanceProfile["expressionAmplitude"]>> = {
  low: "low",
  "低": "low",
  medium: "medium",
  "中": "medium",
  high: "high",
  "高": "high",
};

const focusRealizationAliases: Record<string, FocusRealization> = {
  free: "free",
  stronger: "stronger",
  supported: "stronger",
  soft: "soft_emphasis",
  soft_emphasis: "soft_emphasis",
  slower: "slower",
  lower_weighted: "lower_weighted",
  breathy: "breathy",
  voice_shift: "voice_shift",
  combined: "combined",
  breathy_to_supported: "combined",
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function clampIndex(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseStrength(value: unknown): 1 | 2 | 3 {
  const aliases: Record<string, 1 | 2 | 3> = { "轻": 1, "中": 2, "强": 3 };
  const parsed = aliases[String(value)] ?? integer(value) ?? 2;
  return clampIndex(parsed, 1, 3) as 1 | 2 | 3;
}

function normalizedKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseAliasedValue<T>(
  value: unknown,
  aliases: Record<string, T>,
  label: string,
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = aliases[normalizedKey(value)] ?? aliases[String(value).trim()];
  if (!parsed) throw new Error(`${label}包含不支持的值：${String(value)}`);
  return parsed;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function parsePerformanceProfile(value: unknown): HiddenPerformanceProfile | undefined {
  const direct = object(value);
  const nestedValue = direct.performance_profile ?? direct.performanceProfile;
  const nested = object(nestedValue);
  const source = Object.keys(nested).length ? { ...direct, ...nested } : direct;
  const voiceValue = source.voice_quality ?? source.voiceQuality;

  const profile: HiddenPerformanceProfile = {
    sourceControlRef: string(source.source_control_ref ?? source.sourceControlRef),
    deliveryMode: parseAliasedValue(
      source.delivery_mode ?? source.deliveryMode,
      deliveryModeAliases,
      "delivery_mode",
    ),
    emotionTone: stringList(
      source.emotion_tone ?? source.emotionTone ?? source.emotional_tone ?? source.emotionalTone,
    ),
    continuity: parseAliasedValue(source.continuity, continuityAliases, "continuity"),
    voiceQuality: typeof voiceValue === "string"
      ? parseAliasedValue(voiceValue, voiceQualityAliases, "voice_quality")
      : undefined,
    focusStyle: parseAliasedValue(
      source.focus_style ?? source.focusStyle,
      focusStyleAliases,
      "focus_style",
    ),
    expressionAmplitude: parseAliasedValue(
      source.expression_amplitude ?? source.expressionAmplitude,
      expressionAmplitudeAliases,
      "expression_amplitude",
    ),
    avoid: stringList(source.avoid),
  };

  return Object.values(profile).some((item) => item !== undefined) ? profile : undefined;
}

function parseTimingProfile(value: unknown): TimingProfile | undefined {
  if (value === undefined || value === null) return undefined;
  const timingProfile = normalizeTimingProfile(value);
  if (!timingProfile) {
    throw new Error("timing_profile 必须来自 acoustic evidence，并包含有效的 global_pace。");
  }
  return timingProfile;
}

function validateTimingProfileIndexes(timingProfile: TimingProfile, tokenCount: number) {
  const validIndex = (value: number) => value >= 0 && value < tokenCount;
  timingProfile.pauseHierarchy.forEach((entry) => {
    if (!validIndex(entry.afterTokenIndex)) {
      throw new Error("timing_profile.pause_hierarchy 引用了无效 token index。");
    }
  });
  timingProfile.phraseDurationProfile.forEach((entry) => {
    if (!validIndex(entry.startIndex) || !validIndex(entry.endIndex) || entry.endIndex < entry.startIndex) {
      throw new Error("timing_profile.phrase_duration_profile 引用了无效 token 区间。");
    }
  });
  timingProfile.prolongationStrength.forEach((entry) => {
    if (!validIndex(entry.tokenIndex)) {
      throw new Error("timing_profile.prolongation_strength 引用了无效 token index。");
    }
  });
}

function voiceQualityRange(value: VoiceQuality | undefined): RecitationSentence["voiceQuality"] {
  switch (value) {
    case "breathy_to_supported": return { start: "breathy", transition: value, end: "solid" };
    case "breathy_to_mixed": return { start: "breathy", transition: value, end: "mixed" };
    case "mixed_to_solid": return { start: "mixed", transition: value, end: "solid" };
    case "solid_to_soft": return { start: "solid", transition: value, end: "slightly_breathy" };
    default: return { start: value ?? "neutral", end: value ?? "neutral" };
  }
}

function parseSpan(value: unknown, fallback: TokenSpan, min: number, max: number): TokenSpan {
  const item = object(value);
  const pair = Array.isArray(value) ? value : undefined;
  const start = integer(pair?.[0] ?? item.start ?? item.start_index ?? item.anchor_start);
  const end = integer(pair?.[1] ?? item.end ?? item.end_index ?? item.anchor_end);
  const safeStart = clampIndex(start ?? fallback.start, min, max);
  const safeEnd = clampIndex(end ?? fallback.end, safeStart, max);
  return { start: safeStart, end: safeEnd };
}

function indexList(value: unknown): number[] {
  if (typeof value === "number") return [Math.trunc(value)];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "number") return Math.trunc(item);
      const entry = object(item);
      return integer(entry.index ?? entry.token_index);
    })
    .filter((item): item is number => item !== undefined);
}

function indexesFromEntry(value: unknown, min: number, max: number): number[] {
  if (typeof value === "number") return [clampIndex(Math.trunc(value), min, max)];
  const entry = object(value);
  const explicit = indexList(
    entry.token_indexes ?? entry.tokenIndexes ?? entry.indexes ?? entry.tokens,
  );
  const single = integer(entry.token_index ?? entry.tokenIndex ?? entry.index);
  if (explicit.length || single !== undefined) {
    return [...new Set(explicit.length ? explicit : [single!])]
      .filter((item) => item >= min && item <= max)
      .sort((a, b) => a - b);
  }
  const span = parseSpan(
    entry.focus_span ?? entry.focusSpan ?? entry.span ?? entry.active_span ?? entry.activeSpan ?? entry,
    { start: min, end: min - 1 },
    min,
    max,
  );
  if (span.end < span.start) return [];
  return Array.from({ length: span.end - span.start + 1 }, (_, offset) => span.start + offset);
}

function parseFocus(
  raw: unknown,
  sentenceId: string,
  tokensByIndex: Map<number, TimedToken>,
  min: number,
  max: number,
): FocusTarget[] {
  const entries = Array.isArray(raw) ? raw : [];
  return entries.flatMap((value, position) => {
    const indexes = indexesFromEntry(value, min, max);
    if (!indexes.length) return [];
    const entry = object(value);
    const rawCore = entry.focus_core ?? entry.focusCore ?? entry.core_span ?? entry.coreSpan;
    const coreIndexes = rawCore === undefined ? [] : indexesFromEntry(rawCore, min, max);
    const level = entry.level === "secondary" || entry.level === "次重音"
      ? "secondary"
      : "primary";
    const realizationValue = entry.preferred_realization
      ?? entry.preferredRealization
      ?? entry.focus_style
      ?? entry.focusStyle;
    const preferredRealization = parseAliasedValue(
      realizationValue,
      focusRealizationAliases,
      "focus preferred_realization",
    ) ?? "free";
    const rawAllowed = stringList(entry.allowed_realizations ?? entry.allowedRealizations) ?? [];
    const allowedRealizations = [...new Set([
      preferredRealization,
      ...rawAllowed.map((item) => parseAliasedValue(
        item,
        focusRealizationAliases,
        "focus allowed_realizations",
      )!),
    ])];
    return [{
      id: `${sentenceId}-focus-${position + 1}`,
      sourceControlRef: string(entry.source_control_ref ?? entry.sourceControlRef),
      tokenIds: indexes.map((index) => tokensByIndex.get(index)?.id).filter(Boolean) as string[],
      tokenIndexes: indexes,
      coreTokenIds: coreIndexes.map((index) => tokensByIndex.get(index)?.id).filter(Boolean) as string[],
      coreTokenIndexes: coreIndexes,
      level,
      confidence: number(entry.confidence),
      explanation: string(entry.explanation),
      preferredRealization,
      allowedRealizations,
      avoid: stringList(entry.avoid) ?? [],
    }];
  });
}

function parsePauses(
  raw: unknown,
  sentenceId: string,
  tokensByIndex: Map<number, TimedToken>,
  min: number,
  max: number,
): PauseMark[] {
  const entries = Array.isArray(raw) ? raw : [];
  return entries.flatMap((value, position) => {
    const entry = object(value);
    const after = integer(
      entry.after_index ?? entry.after_token_index ?? entry.afterTokenIndex ?? entry.token_index,
    );
    if (after === undefined || after < min || after > max) return [];
    const token = tokensByIndex.get(after);
    if (!token) return [];
    const marker = String(entry.type ?? entry.mark ?? "short");
    return [{
      id: `${sentenceId}-pause-${position + 1}`,
      sourceControlRef: string(entry.source_control_ref ?? entry.sourceControlRef),
      afterTokenId: token.id,
      afterTokenIndex: after,
      type: marker === "long" || marker === "///" || marker === "长停" ? "long" : "short",
      observedDurationMs: number(entry.observed_duration_ms ?? entry.gap_ms),
      source: "human" as const,
    }];
  });
}

function parseProlongations(
  raw: unknown,
  sentenceId: string,
  tokensByIndex: Map<number, TimedToken>,
  min: number,
  max: number,
): ProlongMark[] {
  const entries = Array.isArray(raw) ? raw : [];
  return entries.flatMap((value, position) => {
    const entry = object(value);
    const index = integer(entry.token_index ?? entry.tokenIndex ?? entry.index ?? value);
    if (index === undefined || index < min || index > max) return [];
    const token = tokensByIndex.get(index);
    if (!token) return [];
    const sourceValue = String(entry.source ?? "legacy");
    const source = sourceValue === "acoustic" || sourceValue === "human"
      ? sourceValue
      : "legacy";
    const explicitSourceRef = string(entry.source_control_ref ?? entry.sourceControlRef);
    return [{
      id: `${sentenceId}-prolong-${position + 1}`,
      sourceControlRef: explicitSourceRef
        ?? (source === "acoustic"
          ? `analysis.acoustic_evidence.duration_outliers.token-${index}`
          : undefined),
      tokenId: token.id,
      tokenIndex: index,
      degree: parseStrength(entry.degree ?? entry.strength ?? 1),
      localDurationRatio: number(entry.local_duration_ratio ?? entry.localDurationRatio),
      confidence: number(entry.confidence),
      observedDurationMs: number(entry.duration_ms ?? entry.durationMs),
      source,
      purpose: typeof entry.purpose === "string" ? entry.purpose : undefined,
    }];
  });
}

function parseProsody(raw: unknown, sentenceId: string, min: number, max: number): ProsodyEvent[] {
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries.flatMap((value, position) => {
    const entry = object(value);
    const type = prosodyAliases[String(entry.type ?? "")];
    if (!type) return [];
    const activeSpan = parseSpan(
      entry.active_span ?? entry.activeSpan,
      { start: min, end: max },
      min,
      max,
    );
    const coreZone = parseSpan(
      entry.core_zone ?? entry.coreZone,
      activeSpan,
      activeSpan.start,
      activeSpan.end,
    );
    return [{
      id: `${sentenceId}-prosody-${position + 1}`,
      sourceControlRef: string(entry.source_control_ref ?? entry.sourceControlRef),
      type,
      activeSpan,
      coreZone,
      strength: parseStrength(entry.strength),
      confidence: number(entry.confidence),
    }];
  });
}

function parseEnding(value: unknown): {
  sourceControlRef?: string;
  type: EndingTone;
  strength: 1 | 2 | 3;
  confidence?: number;
  source?: "acoustic" | "human" | "legacy";
} {
  const entry = object(value);
  const label = typeof value === "string" ? value : entry.type;
  const source = entry.source === "acoustic" || entry.source === "human"
    ? entry.source
    : "legacy";
  return {
    sourceControlRef: string(entry.source_control_ref ?? entry.sourceControlRef),
    type: endingAliases[String(label ?? "level")] ?? "level",
    strength: parseStrength(entry.strength ?? 1),
    confidence: number(entry.confidence),
    source,
  };
}

function parseMacroProsodyPath(value: unknown, min: number, max: number): MacroProsodyPath | undefined {
  const entry = object(value);
  const rawPoints = Array.isArray(entry.points) ? entry.points : [];
  const points = rawPoints.flatMap((value) => {
    const point = object(value);
    const tokenIndex = integer(point.token_index ?? point.tokenIndex);
    const normalizedLevel = number(point.normalized_level ?? point.normalizedLevel);
    if (tokenIndex === undefined || tokenIndex < min || tokenIndex > max || normalizedLevel === undefined) {
      return [];
    }
    return [{
      tokenIndex,
      normalizedLevel,
      rawNormalizedPitch: number(point.raw_normalized_pitch ?? point.rawNormalizedPitch),
    }];
  }).sort((left, right) => left.tokenIndex - right.tokenIndex);
  if (!points.length) return undefined;
  const segments = (Array.isArray(entry.segments) ? entry.segments : []).flatMap((value) => {
    const segment = object(value);
    const startIndex = integer(segment.start_index ?? segment.startIndex);
    const endIndex = integer(segment.end_index ?? segment.endIndex);
    const type = String(segment.type ?? "");
    const startLevel = number(segment.start_level ?? segment.startLevel);
    const endLevel = number(segment.end_level ?? segment.endLevel);
    if (
      startIndex === undefined || endIndex === undefined || startIndex < min || endIndex > max
      || endIndex < startIndex || !["level", "rising", "falling"].includes(type)
      || startLevel === undefined || endLevel === undefined
    ) return [];
    return [{
      startIndex,
      endIndex,
      type: type as "level" | "rising" | "falling",
      startLevel,
      endLevel,
      confidence: number(segment.confidence),
    }];
  });
  return { points, segments, source: "acoustic" };
}

function parseRhythm(value: unknown): Rhythm {
  const entry = object(value);
  return rhythmAliases[String(typeof value === "string" ? value : entry.type ?? entry.label)] ?? "relaxed";
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Convert machine pinyin such as `xiang3`/`lv4` into user-facing tone marks. */
export function displayPinyinFromMachine(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/u:/g, "ü").replace(/v/g, "ü");
  const match = normalized.match(/^([a-zü]+)([0-5])$/i);
  if (!match) return normalized;
  const syllable = match[1];
  const tone = Number(match[2]);
  if (tone === 0 || tone === 5) return syllable;

  const vowels = ["a", "o", "e", "i", "u", "ü"];
  const marked: Record<string, string[]> = {
    a: ["ā", "á", "ǎ", "à"],
    o: ["ō", "ó", "ǒ", "ò"],
    e: ["ē", "é", "ě", "è"],
    i: ["ī", "í", "ǐ", "ì"],
    u: ["ū", "ú", "ǔ", "ù"],
    ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
  };
  let target = syllable.indexOf("a");
  if (target < 0) target = syllable.indexOf("e");
  if (target < 0 && syllable.includes("ou")) target = syllable.indexOf("o");
  if (target < 0) {
    for (let position = syllable.length - 1; position >= 0; position -= 1) {
      if (vowels.includes(syllable[position])) {
        target = position;
        break;
      }
    }
  }
  if (target < 0) return syllable;
  const vowel = syllable[target];
  return `${syllable.slice(0, target)}${marked[vowel][tone - 1]}${syllable.slice(target + 1)}`;
}

function validateSpan(
  value: unknown,
  sentenceNumber: number,
  label: string,
  min: number,
  max: number,
) {
  if (value === undefined || value === null) return;
  const item = object(value);
  const pair = Array.isArray(value) ? value : undefined;
  const start = integer(pair?.[0] ?? item.start ?? item.start_index ?? item.anchor_start);
  const end = integer(pair?.[1] ?? item.end ?? item.end_index ?? item.anchor_end);
  if (start === undefined || end === undefined || start < min || end > max || end < start) {
    throw new Error(`第 ${sentenceNumber} 句的${label}超出本句 token 范围（${min}–${max}）。`);
  }
}

function validateAnnotationIndexes(
  entry: JsonObject,
  sentenceNumber: number,
  min: number,
  max: number,
) {
  const ensure = (index: number | undefined, label: string) => {
    if (index === undefined || index < min || index > max) {
      throw new Error(`第 ${sentenceNumber} 句的${label}引用了无效 token index。`);
    }
  };

  const focus = Array.isArray(entry.focus) ? entry.focus : [];
  focus.forEach((value) => {
    if (typeof value === "number") {
      ensure(Math.trunc(value), "重音");
      return;
    }
    const item = object(value);
    const explicit = indexList(item.token_indexes ?? item.tokenIndexes ?? item.indexes ?? item.tokens);
    const single = integer(item.token_index ?? item.tokenIndex ?? item.index);
    if (explicit.length) explicit.forEach((index) => ensure(index, "重音"));
    else if (single !== undefined) ensure(single, "重音");
    else {
      const span = item.focus_span ?? item.focusSpan ?? item.span ?? item.active_span ?? item.activeSpan;
      if (span === undefined) throw new Error(`第 ${sentenceNumber} 句存在无法识别的重音标记。`);
      validateSpan(span, sentenceNumber, "重音区间", min, max);
      const parsedFocusSpan = parseSpan(span, { start: min, end: max }, min, max);
      const core = item.focus_core ?? item.focusCore ?? item.core_span ?? item.coreSpan;
      validateSpan(core, sentenceNumber, "重音核心区", parsedFocusSpan.start, parsedFocusSpan.end);
    }
  });

  const pauses = Array.isArray(entry.pauses) ? entry.pauses : [];
  pauses.forEach((value) => {
    const item = object(value);
    ensure(integer(item.after_index ?? item.after_token_index ?? item.afterTokenIndex ?? item.token_index), "停顿");
  });

  const prolongations = Array.isArray(entry.prolongations)
    ? entry.prolongations
    : Array.isArray(entry.prolongs) ? entry.prolongs : [];
  prolongations.forEach((value) => {
    const item = object(value);
    ensure(integer(item.token_index ?? item.tokenIndex ?? item.index ?? value), "拖音");
  });

  const prosody = Array.isArray(entry.prosody) ? entry.prosody : entry.prosody ? [entry.prosody] : [];
  prosody.forEach((value) => {
    const item = object(value);
    if (!prosodyAliases[String(item.type ?? "")]) {
      throw new Error(`第 ${sentenceNumber} 句包含不支持的语势类型。`);
    }
    const activeValue = item.active_span ?? item.activeSpan;
    const coreValue = item.core_zone ?? item.coreZone;
    validateSpan(activeValue, sentenceNumber, "语势区间", min, max);
    const activeSpan = parseSpan(activeValue, { start: min, end: max }, min, max);
    validateSpan(coreValue, sentenceNumber, "语势核心区", activeSpan.start, activeSpan.end);
  });

  const ending = object(entry.ending_intonation ?? entry.endingIntonation);
  const endingLabel = typeof (entry.ending_intonation ?? entry.endingIntonation) === "string"
    ? entry.ending_intonation ?? entry.endingIntonation
    : ending.type;
  if (endingLabel !== undefined && !endingAliases[String(endingLabel)]) {
    throw new Error(`第 ${sentenceNumber} 句包含不支持的句尾语调。`);
  }
  const rhythm = object(entry.rhythm);
  const rhythmLabel = typeof entry.rhythm === "string" ? entry.rhythm : rhythm.type ?? rhythm.label;
  if (rhythmLabel !== undefined && !rhythmAliases[String(rhythmLabel)]) {
    throw new Error(`第 ${sentenceNumber} 句包含不支持的节奏类型。`);
  }
}

/** Extract JSON from plain text or a single Markdown code fence, with only safe punctuation repair. */
export function parseControlSpecText(input: string): unknown {
  let text = input.trim().replace(/^\uFEFF/, "");
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}

export function importControlSpec(
  rawValue: unknown,
  sourceText: string,
  workId: string,
  referenceAudioAssetId?: string,
): ControlSpec {
  const envelope = object(rawValue);
  const raw = Object.keys(object(envelope.control_spec)).length
    ? object(envelope.control_spec)
    : envelope;
  const performanceProfile = parsePerformanceProfile(raw);
  const timingProfile = parseTimingProfile(raw.timing_profile ?? raw.timingProfile);
  const rawTokens = raw.tokens;
  if (!Array.isArray(rawTokens)) {
    throw new Error("控制谱必须包含 tokens 数组，并保留本地分析结果中的时间戳与拼音。");
  }
  const sourceCharacters = Array.from(sourceText);
  if (rawTokens.length !== sourceCharacters.length) {
    throw new Error(`tokens 数量不一致：网站正文为 ${sourceCharacters.length} 个字符，导入内容为 ${rawTokens.length} 个。`);
  }

  let previousStart = 0;
  const tokens: TimedToken[] = rawTokens.map((value, position) => {
    const item = object(value);
    const index = integer(item.index);
    const char = item.char;
    const expected = sourceCharacters[position];
    if (index !== position || char !== expected) {
      throw new Error(`token ${position} 与网站正文不一致；导入已停止，正文不会被修改。`);
    }
    const startValue = item.start_ms ?? item.startMs;
    const endValue = item.end_ms ?? item.endMs;
    const startMs = startValue === null || startValue === undefined ? undefined : number(startValue);
    const endMs = endValue === null || endValue === undefined ? undefined : number(endValue);
    if (startMs === undefined || endMs === undefined || startMs < 0 || endMs < startMs) {
      throw new Error(`token ${position} 缺少有效的 start_ms / end_ms。`);
    }
    if (position > 0 && startMs < previousStart) {
      throw new Error(`token ${position} 的时间戳早于前一个 token，无法建立可靠时间轴。`);
    }
    previousStart = startMs;
    const machinePinyin = string(item.machine_pinyin ?? item.machinePinyin ?? item.pinyin);
    const displayPinyin = string(item.display_pinyin ?? item.displayPinyin)
      ?? (machinePinyin ? displayPinyinFromMachine(machinePinyin) : undefined);
    if (/\p{Script=Han}/u.test(expected) && !displayPinyin) {
      throw new Error(`token ${position}（${expected}）缺少拼音；请保留本地分析结果中的 pinyin。`);
    }
    return {
      id: `token-${position}`,
      index: position,
      char: expected,
      machinePinyin,
      displayPinyin,
      pronunciationSource: machinePinyin ? "dictionary" : undefined,
      startMs,
      endMs,
      confidence: number(item.confidence) ?? 1,
    };
  });
  const tokensByIndex = new Map(tokens.map((token) => [token.index, token]));
  if (timingProfile) validateTimingProfileIndexes(timingProfile, tokens.length);
  const rawSentences = raw.sentences;
  if (!Array.isArray(rawSentences)) throw new Error("控制谱必须包含 sentences 数组。");
  if (!rawSentences.length) {
    throw new Error("控制谱至少需要包含一个句子。");
  }

  let sentenceCursor = 0;
  const sentences: RecitationSentence[] = rawSentences.map((value, position) => {
    const sentenceNumber = position + 1;
    const entry = object(value);
    const explicitStart = integer(entry.start_index ?? entry.startIndex);
    const explicitEnd = integer(entry.end_index ?? entry.endIndex);
    const sentenceText = typeof entry.text === "string" ? entry.text : undefined;
    const min = explicitStart ?? sentenceCursor;
    let max = explicitEnd;
    if (min !== sentenceCursor) {
      throw new Error(`第 ${sentenceNumber} 句没有从 token ${sentenceCursor} 连续开始。`);
    }
    if (max === undefined) {
      if (sentenceText === undefined || !Array.from(sentenceText).length) {
        throw new Error(`第 ${sentenceNumber} 句必须包含 text，或明确提供 start_index / end_index。`);
      }
      max = min + Array.from(sentenceText).length - 1;
    }
    if (max < min || max >= tokens.length) {
      throw new Error(`第 ${sentenceNumber} 句的 token 范围无效。`);
    }
    const exactText = tokens.slice(min, max + 1).map((token) => token.char).join("");
    if (sentenceText !== undefined && sentenceText !== exactText) {
      throw new Error(`第 ${sentenceNumber} 句正文与网站正文不一致；导入已停止。`);
    }
    validateAnnotationIndexes(entry, sentenceNumber, min, max);
    sentenceCursor = max + 1;
    const sentenceTokens = tokens.filter((token) => token.index >= min && token.index <= max);
    const id = `sentence-${sentenceNumber}`;
    const sentencePerformanceProfile = parsePerformanceProfile(entry);
    return {
      id,
      order: sentenceNumber,
      text: exactText,
      function: "",
      rhythm: parseRhythm(entry.rhythm),
      continuity: sentencePerformanceProfile?.continuity ?? "connected",
      performanceProfile: sentencePerformanceProfile,
      macroProsodyPath: parseMacroProsodyPath(
        entry.macro_prosody_path ?? entry.macroProsodyPath,
        min,
        max,
      ),
      prosody: parseProsody(entry.prosody, id, min, max),
      endingIntonation: parseEnding(entry.ending_intonation ?? entry.endingIntonation),
      focus: parseFocus(entry.focus, id, tokensByIndex, min, max),
      voiceQuality: voiceQualityRange(sentencePerformanceProfile?.voiceQuality),
      pauses: parsePauses(entry.pauses, id, tokensByIndex, min, max),
      prolongations: parseProlongations(
        entry.prolongations ?? entry.prolongs,
        id,
        tokensByIndex,
        min,
        max,
      ),
      tokens: sentenceTokens,
      teachingCue: "",
      avoid: sentencePerformanceProfile?.avoid ?? [],
      confidence: number(entry.confidence) ?? 0,
      timeRange: {
        startMs: Math.min(...sentenceTokens.map((token) => token.startMs)),
        endMs: Math.max(...sentenceTokens.map((token) => token.endMs)),
      },
    };
  });

  if (sentenceCursor !== tokens.length) {
    throw new Error(`句子只覆盖到 token ${sentenceCursor - 1}，未完整覆盖网站正文。`);
  }

  const joined = tokens.map((token) => token.char).join("");
  if (joined !== sourceText) {
    throw new Error("导入 token 与网站完整正文不一致，不能导入控制谱。");
  }

  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0",
    id: `spec-${crypto.randomUUID()}`,
    workId,
    version: 1,
    source: "hybrid",
    performanceProfile,
    timingProfile,
    tokens,
    documentProfile: {
      deliveryMode: performanceProfile?.deliveryMode ?? "lyrical_recitation",
      recitationDegree: 2,
      baseRhythm: sentences[0]?.rhythm ?? "relaxed",
      emotionalTone: performanceProfile?.emotionTone ?? [],
      energy: "medium",
      control: "medium",
      interactionDistance: "conversational",
      voiceQuality: performanceProfile?.voiceQuality ?? "neutral",
      globalArc: [],
    },
    sentences,
    analysisProvenance: {
      referenceAudioAssetId,
      knowledgeAssetIds: [],
      knowledgeBase: { id: "recitation-expression", version: "1.0", scope: "system" },
      pipelineVersion: "local-analyzer-import-1.0",
      alignmentModel: "elevenlabs-forced-alignment",
      acousticModel: "parselmouth",
      generatedAt: now,
    },
    validation: { state: "valid", issues: [] },
    createdAt: now,
  };
}
