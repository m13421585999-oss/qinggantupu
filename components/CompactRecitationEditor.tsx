"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { buildGraphTokenUnits, type GraphTokenUnit } from "@/lib/graph-track";
import {
  paginateMeasuredPrintBlocks,
  safePrintFilename,
  type PrintPagePlan,
} from "@/lib/print-layout";
import {
  applyProsodyPointOverrides,
  buildTeachingProsodyPoints,
  extendProsodyCurveToTokenEdges,
  monotoneSplinePath,
  PROSODY_VISUAL_LEVEL_COUNT,
  prosodyVisualLevelFromPointerY,
  upsertProsodyPointOverride,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";
import { splitGraphUnitsByMeasuredWidth } from "@/lib/semantic-scene-lines";
import type {
  BreathMark,
  EndingTone,
  PauseMark,
  RecitationSentence,
  RecitationWork,
  TimedToken,
} from "@/lib/recitation-schema";

const COMPACT_MARGIN_MM = 11;
const COMPACT_RENDER_DPR = 2.5;
const COMPACT_CURVE_HEIGHT = 34;
const COMPACT_CURVE_PADDING = 4.5;

type CompactSaveState = "unsaved" | "dirty" | "saving" | "saved" | "failed";

interface CompactSelection {
  sentenceId: string;
  tokenIndex: number;
  x: number;
  y: number;
}

interface CompactBlock {
  id: string;
  sentence: RecitationSentence;
}

function visibleSourceCharacter(value: string) {
  if (/\r|\n/u.test(value)) return "";
  if (/^\s+$/u.test(value)) return " ";
  return value;
}

function lineSignature(lines: GraphTokenUnit[][]) {
  return lines.map((line) => line.map((unit) => unit.token.index).join(",")).join("|");
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

function focusIndexes(sentence: RecitationSentence) {
  return new Set(sentence.focus.flatMap((target) => target.tokenIndexes));
}

function pauseAt(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.pauses.find((pause) => pause.afterTokenIndex === tokenIndex);
}

function breathAt(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.breaths?.find((breath) => breath.afterTokenIndex === tokenIndex);
}

function prolongAt(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.prolongations.find((prolongation) => prolongation.tokenIndex === tokenIndex);
}

function setPauseAt(
  sentence: RecitationSentence,
  token: TimedToken,
  type: PauseMark["type"],
) {
  const current = pauseAt(sentence, token.index);
  if (current?.type === type) {
    return { ...sentence, pauses: sentence.pauses.filter((pause) => pause.id !== current.id) };
  }
  const next: PauseMark = {
    id: current?.id ?? `${sentence.id}-pause-${token.index}`,
    afterTokenId: token.id,
    afterTokenIndex: token.index,
    type,
    source: "human",
  };
  return {
    ...sentence,
    pauses: [
      ...sentence.pauses.filter((pause) => pause.afterTokenIndex !== token.index),
      next,
    ].sort((left, right) => left.afterTokenIndex - right.afterTokenIndex),
  };
}

function setBreathAt(
  sentence: RecitationSentence,
  token: TimedToken,
  type: BreathMark["type"],
) {
  const current = breathAt(sentence, token.index);
  if (current?.type === type) {
    const breaths = (sentence.breaths ?? []).filter((breath) => breath.id !== current.id);
    return { ...sentence, breaths: breaths.length ? breaths : undefined };
  }
  const next: BreathMark = {
    id: current?.id ?? `${sentence.id}-breath-${token.index}`,
    afterTokenId: token.id,
    afterTokenIndex: token.index,
    type,
    source: "human",
  };
  return {
    ...sentence,
    breaths: [
      ...(sentence.breaths ?? []).filter((breath) => breath.afterTokenIndex !== token.index),
      next,
    ].sort((left, right) => left.afterTokenIndex - right.afterTokenIndex),
  };
}

function toggleFocus(sentence: RecitationSentence, token: TimedToken) {
  const contains = sentence.focus.some((target) => target.tokenIndexes.includes(token.index));
  let focus = sentence.focus
    .map((target) => ({
      ...target,
      tokenIds: contains ? target.tokenIds.filter((id) => id !== token.id) : target.tokenIds,
      tokenIndexes: contains
        ? target.tokenIndexes.filter((index) => index !== token.index)
        : target.tokenIndexes,
      coreTokenIds: contains ? target.coreTokenIds?.filter((id) => id !== token.id) : target.coreTokenIds,
      coreTokenIndexes: contains
        ? target.coreTokenIndexes?.filter((index) => index !== token.index)
        : target.coreTokenIndexes,
    }))
    .filter((target) => target.tokenIndexes.length > 0);
  if (!contains) {
    if (focus[0]) {
      focus = focus.map((target, index) => index === 0 ? {
        ...target,
        tokenIds: [...target.tokenIds, token.id],
        tokenIndexes: [...target.tokenIndexes, token.index].sort((left, right) => left - right),
      } : target);
    } else {
      focus = [{
        id: `${sentence.id}-focus-manual`,
        tokenIds: [token.id],
        tokenIndexes: [token.index],
        coreTokenIds: [token.id],
        coreTokenIndexes: [token.index],
        level: "primary",
        confidence: 1,
        preferredRealization: "free",
        allowedRealizations: ["free", "combined"],
        avoid: ["shouting"],
      }];
    }
  }
  return { ...sentence, focus };
}

function toggleProlongation(sentence: RecitationSentence, token: TimedToken) {
  const current = prolongAt(sentence, token.index);
  return {
    ...sentence,
    prolongations: current
      ? sentence.prolongations.filter((prolongation) => prolongation.id !== current.id)
      : [...sentence.prolongations, {
        id: `${sentence.id}-prolong-${token.index}`,
        tokenId: token.id,
        tokenIndex: token.index,
        degree: 1 as const,
        confidence: 1,
        source: "human" as const,
      }],
  };
}

function setEndingTone(sentence: RecitationSentence, type: EndingTone) {
  return {
    ...sentence,
    endingIntonation: {
      ...sentence.endingIntonation,
      type,
      confidence: 1,
      source: "human" as const,
    },
  };
}

function CompactTokenUnit({
  unit,
  sentence,
  focused,
  editable,
  selected,
  endingTokenIndex,
  characterRef,
  measureRef,
  onSelect,
}: {
  unit: GraphTokenUnit;
  sentence: RecitationSentence;
  focused: boolean;
  editable: boolean;
  selected: boolean;
  endingTokenIndex?: number;
  characterRef?: (element: HTMLElement | null) => void;
  measureRef?: (element: HTMLSpanElement | null) => void;
  onSelect?: (anchor: HTMLElement) => void;
}) {
  const pause = pauseAt(sentence, unit.token.index);
  const breath = breathAt(sentence, unit.token.index);
  const prolongation = prolongAt(sentence, unit.token.index);
  const isEndingHost = endingTokenIndex === unit.token.index;
  const tone = isEndingHost && sentence.endingIntonation.type !== "level"
    ? sentence.endingIntonation.type
    : undefined;
  const select = (anchor: HTMLElement) => onSelect?.(anchor);
  return (
    <span
      className="compact-token-unit"
      ref={measureRef}
      data-compact-token-index={unit.token.index}
    >
      <span className="compact-token-manuscript">
        {unit.prefixPunctuation.map((token) => (
          <span className="compact-source-punctuation" key={token.id}>
            {visibleSourceCharacter(token.char)}
          </span>
        ))}
        <span className="compact-spoken-token">
          <span className="compact-token-pinyin" aria-hidden="true">
            {unit.token.displayPinyin ?? unit.token.pinyin ?? " "}
          </span>
          {editable ? (
            <button
              type="button"
              className={`compact-token-char ${focused ? "is-focus" : ""} ${selected ? "is-selected" : ""}`}
              ref={characterRef as (element: HTMLButtonElement | null) => void}
              onClick={(event) => select(event.currentTarget)}
              aria-label={`编辑“${unit.token.char}”及其后方标识`}
            >
              {unit.token.char}
            </button>
          ) : (
            <span
              className={`compact-token-char ${focused ? "is-focus" : ""}`}
              ref={characterRef}
            >
              {unit.token.char}
            </span>
          )}
        </span>
        {prolongation ? <span className="compact-prolongation" aria-label="拖音">—</span> : null}
        {tone ? (
          <span className="compact-ending-tone" aria-label={tone === "rising" ? "上升调" : "下降调"}>
            {tone === "rising" ? "↗" : "↘"}
          </span>
        ) : null}
        {pause ? (
          <span className={`compact-pause compact-pause-${pause.type}`} aria-label={pause.type === "long" ? "长停" : "短停"}>
            {pause.type === "long" ? "///" : "/"}
          </span>
        ) : null}
        {breath ? (
          <span
            className={breath.type === "breath_major" ? "compact-breath-major" : "compact-breath-minor"}
            aria-label={breath.type === "breath_major" ? "大换气" : "小换气"}
          >
            {breath.type === "breath_major" ? "V" : "v"}
          </span>
        ) : null}
        {unit.suffixPunctuation.map((token) => (
          <span className="compact-source-punctuation" key={token.id}>
            {visibleSourceCharacter(token.char)}
          </span>
        ))}
      </span>
      {editable ? (
        <button
          type="button"
          className="compact-boundary-trigger"
          data-export-exclude="true"
          onClick={(event) => select(event.currentTarget.parentElement?.querySelector<HTMLElement>(".compact-token-char") ?? event.currentTarget)}
          aria-label={`在“${unit.token.char}”后添加停顿或换气`}
        >
          +
        </button>
      ) : null}
    </span>
  );
}

function CompactProsodyCurve({
  units,
  points,
  characterRefs,
  rowElement,
  editable,
  onPointChange,
}: {
  units: GraphTokenUnit[];
  points: TeachingProsodyPoint[];
  characterRefs: React.RefObject<Map<number, HTMLElement>>;
  rowElement: HTMLDivElement | null;
  editable: boolean;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragLevelsRef = useRef(new Map<number, number>());
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
    const spoken = units.flatMap((unit) => {
      const element = characterRefs.current.get(unit.token.index);
      return element ? [{ index: unit.token.index, element }] : [];
    });
    if (!spoken.length || rowRect.width <= 0) return;
    const firstRect = spoken[0].element.getBoundingClientRect();
    const lastRect = spoken.at(-1)!.element.getBoundingClientRect();
    const next = {
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
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [characterRefs, measure, rowElement]);

  if (!metrics) return <div className="compact-curve-placeholder" aria-hidden="true" />;
  const rowPoints = points.filter((point) => Number.isFinite(metrics.tokenCenters[point.tokenIndex]));
  if (!rowPoints.length) return <div className="compact-curve-placeholder" aria-hidden="true" />;
  const step = (COMPACT_CURVE_HEIGHT - COMPACT_CURVE_PADDING * 2) / (PROSODY_VISUAL_LEVEL_COUNT - 1);
  const anchors = rowPoints.map((point) => ({
    ...point,
    x: metrics.tokenCenters[point.tokenIndex],
    y: COMPACT_CURVE_HEIGHT - COMPACT_CURVE_PADDING - point.visualLevel * step,
  }));
  const drawingPoints = extendProsodyCurveToTokenEdges(
    anchors,
    metrics.trackStart,
    metrics.trackEnd,
    COMPACT_CURVE_PADDING,
    COMPACT_CURVE_HEIGHT - COMPACT_CURVE_PADDING,
  );
  const path = monotoneSplinePath(drawingPoints);

  const pointerLevel = (event: ReactPointerEvent<SVGGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    return prosodyVisualLevelFromPointerY({
      clientY: event.clientY,
      rectTop: rect.top,
      rectHeight: rect.height,
      viewBoxHeight: COMPACT_CURVE_HEIGHT,
      verticalPadding: COMPACT_CURVE_PADDING,
    });
  };

  return (
    <svg
      ref={svgRef}
      className="compact-prosody-curve"
      viewBox={`0 0 ${metrics.width} ${COMPACT_CURVE_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="每个圆圈与上方一个正文文字对齐，可上下拖动调整语势"
    >
      <path
        d={path}
        fill="none"
        stroke="#526f82"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {anchors.map((point) => (
        <g
          className={editable ? "compact-curve-node is-editable" : "compact-curve-node"}
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
            r="3.4"
            fill="#fffdf8"
            stroke="#526f82"
            strokeWidth="1.65"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}

function CompactGraphLine({
  units,
  sentence,
  focused,
  points,
  editable,
  selectedTokenIndex,
  endingTokenIndex,
  onSelectToken,
  onPointChange,
}: {
  units: GraphTokenUnit[];
  sentence: RecitationSentence;
  focused: Set<number>;
  points: TeachingProsodyPoint[];
  editable: boolean;
  selectedTokenIndex?: number;
  endingTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const characterRefs = useRef(new Map<number, HTMLElement>());
  return (
    <div className="compact-graph-line" ref={setRowElement}>
      <div className="compact-token-row">
        {units.map((unit) => (
          <CompactTokenUnit
            unit={unit}
            sentence={sentence}
            focused={focused.has(unit.token.index)}
            editable={editable}
            selected={selectedTokenIndex === unit.token.index}
            endingTokenIndex={endingTokenIndex}
            key={unit.key}
            characterRef={(element) => {
              if (element) characterRefs.current.set(unit.token.index, element);
              else characterRefs.current.delete(unit.token.index);
            }}
            onSelect={(anchor) => onSelectToken?.(unit.token, anchor)}
          />
        ))}
      </div>
      <CompactProsodyCurve
        units={units}
        points={points}
        characterRefs={characterRefs}
        rowElement={rowElement}
        editable={editable}
        onPointChange={onPointChange}
      />
    </div>
  );
}

function CompactGraphTrack({
  sentence,
  editable,
  selectedTokenIndex,
  onSelectToken,
  onPointChange,
}: {
  sentence: RecitationSentence;
  editable: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const probeRefs = useRef(new Map<number, HTMLSpanElement>());
  const units = useMemo(() => buildGraphTokenUnits(sentence), [sentence]);
  const [lines, setLines] = useState<GraphTokenUnit[][]>(() => units.length ? [units] : []);
  const endingTokenIndex = units.at(-1)?.token.index;
  const focused = useMemo(() => focusIndexes(sentence), [sentence]);
  const points = useMemo(
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
    const unitGap = Number.parseFloat(styles.getPropertyValue("--compact-token-gap")) || 3;
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
    return <p className="compact-graph-fallback">{sentence.text}</p>;
  }

  return (
    <div className="compact-graph-track" ref={trackRef} aria-label={sentence.text}>
      <div className="compact-token-width-probe" aria-hidden="true">
        {units.map((unit) => (
          <CompactTokenUnit
            unit={unit}
            sentence={sentence}
            focused={focused.has(unit.token.index)}
            editable={false}
            selected={false}
            endingTokenIndex={endingTokenIndex}
            key={`probe-${unit.key}`}
            measureRef={(element) => {
              if (element) probeRefs.current.set(unit.token.index, element);
              else probeRefs.current.delete(unit.token.index);
            }}
          />
        ))}
      </div>
      <div className="compact-graph-lines">
        {lines.map((line, index) => (
          <CompactGraphLine
            units={line}
            sentence={sentence}
            focused={focused}
            points={points}
            editable={editable}
            selectedTokenIndex={selectedTokenIndex}
            endingTokenIndex={endingTokenIndex}
            onSelectToken={onSelectToken}
            onPointChange={onPointChange}
            key={`${sentence.id}-compact-line-${index}-${line[0]?.token.index}`}
          />
        ))}
      </div>
    </div>
  );
}

function CompactSentenceRow({
  block,
  measure = false,
  editable = false,
  selectedTokenIndex,
  onSelectToken,
  onPointChange,
}: {
  block: CompactBlock;
  measure?: boolean;
  editable?: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  return (
    <section
      className="compact-sentence-row"
      data-compact-block-id={measure ? undefined : block.id}
      data-compact-measure-id={measure ? block.id : undefined}
    >
      <span className="compact-sentence-number">{String(block.sentence.order).padStart(2, "0")}</span>
      <CompactGraphTrack
        sentence={block.sentence}
        editable={editable}
        selectedTokenIndex={selectedTokenIndex}
        onSelectToken={onSelectToken}
        onPointChange={onPointChange}
      />
    </section>
  );
}

function CompactPageHeader({ work, page, total }: {
  work: RecitationWork;
  page: number;
  total: number;
}) {
  const displayTitle = (work.title || "未命名作品")
    .replace(/^《+\s*/, "")
    .replace(/\s*》+$/, "");
  return (
    <header className="compact-page-header">
      <strong>《{displayTitle}》</strong>
      <span><span>朗诵情感图谱</span><span>（{page}/{total}）</span></span>
      {work.author ? <small>作者：{work.author}</small> : null}
    </header>
  );
}

function CompactPageLegend() {
  return (
    <footer className="compact-page-legend">
      <span><b className="compact-legend-major">V</b> 换气</span>
      <span><b className="compact-legend-minor">v</b> 偷气</span>
      <span><b>/</b> 短停</span>
      <span><b>{"///"}</b> 长停</span>
      <span><b className="compact-legend-focus">红</b> 重音</span>
      <span><i className="compact-legend-curve" aria-hidden="true" /> 语势曲线</span>
    </footer>
  );
}

function CompactA4Page({
  work,
  plan,
  blocksById,
  total,
  selection,
  onSelectToken,
  onPointChange,
}: {
  work: RecitationWork;
  plan: PrintPagePlan;
  blocksById: ReadonlyMap<string, CompactBlock>;
  total: number;
  selection?: CompactSelection;
  onSelectToken: (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => void;
  onPointChange: (sentence: RecitationSentence, tokenIndex: number, visualLevel: number) => void;
}) {
  return (
    <article
      className="compact-a4-page"
      data-compact-pdf-page={plan.index + 1}
      aria-label={`A4 第 ${plan.index + 1} 页，共 ${total} 页`}
    >
      <CompactPageHeader work={work} page={plan.index + 1} total={total} />
      <div className="compact-page-body">
        {plan.blockIds.map((blockId) => {
          const block = blocksById.get(blockId);
          return block ? (
            <CompactSentenceRow
              block={block}
              editable
              selectedTokenIndex={selection?.sentenceId === block.sentence.id ? selection.tokenIndex : undefined}
              onSelectToken={(token, anchor) => onSelectToken(block.sentence, token, anchor)}
              onPointChange={(tokenIndex, visualLevel) => onPointChange(block.sentence, tokenIndex, visualLevel)}
              key={block.id}
            />
          ) : null;
        })}
      </div>
      <CompactPageLegend />
    </article>
  );
}

function contentCapacity(element: HTMLElement) {
  const styles = window.getComputedStyle(element);
  const padding = (Number.parseFloat(styles.paddingTop) || 0)
    + (Number.parseFloat(styles.paddingBottom) || 0);
  return Math.max(0, element.clientHeight - padding);
}

function saveStateLabel(state: CompactSaveState) {
  if (state === "saving") return "正在保存…";
  if (state === "dirty") return "有未保存修改";
  if (state === "failed") return "保存失败，请重试";
  if (state === "saved") return "工程已保存";
  return "等待编辑";
}

export function CompactRecitationEditor({
  work,
  saveState,
  onSentenceChange,
  onSave,
  onOpenLibrary,
  onSwitchFull,
}: {
  work: RecitationWork;
  saveState: CompactSaveState;
  onSentenceChange: (sentence: RecitationSentence) => void;
  onSave: () => void;
  onOpenLibrary: () => void;
  onSwitchFull: () => void;
}) {
  const blocks = useMemo<CompactBlock[]>(
    () => (work.controlSpec?.sentences ?? []).map((sentence) => ({ id: sentence.id, sentence })),
    [work.controlSpec?.sentences],
  );
  const blocksById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const measureRootRef = useRef<HTMLDivElement>(null);
  const pageStackRef = useRef<HTMLDivElement>(null);
  const pageSignatureRef = useRef("");
  const [pages, setPages] = useState<PrintPagePlan[]>([]);
  const [selection, setSelection] = useState<CompactSelection>();
  const [pinyinEditorOpen, setPinyinEditorOpen] = useState(false);
  const [pinyinDraft, setPinyinDraft] = useState("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutMessage, setLayoutMessage] = useState("正在按整句计算 A4 分页…");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const workspaceStyle = {
    "--compact-a4-margin": `${COMPACT_MARGIN_MM}mm`,
  } as CSSProperties;

  const calculatePagination = useCallback(() => {
    const root = measureRootRef.current;
    if (!root || !blocks.length) {
      pageSignatureRef.current = "";
      setPages([]);
      return;
    }
    const firstBody = root.querySelector<HTMLElement>("[data-compact-measure-capacity='first']");
    const continuationBody = root.querySelector<HTMLElement>("[data-compact-measure-capacity='continuation']");
    const measuredElements = Array.from(root.querySelectorAll<HTMLElement>("[data-compact-measure-id]"));
    if (!firstBody || !continuationBody || measuredElements.length !== blocks.length) return;
    const measured = measuredElements.map((element) => ({
      id: element.dataset.compactMeasureId ?? "",
      heightPx: element.getBoundingClientRect().height,
    }));
    if (measured.some((block) => block.heightPx <= 0)) return;
    const styles = window.getComputedStyle(firstBody);
    const blockGapPx = Number.parseFloat(styles.rowGap || styles.gap) || 0;
    const nextPages = paginateMeasuredPrintBlocks(measured, {
      firstPageCapacityPx: contentCapacity(firstBody),
      continuationPageCapacityPx: contentCapacity(continuationBody),
      blockGapPx,
      protectSingleBlockPages: true,
    });
    const nextSignature = nextPages.map((page) => (
      `${page.blockIds.join(",")}:${Math.round(page.usedHeightPx)}:${page.hasOversizedBlock ? 1 : 0}`
    )).join("|");
    if (pageSignatureRef.current !== nextSignature) {
      pageSignatureRef.current = nextSignature;
      setPages(nextPages);
    }
    const oversized = nextPages.filter((page) => page.hasOversizedBlock).length;
    setLayoutMessage(oversized
      ? `已按实际高度排成 ${nextPages.length} 页；${oversized} 个超长句单独占页`
      : `已按实际高度排成 ${nextPages.length} 页；整句不会跨页`);
  }, [blocks]);

  useLayoutEffect(() => {
    const root = measureRootRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => window.requestAnimationFrame(calculatePagination));
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-compact-measure-id], [data-compact-measure-capacity]")
      .forEach((element) => observer.observe(element));
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [blocks, calculatePagination, layoutRevision]);

  const openSelection = (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const width = 386;
    setSelection({
      sentenceId: sentence.id,
      tokenIndex: token.index,
      x: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)),
      y: Math.max(80, Math.min(window.innerHeight - 238, rect.bottom + 10)),
    });
    setPinyinEditorOpen(false);
    setPinyinDraft(token.displayPinyin ?? token.pinyin ?? "");
  };

  const changePoint = (sentence: RecitationSentence, tokenIndex: number, visualLevel: number) => {
    onSentenceChange({
      ...sentence,
      prosodyPointOverrides: upsertProsodyPointOverride(
        sentence.prosodyPointOverrides ?? [],
        tokenIndex,
        visualLevel,
      ),
    });
  };

  const selectedSentence = selection
    ? work.controlSpec?.sentences.find((sentence) => sentence.id === selection.sentenceId)
    : undefined;
  const selectedToken = selectedSentence?.tokens.find((token) => token.index === selection?.tokenIndex);
  const selectedPause = selectedSentence && selectedToken ? pauseAt(selectedSentence, selectedToken.index) : undefined;
  const selectedBreath = selectedSentence && selectedToken ? breathAt(selectedSentence, selectedToken.index) : undefined;
  const selectedFocused = Boolean(selectedSentence && selectedToken && focusIndexes(selectedSentence).has(selectedToken.index));
  const selectedProlong = Boolean(selectedSentence && selectedToken && prolongAt(selectedSentence, selectedToken.index));

  const editSelected = (transform: (sentence: RecitationSentence, token: TimedToken) => RecitationSentence) => {
    if (!selectedSentence || !selectedToken) return;
    onSentenceChange(transform(selectedSentence, selectedToken));
  };

  const saveSelectedPinyin = () => {
    const value = pinyinDraft.trim();
    editSelected((sentence, token) => ({
      ...sentence,
      tokens: sentence.tokens.map((candidate) => (
        candidate.index === token.index ? { ...candidate, displayPinyin: value } : candidate
      )),
    }));
    setPinyinEditorOpen(false);
  };

  const exportPdf = async () => {
    if (exportingPdf || !pages.length) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setSelection(undefined);
    setExportingPdf(true);
    setExportError(undefined);
    setLayoutMessage(`正在生成 ${pages.length} 页 PDF…`);
    try {
      await document.fonts?.ready;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      const stack = pageStackRef.current;
      const pageElements = stack
        ? Array.from(stack.querySelectorAll<HTMLElement>("[data-compact-pdf-page]"))
        : [];
      if (!pageElements.length) throw new Error("A4 页面还没有排版完成");
      const [{ toCanvas }, { jsPDF }] = await Promise.all([
        import("html-to-image"),
        import("jspdf"),
      ]);
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      for (let index = 0; index < pageElements.length; index += 1) {
        const page = pageElements[index];
        const canvas = await toCanvas(page, {
          backgroundColor: "#fffdf8",
          cacheBust: true,
          pixelRatio: COMPACT_RENDER_DPR,
          width: page.scrollWidth,
          height: page.scrollHeight,
          filter: (node) => !(node instanceof Element)
            || node.getAttribute("data-export-exclude") !== "true",
          style: {
            boxShadow: "none",
            margin: "0",
            transform: "none",
          },
        });
        if (index > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(canvas, "PNG", 0, 0, 210, 297, undefined, "FAST");
        setLayoutMessage(`正在生成 PDF：${index + 1} / ${pageElements.length} 页`);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      pdf.save(safePrintFilename(work.title, "pdf"));
      setLayoutMessage(`PDF 已生成：${pageElements.length} 页 A4`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportError(`PDF 导出失败：${message}`);
      setLayoutMessage("PDF 导出失败，请重试");
    } finally {
      setExportingPdf(false);
    }
  };

  if (!blocks.length) {
    return (
      <section className="compact-editor-empty">
        <h1>紧凑版还没有可编辑文稿</h1>
        <p>请先在完整版填写作品标题与正文，再切换回来。</p>
        <button type="button" className="primary-button" onClick={onSwitchFull}>返回完整版</button>
      </section>
    );
  }

  return (
    <section
      className={`compact-editor-workspace ${exportingPdf ? "is-exporting" : ""}`}
      style={workspaceStyle}
      aria-label="紧凑版 A4 朗诵谱编辑器"
    >
      <div className="compact-editor-toolbar" data-export-exclude="true">
        <div className="compact-toolbar-title">
          <p>紧凑版 · 人工朗诵谱</p>
          <strong>{work.title || "未命名作品"}</strong>
          <small>{layoutMessage}</small>
        </div>
        <div className="compact-toolbar-status" aria-live="polite">
          <span className={`compact-save-state state-${saveState}`}>{saveStateLabel(saveState)}</span>
          <span>A4 纵向</span>
          <span>{pages.length || "计算中"} 页</span>
        </div>
        <div className="compact-toolbar-actions">
          <button type="button" className="text-button" onClick={onOpenLibrary}>作品库</button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLayoutRevision((revision) => revision + 1)}
            disabled={exportingPdf}
          >
            重新排版
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onSave}
            disabled={saveState === "saving" || saveState === "saved"}
          >
            {saveState === "saving" ? "保存中…" : "保存工程"}
          </button>
          <button
            type="button"
            className="primary-button compact-export-button"
            onClick={() => void exportPdf()}
            disabled={!pages.length || exportingPdf}
          >
            {exportingPdf ? "正在导出…" : "导出 PDF"}
          </button>
        </div>
      </div>

      {exportError ? <p className="compact-export-error" role="alert">{exportError}</p> : null}

      <div className="compact-page-stack" ref={pageStackRef}>
        {pages.map((page) => (
          <CompactA4Page
            work={work}
            plan={page}
            blocksById={blocksById}
            total={pages.length}
            selection={selection}
            onSelectToken={openSelection}
            onPointChange={changePoint}
            key={`compact-page-${page.index}-${page.blockIds.join("-")}`}
          />
        ))}
      </div>

      {selectedSentence && selectedToken && selection ? (
        <aside
          className="compact-marker-popover"
          data-export-exclude="true"
          style={{ left: selection.x, top: selection.y }}
          role="dialog"
          aria-label={`编辑“${selectedToken.char}”的朗诵标识`}
        >
          <div className="compact-popover-heading">
            <span>“{selectedToken.char}”及字后位置</span>
            <button type="button" onClick={() => { setSelection(undefined); setPinyinEditorOpen(false); }} aria-label="关闭标识工具">×</button>
          </div>
          <div className="compact-marker-groups">
            <div>
              <small>停顿</small>
              <button
                type="button"
                className={selectedPause?.type === "short" ? "active" : ""}
                onClick={() => editSelected((sentence, token) => setPauseAt(sentence, token, "short"))}
              >/</button>
              <button
                type="button"
                className={selectedPause?.type === "long" ? "active" : ""}
                onClick={() => editSelected((sentence, token) => setPauseAt(sentence, token, "long"))}
              >{"//"}</button>
            </div>
            <div>
              <small>换气</small>
              <button
                type="button"
                className={`major-breath-button ${selectedBreath?.type === "breath_major" ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setBreathAt(sentence, token, "breath_major"))}
              >V</button>
              <button
                type="button"
                className={`minor-breath-button ${selectedBreath?.type === "breath_minor" ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setBreathAt(sentence, token, "breath_minor"))}
              >v</button>
            </div>
            <div className="compact-other-markers">
              <small>其他</small>
              <button
                type="button"
                className={selectedFocused ? "active" : ""}
                onClick={() => editSelected(toggleFocus)}
              >重音</button>
              <button
                type="button"
                className={selectedProlong ? "active" : ""}
                onClick={() => editSelected(toggleProlongation)}
              >拖音</button>
              <button
                type="button"
                className={selectedSentence.endingIntonation.type === "rising" ? "active" : ""}
                onClick={() => editSelected((sentence) => setEndingTone(sentence, "rising"))}
              >↗</button>
              <button
                type="button"
                className={selectedSentence.endingIntonation.type === "falling" ? "active" : ""}
                onClick={() => editSelected((sentence) => setEndingTone(sentence, "falling"))}
              >↘</button>
              <button
                type="button"
                className={pinyinEditorOpen ? "active" : ""}
                onClick={() => {
                  setPinyinDraft(selectedToken.displayPinyin ?? selectedToken.pinyin ?? "");
                  setPinyinEditorOpen((open) => !open);
                }}
              >拼音</button>
            </div>
          </div>
          {pinyinEditorOpen ? (
            <div className="compact-pinyin-editor">
              <label>拼音
                <input
                  value={pinyinDraft}
                  onChange={(event) => setPinyinDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveSelectedPinyin();
                  }}
                  aria-label={`修改“${selectedToken.char}”的拼音`}
                />
              </label>
              <button type="button" onClick={saveSelectedPinyin}>保存</button>
            </div>
          ) : null}
        </aside>
      ) : null}

      <div className="compact-measure-layer" aria-hidden="true" ref={measureRootRef}>
        <article className="compact-a4-page compact-measure-page">
          <CompactPageHeader work={work} page={1} total={1} />
          <div className="compact-page-body" data-compact-measure-capacity="first" />
          <CompactPageLegend />
        </article>
        <article className="compact-a4-page compact-measure-page">
          <CompactPageHeader work={work} page={2} total={2} />
          <div className="compact-page-body" data-compact-measure-capacity="continuation" />
          <CompactPageLegend />
        </article>
        <div className="compact-block-measure-list">
          {blocks.map((block) => (
            <CompactSentenceRow block={block} measure key={`compact-measure-${block.id}`} />
          ))}
        </div>
      </div>
    </section>
  );
}
