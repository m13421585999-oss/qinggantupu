import type {
  EndingTone,
  PauseMark,
  ProlongMark,
  RecitationSentence,
  TimedToken,
} from "./recitation-schema";

export interface GraphTokenUnit {
  key: string;
  token: TimedToken;
  prefixPunctuation: TimedToken[];
  suffixPunctuation: TimedToken[];
  sourceTokenIndexes: number[];
  prolongation?: ProlongMark;
  pause?: PauseMark;
  endingTone?: EndingTone;
}

export function isSourcePunctuation(char: string) {
  return /\p{P}/u.test(char);
}

export function isGraphPunctuation(char: string) {
  return isSourcePunctuation(char) || /^\s+$/u.test(char);
}

function pauseBoundaryHasSourcePunctuation(
  tokens: TimedToken[],
  tokenPosition: number,
) {
  let left = tokenPosition;
  while (left >= 0 && tokens[left].char.trim().length === 0) left -= 1;

  let right = tokenPosition + 1;
  while (right < tokens.length && tokens[right].char.trim().length === 0) right += 1;

  return (left >= 0 && isSourcePunctuation(tokens[left].char))
    || (right < tokens.length && isSourcePunctuation(tokens[right].char));
}

function strongerPause(current: PauseMark | undefined, candidate: PauseMark) {
  if (!current || candidate.type === "long") return candidate;
  return current;
}

export function buildGraphTokenUnits(sentence: RecitationSentence): GraphTokenUnit[] {
  const units: GraphTokenUnit[] = [];
  const hostBySourceIndex = new Map<number, GraphTokenUnit>();
  let pendingPrefix: TimedToken[] = [];

  for (const token of sentence.tokens) {
    if (isGraphPunctuation(token.char)) {
      const currentHost = units.at(-1);
      if (currentHost) {
        currentHost.suffixPunctuation.push(token);
        currentHost.sourceTokenIndexes.push(token.index);
        hostBySourceIndex.set(token.index, currentHost);
      } else {
        pendingPrefix.push(token);
      }
      continue;
    }

    const unit: GraphTokenUnit = {
      key: `token-unit-${token.id}`,
      token,
      prefixPunctuation: units.length === 0 ? pendingPrefix : [],
      suffixPunctuation: [],
      sourceTokenIndexes: [
        ...(units.length === 0 ? pendingPrefix.map((item) => item.index) : []),
        token.index,
      ],
    };
    units.push(unit);
    hostBySourceIndex.set(token.index, unit);
    if (units.length === 1) {
      for (const punctuation of pendingPrefix) {
        hostBySourceIndex.set(punctuation.index, unit);
      }
      pendingPrefix = [];
    }
  }

  for (const mark of sentence.prolongations) {
    const host = hostBySourceIndex.get(mark.tokenIndex);
    if (host) host.prolongation = mark;
  }

  const tokenPositions = new Map(
    sentence.tokens.map((token, position) => [token.index, position]),
  );
  for (const mark of sentence.pauses) {
    const tokenPosition = tokenPositions.get(mark.afterTokenIndex);
    if (tokenPosition === undefined) continue;
    if (pauseBoundaryHasSourcePunctuation(sentence.tokens, tokenPosition)) continue;
    const host = hostBySourceIndex.get(mark.afterTokenIndex);
    if (host) host.pause = strongerPause(host.pause, mark);
  }

  const endingHost = units.at(-1);
  if (endingHost) endingHost.endingTone = sentence.endingIntonation.type;

  return units;
}
