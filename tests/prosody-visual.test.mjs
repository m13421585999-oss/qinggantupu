import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProsodyPointOverrides,
  buildTeachingProsodyPoints,
  extendProsodyCurveToTokenEdges,
  monotoneSplinePath,
  PROSODY_VISUAL_LEVEL_COUNT,
  PROSODY_SMOOTHING_WINDOW,
  prosodyVisualLevelFromPointerY,
  upsertProsodyPointOverride,
} from "../lib/prosody-visual.ts";

test("teaching prosody creates exactly one anchor for every spoken token index", () => {
  const points = buildTeachingProsodyPoints(
    [0, 1, 3, 4],
    [
      { tokenIndex: 0, normalizedLevel: 0.2 },
      { tokenIndex: 1, normalizedLevel: 0.4 },
      { tokenIndex: 3, normalizedLevel: -0.2 },
      { tokenIndex: 4, normalizedLevel: 0.1 },
    ],
  );

  assert.deepEqual(points.map((point) => point.tokenIndex), [0, 1, 3, 4]);
  assert.equal(points.length, 4, "punctuation index 2 never creates an anchor");
});

test("five-token smoothing and nine-level quantization suppress tiny pitch jitter", () => {
  const source = [0, 0.16, -0.12, 0.18, -0.09, 0.15, 0.02].map((level, tokenIndex) => ({
    tokenIndex,
    macroPitchCenter: level,
    normalizedLevel: level,
  }));
  const points = buildTeachingProsodyPoints(source.map((point) => point.tokenIndex), source);

  assert.equal(PROSODY_SMOOTHING_WINDOW, 5);
  assert.equal(PROSODY_VISUAL_LEVEL_COUNT, 9);
  assert.ok(new Set(points.map((point) => point.visualLevel)).size <= 2);
  assert.ok(points.every((point) => point.visualLevel >= 0 && point.visualLevel < 9));
});

test("macro rise and valley survive visual smoothing", () => {
  const levels = [1.1, 0.7, 0.1, -0.8, -1.25, -1, -0.35, 0.45, 1.35];
  const points = buildTeachingProsodyPoints(
    levels.map((_, tokenIndex) => tokenIndex),
    levels.map((normalizedLevel, tokenIndex) => ({ tokenIndex, normalizedLevel })),
  );
  const valley = points.reduce((best, point) => point.visualLevel < best.visualLevel ? point : best);

  assert.ok(valley.tokenIndex >= 3 && valley.tokenIndex <= 5);
  assert.ok(points.at(-1).visualLevel > valley.visualLevel);
});

test("human teaching overrides change only the rendered visual level", () => {
  const acousticPoints = [
    { tokenIndex: 0, macroPitchCenter: -0.4, normalizedLevel: -0.2 },
    { tokenIndex: 1, macroPitchCenter: 0.8, normalizedLevel: 0.6 },
    { tokenIndex: 2, macroPitchCenter: 0.1, normalizedLevel: 0.2 },
  ];
  const automatic = buildTeachingProsodyPoints([0, 1, 2], acousticPoints);
  const snapshot = structuredClone(automatic);
  const rendered = applyProsodyPointOverrides(automatic, [
    { tokenIndex: 1, visualLevel: 8, source: "human" },
  ]);

  assert.deepEqual(automatic, snapshot, "automatic acoustic-derived points are not mutated");
  assert.equal(rendered[1].visualLevel, 8);
  assert.equal(rendered[1].isOverridden, true);
  assert.equal(rendered[1].sourceLevel, automatic[1].sourceLevel);
  assert.equal(rendered[1].smoothedLevel, automatic[1].smoothedLevel);
  assert.equal(rendered[0], automatic[0], "unmodified anchors retain their original object");
});

test("upserting an override is sparse, sorted, deduplicated, and visually clamped", () => {
  const overrides = [
    { tokenIndex: 7, visualLevel: 2, source: "human" },
    { tokenIndex: 3, visualLevel: 4, source: "human" },
  ];
  const next = upsertProsodyPointOverride(overrides, 3, 20);

  assert.deepEqual(next, [
    { tokenIndex: 3, visualLevel: 8, source: "human" },
    { tokenIndex: 7, visualLevel: 2, source: "human" },
  ]);
  assert.deepEqual(overrides, [
    { tokenIndex: 7, visualLevel: 2, source: "human" },
    { tokenIndex: 3, visualLevel: 4, source: "human" },
  ], "the sentence draft owns the returned override array");
});

test("pointer Y maps through a scaled SVG and clamps to the nine teaching levels", () => {
  const options = { rectTop: 100, rectHeight: 48, viewBoxHeight: 96 };
  assert.equal(prosodyVisualLevelFromPointerY({ ...options, clientY: 103.5 }), 8);
  assert.equal(prosodyVisualLevelFromPointerY({ ...options, clientY: 124 }), 4);
  assert.equal(prosodyVisualLevelFromPointerY({ ...options, clientY: 144.5 }), 0);
  assert.equal(prosodyVisualLevelFromPointerY({ ...options, clientY: 70 }), 8);
  assert.equal(prosodyVisualLevelFromPointerY({ ...options, clientY: 180 }), 0);
  assert.equal(prosodyVisualLevelFromPointerY({ ...options, clientY: 124, rectHeight: 0 }), undefined);
});

test("paint-only curve endpoints follow the edge-anchor trend without creating editable tokens", () => {
  const anchors = [
    { x: 40, y: 30, tokenIndex: 4 },
    { x: 88, y: 18, tokenIndex: 5 },
  ];
  const snapshot = structuredClone(anchors);
  const drawingPoints = extendProsodyCurveToTokenEdges(anchors, 18, 112, 7, 89);

  assert.deepEqual(anchors, snapshot, "source token anchors remain untouched");
  assert.deepEqual(drawingPoints, [
    { x: 18, y: 35.5 },
    { x: 40, y: 30 },
    { x: 88, y: 18 },
    { x: 112, y: 12 },
  ]);
  assert.equal(drawingPoints[0].x, 18, "the path begins exactly at the first character edge");
  assert.equal(drawingPoints.at(-1).x, 112, "the path ends exactly at the last character edge");
  assert.ok(drawingPoints.every((point) => !("tokenIndex" in point)));
});

test("paint-only endpoint extrapolation is distance-limited and visually clamped", () => {
  const drawingPoints = extendProsodyCurveToTokenEdges(
    [
      { x: 40, y: 42, tokenIndex: 4 },
      { x: 50, y: 16, tokenIndex: 5 },
      { x: 60, y: 34, tokenIndex: 6 },
    ],
    -200,
    400,
    7,
    48,
  );

  assert.deepEqual(drawingPoints[0], { x: -200, y: 48 }, "start tangent is capped to one anchor interval and the visible Y range");
  assert.deepEqual(drawingPoints.at(-1), { x: 400, y: 48 }, "end tangent is capped to one anchor interval and the visible Y range");
});

test("paint-only endpoints fall back to a horizontal height for one or repeated anchors", () => {
  assert.deepEqual(
    extendProsodyCurveToTokenEdges([{ x: 40, y: 30, tokenIndex: 4 }], 18, 64, 7, 89),
    [
      { x: 18, y: 30 },
      { x: 40, y: 30 },
      { x: 64, y: 30 },
    ],
  );
  assert.deepEqual(
    extendProsodyCurveToTokenEdges([
      { x: 40, y: 30, tokenIndex: 4 },
      { x: 40, y: 18, tokenIndex: 5 },
    ], 18, 64, 7, 89),
    [
      { x: 18, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 18 },
      { x: 64, y: 18 },
    ],
  );
});

test("monotone spline passes through token anchors without template replacement", () => {
  const anchors = [
    { x: 12, y: 38 },
    { x: 48, y: 22 },
    { x: 86, y: 44 },
  ];
  const path = monotoneSplinePath(anchors);

  assert.match(path, /^M 12 38 C /);
  assert.match(path, /48 22/);
  assert.match(path, /86 44$/);
});
