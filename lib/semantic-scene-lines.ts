import type { GraphTokenUnit } from "./graph-track";

export interface SemanticSceneLineOptions {
  /** One-line reading stays preferable until this approximate visual width is exceeded. */
  singleLineCapacity?: number;
  /** Additional teaching boundaries, usually prosody event span ends. */
  preferredBoundaryIndexes?: number[];
}

function punctuationStrength(unit: GraphTokenUnit) {
  const punctuation = unit.suffixPunctuation.map((token) => token.char).join("");
  if (/[。！？!?]/u.test(punctuation)) return 5;
  if (/[；;]/u.test(punctuation)) return 4;
  if (/[，、,:：]/u.test(punctuation)) return 3;
  return 0;
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
