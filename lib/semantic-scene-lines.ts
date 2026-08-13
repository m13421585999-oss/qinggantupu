import type { GraphTokenUnit } from "./graph-track";

export interface SemanticSceneLineOptions {
  /** One-line reading stays preferable until this approximate visual width is exceeded. */
  singleLineCapacity?: number;
  /** Additional teaching boundaries, usually prosody event span ends. */
  preferredBoundaryIndexes?: number[];
}

export interface MeasuredSceneBlockOptions {
  /** Available inline width for one manuscript block, in unscaled CSS pixels. */
  maxLineWidth: number;
  /** Measured rendered width for each host token, including attached decorations. */
  unitWidths: ReadonlyMap<number, number> | Record<number, number>;
  unitGap?: number;
  /** Boundaries inside a focus phrase or a prosody core that should be avoided. */
  protectedBoundaryIndexes?: number[];
  /** Useful teaching boundaries, such as the end of a prosody event. */
  preferredBoundaryIndexes?: number[];
}

function punctuationStrength(unit: GraphTokenUnit) {
  const punctuation = unit.suffixPunctuation.map((token) => token.char).join("");
  if (/[。！？!?]/u.test(punctuation)) return 5;
  if (/[；;]/u.test(punctuation)) return 4;
  if (/[，、,:：]/u.test(punctuation)) return 3;
  return 0;
}

function measuredWidth(
  widths: MeasuredSceneBlockOptions["unitWidths"],
  tokenIndex: number,
) {
  const value = "get" in widths && typeof widths.get === "function"
    ? widths.get(tokenIndex)
    : (widths as Record<number, number>)[tokenIndex];
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 1;
}

function betterLayout(
  candidate: { lineCount: number; score: number },
  current?: { lineCount: number; score: number },
) {
  if (!current) return true;
  if (candidate.lineCount !== current.lineCount) {
    return candidate.lineCount < current.lineCount;
  }
  return candidate.score < current.score;
}

/**
 * Split only after the minimum viewer font can no longer keep the scene on one
 * line. Widths come from rendered token columns, so pinyin, punctuation and all
 * attached recitation marks participate in the decision without becoming
 * independent columns.
 */
export function splitGraphUnitsByMeasuredWidth(
  units: GraphTokenUnit[],
  options: MeasuredSceneBlockOptions,
) {
  if (units.length <= 1) return units.length ? [units] : [];

  const maxWidth = Math.max(1, options.maxLineWidth);
  const gap = Math.max(0, options.unitGap ?? 0);
  const preferred = new Set(options.preferredBoundaryIndexes ?? []);
  const protectedBoundaries = new Set(options.protectedBoundaryIndexes ?? []);
  const widths = units.map((unit) => measuredWidth(options.unitWidths, unit.token.index));
  const prefixWidths = [0];
  widths.forEach((width) => prefixWidths.push(prefixWidths.at(-1)! + width));
  const rangeWidth = (start: number, end: number) => (
    prefixWidths[end] - prefixWidths[start] + Math.max(0, end - start - 1) * gap
  );

  if (rangeWidth(0, units.length) <= maxWidth + 0.5) return [units];

  type Layout = { lineCount: number; score: number; ends: number[] };
  const solve = (minimumItems: number) => {
    const bestFrom = new Map<number, Layout>();
    bestFrom.set(units.length, { lineCount: 0, score: 0, ends: [] });

    for (let start = units.length - 1; start >= 0; start -= 1) {
      let best: Layout | undefined;
      for (let end = start + 1; end <= units.length; end += 1) {
        const width = rangeWidth(start, end);
        // A single unusually wide decorated token must remain renderable. Other
        // over-wide candidates cannot form a valid block.
        if (width > maxWidth + 0.5 && end > start + 1) break;
        const remainder = bestFrom.get(end);
        if (!remainder) continue;

        const itemCount = end - start;
        if (itemCount < minimumItems && units.length >= minimumItems * 2) continue;

        const isLast = end === units.length;
        const boundaryUnit = units[end - 1];
        const fillRatio = Math.min(1.5, width / maxWidth);
        let score = Math.pow(1 - fillRatio, 2) * (isLast ? 4 : 9);

        if (!isLast) {
          score -= punctuationStrength(boundaryUnit) * 4.5;
          if (boundaryUnit.pause) score -= boundaryUnit.pause.type === "long" ? 18 : 9;
          if (preferred.has(boundaryUnit.token.index)) score -= 7;
          if (protectedBoundaries.has(boundaryUnit.token.index)) score += 1000;
        }

        const candidate: Layout = {
          lineCount: remainder.lineCount + 1,
          score: remainder.score + score,
          ends: [end, ...remainder.ends],
        };
        if (betterLayout(candidate, best)) best = candidate;
      }
      if (best) bestFrom.set(start, best);
    }
    return bestFrom.get(0);
  };

  // Prefer blocks containing at least three spoken characters. Only fall back
  // to an orphan when an exceptionally wide unit makes every safe layout
  // impossible.
  const layout = solve(3) ?? solve(1);
  if (!layout) return units.map((unit) => [unit]);
  let start = 0;
  return layout.ends.map((end) => {
    const line = units.slice(start, end);
    start = end;
    return line;
  });
}

export function graphUnitVisualWeight(unit: GraphTokenUnit) {
  const punctuationWeight = (
    unit.prefixPunctuation.length + unit.suffixPunctuation.length
  ) * 0.3;
  const prolongationWeight = unit.prolongation ? 1.2 : 0;
  const pauseWeight = unit.pause?.type === "long" ? 0.75 : unit.pause ? 0.4 : 0;
  const endingWeight = unit.endingTone ? 0.65 : 0;
  return 1 + punctuationWeight + prolongationWeight + pauseWeight + endingWeight;
}

/**
 * Produces one or two stable reading lines. The split prefers punctuation,
 * explicit pauses and prosody boundaries, while heavily penalising orphan
 * characters. It never changes token indexes or the underlying prosody data.
 */
export function splitGraphUnitsIntoSemanticLines(
  units: GraphTokenUnit[],
  options: SemanticSceneLineOptions = {},
) {
  if (units.length <= 1) return units.length ? [units] : [];

  const capacity = options.singleLineCapacity ?? 18.5;
  const weights = units.map(graphUnitVisualWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= capacity) return [units];

  const preferred = new Set(options.preferredBoundaryIndexes ?? []);
  let leftWeight = 0;
  let bestSplit = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let split = 1; split < units.length; split += 1) {
    leftWeight += weights[split - 1];
    const rightWeight = totalWeight - leftWeight;
    const leftCount = split;
    const rightCount = units.length - split;
    const boundaryUnit = units[split - 1];

    let score = Math.abs(leftWeight - rightWeight);
    score -= punctuationStrength(boundaryUnit) * 2.2;
    if (boundaryUnit.pause) score -= boundaryUnit.pause.type === "long" ? 6 : 3;
    if (preferred.has(boundaryUnit.token.index)) score -= 4;

    if (leftCount === 1 || rightCount === 1) score += 100;
    else if (leftCount === 2 || rightCount === 2) score += 10;

    if (score < bestScore) {
      bestScore = score;
      bestSplit = split;
    }
  }

  return [units.slice(0, bestSplit), units.slice(bestSplit)];
}
