"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GraphTokenUnit } from "@/lib/graph-track";
import {
  extendProsodyCurveToTokenEdges,
  interpolateProsodyPointChanges,
  monotoneSplinePath,
  nearestProsodyVisualLevelPosition,
  PROSODY_COLOR,
  PROSODY_NODE_FILL,
  PROSODY_NODE_RADIUS,
  PROSODY_NODE_STROKE_WIDTH,
  PROSODY_STROKE_WIDTH,
  PROSODY_VISUAL_LEVEL_COUNT,
  prosodyVisualLevelFromPointerY,
  type ProsodyPointChange,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";

const DEFAULT_PROSODY_VISUAL_LEVELS = Array.from(
  { length: PROSODY_VISUAL_LEVEL_COUNT },
  (_, visualLevel) => visualLevel,
);

interface CurveMetrics {
  width: number;
  trackStart: number;
  trackEnd: number;
  tokenCenters: Record<number, number>;
}

interface PaintGesture {
  tokenPosition: number;
  levelPosition: number;
  emittedLevels: Map<number, number>;
}

/**
 * Shared teaching-prosody track used by every renderer (Full A4 and Compact).
 * It owns the DOM measurement, the SVG curve, the thickened stroke spec and
 * the pointer/keyboard editing, so both editions render the exact same
 * prosody semantics and stroke weight from one ControlSpec.
 */
export function TeachingProsodyTrack({
  units,
  points,
  characterRefs,
  rowElement,
  editable,
  curveHeight,
  curvePadding,
  className = "teaching-prosody-track",
  visualLevels,
  continuousDrawing = false,
  onPointChange,
  onPointsChange,
}: {
  units: GraphTokenUnit[];
  points: TeachingProsodyPoint[];
  characterRefs: React.RefObject<Map<number, HTMLElement>>;
  rowElement: HTMLDivElement | null;
  editable: boolean;
  curveHeight: number;
  curvePadding: number;
  className?: string;
  visualLevels?: readonly number[];
  continuousDrawing?: boolean;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
  onPointsChange?: (changes: ProsodyPointChange[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragLevelsRef = useRef(new Map<number, number>());
  const paintGesturesRef = useRef(new Map<number, PaintGesture>());
  const [metrics, setMetrics] = useState<CurveMetrics>();
  const activeVisualLevels = visualLevels && visualLevels.length >= 2
    ? visualLevels
    : DEFAULT_PROSODY_VISUAL_LEVELS;

  const measure = useCallback(() => {
    const row = rowElement;
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const spoken = units.flatMap((unit) => {
      const element = characterRefs.current.get(unit.token.index);
      return element ? [{ index: unit.token.index, element }] : [];
    });
    if (!spoken.length || rowRect.width <= 0) return;
    const firstRect = spoken[0].element.getBoundingClientRect();
    const lastRect = spoken.at(-1)!.element.getBoundingClientRect();
    const next: CurveMetrics = {
      width: rowRect.width,
      trackStart: firstRect.left - rowRect.left,
      trackEnd: lastRect.right - rowRect.left,
      tokenCenters: Object.fromEntries(spoken.map(({ index, element }) => {
        const rect = element.getBoundingClientRect();
        return [index, rect.left - rowRect.left + rect.width / 2];
      })),
    };
    setMetrics((current) => {
      if (
        current
        && Math.abs(current.width - next.width) < 0.25
        && Math.abs(current.trackStart - next.trackStart) < 0.25
        && Math.abs(current.trackEnd - next.trackEnd) < 0.25
        && Object.keys(next.tokenCenters).every((key) => (
          Math.abs((current.tokenCenters[Number(key)] ?? -9999) - next.tokenCenters[Number(key)]) < 0.25
        ))
      ) return current;
      return next;
    });
  }, [characterRefs, rowElement, units]);

  useLayoutEffect(() => {
    if (!rowElement) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(rowElement);
    for (const element of characterRefs.current.values()) observer.observe(element);
    // A marker (V, v, /, ///) can shift a character horizontally without
    // changing its own dimensions. Observe rendered children too so the curve
    // always re-reads each character's real screen position.
    const layoutObserver = new MutationObserver(schedule);
    layoutObserver.observe(rowElement, { childList: true, subtree: true });
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      layoutObserver.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [characterRefs, measure, rowElement]);

  if (!metrics) return <div className={`${className}-placeholder`} aria-hidden="true" />;
  const rowPoints = points.filter((point) => Number.isFinite(metrics.tokenCenters[point.tokenIndex]));
  if (!rowPoints.length) return <div className={`${className}-placeholder`} aria-hidden="true" />;
  const step = (curveHeight - curvePadding * 2) / (activeVisualLevels.length - 1);
  const anchors = rowPoints.map((point) => {
    const displayLevelPosition = nearestProsodyVisualLevelPosition(
      point.visualLevel,
      activeVisualLevels,
    );
    return {
      ...point,
      displayLevelPosition,
      x: metrics.tokenCenters[point.tokenIndex],
      y: curveHeight - curvePadding - displayLevelPosition * step,
    };
  });
  const anchorTokenIndexes = anchors.map((point) => point.tokenIndex);
  const drawingPoints = extendProsodyCurveToTokenEdges(
    anchors,
    metrics.trackStart,
    metrics.trackEnd,
    curvePadding,
    curveHeight - curvePadding,
  );
  const path = monotoneSplinePath(drawingPoints);

  const pointerLevelPosition = (event: ReactPointerEvent<SVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    return prosodyVisualLevelFromPointerY({
      clientY: event.clientY,
      rectTop: rect.top,
      rectHeight: rect.height,
      viewBoxHeight: curveHeight,
      verticalPadding: curvePadding,
      visualLevelCount: activeVisualLevels.length,
    });
  };

  const pointerLevel = (event: ReactPointerEvent<SVGElement>) => {
    const levelPosition = pointerLevelPosition(event);
    return levelPosition === undefined ? undefined : activeVisualLevels[levelPosition];
  };

  const emitPointChanges = (changes: ProsodyPointChange[]) => {
    if (!changes.length) return;
    if (onPointsChange) {
      onPointsChange(changes);
      return;
    }
    changes.forEach((change) => onPointChange?.(change.tokenIndex, change.visualLevel));
  };

  const pointerPaintTarget = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const levelPosition = pointerLevelPosition(event);
    if (!rect || rect.width <= 0 || levelPosition === undefined) return undefined;
    const localX = (event.clientX - rect.left) * metrics.width / rect.width;
    let tokenPosition = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    anchors.forEach((point, position) => {
      const distance = Math.abs(point.x - localX);
      if (distance < nearestDistance) {
        tokenPosition = position;
        nearestDistance = distance;
      }
    });
    return { tokenPosition, levelPosition };
  };

  const emitPaintChanges = (gesture: PaintGesture, changes: ProsodyPointChange[]) => {
    const freshChanges = changes.filter((change) => {
      if (gesture.emittedLevels.get(change.tokenIndex) === change.visualLevel) return false;
      gesture.emittedLevels.set(change.tokenIndex, change.visualLevel);
      return true;
    });
    emitPointChanges(freshChanges);
  };

  const beginContinuousDrawing = (event: ReactPointerEvent<SVGSVGElement>) => {
    const target = pointerPaintTarget(event);
    if (!target) return;
    const gesture: PaintGesture = {
      ...target,
      emittedLevels: new Map(),
    };
    paintGesturesRef.current.set(event.pointerId, gesture);
    emitPaintChanges(gesture, interpolateProsodyPointChanges({
      tokenIndexes: anchorTokenIndexes,
      visualLevels: activeVisualLevels,
      fromTokenPosition: target.tokenPosition,
      toTokenPosition: target.tokenPosition,
      fromLevelPosition: target.levelPosition,
      toLevelPosition: target.levelPosition,
    }));
  };

  const continueContinuousDrawing = (event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = paintGesturesRef.current.get(event.pointerId);
    const target = pointerPaintTarget(event);
    if (!gesture || !target) return;
    emitPaintChanges(gesture, interpolateProsodyPointChanges({
      tokenIndexes: anchorTokenIndexes,
      visualLevels: activeVisualLevels,
      fromTokenPosition: gesture.tokenPosition,
      toTokenPosition: target.tokenPosition,
      fromLevelPosition: gesture.levelPosition,
      toLevelPosition: target.levelPosition,
    }));
    gesture.tokenPosition = target.tokenPosition;
    gesture.levelPosition = target.levelPosition;
  };

  const finishContinuousDrawing = (event: ReactPointerEvent<SVGSVGElement>) => {
    continueContinuousDrawing(event);
    paintGesturesRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <svg
      ref={svgRef}
      className={`${className}${editable && continuousDrawing ? " is-drawable" : ""}`}
      viewBox={`0 0 ${metrics.width} ${curveHeight}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={editable && continuousDrawing
        ? `按住鼠标左键连续绘制语势，共 ${activeVisualLevels.length} 档；每个圆圈与上方正文文字对齐`
        : "每个圆圈与上方一个正文文字对齐，可上下拖动调整语势"}
      data-prosody-level-count={activeVisualLevels.length}
      onPointerDown={editable && continuousDrawing ? (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        beginContinuousDrawing(event);
      } : undefined}
      onPointerMove={editable && continuousDrawing ? (event) => {
        if (!paintGesturesRef.current.has(event.pointerId)) return;
        event.preventDefault();
        continueContinuousDrawing(event);
      } : undefined}
      onPointerUp={editable && continuousDrawing ? finishContinuousDrawing : undefined}
      onPointerCancel={editable && continuousDrawing ? (event) => {
        paintGesturesRef.current.delete(event.pointerId);
      } : undefined}
      onLostPointerCapture={editable && continuousDrawing ? (event) => {
        paintGesturesRef.current.delete(event.pointerId);
      } : undefined}
    >
      {editable && continuousDrawing ? (
        <rect
          className="teaching-curve-drawing-surface"
          x="0"
          y="0"
          width={metrics.width}
          height={curveHeight}
          fill="transparent"
          pointerEvents="all"
          aria-hidden="true"
        />
      ) : null}
      <path
        d={path}
        fill="none"
        stroke={PROSODY_COLOR}
        strokeWidth={PROSODY_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {anchors.map((point) => (
        <g
          className={editable ? "teaching-curve-node is-editable" : "teaching-curve-node"}
          key={point.tokenIndex}
          role={editable ? "slider" : undefined}
          tabIndex={editable ? 0 : undefined}
          aria-label={editable ? `调整第 ${point.tokenIndex + 1} 个字的语势高度` : undefined}
          aria-valuemin={editable ? 1 : undefined}
          aria-valuemax={editable ? activeVisualLevels.length : undefined}
          aria-valuenow={editable ? point.displayLevelPosition + 1 : undefined}
          aria-valuetext={editable
            ? `第 ${point.displayLevelPosition + 1} 档，共 ${activeVisualLevels.length} 档`
            : undefined}
          onKeyDown={editable ? (event: ReactKeyboardEvent<SVGGElement>) => {
            const delta = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
            if (!delta) return;
            event.preventDefault();
            const nextPosition = Math.max(
              0,
              Math.min(activeVisualLevels.length - 1, point.displayLevelPosition + delta),
            );
            emitPointChanges([{
              tokenIndex: point.tokenIndex,
              visualLevel: activeVisualLevels[nextPosition],
            }]);
          } : undefined}
          onPointerDown={editable && !continuousDrawing ? (event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const level = pointerLevel(event);
            if (level === undefined) return;
            dragLevelsRef.current.set(event.pointerId, level);
            emitPointChanges([{ tokenIndex: point.tokenIndex, visualLevel: level }]);
          } : undefined}
          onPointerMove={editable && !continuousDrawing ? (event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const level = pointerLevel(event);
            if (level === undefined || dragLevelsRef.current.get(event.pointerId) === level) return;
            dragLevelsRef.current.set(event.pointerId, level);
            emitPointChanges([{ tokenIndex: point.tokenIndex, visualLevel: level }]);
          } : undefined}
          onPointerUp={editable && !continuousDrawing ? (event) => {
            const level = pointerLevel(event);
            if (level !== undefined && dragLevelsRef.current.get(event.pointerId) !== level) {
              emitPointChanges([{ tokenIndex: point.tokenIndex, visualLevel: level }]);
            }
            dragLevelsRef.current.delete(event.pointerId);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          } : undefined}
          onPointerCancel={editable && !continuousDrawing ? (event) => {
            dragLevelsRef.current.delete(event.pointerId);
          } : undefined}
        >
          <circle cx={point.x} cy={point.y} r="6.5" fill="transparent" />
          <circle
            cx={point.x}
            cy={point.y}
            r={PROSODY_NODE_RADIUS}
            fill={PROSODY_NODE_FILL}
            stroke={PROSODY_COLOR}
            strokeWidth={PROSODY_NODE_STROKE_WIDTH}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}
