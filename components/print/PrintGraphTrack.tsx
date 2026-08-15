"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildGraphTokenUnits, type GraphTokenUnit } from "@/lib/graph-track";
import {
  applyProsodyPointOverrides,
  buildTeachingProsodyPoints,
  extendProsodyCurveToTokenEdges,
  monotoneSplinePath,
  PROSODY_VISUAL_LEVEL_COUNT,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";
import { splitGraphUnitsByMeasuredWidth } from "@/lib/semantic-scene-lines";
import type { RecitationSentence } from "@/lib/recitation-schema";

const PRINT_CURVE_HEIGHT = 36;

function visibleSourceCharacter(value: string) {
  if (/\r|\n/u.test(value)) return "";
  if (/^\s+$/u.test(value)) return " ";
  return value;
}

function protectedSentenceBoundaries(sentence: RecitationSentence) {
  const indexes = new Set<number>();
  const protectInside = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) indexes.add(index);
  };
  sentence.focus.forEach((target) => {
    const ordered = [...target.tokenIndexes].sort((left, right) => left - right);
    if (ordered.length > 1) protectInside(ordered[0], ordered.at(-1)!);
  });
  sentence.prosody.forEach((event) => protectInside(event.coreZone.start, event.coreZone.end));
  return [...indexes];
}

function lineSignature(lines: GraphTokenUnit[][]) {
  return lines.map((line) => line.map((unit) => unit.token.index).join(",")).join("|");
}

function PrintTokenUnit({
  unit,
  focused,
  characterRef,
  measureRef,
}: {
  unit: GraphTokenUnit;
  focused: boolean;
  characterRef?: (element: HTMLSpanElement | null) => void;
  measureRef?: (element: HTMLSpanElement | null) => void;
}) {
  return (
    <span className="print-token-unit" ref={measureRef} data-print-token-index={unit.token.index}>
      <span className="print-token-manuscript">
        {unit.prefixPunctuation.map((token) => (
          <span className="print-source-punctuation" key={token.id}>
            {visibleSourceCharacter(token.char)}
          </span>
        ))}
        <span className="print-spoken-token">
          <span className="print-token-pinyin" aria-hidden="true">
            {unit.token.displayPinyin ?? unit.token.pinyin ?? " "}
          </span>
          <span
            className={`print-token-char ${focused ? "is-focus" : ""}`}
            ref={characterRef}
          >
            {unit.token.char}
          </span>
        </span>
        {unit.prolongation ? (
          <span className="print-prolongation" aria-label="拖音">—</span>
        ) : null}
        {unit.endingTone ? (
          <span className="print-ending-tone" aria-label={unit.endingTone === "rising" ? "上升调" : "下降调"}>
            {unit.endingTone === "rising" ? "↗" : "↘"}
          </span>
        ) : null}
        {unit.pause ? (
          <span className={`print-pause print-pause-${unit.pause.type}`} aria-label={unit.pause.type === "long" ? "长停" : "短停"}>
            {unit.pause.type === "long" ? "///" : "/"}
          </span>
        ) : null}
        {unit.suffixPunctuation.map((token) => (
          <span className="print-source-punctuation" key={token.id}>
            {visibleSourceCharacter(token.char)}
          </span>
        ))}
      </span>
    </span>
  );
}

function PrintProsodyCurve({
  units,
  points,
  characterRefs,
  rowElement,
}: {
  units: GraphTokenUnit[];
  points: TeachingProsodyPoint[];
  characterRefs: React.RefObject<Map<number, HTMLSpanElement>>;
  rowElement: HTMLDivElement | null;
}) {
  const gradientId = useId();
  const [metrics, setMetrics] = useState<{
    width: number;
    trackStart: number;
    trackEnd: number;
    tokenCenters: Record<number, number>;
  }>();

  const measure = useCallback(() => {
    const row = rowElement;
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const spokenCharacters = units.flatMap((unit) => {
      const element = characterRefs.current.get(unit.token.index);
      return element ? [{ index: unit.token.index, element }] : [];
    });
    if (!spokenCharacters.length || rowRect.width <= 0) return;
    const firstRect = spokenCharacters[0].element.getBoundingClientRect();
    const lastRect = spokenCharacters.at(-1)!.element.getBoundingClientRect();
    const next = {
      width: rowRect.width,
      trackStart: firstRect.left - rowRect.left,
      trackEnd: lastRect.right - rowRect.left,
      tokenCenters: Object.fromEntries(spokenCharacters.map(({ index, element }) => {
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
    const row = rowElement;
    if (!row) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    for (const element of characterRefs.current.values()) observer.observe(element);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [characterRefs, measure, rowElement]);

  if (!metrics) return <div className="print-curve-placeholder" aria-hidden="true" />;
  const rowPoints = points.filter((point) => Number.isFinite(metrics.tokenCenters[point.tokenIndex]));
  if (!rowPoints.length) return <div className="print-curve-placeholder" aria-hidden="true" />;

  const verticalPadding = 4;
  const step = (PRINT_CURVE_HEIGHT - verticalPadding * 2) / (PROSODY_VISUAL_LEVEL_COUNT - 1);
  const anchors = rowPoints.map((point) => ({
    ...point,
    x: metrics.tokenCenters[point.tokenIndex],
    y: PRINT_CURVE_HEIGHT - verticalPadding - point.visualLevel * step,
  }));
  const drawingPoints = extendProsodyCurveToTokenEdges(
    anchors,
    metrics.trackStart,
    metrics.trackEnd,
    verticalPadding,
    PRINT_CURVE_HEIGHT - verticalPadding,
  );
  const path = monotoneSplinePath(drawingPoints);
  const fillPath = `${path} L ${drawingPoints.at(-1)!.x} ${PRINT_CURVE_HEIGHT} L ${drawingPoints[0].x} ${PRINT_CURVE_HEIGHT} Z`;
  const baseline = PRINT_CURVE_HEIGHT / 2;

  return (
    <svg
      className="print-prosody-curve"
      viewBox={`0 0 ${metrics.width} ${PRINT_CURVE_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="与本行文字逐字对应的宏观语势曲线"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c8452f" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#c8452f" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradientId})`} />
      <line
        x1={drawingPoints[0].x}
        x2={drawingPoints.at(-1)!.x}
        y1={baseline}
        y2={baseline}
        stroke="#ded2c5"
        strokeWidth="0.8"
        strokeDasharray="2 4"
      />
      <path
        d={path}
        fill="none"
        stroke="#c8452f"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {anchors.map((point) => (
        <circle
          key={point.tokenIndex}
          cx={point.x}
          cy={point.y}
          r="1.8"
          fill="#c8452f"
          stroke="#fbf7ef"
          strokeWidth="0.7"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function PrintGraphLine({
  units,
  focusedIndexes,
  teachingPoints,
}: {
  units: GraphTokenUnit[];
  focusedIndexes: Set<number>;
  teachingPoints: TeachingProsodyPoint[];
}) {
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const characterRefs = useRef(new Map<number, HTMLSpanElement>());
  return (
    <div className="print-graph-line" ref={setRowElement}>
      <div className="print-token-row">
        {units.map((unit) => (
          <PrintTokenUnit
            unit={unit}
            focused={focusedIndexes.has(unit.token.index)}
            key={unit.key}
            characterRef={(element) => {
              if (element) characterRefs.current.set(unit.token.index, element);
              else characterRefs.current.delete(unit.token.index);
            }}
          />
        ))}
      </div>
      <PrintProsodyCurve
        units={units}
        points={teachingPoints}
        characterRefs={characterRefs}
        rowElement={rowElement}
      />
    </div>
  );
}

export function PrintGraphTrack({ sentence }: { sentence: RecitationSentence }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const probeRefs = useRef(new Map<number, HTMLSpanElement>());
  const units = useMemo(() => buildGraphTokenUnits(sentence), [sentence]);
  const [lines, setLines] = useState<GraphTokenUnit[][]>(() => units.length ? [units] : []);
  const focusedIndexes = useMemo(
    () => new Set(sentence.focus.flatMap((target) => target.tokenIndexes)),
    [sentence.focus],
  );
  const teachingPoints = useMemo(
    () => applyProsodyPointOverrides(
      buildTeachingProsodyPoints(
        units.map((unit) => unit.token.index),
        sentence.macroProsodyPath?.points ?? [],
      ),
      sentence.prosodyPointOverrides,
    ),
    [sentence.macroProsodyPath, sentence.prosodyPointOverrides, units],
  );

  const fitLines = useCallback(() => {
    const track = trackRef.current;
    if (!track || !units.length || track.clientWidth <= 0) return;
    const styles = window.getComputedStyle(track);
    const unitGap = Number.parseFloat(styles.getPropertyValue("--print-token-gap")) || 2;
    const widths = new Map(units.flatMap((unit) => {
      const element = probeRefs.current.get(unit.token.index);
      return element ? [[unit.token.index, element.getBoundingClientRect().width]] : [];
    }));
    if (widths.size !== units.length) return;
    const nextLines = splitGraphUnitsByMeasuredWidth(units, {
      maxLineWidth: track.clientWidth,
      unitWidths: widths,
      unitGap,
      preferredBoundaryIndexes: sentence.prosody.map((event) => event.activeSpan.end),
      protectedBoundaryIndexes: protectedSentenceBoundaries(sentence),
    });
    setLines((current) => lineSignature(current) === lineSignature(nextLines) ? current : nextLines);
  }, [sentence, units]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitLines);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(track);
    for (const element of probeRefs.current.values()) observer.observe(element);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [fitLines]);

  if (!units.length) {
    return (
      <div className="print-graph-fallback">
        <p>{sentence.text}</p>
        <span aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="print-graph-track" ref={trackRef} aria-label={sentence.text}>
      <div className="print-token-width-probe" aria-hidden="true">
        {units.map((unit) => (
          <PrintTokenUnit
            unit={unit}
            focused={focusedIndexes.has(unit.token.index)}
            key={`probe-${unit.key}`}
            measureRef={(element) => {
              if (element) probeRefs.current.set(unit.token.index, element);
              else probeRefs.current.delete(unit.token.index);
            }}
          />
        ))}
      </div>
      <div className="print-graph-lines">
        {lines.map((line, index) => (
          <PrintGraphLine
            units={line}
            focusedIndexes={focusedIndexes}
            teachingPoints={teachingPoints}
            key={`${sentence.id}-print-line-${index}-${line[0]?.token.index}`}
          />
        ))}
      </div>
    </div>
  );
}
