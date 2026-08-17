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
  monotoneSplinePath,
  PROSODY_COLOR,
  PROSODY_NODE_FILL,
  PROSODY_NODE_RADIUS,
  PROSODY_NODE_STROKE_WIDTH,
  PROSODY_STROKE_WIDTH,
  PROSODY_VISUAL_LEVEL_COUNT,
  prosodyVisualLevelFromPointerY,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";

interface CurveMetrics {
  width: number;
  trackStart: number;
  trackEnd: number;
  tokenCenters: Record<number, number>;
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
  onPointChange,
}: {
  units: GraphTokenUnit[];
  points: TeachingProsodyPoint[];
  characterRefs: React.RefObject<Map<number, HTMLElement>>;
  rowElement: HTMLDivElement | null;
  editable: boolean;
  curveHeight: number;
  curvePadding: number;
  className?: string;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragLevelsRef = useRef(new Map<number, number>());
  const [metrics, setMetrics] = useState<CurveMetrics>();

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
  const step = (curveHeight - curvePadding * 2) / (PROSODY_VISUAL_LEVEL_COUNT - 1);
  const anchors = rowPoints.map((point) => ({
    ...point,
    x: metrics.tokenCenters[point.tokenIndex],
    y: curveHeight - curvePadding - point.visualLevel * step,
  }));
  const drawingPoints = extendProsodyCurveToTokenEdges(
    anchors,
    metrics.trackStart,
    metrics.trackEnd,
    curvePadding,
    curveHeight - curvePadding,
  );
  const path = monotoneSplinePath(drawingPoints);

  const pointerLevel = (event: ReactPointerEvent<SVGGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    return prosodyVisualLevelFromPointerY({
      clientY: event.clientY,
      rectTop: rect.top,
      rectHeight: rect.height,
      viewBoxHeight: curveHeight,
      verticalPadding: curvePadding,
    });
  };

  return (
    <svg
      ref={svgRef}
      className={className}
      viewBox={`0 0 ${metrics.width} ${curveHeight}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="每个圆圈与上方一个正文文字对齐，可上下拖动调整语势"
    >
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
          aria-valuemin={editable ? 0 : undefined}
          aria-valuemax={editable ? PROSODY_VISUAL_LEVEL_COUNT - 1 : undefined}
          aria-valuenow={editable ? point.visualLevel : undefined}
          onKeyDown={editable ? (event: ReactKeyboardEvent<SVGGElement>) => {
            const delta = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
            if (!delta) return;
            event.preventDefault();
            onPointChange?.(
              point.tokenIndex,
              Math.max(0, Math.min(PROSODY_VISUAL_LEVEL_COUNT - 1, point.visualLevel + delta)),
            );
          } : undefined}
          onPointerDown={editable ? (event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const level = pointerLevel(event);
            if (level === undefined) return;
            dragLevelsRef.current.set(event.pointerId, level);
            onPointChange?.(point.tokenIndex, level);
          } : undefined}
          onPointerMove={editable ? (event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const level = pointerLevel(event);
            if (level === undefined || dragLevelsRef.current.get(event.pointerId) === level) return;
            dragLevelsRef.current.set(event.pointerId, level);
            onPointChange?.(point.tokenIndex, level);
          } : undefined}
          onPointerUp={editable ? (event) => {
            const level = pointerLevel(event);
            if (level !== undefined && dragLevelsRef.current.get(event.pointerId) !== level) {
              onPointChange?.(point.tokenIndex, level);
            }
            dragLevelsRef.current.delete(event.pointerId);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          } : undefined}
          onPointerCancel={editable ? (event) => {
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
