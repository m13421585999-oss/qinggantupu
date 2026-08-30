"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  upsertProsodyPointOverride,
  type ProsodyPointChange,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";
import {
  adjustVisualLineBoundaries,
  mergeAcrossCompactSentences,
  splitGraphUnitsByMeasuredWidth,
  type VisualLineMergeDirection,
} from "@/lib/semantic-scene-lines";
import { TeachingProsodyTrack } from "@/components/TeachingProsodyTrack";
import { DistanceViewGlyph } from "@/components/RecitationTechniqueGlyphs";
import { VirtualVoiceGroupOverlay } from "@/components/VirtualVoiceGroupOverlay";
import { usesChushibiaoVirtualVoiceSpacing } from "@/lib/edition-layout";
import {
  deliveryTechniqueAt,
  distanceViewAt,
  setDeliveryTechniqueAt,
} from "@/lib/delivery-technique";
import {
  COMPACT_LEGEND_OPTIONS,
  type CompactLegendItemId,
  usedCompactLegendItems,
} from "@/lib/compact-legend";
import { isRhythm, RHYTHM_LABELS, rhythmLabel } from "@/lib/recitation-schema";
import {
  mapActiveSceneAssetsBySceneId,
  mapSceneAssetsToSentences,
} from "@/lib/visual-assets";
import type {
  BreathMark,
  EndingTone,
  PauseMark,
  RecitationSentence,
  RecitationWork,
  Rhythm,
  SceneTechniqueMark,
  TimedToken,
} from "@/lib/recitation-schema";

const COMPACT_MARGIN_MM = 8.5;
const COMPACT_RENDER_DPR = 2.5;
const COMPACT_CURVE_HEIGHT = 34;
const COMPACT_CURVE_PADDING = 4.5;
const COMPACT_PROSODY_LEVELS = [0, 2, 4, 6, 8] as const;
const COMPACT_RHYTHM_OPTIONS = (Object.keys(RHYTHM_LABELS) as Rhythm[]).map((value) => ({
  value,
  label: RHYTHM_LABELS[value],
}));

type CompactSaveState = "unsaved" | "dirty" | "saving" | "saved" | "failed";

interface CompactSelection {
  sentenceId: string;
  tokenIndex: number;
  x: number;
  y: number;
}

interface CompactRhythmSelection {
  sentenceId: string;
  x: number;
  y: number;
}

interface CompactBlock {
  id: string;
  sentence: RecitationSentence;
}

interface CompactLineBlock {
  id: string;
  sentenceId: string;
  tokenIndexes: number[];
  cropIndex: number;
  displayOrder: number;
}

interface CompactSentenceDraft {
  source: RecitationSentence;
  current: RecitationSentence;
}

function applyPinyinOverrides(sentence: RecitationSentence, overrides: Record<string, string>) {
  if (!Object.keys(overrides).length) return sentence;
  return {
    ...sentence,
    tokens: sentence.tokens.map((token) => {
      const override = overrides[token.id];
      return override === undefined ? token : { ...token, displayPinyin: override };
    }),
  };
}

function visibleSourceCharacter(value: string) {
  if (/\r|\n/u.test(value)) return "";
  if (/^\s+$/u.test(value)) return " ";
  return value;
}

function lineSignature(lines: GraphTokenUnit[][]) {
  return lines.map((line) => line.map((unit) => unit.token.index).join(",")).join("|");
}

function compactLineId(sentenceId: string, line: GraphTokenUnit[]) {
  const first = line[0]?.token.index ?? 0;
  const last = line.at(-1)?.token.index ?? first;
  return `${sentenceId}:line:${first}-${last}`;
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

function sceneTechniqueAt(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.sceneTechniqueMarks?.find((mark) => mark.tokenIndex === tokenIndex);
}

function isSpringSceneTechniqueWork(title: string) {
  return title
    .normalize("NFKC")
    .trim()
    .replace(/^《+\s*/u, "")
    .replace(/\s*》+$/u, "")
    .replace(/\s+/gu, "") === "春";
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

function toggleStaccato(sentence: RecitationSentence, token: TimedToken) {
  const focused = focusIndexes(sentence).has(token.index);
  const shortPause = pauseAt(sentence, token.index)?.type === "short";
  const active = focused && shortPause;
  let next = sentence;
  if (active || !focused) next = toggleFocus(next, token);
  if (active || !shortPause) next = setPauseAt(next, token, "short");
  return next;
}

function setSceneTechniqueAt(
  sentence: RecitationSentence,
  token: TimedToken,
  type: SceneTechniqueMark["type"],
) {
  const current = sceneTechniqueAt(sentence, token.index);
  const marks = (sentence.sceneTechniqueMarks ?? [])
    .filter((mark) => mark.tokenIndex !== token.index);
  if (current?.type === type) {
    return { ...sentence, sceneTechniqueMarks: marks.length ? marks : undefined };
  }
  return {
    ...sentence,
    sceneTechniqueMarks: [...marks, {
      id: current?.id ?? `${sentence.id}-scene-technique-${token.index}`,
      tokenId: token.id,
      tokenIndex: token.index,
      type,
      source: "human" as const,
    }].sort((left, right) => left.tokenIndex - right.tokenIndex),
  };
}

function toggleEndingTone(
  sentence: RecitationSentence,
  type: Exclude<EndingTone, "level">,
): RecitationSentence {
  const nextType: EndingTone = sentence.endingIntonation.type === type ? "level" : type;
  return {
    ...sentence,
    endingIntonation: {
      ...sentence.endingIntonation,
      type: nextType,
      confidence: 1,
      source: "human" as const,
    },
  };
}

function CompactSceneTechniqueGlyph({ type }: { type: SceneTechniqueMark["type"] }) {
  if (type === "real") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.4 12s3.6-5.6 9.6-5.6 9.6 5.6 9.6 5.6-3.6 5.6-9.6 5.6S2.4 12 2.4 12Z" />
        <circle cx="12" cy="12" r="2.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20.2 4.5 13c-4.4-4.2 1.8-10.7 6.2-6.2L12 8.1l1.3-1.3c4.4-4.5 10.6 2 6.2 6.2L12 20.2Z" />
    </svg>
  );
}

function CompactTokenUnit({
  unit,
  sentence,
  focused,
  editable,
  selected,
  showSceneTechniqueRow,
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
  showSceneTechniqueRow: boolean;
  endingTokenIndex?: number;
  characterRef?: (element: HTMLElement | null) => void;
  measureRef?: (element: HTMLSpanElement | null) => void;
  onSelect?: (anchor: HTMLElement) => void;
}) {
  const pause = pauseAt(sentence, unit.token.index);
  const breath = breathAt(sentence, unit.token.index);
  const prolongation = prolongAt(sentence, unit.token.index);
  const sceneTechnique = sceneTechniqueAt(sentence, unit.token.index);
  const virtualVoice = deliveryTechniqueAt(sentence, unit.token.index, "virtual_voice");
  const distanceView = distanceViewAt(sentence, unit.token.index);
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
        {distanceView ? (
          <span
            className={`compact-distance-marker is-${distanceView.type}`}
            aria-label={distanceView.type === "distant_view" ? "远景" : "近景"}
          >
            <DistanceViewGlyph type={distanceView.type} />
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
        <span className={`compact-spoken-token ${showSceneTechniqueRow ? "has-scene-technique-row" : ""}`}>
          {showSceneTechniqueRow ? (
            <span
              className={`compact-scene-technique-slot ${sceneTechnique ? `is-${sceneTechnique.type}` : ""}`}
              aria-label={sceneTechnique?.type === "real" ? "实景" : sceneTechnique?.type === "virtual" ? "虚景" : undefined}
            >
              {sceneTechnique ? <CompactSceneTechniqueGlyph type={sceneTechnique.type} /> : null}
            </span>
          ) : null}
          <span className="compact-token-pinyin" aria-hidden="true">
            {unit.token.displayPinyin ?? unit.token.pinyin ?? " "}
          </span>
          {editable ? (
            <button
              type="button"
              className={`compact-token-char ${focused ? "is-focus" : ""} ${virtualVoice ? "is-virtual-voice" : ""} ${selected ? "is-selected" : ""}`}
              ref={characterRef as (element: HTMLButtonElement | null) => void}
              onClick={(event) => select(event.currentTarget)}
              aria-label={`编辑“${unit.token.char}”及其后方标识`}
            >
              {unit.token.char}
            </button>
          ) : (
            <span
              className={`compact-token-char ${focused ? "is-focus" : ""} ${virtualVoice ? "is-virtual-voice" : ""}`}
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

function CompactProsodyCurve(props: {
  units: GraphTokenUnit[];
  points: TeachingProsodyPoint[];
  characterRefs: React.RefObject<Map<number, HTMLElement>>;
  rowElement: HTMLDivElement | null;
  editable: boolean;
  onPointsChange?: (changes: ProsodyPointChange[]) => void;
}) {
  return (
    <TeachingProsodyTrack
      {...props}
      curveHeight={COMPACT_CURVE_HEIGHT}
      curvePadding={COMPACT_CURVE_PADDING}
      className="compact-prosody-curve"
      visualLevels={COMPACT_PROSODY_LEVELS}
      continuousDrawing
    />
  );
}


function CompactGraphLine({
  units,
  sentence,
  focused,
  points,
  editable,
  springSceneTechniqueMode,
  selectedTokenIndex,
  endingTokenIndex,
  onSelectToken,
  onPointsChange,
}: {
  units: GraphTokenUnit[];
  sentence: RecitationSentence;
  focused: Set<number>;
  points: TeachingProsodyPoint[];
  editable: boolean;
  springSceneTechniqueMode: boolean;
  selectedTokenIndex?: number;
  endingTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointsChange?: (changes: ProsodyPointChange[]) => void;
}) {
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const characterRefs = useRef(new Map<number, HTMLElement>());
  return (
    <div
      className={`compact-graph-line ${springSceneTechniqueMode ? "is-spring-scene-technique" : ""}`}
      ref={setRowElement}
    >
      <div className="compact-token-row">
        {units.map((unit) => (
          <CompactTokenUnit
            unit={unit}
            sentence={sentence}
            focused={focused.has(unit.token.index)}
            editable={editable}
            selected={selectedTokenIndex === unit.token.index}
            showSceneTechniqueRow={springSceneTechniqueMode}
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
      <VirtualVoiceGroupOverlay
        sentence={sentence}
        tokenIndexes={units.map((unit) => unit.token.index)}
        characterRefs={characterRefs}
        rowElement={rowElement}
      />
      {springSceneTechniqueMode ? null : (
        <CompactProsodyCurve
          units={units}
          points={points}
          characterRefs={characterRefs}
          rowElement={rowElement}
          editable={editable}
          onPointsChange={onPointsChange}
        />
      )}
    </div>
  );
}

function CompactGraphTrack({
  sentence,
  sceneImageUrl,
  sceneImageAlt,
  measure,
  lineTokenIndexes,
  displayOrder,
  cropIndex,
  onSelectRhythm,
  editable,
  springSceneTechniqueMode,
  selectedTokenIndex,
  onSelectToken,
  onPointsChange,
}: {
  sentence: RecitationSentence;
  sceneImageUrl?: string;
  sceneImageAlt?: string;
  measure?: boolean;
  lineTokenIndexes?: readonly number[];
  displayOrder?: number;
  cropIndex?: number;
  onSelectRhythm?: (anchor: HTMLElement) => void;
  editable: boolean;
  springSceneTechniqueMode: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointsChange?: (changes: ProsodyPointChange[]) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const textColumnRef = useRef<HTMLDivElement>(null);
  const probeRefs = useRef(new Map<number, HTMLSpanElement>());
  const units = useMemo(() => buildGraphTokenUnits(sentence), [sentence]);
  const [lines, setLines] = useState<GraphTokenUnit[][]>(() => units.length ? [units] : []);
  const fixedLine = useMemo(() => {
    if (!lineTokenIndexes) return undefined;
    const included = new Set(lineTokenIndexes);
    return units.filter((unit) => included.has(unit.token.index));
  }, [lineTokenIndexes, units]);
  const displayedLines = fixedLine ? [fixedLine] : lines;
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
    if (lineTokenIndexes) return;
    const track = trackRef.current;
    const textColumn = textColumnRef.current;
    const maxLineWidth = textColumn?.clientWidth ?? 0;
    if (!track || !units.length || maxLineWidth <= 0) return;
    const styles = window.getComputedStyle(track);
    const unitGap = Number.parseFloat(styles.getPropertyValue("--compact-token-gap")) || 3;
    const widths = new Map(units.flatMap((unit) => {
      const element = probeRefs.current.get(unit.token.index);
      return element ? [[unit.token.index, element.getBoundingClientRect().width]] : [];
    }));
    if (widths.size !== units.length) return;
    const nextLines = splitGraphUnitsByMeasuredWidth(units, {
      maxLineWidth,
      unitWidths: widths,
      unitGap,
      preferredBoundaryIndexes: sentence.prosody.map((event) => event.activeSpan.end),
      protectedBoundaryIndexes: protectedSentenceBoundaries(sentence),
      forcedBoundaryIndexes: sentence.lineBreakAfterTokenIndexes,
    });
    setLines((current) => lineSignature(current) === lineSignature(nextLines) ? current : nextLines);
  }, [lineTokenIndexes, sentence, units]);

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
    if (textColumnRef.current) observer.observe(textColumnRef.current);
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
            showSceneTechniqueRow={springSceneTechniqueMode}
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
        {displayedLines.map((line, index) => {
          const sourceLineIndex = lineTokenIndexes ? (cropIndex ?? 0) : index;
          const lineId = compactLineId(sentence.id, line);
          const visualLine = (
            <div
            className="compact-visual-line"
            key={measure ? undefined : lineId}
          >
            <CompactSceneThumbnail
              imageUrl={measure ? undefined : sceneImageUrl}
              imageAlt={sceneImageAlt}
              order={displayOrder ?? sentence.order}
              sourceOrder={sentence.order}
              rhythm={sentence.rhythm}
              cropIndex={sourceLineIndex}
              onSelectRhythm={onSelectRhythm}
            />
            <div
              className="compact-visual-graph-column"
              ref={index === 0 ? textColumnRef : undefined}
            >
              <CompactGraphLine
                units={line}
                sentence={sentence}
                focused={focused}
                points={points}
                editable={editable}
                springSceneTechniqueMode={springSceneTechniqueMode}
                selectedTokenIndex={selectedTokenIndex}
                endingTokenIndex={endingTokenIndex}
                onSelectToken={onSelectToken}
                onPointsChange={onPointsChange}
              />
            </div>
            </div>
          );
          return measure ? (
            <div
              className="compact-sentence-row compact-line-measure-row"
              data-compact-measure-id={lineId}
              data-compact-sentence-id={sentence.id}
              data-compact-token-indexes={line.map((unit) => unit.token.index).join(",")}
              data-compact-crop-index={sourceLineIndex}
              key={lineId}
            >
              {visualLine}
            </div>
          ) : visualLine;
        })}
      </div>
    </div>
  );
}

function CompactSentenceRow({
  block,
  sceneImageUrl,
  sceneImageAlt,
  lineBlock,
  onSelectRhythm,
  measure = false,
  editable = false,
  springSceneTechniqueMode = false,
  selectedTokenIndex,
  onSelectToken,
  onPointsChange,
}: {
  block: CompactBlock;
  sceneImageUrl?: string;
  sceneImageAlt?: string;
  lineBlock?: CompactLineBlock;
  onSelectRhythm?: (anchor: HTMLElement) => void;
  measure?: boolean;
  editable?: boolean;
  springSceneTechniqueMode?: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointsChange?: (changes: ProsodyPointChange[]) => void;
}) {
  return (
    <section
      className={measure ? "compact-sentence-measure-group" : "compact-sentence-row"}
      data-compact-block-id={measure ? undefined : (lineBlock?.id ?? block.id)}
    >
      <CompactGraphTrack
        sentence={block.sentence}
        sceneImageUrl={sceneImageUrl}
        sceneImageAlt={sceneImageAlt}
        measure={measure}
        lineTokenIndexes={lineBlock?.tokenIndexes}
        displayOrder={lineBlock?.displayOrder}
        cropIndex={lineBlock?.cropIndex}
        onSelectRhythm={onSelectRhythm}
        editable={editable}
        springSceneTechniqueMode={springSceneTechniqueMode}
        selectedTokenIndex={selectedTokenIndex}
        onSelectToken={onSelectToken}
        onPointsChange={onPointsChange}
      />
    </section>
  );
}

function CompactSceneThumbnail({
  imageUrl,
  imageAlt,
  order,
  sourceOrder,
  rhythm,
  cropIndex = 0,
  showMeta = true,
  onSelectRhythm,
}: {
  imageUrl?: string;
  imageAlt?: string;
  order: number;
  sourceOrder?: number;
  rhythm: RecitationSentence["rhythm"];
  cropIndex?: number;
  showMeta?: boolean;
  onSelectRhythm?: (anchor: HTMLElement) => void;
}) {
  const [failed, setFailed] = useState<string>();
  const available = Boolean(imageUrl && imageUrl !== failed);
  const label = rhythmLabel(rhythm);
  const orderLabel = String(order).padStart(2, "0");
  const cropPositions = ["center 42%", "center 56%", "center 68%"] as const;
  return (
    <aside className="compact-scene-thumbnail" aria-label={imageAlt ?? `第 ${order} 段情景小图`}>
      {available && imageUrl ? (
        // Generated scene assets are same-origin persisted R2 objects.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={imageAlt ?? ""}
          decoding="async"
          style={{ objectPosition: cropPositions[((sourceOrder ?? order) - 1 + cropIndex) % cropPositions.length] }}
          onError={() => setFailed(imageUrl)}
        />
      ) : (
        <div className="compact-scene-placeholder" role="img" aria-label="情景图片生成中" />
      )}
      {showMeta ? <div className="compact-scene-meta">
        <span className="compact-sentence-number" aria-label={`编号 ${orderLabel}`}>
          {Array.from(orderLabel).map((character, index) => (
            <span key={index}>{character}</span>
          ))}
        </span>
        <button
          type="button"
          className="compact-rhythm-label"
          aria-label={label ? `选择节奏，当前：${label}` : "选择节奏，当前未标注"}
          disabled={!onSelectRhythm}
          onClick={(event) => onSelectRhythm?.(event.currentTarget)}
        >
          {Array.from(label ?? "未标").map((character, index) => (
            <span key={index}>{character}</span>
          ))}
        </button>
      </div> : null}
    </aside>
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
      <strong>《{displayTitle}》情感图谱（{page}/{total}）</strong>
      {work.author ? <small>作者：{work.author}</small> : null}
    </header>
  );
}

function CompactLegendGlyph({ id }: { id: CompactLegendItemId }) {
  if (id === "breath-major") {
    return <b className="compact-legend-major" aria-hidden="true">V</b>;
  }
  if (id === "breath-minor") {
    return <b className="compact-legend-minor" aria-hidden="true">v</b>;
  }
  if (id === "pause-short") return <b aria-hidden="true">/</b>;
  if (id === "pause-long") return <b aria-hidden="true">{"///"}</b>;
  if (id === "focus") {
    return <b className="compact-legend-focus" aria-hidden="true">红</b>;
  }
  if (id === "virtual-voice") {
    return <b className="compact-legend-virtual-voice" aria-hidden="true">声</b>;
  }
  if (id === "distant-view") {
    return <DistanceViewGlyph type="distant_view" />;
  }
  if (id === "close-view") {
    return <DistanceViewGlyph type="close_view" />;
  }
  if (id === "prosody-curve") {
    return <i className="compact-legend-curve" aria-hidden="true" />;
  }
  if (id === "intonation-rising") {
    return <b className="compact-legend-arrow" aria-hidden="true">↗</b>;
  }
  if (id === "intonation-falling") {
    return <b className="compact-legend-arrow" aria-hidden="true">↘</b>;
  }
  if (id === "prolong") {
    return <b className="compact-legend-prolong" aria-hidden="true">—</b>;
  }
  if (id === "staccato") {
    return <b className="compact-legend-staccato" aria-hidden="true">/红/红</b>;
  }
  if (id === "real-scene") {
    return (
      <svg className="compact-legend-icon compact-legend-real-scene" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.4 12s3.6-5.6 9.6-5.6 9.6 5.6 9.6 5.6-3.6 5.6-9.6 5.6S2.4 12 2.4 12Z" />
        <circle cx="12" cy="12" r="2.8" />
      </svg>
    );
  }
  return (
    <svg className="compact-legend-icon compact-legend-virtual-scene" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20.2 4.5 13c-4.4-4.2 1.8-10.7 6.2-6.2L12 8.1l1.3-1.3c4.4-4.5 10.6 2 6.2 6.2L12 20.2Z" />
    </svg>
  );
}

function CompactLegendItem({ id }: { id: CompactLegendItemId }) {
  const option = COMPACT_LEGEND_OPTIONS.find((candidate) => candidate.id === id);
  return (
    <span className={`compact-legend-item compact-legend-item-${id}`}>
      <CompactLegendGlyph id={id} />
      {option?.label ?? id}
    </span>
  );
}

function CompactPageLegend({ items }: { items: readonly CompactLegendItemId[] }) {
  return (
    <footer
      className={`compact-page-legend ${items.length ? "" : "is-empty"}`}
      aria-label="朗诵标识图例"
    >
      {items.map((id) => <CompactLegendItem id={id} key={id} />)}
    </footer>
  );
}

function CompactA4Page({
  work,
  plan,
  blocksById,
  lineBlocksById,
  sceneAssetsByLineId,
  sceneAssetsBySentenceId,
  legendItems,
  springSceneTechniqueMode,
  total,
  selection,
  onSelectToken,
  onPointsChange,
  onSelectRhythm,
}: {
  work: RecitationWork;
  plan: PrintPagePlan;
  blocksById: ReadonlyMap<string, CompactBlock>;
  lineBlocksById: ReadonlyMap<string, CompactLineBlock>;
  sceneAssetsByLineId: ReadonlyMap<string, { url?: string; prompt?: string }>;
  sceneAssetsBySentenceId: ReadonlyMap<string, { url?: string; prompt?: string }>;
  legendItems: readonly CompactLegendItemId[];
  springSceneTechniqueMode: boolean;
  total: number;
  selection?: CompactSelection;
  onSelectToken: (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => void;
  onPointsChange: (sentence: RecitationSentence, changes: ProsodyPointChange[]) => void;
  onSelectRhythm: (sentence: RecitationSentence, anchor: HTMLElement) => void;
}) {
  return (
    <article
      className="compact-a4-page"
      data-compact-pdf-page={plan.index + 1}
      aria-label={`A4 第 ${plan.index + 1} 页，共 ${total} 页`}
    >
      <CompactPageHeader work={work} page={plan.index + 1} total={total} />
      <div className="compact-page-body">
        {plan.blockIds.map((lineBlockId) => {
          const lineBlock = lineBlocksById.get(lineBlockId);
          const block = lineBlock ? blocksById.get(lineBlock.sentenceId) : undefined;
          const scene = lineBlock
            ? sceneAssetsByLineId.get(lineBlock.id)
              ?? sceneAssetsBySentenceId.get(lineBlock.sentenceId)
            : undefined;
          const compactSceneImageUrl = scene?.url
            ?? (lineBlock
              ? `/compact-scenes/${encodeURIComponent(work.id)}/${encodeURIComponent(lineBlock.id)}.jpg`
              : undefined);
          return block && lineBlock ? (
            <CompactSentenceRow
              block={block}
              lineBlock={lineBlock}
              sceneImageUrl={compactSceneImageUrl}
              sceneImageAlt={scene?.prompt ?? `${block.sentence.text}的意境图`}
              editable
              springSceneTechniqueMode={springSceneTechniqueMode}
              selectedTokenIndex={selection?.sentenceId === block.sentence.id ? selection.tokenIndex : undefined}
              onSelectToken={(token, anchor) => onSelectToken(block.sentence, token, anchor)}
              onPointsChange={(changes) => onPointsChange(block.sentence, changes)}
              onSelectRhythm={(anchor) => onSelectRhythm(block.sentence, anchor)}
              key={lineBlock.id}
            />
          ) : null;
        })}
      </div>
      <CompactPageLegend items={legendItems} />
      <div className="compact-logo-footer" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/full-logo.jpeg" alt="忆岁朗诵院" />
      </div>
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
  onSentencesChange,
  onPinyinOverrideChange,
  onSave,
  onOpenLibrary,
  onSwitchFull,
}: {
  work: RecitationWork;
  saveState: CompactSaveState;
  onSentenceChange: (sentence: RecitationSentence) => void;
  onSentencesChange: (sentences: RecitationSentence[]) => void;
  onPinyinOverrideChange: (tokenId: string, value: string) => void;
  onLegendItemsChange: (items: CompactLegendItemId[]) => void;
  onSave: () => void;
  onOpenLibrary: () => void;
  onSwitchFull: () => void;
}) {
  const blocks = useMemo<CompactBlock[]>(
    () => (work.controlSpec?.sentences ?? []).map((sentence) => ({
      id: sentence.id,
      sentence: applyPinyinOverrides(sentence, work.controlSpec?.pinyinOverrides ?? {}),
    })),
    [work.controlSpec],
  );
  const sentenceDraftsRef = useRef(new Map<string, CompactSentenceDraft>());
  useLayoutEffect(() => {
    const activeIds = new Set(blocks.map((block) => block.id));
    for (const sentenceId of sentenceDraftsRef.current.keys()) {
      if (!activeIds.has(sentenceId)) sentenceDraftsRef.current.delete(sentenceId);
    }
    for (const block of blocks) {
      const draft = sentenceDraftsRef.current.get(block.id);
      if (!draft || draft.source !== block.sentence) {
        sentenceDraftsRef.current.set(block.id, {
          source: block.sentence,
          current: block.sentence,
        });
      }
    }
  }, [blocks]);
  const blocksById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const springSceneTechniqueMode = isSpringSceneTechniqueWork(work.title);
  const legendItems = useMemo(
    () => usedCompactLegendItems(work.controlSpec?.sentences ?? [], {
      showProsodyCurve: !springSceneTechniqueMode,
    }),
    [springSceneTechniqueMode, work.controlSpec?.sentences],
  );
  const legendSignature = legendItems.join("|");
  const chushibiaoVirtualVoiceSpacing = usesChushibiaoVirtualVoiceSpacing(work.id);
  const sceneAssetsBySentenceId = useMemo(
    () => mapSceneAssetsToSentences(work.visuals, work.controlSpec?.sentences ?? []),
    [work.visuals, work.controlSpec],
  );
  const sceneAssetsByLineId = useMemo(
    () => mapActiveSceneAssetsBySceneId(work.visuals),
    [work.visuals],
  );
  const invalidRhythmBlocks = useMemo(
    () => blocks.filter((block) => !isRhythm(block.sentence.rhythm)),
    [blocks],
  );
  useEffect(() => {
    for (const block of invalidRhythmBlocks) {
      console.warn("[CompactRecitationEditor] 未知或缺失的节奏值，已隐藏节奏标签", {
        sentenceId: block.sentence.id,
        invalidRhythm: block.sentence.rhythm,
      });
    }
  }, [invalidRhythmBlocks]);
  const measureRootRef = useRef<HTMLDivElement>(null);
  const pageStackRef = useRef<HTMLDivElement>(null);
  const pageSignatureRef = useRef("");
  const [pages, setPages] = useState<PrintPagePlan[]>([]);
  const [lineBlocks, setLineBlocks] = useState<CompactLineBlock[]>([]);
  const [selection, setSelection] = useState<CompactSelection>();
  const [rhythmSelection, setRhythmSelection] = useState<CompactRhythmSelection>();
  const [pinyinDraft, setPinyinDraft] = useState("");
  const [pinyinDraftDirty, setPinyinDraftDirty] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutMessage, setLayoutMessage] = useState("正在按实际行高计算 A4 分页…");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const lineBlocksById = useMemo(
    () => new Map(lineBlocks.map((lineBlock) => [lineBlock.id, lineBlock])),
    [lineBlocks],
  );
  const workspaceStyle = {
    "--compact-a4-margin": `${COMPACT_MARGIN_MM}mm`,
  } as CSSProperties;

  const calculatePagination = useCallback(() => {
    const root = measureRootRef.current;
    if (!root || !blocks.length) {
      pageSignatureRef.current = "";
      setPages([]);
      setLineBlocks([]);
      return;
    }
    const firstBody = root.querySelector<HTMLElement>("[data-compact-measure-capacity='first']");
    const continuationBody = root.querySelector<HTMLElement>("[data-compact-measure-capacity='continuation']");
    const measuredElements = Array.from(root.querySelectorAll<HTMLElement>("[data-compact-measure-id]"));
    if (!firstBody || !continuationBody || !measuredElements.length) return;
    const nextLineBlocks = measuredElements.map((element, index) => ({
      id: element.dataset.compactMeasureId ?? "",
      sentenceId: element.dataset.compactSentenceId ?? "",
      tokenIndexes: (element.dataset.compactTokenIndexes ?? "")
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter(Number.isFinite),
      cropIndex: Number.parseInt(element.dataset.compactCropIndex ?? "0", 10) || 0,
      displayOrder: index + 1,
    }));
    if (nextLineBlocks.some((line) => !line.id || !line.sentenceId || !line.tokenIndexes.length)) return;
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
      protectSingleBlockPages: false,
    });
    const nextSignature = nextPages.map((page) => (
      `${page.blockIds.join(",")}:${Math.round(page.usedHeightPx)}:${page.hasOversizedBlock ? 1 : 0}`
    )).join("|") + `#${nextLineBlocks.map((line) => (
      `${line.id}:${line.cropIndex}:${line.displayOrder}:${line.tokenIndexes.join(",")}`
    )).join("|")}`;
    if (pageSignatureRef.current !== nextSignature) {
      pageSignatureRef.current = nextSignature;
      setLineBlocks(nextLineBlocks);
      setPages(nextPages);
    }
    const oversized = nextPages.filter((page) => page.hasOversizedBlock).length;
    setLayoutMessage(oversized
      ? `已按实际行高排成 ${nextPages.length} 页；${oversized} 个超高行单独占页`
      : `已按实际行高排成 ${nextPages.length} 页；共 ${nextLineBlocks.length} 行连续编号`);
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
  }, [blocks, calculatePagination, layoutRevision, legendSignature, springSceneTechniqueMode]);

  const openSelection = (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const width = 430;
    setRhythmSelection(undefined);
    setSelection({
      sentenceId: sentence.id,
      tokenIndex: token.index,
      x: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)),
      y: Math.max(72, Math.min(window.innerHeight - 390, rect.bottom + 10)),
    });
    setPinyinDraft(token.displayPinyin ?? token.pinyin ?? "");
    setPinyinDraftDirty(false);
  };

  const openRhythmSelection = (sentence: RecitationSentence, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const width = 236;
    setSelection(undefined);
    setRhythmSelection({
      sentenceId: sentence.id,
      x: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right + 8)),
      y: Math.max(72, Math.min(window.innerHeight - 230, rect.top - 8)),
    });
  };

  const changePoints = (sentence: RecitationSentence, changes: ProsodyPointChange[]) => {
    if (!changes.length) return;
    const draft = sentenceDraftsRef.current.get(sentence.id);
    const current = draft?.current ?? sentence;
    const prosodyPointOverrides = changes.reduce(
      (overrides, change) => upsertProsodyPointOverride(
        overrides,
        change.tokenIndex,
        change.visualLevel,
      ),
      current.prosodyPointOverrides ?? [],
    );
    const nextSentence = { ...current, prosodyPointOverrides };
    sentenceDraftsRef.current.set(sentence.id, {
      source: draft?.source ?? sentence,
      current: nextSentence,
    });
    onSentenceChange(nextSentence);
  };

  const selectedSentence = selection ? blocksById.get(selection.sentenceId)?.sentence : undefined;
  const selectedRhythmSentence = rhythmSelection
    ? blocksById.get(rhythmSelection.sentenceId)?.sentence
    : undefined;
  const selectedToken = selectedSentence?.tokens.find((token) => token.index === selection?.tokenIndex);
  const selectedPause = selectedSentence && selectedToken ? pauseAt(selectedSentence, selectedToken.index) : undefined;
  const selectedBreath = selectedSentence && selectedToken ? breathAt(selectedSentence, selectedToken.index) : undefined;
  const selectedFocused = Boolean(selectedSentence && selectedToken && focusIndexes(selectedSentence).has(selectedToken.index));
  const selectedProlong = Boolean(selectedSentence && selectedToken && prolongAt(selectedSentence, selectedToken.index));
  const selectedStaccato = Boolean(selectedFocused && selectedPause?.type === "short");
  const selectedSentenceLineBlocks = selectedSentence
    ? lineBlocks.filter((lineBlock) => lineBlock.sentenceId === selectedSentence.id)
    : [];
  const selectedLineBlockIndex = selectedToken
    ? selectedSentenceLineBlocks.findIndex((lineBlock) => lineBlock.tokenIndexes.includes(selectedToken.index))
    : -1;
  const selectedGlobalLineBlockIndex = selectedToken
    ? lineBlocks.findIndex((lineBlock) => lineBlock.tokenIndexes.includes(selectedToken.index))
    : -1;
  const canMergeIntoPreviousLine = selectedGlobalLineBlockIndex > 0;
  const canMergeIntoNextLine = selectedGlobalLineBlockIndex >= 0
    && selectedGlobalLineBlockIndex < lineBlocks.length - 1;
  const selectedSceneTechnique = selectedSentence && selectedToken
    ? sceneTechniqueAt(selectedSentence, selectedToken.index)
    : undefined;
  const selectedVirtualVoice = Boolean(selectedSentence && selectedToken && (
    deliveryTechniqueAt(selectedSentence, selectedToken.index, "virtual_voice")
  ));
  const selectedDistanceView = selectedSentence && selectedToken
    ? distanceViewAt(selectedSentence, selectedToken.index)
    : undefined;

  const editSelected = (transform: (sentence: RecitationSentence, token: TimedToken) => RecitationSentence) => {
    if (!selectedSentence || !selectedToken) return;
    onSentenceChange(transform(selectedSentence, selectedToken));
  };

  const mergeSelectedIntoLine = (direction: VisualLineMergeDirection) => {
    if (!selectedSentence || !selectedToken || selectedLineBlockIndex < 0 || selectedGlobalLineBlockIndex < 0) return;
    const adjacentLineBlock = lineBlocks[selectedGlobalLineBlockIndex + (direction === "previous" ? -1 : 1)];
    if (!adjacentLineBlock) return;
    if (adjacentLineBlock.sentenceId !== selectedSentence.id) {
      const adjacentSentence = blocksById.get(adjacentLineBlock.sentenceId)?.sentence;
      if (!adjacentSentence) return;
      const result = mergeAcrossCompactSentences(
        selectedSentence,
        adjacentSentence,
        selectedToken.index,
        direction,
      );
      if (!result || !work.controlSpec) return;
      onSentencesChange(work.controlSpec.sentences.flatMap((sentence) => {
        if (sentence.id === selectedSentence.id) return result.selected ? [result.selected] : [];
        if (sentence.id === adjacentSentence.id) return [result.adjacent];
        return [sentence];
      }));
      setSelection(undefined);
      return;
    }
    const lineBreakAfterTokenIndexes = adjustVisualLineBoundaries(
      selectedSentenceLineBlocks.map((lineBlock) => lineBlock.tokenIndexes),
      selectedLineBlockIndex,
      selectedToken.index,
      direction,
    );
    if (!lineBreakAfterTokenIndexes) return;
    onSentenceChange({
      ...selectedSentence,
      lineBreakAfterTokenIndexes: lineBreakAfterTokenIndexes.length
        ? lineBreakAfterTokenIndexes
        : undefined,
    });
  };

  const selectRhythm = (rhythm: Rhythm) => {
    if (!selectedRhythmSentence) return;
    onSentenceChange({ ...selectedRhythmSentence, rhythm });
    setRhythmSelection(undefined);
  };

  const saveSelectedPinyin = () => {
    const value = pinyinDraft.trim();
    if (!selectedToken || !pinyinDraftDirty) return;
    onPinyinOverrideChange(selectedToken.id, value);
    setPinyinDraftDirty(false);
  };

  const exportPdf = async () => {
    if (exportingPdf || !pages.length) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setSelection(undefined);
    setRhythmSelection(undefined);
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
      className={`compact-editor-workspace ${exportingPdf ? "is-exporting" : ""} ${springSceneTechniqueMode ? "is-spring-scene-technique" : ""} ${chushibiaoVirtualVoiceSpacing ? "is-chushibiao-virtual-spacing" : ""}`}
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
          {springSceneTechniqueMode ? <span className="compact-spring-technique-badge">《春》实景 / 虚景版</span> : null}
          {!springSceneTechniqueMode ? <span className="compact-curve-edit-hint">语势：按住曲线绘制 · 5 档</span> : null}
          <span>A4 纵向</span>
          <span>{pages.length || "计算中"} 页</span>
        </div>
        <div className="compact-toolbar-actions">
          <button type="button" className="text-button" onClick={onOpenLibrary}>作品库</button>
          <span className="compact-auto-legend-status">自动图例：{legendItems.length} 项</span>
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
            lineBlocksById={lineBlocksById}
            sceneAssetsByLineId={sceneAssetsByLineId}
            sceneAssetsBySentenceId={sceneAssetsBySentenceId}
            legendItems={legendItems}
            springSceneTechniqueMode={springSceneTechniqueMode}
            total={pages.length}
            selection={selection}
            onSelectToken={openSelection}
            onPointsChange={changePoints}
            onSelectRhythm={openRhythmSelection}
            key={`compact-page-${page.index}-${page.blockIds.join("-")}`}
          />
        ))}
      </div>

      {selectedRhythmSentence && rhythmSelection ? (
        <aside
          className="compact-rhythm-popover"
          data-export-exclude="true"
          style={{ left: rhythmSelection.x, top: rhythmSelection.y }}
          role="dialog"
          aria-label="选择节奏"
        >
          <div className="compact-rhythm-popover-heading">
            <div>
              <strong>选择节奏</strong>
              <small>同一原句的所有分行会同步更新</small>
            </div>
            <button type="button" onClick={() => setRhythmSelection(undefined)} aria-label="关闭节奏选择">×</button>
          </div>
          <div className="compact-rhythm-option-grid" role="group" aria-label="六种节奏">
            {COMPACT_RHYTHM_OPTIONS.map((option) => {
              const selected = selectedRhythmSentence.rhythm === option.value;
              return (
                <button
                  type="button"
                  className={selected ? "active" : ""}
                  aria-pressed={selected}
                  onClick={() => selectRhythm(option.value)}
                  key={option.value}
                >{option.label}</button>
              );
            })}
          </div>
        </aside>
      ) : null}

      {selectedSentence && selectedToken && selection ? (
        <aside
          className="compact-marker-popover"
          data-export-exclude="true"
          style={{ left: selection.x, top: selection.y }}
          role="dialog"
          aria-label={`编辑“${selectedToken.char}”的朗诵标识与排版`}
        >
          <div className="compact-popover-heading">
            <span>“{selectedToken.char}”的朗诵与排版</span>
            <button type="button" onClick={() => setSelection(undefined)} aria-label="关闭标识工具">×</button>
          </div>
          <div className="compact-marker-groups">
            <div className="compact-line-break-copy">
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
              >{"///"}</button>
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
                className={`compact-staccato-button ${selectedStaccato ? "active" : ""}`}
                onClick={() => editSelected(toggleStaccato)}
              >一字一顿</button>
              <button
                type="button"
                className={`compact-virtual-voice-button ${selectedVirtualVoice ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setDeliveryTechniqueAt(sentence, token, "virtual_voice"))}
              ><span aria-hidden="true">声</span>虚声</button>
              <button
                type="button"
                className={`compact-distance-button ${selectedDistanceView?.type === "distant_view" ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setDeliveryTechniqueAt(sentence, token, "distant_view"))}
              ><DistanceViewGlyph type="distant_view" />远景</button>
              <button
                type="button"
                className={`compact-distance-button ${selectedDistanceView?.type === "close_view" ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setDeliveryTechniqueAt(sentence, token, "close_view"))}
              ><DistanceViewGlyph type="close_view" />近景</button>
              <button
                type="button"
                className={selectedSentence.endingIntonation.type === "rising" ? "active" : ""}
                onClick={() => editSelected((sentence) => toggleEndingTone(sentence, "rising"))}
                aria-label={selectedSentence.endingIntonation.type === "rising" ? "取消上扬语调" : "设置上扬语调"}
                aria-pressed={selectedSentence.endingIntonation.type === "rising"}
                title={selectedSentence.endingIntonation.type === "rising" ? "再次点击取消上扬" : "设置句尾上扬"}
              >↗</button>
              <button
                type="button"
                className={selectedSentence.endingIntonation.type === "falling" ? "active" : ""}
                onClick={() => editSelected((sentence) => toggleEndingTone(sentence, "falling"))}
                aria-label={selectedSentence.endingIntonation.type === "falling" ? "取消下降语调" : "设置下降语调"}
                aria-pressed={selectedSentence.endingIntonation.type === "falling"}
                title={selectedSentence.endingIntonation.type === "falling" ? "再次点击取消下降" : "设置句尾下降"}
              >↘</button>
              {springSceneTechniqueMode ? (
                <>
                  <button
                    type="button"
                    className={`compact-scene-marker-button is-real ${selectedSceneTechnique?.type === "real" ? "active" : ""}`}
                    onClick={() => editSelected((sentence, token) => setSceneTechniqueAt(sentence, token, "real"))}
                  >眼睛·实景</button>
                  <button
                    type="button"
                    className={`compact-scene-marker-button is-virtual ${selectedSceneTechnique?.type === "virtual" ? "active" : ""}`}
                    onClick={() => editSelected((sentence, token) => setSceneTechniqueAt(sentence, token, "virtual"))}
                  >心形·虚景</button>
                </>
              ) : null}
            </div>
          </div>
          <div className="compact-line-break-editor">
            <div>
              <strong>调整行分界</strong>
              <small>移动现有上下行的文字，不额外插入空行</small>
            </div>
            <div className="compact-line-break-actions">
              <button
                type="button"
                disabled={!canMergeIntoPreviousLine}
                onClick={() => mergeSelectedIntoLine("previous")}
              >并入上一行</button>
              <button
                type="button"
                disabled={!canMergeIntoNextLine}
                onClick={() => mergeSelectedIntoLine("next")}
              >并入下一行</button>
            </div>
          </div>
          <div className="compact-pinyin-editor">
            <label>拼音
              <input
                value={pinyinDraft}
                onChange={(event) => {
                  setPinyinDraft(event.target.value);
                  setPinyinDraftDirty(true);
                }}
                onBlur={saveSelectedPinyin}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveSelectedPinyin();
                  }
                }}
                aria-label={`修改“${selectedToken.char}”的拼音`}
              />
            </label>
            <button type="button" onClick={saveSelectedPinyin} disabled={!pinyinDraftDirty}>保存</button>
          </div>
        </aside>
      ) : null}

      <div className="compact-measure-layer" aria-hidden="true" ref={measureRootRef}>
        <article className="compact-a4-page compact-measure-page">
          <CompactPageHeader work={work} page={1} total={1} />
          <div className="compact-page-body" data-compact-measure-capacity="first" />
          <CompactPageLegend items={legendItems} />
        </article>
        <article className="compact-a4-page compact-measure-page">
          <CompactPageHeader work={work} page={2} total={2} />
          <div className="compact-page-body" data-compact-measure-capacity="continuation" />
          <CompactPageLegend items={legendItems} />
        </article>
        <div className="compact-block-measure-list">
          {blocks.map((block) => (
            <CompactSentenceRow
              block={block}
              measure
              springSceneTechniqueMode={springSceneTechniqueMode}
              key={`compact-measure-${block.id}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
