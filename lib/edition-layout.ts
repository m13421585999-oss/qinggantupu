import type {
  ControlSpec,
  EditionLayoutRow,
  RecitationSentence,
  TimedToken,
} from "./recitation-schema";
import {
  adjustVisualLineBoundaries,
  rebuildSentenceFromTokens,
  type VisualLineMergeDirection,
} from "./semantic-scene-lines.ts";

export interface EditionSentenceRow {
  id: string;
  sourceSentenceIds: string[];
  tokenIndexes: number[];
  lineBreakAfterTokenIndexes: number[];
  sentence: RecitationSentence;
}

export interface EditionVisualLine {
  rowId: string;
  tokenIndexes: number[];
}

const CHUSHIBIAO_VIRTUAL_VOICE_SPACING_WORK_ID = "work_ca868cbb-c50d-4a60-84a3-e6b4706012c8";

/** A single-work layout exception requested for the heavily marked 《出师表》. */
export function usesChushibiaoVirtualVoiceSpacing(workId: string) {
  return workId === CHUSHIBIAO_VIRTUAL_VOICE_SPACING_WORK_ID;
}

function orderedUniqueIndexes(indexes: readonly number[]) {
  return [...new Set(indexes.filter(Number.isInteger))]
    .sort((left, right) => left - right);
}

export function layoutRowsFromSentences(
  sentences: readonly RecitationSentence[],
  allTokens: readonly TimedToken[] = [],
) {
  const rows = sentences.flatMap<EditionLayoutRow>((sentence) => {
    const tokenIndexes = orderedUniqueIndexes(sentence.tokens.map((token) => token.index));
    if (!tokenIndexes.length) return [];
    const included = new Set(tokenIndexes);
    const finalTokenIndex = tokenIndexes.at(-1);
    const lineBreakAfterTokenIndexes = orderedUniqueIndexes(
      sentence.lineBreakAfterTokenIndexes ?? [],
    ).filter((index) => included.has(index) && index !== finalTokenIndex);
    return [{
      id: sentence.id,
      tokenIndexes,
      lineBreakAfterTokenIndexes: lineBreakAfterTokenIndexes.length
        ? lineBreakAfterTokenIndexes
        : undefined,
    }];
  });
  if (!allTokens.length || !rows.length) return rows;

  const assigned = new Set(rows.flatMap((row) => row.tokenIndexes));
  for (const token of [...allTokens].sort((left, right) => left.index - right.index)) {
    if (assigned.has(token.index)) continue;
    const preceding = [...rows].reverse().find((row) => (
      (row.tokenIndexes.at(-1) ?? Number.NEGATIVE_INFINITY) < token.index
    ));
    const following = rows.find((row) => (
      (row.tokenIndexes[0] ?? Number.POSITIVE_INFINITY) > token.index
    ));
    const owner = preceding ?? following ?? rows[0];
    owner.tokenIndexes = orderedUniqueIndexes([...owner.tokenIndexes, token.index]);
    assigned.add(token.index);
  }
  return rows;
}

function validLayoutRows(
  rows: readonly EditionLayoutRow[] | undefined,
  tokens: readonly TimedToken[],
) {
  if (!rows?.length || !tokens.length) return undefined;
  const validIndexes = new Set(tokens.map((token) => token.index));
  const seen = new Set<number>();
  const normalized = rows.flatMap<EditionLayoutRow>((row, position) => {
    const tokenIndexes = orderedUniqueIndexes(row.tokenIndexes ?? [])
      .filter((index) => validIndexes.has(index) && !seen.has(index));
    tokenIndexes.forEach((index) => seen.add(index));
    if (!tokenIndexes.length) return [];
    const included = new Set(tokenIndexes);
    const finalTokenIndex = tokenIndexes.at(-1);
    const lineBreakAfterTokenIndexes = orderedUniqueIndexes(
      row.lineBreakAfterTokenIndexes ?? [],
    ).filter((index) => included.has(index) && index !== finalTokenIndex);
    return [{
      id: row.id?.trim() || `edition-row-${position + 1}`,
      tokenIndexes,
      lineBreakAfterTokenIndexes: lineBreakAfterTokenIndexes.length
        ? lineBreakAfterTokenIndexes
        : undefined,
    }];
  });
  if (seen.size !== validIndexes.size) return undefined;
  return normalized;
}

/** Freeze both editions before either editor changes its row boundaries. */
export function ensureEditionLayouts(spec: ControlSpec): ControlSpec {
  const fallbackRows = layoutRowsFromSentences(spec.sentences, spec.tokens);
  const compactRows = validLayoutRows(spec.editionLayouts?.compact?.rows, spec.tokens)
    ?? fallbackRows;
  const fullRows = validLayoutRows(spec.editionLayouts?.full?.rows, spec.tokens)
    ?? fallbackRows;
  return {
    ...spec,
    editionLayouts: {
      compact: { rows: compactRows },
      full: { rows: fullRows },
    },
  };
}

/** Compact owns its current rows; Full keeps the frozen rows it already had. */
export function withCompactSentences(
  spec: ControlSpec,
  sentences: RecitationSentence[],
): ControlSpec {
  const frozen = ensureEditionLayouts(spec);
  return {
    ...frozen,
    sentences,
    editionLayouts: {
      ...frozen.editionLayouts,
      compact: { rows: layoutRowsFromSentences(sentences, spec.tokens) },
    },
  };
}

/** Full owns its row boundaries; Compact and the shared annotations stay untouched. */
export function withFullLayoutRows(
  spec: ControlSpec,
  rows: EditionLayoutRow[],
): ControlSpec {
  const frozen = ensureEditionLayouts(spec);
  const fullRows = validLayoutRows(rows, spec.tokens);
  if (!fullRows) return frozen;
  return {
    ...frozen,
    editionLayouts: {
      ...frozen.editionLayouts,
      full: { rows: fullRows },
    },
  };
}

function isBoundaryPunctuation(char: string) {
  return /\p{P}|\s/u.test(char);
}

function retainedBoundaries(
  boundaries: readonly number[] | undefined,
  tokenIndexes: readonly number[],
) {
  const included = new Set(tokenIndexes);
  const finalTokenIndex = tokenIndexes.at(-1);
  const next = orderedUniqueIndexes(boundaries ?? [])
    .filter((index) => included.has(index) && index !== finalTokenIndex);
  return next.length ? next : undefined;
}

/**
 * Move the selected Full visual-line fragment into its adjacent visual line.
 * Measured line boundaries are supplied by the editor, while row ownership is
 * updated here without changing Compact sentences or shared token annotations.
 */
export function mergeFullLayoutRowsAtToken(
  spec: ControlSpec,
  visualLines: readonly EditionVisualLine[],
  tokenIndex: number,
  direction: VisualLineMergeDirection,
) {
  const lineIndex = visualLines.findIndex((line) => line.tokenIndexes.includes(tokenIndex));
  if (lineIndex < 0) return undefined;
  const adjacentLine = visualLines[lineIndex + (direction === "previous" ? -1 : 1)];
  if (!adjacentLine) return undefined;

  const frozen = ensureEditionLayouts(spec);
  const rows = resolveFullLayoutRows(frozen).map((row) => ({
    ...row,
    tokenIndexes: [...row.tokenIndexes],
    lineBreakAfterTokenIndexes: row.lineBreakAfterTokenIndexes
      ? [...row.lineBreakAfterTokenIndexes]
      : undefined,
  }));
  const selectedLine = visualLines[lineIndex];
  const selectedRowIndex = rows.findIndex((row) => row.id === selectedLine.rowId);
  const adjacentRowIndex = rows.findIndex((row) => row.id === adjacentLine.rowId);
  if (selectedRowIndex < 0 || adjacentRowIndex < 0) return undefined;

  if (selectedRowIndex === adjacentRowIndex) {
    const rowLines = visualLines.filter((line) => line.rowId === selectedLine.rowId);
    const localLineIndex = rowLines.indexOf(selectedLine);
    const lineBreakAfterTokenIndexes = adjustVisualLineBoundaries(
      rowLines.map((line) => line.tokenIndexes),
      localLineIndex,
      tokenIndex,
      direction,
    );
    if (!lineBreakAfterTokenIndexes) return undefined;
    rows[selectedRowIndex] = {
      ...rows[selectedRowIndex],
      lineBreakAfterTokenIndexes: lineBreakAfterTokenIndexes.length
        ? lineBreakAfterTokenIndexes
        : undefined,
    };
    return rows;
  }

  const expectedAdjacentRowIndex = selectedRowIndex + (direction === "previous" ? -1 : 1);
  if (adjacentRowIndex !== expectedAdjacentRowIndex) return undefined;
  const selectedRow = rows[selectedRowIndex];
  const adjacentRow = rows[adjacentRowIndex];
  const tokenPosition = selectedRow.tokenIndexes.indexOf(tokenIndex);
  if (tokenPosition < 0) return undefined;

  let moveThroughPosition = tokenPosition;
  if (direction === "previous") {
    const tokensByIndex = new Map(spec.tokens.map((token) => [token.index, token] as const));
    while (moveThroughPosition + 1 < selectedRow.tokenIndexes.length) {
      const nextToken = tokensByIndex.get(selectedRow.tokenIndexes[moveThroughPosition + 1]);
      if (!nextToken || !isBoundaryPunctuation(nextToken.char)) break;
      moveThroughPosition += 1;
    }
  }

  const moved = direction === "next"
    ? selectedRow.tokenIndexes.slice(tokenPosition)
    : selectedRow.tokenIndexes.slice(0, moveThroughPosition + 1);
  const remaining = direction === "next"
    ? selectedRow.tokenIndexes.slice(0, tokenPosition)
    : selectedRow.tokenIndexes.slice(moveThroughPosition + 1);
  if (!moved.length) return undefined;

  const destinationTokenIndexes = direction === "next"
    ? [...moved, ...adjacentRow.tokenIndexes]
    : [...adjacentRow.tokenIndexes, ...moved];
  const destinationBoundaries = retainedBoundaries([
    ...(selectedRow.lineBreakAfterTokenIndexes ?? []),
    ...(adjacentRow.lineBreakAfterTokenIndexes ?? []),
  ], destinationTokenIndexes);
  const nextAdjacentRow: EditionLayoutRow = {
    ...adjacentRow,
    tokenIndexes: destinationTokenIndexes,
    lineBreakAfterTokenIndexes: destinationBoundaries,
  };

  if (remaining.length) {
    rows[selectedRowIndex] = {
      ...selectedRow,
      tokenIndexes: remaining,
      lineBreakAfterTokenIndexes: retainedBoundaries(
        selectedRow.lineBreakAfterTokenIndexes,
        remaining,
      ),
    };
    rows[adjacentRowIndex] = nextAdjacentRow;
    return rows;
  }

  return rows.flatMap((row, index) => {
    if (index === selectedRowIndex) return [];
    if (index === adjacentRowIndex) return [nextAdjacentRow];
    return [row];
  });
}

export function resolveFullLayoutRows(spec: ControlSpec) {
  return validLayoutRows(spec.editionLayouts?.full?.rows, spec.tokens)
    ?? layoutRowsFromSentences(spec.sentences, spec.tokens);
}

function tokenOwnerSentences(
  sentences: readonly RecitationSentence[],
  tokenIndexes: ReadonlySet<number>,
) {
  return sentences.filter((sentence) => (
    sentence.tokens.some((token) => tokenIndexes.has(token.index))
  ));
}

export function buildEditionSentenceRows(
  spec: ControlSpec,
  rows: readonly EditionLayoutRow[],
): EditionSentenceRow[] {
  const tokensByIndex = new Map<number, TimedToken>();
  spec.tokens.forEach((token) => tokensByIndex.set(token.index, token));
  spec.sentences.forEach((sentence) => {
    sentence.tokens.forEach((token) => tokensByIndex.set(token.index, token));
  });

  return rows.flatMap<EditionSentenceRow>((row, position) => {
    const tokenIndexes = orderedUniqueIndexes(row.tokenIndexes);
    const included = new Set(tokenIndexes);
    const tokens = tokenIndexes.flatMap((index) => {
      const token = tokensByIndex.get(index);
      return token ? [token] : [];
    });
    if (!tokens.length) return [];
    const owners = tokenOwnerSentences(spec.sentences, included);
    const base = owners.find((sentence) => sentence.id === row.id)
      ?? owners.find((sentence) => sentence.tokens.some((token) => token.index === tokenIndexes[0]))
      ?? owners[0];
    if (!base) return [];
    const lineBreakAfterTokenIndexes = orderedUniqueIndexes(
      row.lineBreakAfterTokenIndexes ?? [],
    ).filter((index) => included.has(index) && index !== tokenIndexes.at(-1));
    return [{
      id: row.id,
      sourceSentenceIds: owners.map((sentence) => sentence.id),
      tokenIndexes,
      lineBreakAfterTokenIndexes,
      sentence: rebuildSentenceFromTokens(base, owners, tokens, {
        id: row.id,
        order: position + 1,
        lineBreakAfterTokenIndexes,
      }),
    }];
  });
}

export function sentenceOwnerByTokenIndex(sentences: readonly RecitationSentence[]) {
  const owners = new Map<number, RecitationSentence>();
  sentences.forEach((sentence) => {
    sentence.tokens.forEach((token) => owners.set(token.index, sentence));
  });
  return owners;
}

export function endingTonesByTokenIndex(sentences: readonly RecitationSentence[]) {
  const tones = new Map<number, RecitationSentence["endingIntonation"]["type"]>();
  sentences.forEach((sentence) => {
    if (sentence.endingIntonation.type === "level") return;
    const host = [...sentence.tokens].reverse().find((token) => !/[\p{P}\s]/u.test(token.char));
    if (host) tones.set(host.index, sentence.endingIntonation.type);
  });
  return tones;
}
