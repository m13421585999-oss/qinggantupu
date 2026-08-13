import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTeachingProsodyPoints,
  monotoneSplinePath,
  PROSODY_VISUAL_LEVEL_COUNT,
  PROSODY_SMOOTHING_WINDOW,
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
