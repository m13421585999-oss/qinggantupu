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

function rhythmTag(value: unknown) {
  const rhythm = object(value);
  const key = String(typeof value === "string" ? value : rhythm.type ?? rhythm.label ?? "");
  const tags: Record<string, string> = {
    light: "[bright and lively]",
    solemn: "[solemn]",
    relaxed: "[calm]",
    tense: "[tense]",
    soaring: "[passionately]",
    low: "[low and restrained]",
  };
  return tags[key] ?? "[natural]";
}

function prosodyTag(type: unknown, strength: unknown, core = false) {
  const level = Math.max(1, Math.min(3, integer(strength) ?? 2));
  const prefix = level === 1 ? "gently " : level === 3 ? "strongly " : "";
  const tags: Record<string, string> = core
    ? {
      peak: "strong and resonant",
      valley: "quiet and restrained",
      rising: "with greater intensity",
      falling: "softly easing down",
    }
    : {
      peak: "building toward a crest",
      valley: "settling into a low contour",
      rising: "gradually building",
      falling: "gradually easing",
    };
  const direction = tags[String(type)];
  return direction ? `[${prefix}${direction}]` : undefined;
}

function endingTag(value: unknown) {
  const ending = object(value);
  const type = String(typeof value === "string" ? value : ending.type ?? "");
  const tags: Record<string, string> = {
    rising: "[with rising intonation]",
    falling: "[with falling intonation]",
    level: "[with level intonation]",
  };
  return tags[type];
}

function isSpokenCharacter(value: string) {
  return /[\p{L}\p{N}]/u.test(value);
}

function spanBoundary(value: unknown, edge: "start" | "end") {
  const span = object(value);
  return integer(span[edge] ?? span[`${edge}_index`] ?? span[`anchor_${edge}`]);
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
    append(rhythmTag(sentence.rhythm));
    append(" ");

    const focusStarts = new Map<number, "primary" | "secondary">();
    const focusEnds = new Set<number>();
    const focusEntries = Array.isArray(sentence.focus) ? sentence.focus.map(object) : [];
    focusEntries.forEach((focus) => {
      const indexes = [...new Set(tokenIndexes(focus.tokenIndexes ?? focus.token_indexes))]
        .sort((left, right) => left - right);
      const level = focus.level === "secondary" ? "secondary" : "primary";
      indexes.forEach((index, position) => {
        if (position === 0 || indexes[position - 1] !== index - 1) {
          const existing = focusStarts.get(index);
          if (!existing || level === "primary") focusStarts.set(index, level);
        }
        if (position === indexes.length - 1 || indexes[position + 1] !== index + 1) focusEnds.add(index);
      });
    });

    const pauses = new Map<number, "short" | "long">();
    const pauseEntries = Array.isArray(sentence.pauses) ? sentence.pauses.map(object) : [];
    pauseEntries.forEach((pause) => {
      const index = integer(pause.afterTokenIndex ?? pause.after_index);
      if (index !== undefined) pauses.set(index, pause.type === "long" ? "long" : "short");
    });

    const prolongations = new Set<number>();
    const prolongEntries = Array.isArray(sentence.prolongations)
      ? sentence.prolongations.map(object)
      : [];
    prolongEntries.forEach((prolongation) => {
      const index = integer(prolongation.tokenIndex ?? prolongation.token_index);
      if (index !== undefined) prolongations.add(index);
    });

    const before = new Map<number, string[]>();
    const after = new Map<number, string[]>();
    const addBoundary = (target: Map<number, string[]>, index: number | undefined, tag: string | undefined) => {
      if (index === undefined || !tag) return;
      target.set(index, [...(target.get(index) ?? []), tag]);
    };
    const prosodyEntries = Array.isArray(sentence.prosody) ? sentence.prosody.map(object) : [];
    prosodyEntries.forEach((prosody) => {
      const active = prosody.activeSpan ?? prosody.active_span;
      const core = prosody.coreZone ?? prosody.core_zone;
      const activeStart = spanBoundary(active, "start");
      const activeEnd = spanBoundary(active, "end");
      const coreStart = spanBoundary(core, "start");
      const coreEnd = spanBoundary(core, "end");
      addBoundary(before, activeStart, prosodyTag(prosody.type, prosody.strength));
      addBoundary(before, coreStart, prosodyTag(prosody.type, prosody.strength, true));
      if (coreEnd !== undefined) addBoundary(after, coreEnd, prosodyTag(prosody.type, prosody.strength));
      if (activeEnd !== undefined) addBoundary(after, activeEnd, rhythmTag(sentence.rhythm));
    });

    const finalSpokenIndex = [...sentenceIndexes].reverse()
      .find((index) => isSpokenCharacter(tokenByIndex.get(index)?.char ?? ""));
    const finalTag = endingTag(sentence.endingIntonation ?? sentence.ending_intonation);

    sentenceIndexes.forEach((index) => {
      const token = tokenByIndex.get(index)!;
      before.get(index)?.forEach(append);
      const focusStart = focusStarts.get(index);
      if (focusStart === "primary") append("[emphasized]");
      else if (focusStart === "secondary") append("[gently emphasized]");
      if (prolongations.has(index)) append("[drawn out]");
      if (index === finalSpokenIndex) append(finalTag);

      sourceOffsets.set(index, Array.from(text).length);
      append(token.char);

      if (prolongations.has(index)) append("——");
      const pause = pauses.get(index);
      if (pause) append(pause === "long" ? " [long pause] " : " [short pause] ");
      if (focusEnds.has(index) || prolongations.has(index)) {
        append("[continue naturally]");
      }
      after.get(index)?.forEach(append);
    });
    if (sentencePosition < sentences.length - 1) append("\n");
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
