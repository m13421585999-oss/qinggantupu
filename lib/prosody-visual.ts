import type { MacroProsodyPoint, ProsodyPointOverride } from "./recitation-schema";

export type { ProsodyPointOverride } from "./recitation-schema";

export const PROSODY_VISUAL_LEVEL_COUNT = 9;
export const PROSODY_SMOOTHING_WINDOW = 5;

export interface TeachingProsodyPoint {
  tokenIndex: number;
  sourceLevel: number;
  smoothedLevel: number;
  visualLevel: number;
  /** True only when the teaching display height was explicitly adjusted by a creator. */
  isOverridden?: boolean;
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
) {
  if (!anchors.length) return [];
  const points = anchors.map(({ x, y }) => ({ x, y }));
  const first = points[0];
  const last = points.at(-1)!;
  const start = Number.isFinite(trackStart) ? Math.min(trackStart, first.x) : first.x;
  const end = Number.isFinite(trackEnd) ? Math.max(trackEnd, last.x) : last.x;
  if (start < first.x) points.unshift({ x: start, y: first.y });
  if (end > last.x) points.push({ x: end, y: last.y });
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
  if (!known.length) return [];

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
  const sourceLevels = interpolateMissingLevels(orderedIndexes, sourcePoints);
  if (!sourceLevels.length) return [];

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
  const levelCount = Math.max(7, Math.min(9, Math.round(visualLevelCount)));
  const localY = (clientY - rectTop) * viewBoxHeight / rectHeight;
  const visualStep = (viewBoxHeight - verticalPadding * 2) / (levelCount - 1);
  return Math.max(
    0,
    Math.min(levelCount - 1, Math.round((viewBoxHeight - verticalPadding - localY) / visualStep)),
  );
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
