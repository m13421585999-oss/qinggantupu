import type {
  EndingTone,
  PauseMark,
  ProlongMark,
  RecitationSentence,
  TimedToken,
} from "./recitation-schema";

export type GraphTrackColumn =
  | { kind: "token"; key: string; token: TimedToken }
  | { kind: "prolongation"; key: string; tokenIndex: number; mark: ProlongMark }
  | { kind: "ending"; key: string; tokenIndex: number; tone: EndingTone }
  | { kind: "pause"; key: string; afterTokenIndex: number; mark: PauseMark };

export function isGraphPunctuation(char: string) {
  return /[，。！？、；：\s]/u.test(char);
}

export function buildGraphTrackColumns(sentence: RecitationSentence): GraphTrackColumn[] {
  const prolongations = new Map(
    sentence.prolongations.map((mark) => [mark.tokenIndex, mark]),
  );
  const pauses = new Map(
    sentence.pauses.map((mark) => [mark.afterTokenIndex, mark]),
  );
  const endingAnchorIndex = sentence.tokens.findLast(
    (token) => token.char.trim().length > 0,
  )?.index;

  return sentence.tokens.flatMap((token): GraphTrackColumn[] => {
    const columns: GraphTrackColumn[] = [{
      kind: "token",
      key: `token-${token.id}`,
      token,
    }];
    const prolongation = prolongations.get(token.index);
    if (prolongation) {
      columns.push({
        kind: "prolongation",
        key: `prolongation-${prolongation.id}`,
        tokenIndex: token.index,
        mark: prolongation,
      });
    }
    if (token.index === endingAnchorIndex) {
      columns.push({
        kind: "ending",
        key: `ending-${sentence.id}-${token.index}`,
        tokenIndex: token.index,
        tone: sentence.endingIntonation.type,
      });
    }
    const pause = pauses.get(token.index);
    if (pause) {
      columns.push({
        kind: "pause",
        key: `pause-${pause.id}`,
        afterTokenIndex: token.index,
        mark: pause,
      });
    }
    return columns;
  });
}

export function graphTrackTemplate(columns: GraphTrackColumn[]) {
  return columns.map((column) => {
    if (column.kind === "token") {
      return isGraphPunctuation(column.token.char)
        ? "minmax(20px, .5fr)"
        : "minmax(42px, 1fr)";
    }
    if (column.kind === "prolongation") return "minmax(30px, .7fr)";
    if (column.kind === "pause") {
      return column.mark.type === "long"
        ? "minmax(30px, .58fr)"
        : "minmax(16px, .3fr)";
    }
    return "minmax(24px, .45fr)";
  }).join(" ");
}

export function graphTrackMinimumWidth(columns: GraphTrackColumn[]) {
  return columns.reduce((total, column) => {
    if (column.kind === "token") {
      return total + (isGraphPunctuation(column.token.char) ? 20 : 42);
    }
    if (column.kind === "prolongation") return total + 30;
    if (column.kind === "pause") return total + (column.mark.type === "long" ? 30 : 16);
    return total + 24;
  }, 0);
}
