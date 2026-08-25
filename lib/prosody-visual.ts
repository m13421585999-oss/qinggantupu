import type { MacroProsodyPoint, ProsodyPointOverride } from "./recitation-schema";

export type { ProsodyPointOverride } from "./recitation-schema";

export const PROSODY_VISUAL_LEVEL_COUNT = 9;
export const PROSODY_SMOOTHING_WINDOW = 5;

// Shared teaching-prosody stroke spec used by every renderer (Full and
// Compact) so the curve keeps one visual weight. The main curve is thickened
// ~45% over the previous 1.65px spec; the node outline ~25%.
export const PROSODY_COLOR = "#526f82";
export const PROSODY_STROKE_WIDTH = 2.4;
export const PROSODY_NODE_STROKE_WIDTH = 2.05;
export const PROSODY_NODE_FILL = "#fffdf8";
export const PROSODY_NODE_RADIUS = 3.4;

export interface TeachingProsodyPoint {
  tokenIndex: number;
  sourceLevel: number;
  smoothedLevel: number;
  visualLevel: number;
  /** True when this sentence had no usable acoustic pitch at any spoken token. */
  isNeutralFallback?: boolean;
  /** True only when the teaching display height was explicitly adjusted by a creator. */
  isOverridden?: boolean;
}

export interface ProsodyPointChange {
  tokenIndex: number;
  visualLevel: number;
}

interface SplinePoint {
  x: number;
  y: number;
}

/**
 * Add paint-only endpoints at the first/last character edges.
 * Returned points intentionally contain no token identity, so these endpoints
 * can never become editable anchors or persisted human overrides.
 */
export function extendProsodyCurveToTokenEdges(
  anchors: SplinePoint[],
  trackStart: number,
  trackEnd: number,
  minY = Number.NEGATIVE_INFINITY,
  maxY = Number.POSITIVE_INFINITY,
) {
  if (!anchors.length) return [];
  const points = anchors.map(({ x, y }) => ({ x, y }));
  const first = points[0];
  const last = points.at(-1)!;
  const lowerY = Number.isFinite(minY) && Number.isFinite(maxY)
    ? Math.min(minY, maxY)
    : Number.isFinite(minY) ? minY : Number.NEGATIVE_INFINITY;
  const upperY = Number.isFinite(minY) && Number.isFinite(maxY)
    ? Math.max(minY, maxY)
    : Number.isFinite(maxY) ? maxY : Number.POSITIVE_INFINITY;
  const clampY = (value: number, fallback: number) => {
    const safeValue = Number.isFinite(value) ? value : fallback;
    return Math.max(lowerY, Math.min(upperY, safeValue));
  };
  const extrapolatedY = (
    edgeX: number,
    edgeAnchor: SplinePoint,
    adjacentAnchor: SplinePoint | undefined,
    direction: "start" | "end",
  ) => {
    if (!adjacentAnchor || !Number.isFinite(edgeAnchor.y)) return clampY(edgeAnchor.y, 0);
    const anchorDistance = direction === "start"
      ? adjacentAnchor.x - edgeAnchor.x
      : edgeAnchor.x - adjacentAnchor.x;
    const extensionDistance = direction === "start"
      ? edgeAnchor.x - edgeX
      : edgeX - edgeAnchor.x;
    if (
      !Number.isFinite(anchorDistance) || anchorDistance <= 0
      || !Number.isFinite(extensionDistance) || extensionDistance <= 0
      || !Number.isFinite(adjacentAnchor.y)
    ) return clampY(edgeAnchor.y, 0);
    const ratio = Math.max(0, Math.min(1, extensionDistance / anchorDistance));
    const deltaY = direction === "start"
      ? edgeAnchor.y - adjacentAnchor.y
      : edgeAnchor.y - adjacentAnchor.y;
    return clampY(edgeAnchor.y + deltaY * ratio, edgeAnchor.y);
  };
  const start = Number.isFinite(trackStart) && trackStart < first.x ? trackStart : first.x;
  const end = Number.isFinite(trackEnd) && trackEnd > last.x ? trackEnd : last.x;
  if (start < first.x) {
    points.unshift({
      x: start,
      y: extrapolatedY(start, first, points[1], "start"),
    });
  }
  if (end > last.x) {
    points.push({
      x: end,
      y: extrapolatedY(end, last, points.at(-2), "end"),
    });
  }
  return points;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * ratio));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function pointSourceLevel(point: MacroProsodyPoint) {
  return point.macroPitchCenter
    ?? point.rawNormalizedPitch
    ?? point.normalizedLevel;
}

function interpolateMissingLevels(
  tokenIndexes: number[],
  sourcePoints: MacroProsodyPoint[],
) {
  const sourceByToken = new Map(
    sourcePoints
      .filter((point) => Number.isFinite(pointSourceLevel(point)))
      .map((point) => [point.tokenIndex, pointSourceLevel(point)]),
  );
  const known = tokenIndexes.flatMap((tokenIndex, position) => {
    const value = sourceByToken.get(tokenIndex);
    return value === undefined ? [] : [{ position, value }];
  });
  // Forced-alignment windows can occasionally contain no usable voiced F0
  // (for example when repeated source text cannot be matched to the audio).
  // A missing acoustic observation must not remove the manuscript's teaching
  // layer altogether. Use a deliberately neutral zero contour in that case:
  // it creates no invented rise/fall, while keeping one editable anchor per
  // spoken token until a fresh acoustic analysis or a human override exists.
  if (!known.length) return tokenIndexes.map(() => 0);

  return tokenIndexes.map((_, position) => {
    const exact = known.find((point) => point.position === position);
    if (exact) return exact.value;
    let left: { position: number; value: number } | undefined;
    for (const point of known) {
      if (point.position >= position) break;
      left = point;
    }
    const right = known.find((point) => point.position > position);
    if (!left) return right!.value;
    if (!right) return left.value;
    const progress = (position - left.position) / (right.position - left.position);
    return left.value + (right.value - left.value) * progress;
  });
}

/**
 * Convert acoustic token pitch centers into the low-granularity teaching path.
 * This is intentionally a display transform: source acoustic values stay intact.
 */
export function buildTeachingProsodyPoints(
  tokenIndexes: number[],
  sourcePoints: MacroProsodyPoint[],
  visualLevelCount = PROSODY_VISUAL_LEVEL_COUNT,
): TeachingProsodyPoint[] {
  const orderedIndexes = [...new Set(tokenIndexes)];
  if (!orderedIndexes.length) return [];
  const orderedIndexSet = new Set(orderedIndexes);
  const hasAcousticSource = sourcePoints.some((point) => (
    orderedIndexSet.has(point.tokenIndex) && Number.isFinite(pointSourceLevel(point))
  ));
  const sourceLevels = interpolateMissingLevels(orderedIndexes, sourcePoints);

  const radius = sourceLevels.length >= PROSODY_SMOOTHING_WINDOW ? 2 : 1;
  const smoothedLevels = sourceLevels.map((sourceLevel, position) => {
    const window = sourceLevels.slice(
      Math.max(0, position - radius),
      Math.min(sourceLevels.length, position + radius + 1),
    );
    const localCenter = median(window);
    const sourceWeight = position === 0 || position === sourceLevels.length - 1 ? 0.58 : 0.24;
    return sourceLevel * sourceWeight + localCenter * (1 - sourceWeight);
  });

  const levelCount = Math.max(7, Math.min(9, Math.round(visualLevelCount)));
  const middleLevel = (levelCount - 1) / 2;
  const center = median(smoothedLevels);
  const robustRange = quantile(smoothedLevels, 0.9) - quantile(smoothedLevels, 0.1);
  // Normalized pitch is in semitones. A half-semitone floor prevents ordinary
  // 0.1–0.2 differences from becoming visible zigzags.
  const quantizationStep = Math.max(0.5, robustRange / Math.max(1, levelCount - 1));

  return orderedIndexes.map((tokenIndex, position) => ({
    tokenIndex,
    sourceLevel: sourceLevels[position],
    smoothedLevel: smoothedLevels[position],
    visualLevel: Math.max(
      0,
      Math.min(levelCount - 1, Math.round((smoothedLevels[position] - center) / quantizationStep + middleLevel)),
    ),
    ...(!hasAcousticSource ? { isNeutralFallback: true } : {}),
  }));
}

function clampVisualLevel(value: number, visualLevelCount: number) {
  const levelCount = Math.max(7, Math.min(9, Math.round(visualLevelCount)));
  return Math.max(0, Math.min(levelCount - 1, Math.round(value)));
}

/**
 * Overlay sparse human teaching heights after acoustic smoothing/quantization.
 * Source pitch centers and normalized acoustic levels remain untouched.
 */
export function applyProsodyPointOverrides(
  points: TeachingProsodyPoint[],
  overrides: ProsodyPointOverride[] = [],
  visualLevelCount = PROSODY_VISUAL_LEVEL_COUNT,
) {
  const overridesByToken = new Map<number, number>();
  for (const override of overrides) {
    if (!Number.isInteger(override.tokenIndex) || !Number.isFinite(override.visualLevel)) continue;
    overridesByToken.set(
      override.tokenIndex,
      clampVisualLevel(override.visualLevel, visualLevelCount),
    );
  }

  return points.map((point) => {
    const visualLevel = overridesByToken.get(point.tokenIndex);
    return visualLevel === undefined
      ? point
      : { ...point, visualLevel, isOverridden: true };
  });
}

/** Upsert one sparse override for pointer-drag previews or a saved sentence draft. */
export function upsertProsodyPointOverride(
  overrides: ProsodyPointOverride[],
  tokenIndex: number,
  visualLevel: number,
  visualLevelCount = PROSODY_VISUAL_LEVEL_COUNT,
) {
  if (!Number.isInteger(tokenIndex) || !Number.isFinite(visualLevel)) return overrides;
  const nextPoint: ProsodyPointOverride = {
    tokenIndex,
    visualLevel: clampVisualLevel(visualLevel, visualLevelCount),
    source: "human",
  };
  return [
    ...overrides.filter((point) => point.tokenIndex !== tokenIndex),
    nextPoint,
  ].sort((left, right) => left.tokenIndex - right.tokenIndex);
}

/** Map a screen-space pointer Y back into the quantized SVG teaching levels. */
export function prosodyVisualLevelFromPointerY({
  clientY,
  rectTop,
  rectHeight,
  viewBoxHeight,
  verticalPadding = 7,
  visualLevelCount = PROSODY_VISUAL_LEVEL_COUNT,
}: {
  clientY: number;
  rectTop: number;
  rectHeight: number;
  viewBoxHeight: number;
  verticalPadding?: number;
  visualLevelCount?: number;
}) {
  if (
    !Number.isFinite(clientY) || !Number.isFinite(rectTop)
    || !Number.isFinite(rectHeight) || rectHeight <= 0
    || !Number.isFinite(viewBoxHeight) || viewBoxHeight <= verticalPadding * 2
  ) return undefined;
  const levelCount = Math.max(2, Math.min(9, Math.round(visualLevelCount)));
  const localY = (clientY - rectTop) * viewBoxHeight / rectHeight;
  const visualStep = (viewBoxHeight - verticalPadding * 2) / (levelCount - 1);
  return Math.max(
    0,
    Math.min(levelCount - 1, Math.round((viewBoxHeight - verticalPadding - localY) / visualStep)),
  );
}

/** Find the displayed slot nearest to a persisted teaching height. */
export function nearestProsodyVisualLevelPosition(
  visualLevel: number,
  visualLevels: readonly number[],
) {
  if (!visualLevels.length || !Number.isFinite(visualLevel)) return 0;
  let nearestPosition = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  visualLevels.forEach((candidate, position) => {
    const distance = Math.abs(candidate - visualLevel);
    // Prefer the higher slot on an exact tie, matching ordinary rounding.
    if (distance <= nearestDistance) {
      nearestPosition = position;
      nearestDistance = distance;
    }
  });
  return nearestPosition;
}

/**
 * Fill every token crossed by one paint movement. The first token was already
 * emitted by the previous pointer sample, so a horizontal move starts at the
 * next token; a vertical move within one token emits that token again.
 */
export function interpolateProsodyPointChanges({
  tokenIndexes,
  visualLevels,
  fromTokenPosition,
  toTokenPosition,
  fromLevelPosition,
  toLevelPosition,
}: {
  tokenIndexes: readonly number[];
  visualLevels: readonly number[];
  fromTokenPosition: number;
  toTokenPosition: number;
  fromLevelPosition: number;
  toLevelPosition: number;
}): ProsodyPointChange[] {
  if (!tokenIndexes.length || !visualLevels.length) return [];
  const clampPosition = (value: number, maximum: number) => (
    Math.max(0, Math.min(maximum, Math.round(Number.isFinite(value) ? value : 0)))
  );
  const startTokenPosition = clampPosition(fromTokenPosition, tokenIndexes.length - 1);
  const endTokenPosition = clampPosition(toTokenPosition, tokenIndexes.length - 1);
  const startLevelPosition = clampPosition(fromLevelPosition, visualLevels.length - 1);
  const endLevelPosition = clampPosition(toLevelPosition, visualLevels.length - 1);
  const tokenDistance = Math.abs(endTokenPosition - startTokenPosition);

  if (!tokenDistance) {
    return [{
      tokenIndex: tokenIndexes[endTokenPosition],
      visualLevel: visualLevels[endLevelPosition],
    }];
  }

  const direction = endTokenPosition > startTokenPosition ? 1 : -1;
  return Array.from({ length: tokenDistance }, (_, offset) => {
    const step = offset + 1;
    const progress = step / tokenDistance;
    const tokenPosition = startTokenPosition + direction * step;
    const levelPosition = clampPosition(
      startLevelPosition + (endLevelPosition - startLevelPosition) * progress,
      visualLevels.length - 1,
    );
    return {
      tokenIndex: tokenIndexes[tokenPosition],
      visualLevel: visualLevels[levelPosition],
    };
  });
}

/** Monotone cubic spline: passes through every anchor without overshooting it. */
export function monotoneSplinePath(points: SplinePoint[]) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const slopes = points.slice(1).map((point, index) => {
    const previous = points[index];
    return (point.y - previous.y) / Math.max(point.x - previous.x, 0.001);
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes.at(-1)!;
    const left = slopes[index - 1];
    const right = slopes[index];
    if (left === 0 || right === 0 || Math.sign(left) !== Math.sign(right)) return 0;
    return (2 * left * right) / (left + right);
  });

  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const width = point.x - previous.x;
    const controlOffset = width / 3;
    return `${path} C ${previous.x + controlOffset} ${previous.y + tangents[index] * controlOffset}, ${point.x - controlOffset} ${point.y - tangents[index + 1] * controlOffset}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}
