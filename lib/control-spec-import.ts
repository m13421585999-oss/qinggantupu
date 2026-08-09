import type {
  ControlSpec,
  EndingTone,
  FocusTarget,
  PauseMark,
  ProlongMark,
  ProsodyEvent,
  ProsodyType,
  RecitationAnalysisPackage,
  RecitationSentence,
  Rhythm,
  TimedToken,
  TokenSpan,
} from "./recitation-schema";

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
    entry.span ?? entry.active_span ?? entry.activeSpan ?? entry,
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
    const level = entry.level === "secondary" || entry.level === "次重音"
      ? "secondary"
      : "primary";
    return [{
      id: `${sentenceId}-focus-${position + 1}`,
      tokenIds: indexes.map((index) => tokensByIndex.get(index)?.id).filter(Boolean) as string[],
      tokenIndexes: indexes,
      level,
      preferredRealization: "free" as const,
      allowedRealizations: ["free", "combined"] as const,
      avoid: [],
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
    return [{
      id: `${sentenceId}-prolong-${position + 1}`,
      tokenId: token.id,
      tokenIndex: index,
      degree: parseStrength(entry.degree ?? entry.strength ?? 1),
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
      type,
      activeSpan,
      coreZone,
      strength: parseStrength(entry.strength),
      confidence: number(entry.confidence),
    }];
  });
}

function parseEnding(value: unknown): { type: EndingTone; strength: 1 | 2 | 3 } {
  const entry = object(value);
  const label = typeof value === "string" ? value : entry.type;
  return {
    type: endingAliases[String(label ?? "level")] ?? "level",
    strength: parseStrength(entry.strength ?? 1),
  };
}

function parseRhythm(value: unknown): Rhythm {
  const entry = object(value);
  return rhythmAliases[String(typeof value === "string" ? value : entry.type ?? entry.label)] ?? "relaxed";
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
  analysis: RecitationAnalysisPackage,
  workId: string,
  referenceAudioAssetId?: string,
): ControlSpec {
  const raw = object(rawValue);
  const rawTokens = raw.tokens;
  if (!Array.isArray(rawTokens)) {
    throw new Error("控制谱必须包含 tokens 数组。请让 ChatGPT 保留分析包中的 token index 与字符。");
  }
  if (rawTokens.length !== analysis.tokens.length) {
    throw new Error(`tokens 数量不一致：正文为 ${analysis.tokens.length} 个 token，导入内容为 ${rawTokens.length} 个。`);
  }

  rawTokens.forEach((value, position) => {
    const item = object(value);
    const index = integer(item.index);
    const char = item.char;
    const expected = analysis.tokens[position];
    if (index !== expected.index || char !== expected.char) {
      throw new Error(`token ${position} 与正文不一致；导入已停止，正文不会被修改。`);
    }
  });

  const tokens: TimedToken[] = analysis.tokens.map((token) => ({
    id: `token-${token.index}`,
    index: token.index,
    char: token.char,
    machinePinyin: token.machine_pinyin,
    displayPinyin: token.display_pinyin,
    pronunciationSource: token.machine_pinyin ? "dictionary" : undefined,
    startMs: token.start_ms,
    endMs: token.end_ms,
    confidence: token.confidence ?? 1,
  }));
  const tokensByIndex = new Map(tokens.map((token) => [token.index, token]));
  const rawSentences = raw.sentences;
  if (!Array.isArray(rawSentences)) throw new Error("控制谱必须包含 sentences 数组。");
  if (rawSentences.length !== analysis.sentences.length) {
    throw new Error(`句子数量不一致：分析包为 ${analysis.sentences.length} 句，导入内容为 ${rawSentences.length} 句。`);
  }

  const sentences: RecitationSentence[] = analysis.sentences.map((base, position) => {
    const entry = object(rawSentences[position]);
    if (typeof entry.text === "string" && entry.text !== base.text) {
      throw new Error(`第 ${position + 1} 句正文与分析包不一致；导入已停止。`);
    }
    const min = base.start_index;
    const max = base.end_index;
    const sentenceTokens = tokens.filter((token) => token.index >= min && token.index <= max);
    const id = base.id || `sentence-${position + 1}`;
    return {
      id,
      order: position + 1,
      text: base.text,
      function: "",
      rhythm: parseRhythm(entry.rhythm),
      continuity: "connected",
      prosody: parseProsody(entry.prosody, id, min, max),
      endingIntonation: parseEnding(entry.ending_intonation ?? entry.endingIntonation),
      focus: parseFocus(entry.focus, id, tokensByIndex, min, max),
      voiceQuality: { start: "neutral", end: "neutral" },
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
      avoid: [],
      confidence: number(entry.confidence) ?? 0,
      timeRange: { startMs: base.start_ms, endMs: base.end_ms },
    };
  });

  const joined = tokens.map((token) => token.char).join("");
  if (joined !== analysis.work.full_text) {
    throw new Error("分析包 token 与完整正文不一致，不能导入控制谱。");
  }

  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0",
    id: `spec-${crypto.randomUUID()}`,
    workId,
    version: 1,
    source: "hybrid",
    tokens,
    documentProfile: {
      deliveryMode: "lyrical_recitation",
      recitationDegree: 2,
      baseRhythm: sentences[0]?.rhythm ?? "relaxed",
      emotionalTone: [],
      energy: "medium",
      control: "medium",
      interactionDistance: "conversational",
      voiceQuality: "neutral",
      globalArc: [],
    },
    sentences,
    analysisProvenance: {
      referenceAudioAssetId,
      knowledgeAssetIds: [],
      knowledgeBase: { id: "recitation-expression", version: "1.0", scope: "system" },
      pipelineVersion: "audio-facts-1.0",
      alignmentModel: "elevenlabs-forced-alignment",
      acousticModel: "parselmouth",
      generatedAt: now,
    },
    validation: { state: "valid", issues: [] },
    createdAt: now,
  };
}
