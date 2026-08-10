type JsonObject = Record<string, unknown>;

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

function tokenIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => integer(item))
    .filter((item): item is number => item !== undefined);
}

function rhythmKey(value: unknown) {
  const rhythm = object(value);
  return String(typeof value === "string" ? value : rhythm.type ?? rhythm.label ?? "relaxed");
}

function globalDeliveryDirection(spec: JsonObject) {
  const profile = object(spec.documentProfile ?? spec.document_profile);
  const rhythm = rhythmKey(profile.baseRhythm ?? profile.base_rhythm);
  const styles: Record<string, string> = {
    light: "bright, natural and continuous",
    solemn: "solemn, measured and continuous",
    relaxed: "soft, warm and naturally continuous",
    tense: "focused and connected, with controlled tension",
    soaring: "open and resonant while keeping phrases connected",
    low: "low, restrained and continuous",
  };
  return `[${styles[rhythm] ?? styles.relaxed}; no unnecessary pauses or restarts]`;
}

function focusIndexes(value: JsonObject) {
  const explicit = tokenIndexes(value.tokenIndexes ?? value.token_indexes);
  if (explicit.length) return explicit;
  const span = object(value.focusSpan ?? value.focus_span);
  const start = integer(span.start ?? span.start_index);
  const end = integer(span.end ?? span.end_index);
  if (start === undefined || end === undefined || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function sentenceDeliveryDirection(
  sentence: JsonObject,
  tokenByIndex: Map<number, { char: string }>,
) {
  const parts: string[] = [];
  const rhythm = rhythmKey(sentence.rhythm);
  const rhythmDirections: Record<string, string> = {
    light: "bright and light",
    solemn: "solemn and measured",
    relaxed: "soft and warm",
    tense: "controlled and tense",
    soaring: "open and resonant",
    low: "low and restrained",
  };
  parts.push(rhythmDirections[rhythm] ?? rhythmDirections.relaxed);

  const prosody = Array.isArray(sentence.prosody) ? sentence.prosody.map(object) : [];
  const types = prosody.map((event) => String(event.type ?? ""));
  if (types.includes("falling") && types.includes("rising")) {
    parts.push("gently descending into a low point, then opening again");
  } else if (types.includes("valley")) {
    parts.push("settling into one low contour, then recovering naturally");
  } else if (types.includes("peak")) {
    parts.push("building toward one natural crest, then releasing");
  } else if (types.includes("rising")) {
    parts.push("gently building through the phrase");
  } else if (types.includes("falling")) {
    parts.push("gently settling through the phrase");
  }

  const focusEntries = Array.isArray(sentence.focus) ? sentence.focus.map(object) : [];
  const primary = focusEntries[0];
  if (primary) {
    const focusText = focusIndexes(primary)
      .map((index) => tokenByIndex.get(index)?.char ?? "")
      .join("")
      .trim();
    if (focusText) parts.push(`let ${focusText} carry the emotional focus without breaking the flow`);
  }

  const ending = object(sentence.endingIntonation ?? sentence.ending_intonation);
  if (ending.type === "rising") parts.push("ending with a natural lift");
  else if (ending.type === "falling") parts.push("ending with a gentle settling tone");
  return `[${parts.join(", ")}]`;
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

  append(globalDeliveryDirection(spec));
  append(" ");

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
    append(sentenceDeliveryDirection(sentence, tokenByIndex));
    append(" ");

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

    const strongestProlongation = [...prolongations.entries()]
      .filter(([, degree]) => degree >= 2)
      .sort((left, right) => right[1] - left[1])[0]?.[0];
    const pauseCandidates = [...pauses.entries()]
      .sort((left, right) => (right[1] === "long" ? 1 : 0) - (left[1] === "long" ? 1 : 0));
    const explicitPause = pauseCandidates.find(([index]) => {
      const offset = sentenceIndexes.indexOf(index);
      const next = tokenByIndex.get(sentenceIndexes[offset + 1])?.char ?? "";
      return offset >= 0 && offset < sentenceIndexes.length - 1 && !/[，。！？、；：,!?;:\s]/u.test(next);
    });

    sentenceIndexes.forEach((index) => {
      const token = tokenByIndex.get(index)!;
      sourceOffsets.set(index, Array.from(text).length);
      append(token.char);

      if (index === strongestProlongation) append("——");
      if (explicitPause?.[0] === index) append(explicitPause[1] === "long" ? "……" : "，");
    });
    if (
      sentencePosition < sentences.length - 1
      && !/\s/u.test(tokenByIndex.get(sentenceIndexes.at(-1)!)?.char ?? "")
    ) append(" ");
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
