import type {
  ControlSpec,
  RecitationSentence,
  TimedToken,
} from "./recitation-schema";
import { pinyin } from "pinyin-pro";

export interface CompactSentenceRange {
  startIndex: number;
  endIndex: number;
  text: string;
}

const ALWAYS_TERMINAL = new Set(["。", "！", "？", "!", "?", "…"]);
const TERMINAL_RUN = new Set([...ALWAYS_TERMINAL, "."]);
const CLOSING_PUNCTUATION = new Set([
  "”",
  "’",
  "\"",
  "'",
  "」",
  "』",
  "）",
  ")",
  "】",
  "]",
  "》",
  "〉",
]);

function isLineBreak(char: string) {
  return char === "\r" || char === "\n";
}

function isHorizontalWhitespace(char: string) {
  return !isLineBreak(char) && /^\s$/u.test(char);
}

function isWesternPeriodBoundary(characters: string[], index: number) {
  const next = characters[index + 1];
  if (next === undefined) return true;
  return /^\s$/u.test(next)
    || CLOSING_PUNCTUATION.has(next)
    || TERMINAL_RUN.has(next);
}

function isTerminalBoundary(characters: string[], index: number) {
  const char = characters[index];
  if (ALWAYS_TERMINAL.has(char)) return true;
  return char === "." && isWesternPeriodBoundary(characters, index);
}

/**
 * Split a manuscript into complete, contiguous sentence rows while preserving
 * every source character. Separator whitespace is attached to a neighboring
 * spoken row, so blank lines never become standalone compact rows.
 */
export function splitCompactSentenceRanges(sourceText: string): CompactSentenceRange[] {
  const characters = Array.from(sourceText);
  const ranges: CompactSentenceRange[] = [];
  let rowStart = 0;

  const finishRange = (endIndex: number) => {
    if (endIndex < rowStart) return;
    const text = characters.slice(rowStart, endIndex + 1).join("");
    if (text.trim()) {
      ranges.push({ startIndex: rowStart, endIndex, text });
      rowStart = endIndex + 1;
      return;
    }

    const previous = ranges.at(-1);
    if (previous && previous.endIndex === rowStart - 1) {
      previous.endIndex = endIndex;
      previous.text += text;
      rowStart = endIndex + 1;
    }
  };

  for (let index = 0; index < characters.length; index += 1) {
    if (isLineBreak(characters[index])) {
      let endIndex = index;
      if (characters[index] === "\r" && characters[index + 1] === "\n") {
        endIndex += 1;
      }
      finishRange(endIndex);
      index = endIndex;
      continue;
    }

    if (!isTerminalBoundary(characters, index)) continue;

    let endIndex = index;
    while (TERMINAL_RUN.has(characters[endIndex + 1])) endIndex += 1;
    while (CLOSING_PUNCTUATION.has(characters[endIndex + 1])) endIndex += 1;
    while (isHorizontalWhitespace(characters[endIndex + 1] ?? "")) endIndex += 1;
    finishRange(endIndex);
    index = endIndex;
  }

  if (rowStart < characters.length) finishRange(characters.length - 1);
  return ranges;
}

export function buildCompactTokens(sourceText: string): TimedToken[] {
  return Array.from(sourceText, (char, index) => ({
    id: `token-${index}`,
    index,
    char,
    displayPinyin: /\p{Script=Han}/u.test(char)
      ? pinyin(char, { toneType: "symbol" })
      : undefined,
    startMs: 0,
    endMs: 0,
    confidence: 0,
  }));
}

function buildCompactSentence(
  range: CompactSentenceRange,
  position: number,
  tokens: TimedToken[],
): RecitationSentence {
  const sentenceTokens = tokens.slice(range.startIndex, range.endIndex + 1);
  return {
    id: `sentence-${position + 1}`,
    order: position + 1,
    text: range.text,
    function: "",
    rhythm: "relaxed",
    continuity: "connected",
    prosody: [],
    endingIntonation: {
      type: "level",
      strength: 1,
      confidence: 0,
      source: "human",
    },
    focus: [],
    voiceQuality: { start: "neutral", end: "neutral" },
    pauses: [],
    prolongations: [],
    tokens: sentenceTokens,
    teachingCue: "",
    avoid: [],
    confidence: 1,
    timeRange: { startMs: 0, endMs: 0 },
  };
}

/** Build the neutral, audio-free control spec used by the compact editor. */
export function buildCompactControlSpec(workId: string, sourceText: string): ControlSpec {
  const normalizedWorkId = workId.trim();
  if (!normalizedWorkId) throw new Error("紧凑版控制谱缺少作品编号。");
  if (!sourceText.trim()) throw new Error("紧凑版控制谱需要非空正文。");

  const tokens = buildCompactTokens(sourceText);
  const ranges = splitCompactSentenceRanges(sourceText);
  if (!ranges.length) throw new Error("紧凑版正文没有可排版的朗诵内容。");

  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: "2.0",
    id: `compact-spec-${normalizedWorkId}`,
    workId: normalizedWorkId,
    version: 1,
    source: "human",
    documentProfile: {
      deliveryMode: "natural_narration",
      recitationDegree: 1,
      baseRhythm: "relaxed",
      emotionalTone: [],
      energy: "medium",
      control: "medium",
      interactionDistance: "conversational",
      voiceQuality: "neutral",
      globalArc: [],
    },
    tokens,
    sentences: ranges.map((range, position) => buildCompactSentence(range, position, tokens)),
    analysisProvenance: {
      knowledgeAssetIds: [],
      pipelineVersion: "compact-manual-1.0",
      generatedAt,
    },
    validation: { state: "valid", issues: [] },
    createdAt: generatedAt,
  };
}
