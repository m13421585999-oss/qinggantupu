"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { buildGraphTokenUnits, type GraphTokenUnit } from "@/lib/graph-track";
import {
  safePrintFilename,
  type PrintPagePlan,
} from "@/lib/print-layout";
import {
  applyProsodyPointOverrides,
  buildTeachingProsodyPoints,
  upsertProsodyPointOverride,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";
import { splitGraphUnitsByMeasuredWidth } from "@/lib/semantic-scene-lines";
import { TeachingProsodyTrack } from "@/components/TeachingProsodyTrack";
import { DistanceViewGlyph } from "@/components/RecitationTechniqueGlyphs";
import { VirtualVoiceGroupOverlay } from "@/components/VirtualVoiceGroupOverlay";
import {
  usedCompactLegendItems,
  type CompactLegendItemId,
} from "@/lib/compact-legend";
import {
  deliveryTechniqueAt,
  distanceViewAt,
  setDeliveryTechniqueAt,
} from "@/lib/delivery-technique";
import {
  mapActiveSceneAssetsBySceneId,
  mapSceneAssetsToSentences,
} from "@/lib/visual-assets";
import {
  buildEditionSentenceRows,
  endingTonesByTokenIndex,
  mergeFullLayoutRowsAtToken,
  resolveFullLayoutRows,
  sentenceOwnerByTokenIndex,
  usesChushibiaoVirtualVoiceSpacing,
} from "@/lib/edition-layout";
import { rhythmLabel } from "@/lib/recitation-schema";
import type {
  BreathMark,
  EndingTone,
  PauseMark,
  RecitationSentence,
  RecitationWork,
  Rhythm,
  SceneTechniqueMark,
  TimedToken,
  EditionLayoutRow,
} from "@/lib/recitation-schema";

const FULL_MARGIN_MM = 14;
const FULL_RENDER_DPR = 2.5;
const FULL_CURVE_HEIGHT = 52;
const FULL_CURVE_PADDING = 7;

// Scattered diagonal watermark positions; one per A4 page (re-rendered per page).
const FULL_WATERMARKS: Array<{ x: string; y: string }> = [
  { x: "8%",  y: "9%"  },
  { x: "62%", y: "11%" },
  { x: "28%", y: "19%" },
  { x: "86%", y: "26%" },
  { x: "5%",  y: "36%" },
  { x: "48%", y: "42%" },
  { x: "22%", y: "54%" },
  { x: "74%", y: "61%" },
  { x: "38%", y: "74%" },
  { x: "12%", y: "84%" },
  { x: "82%", y: "88%" },
];

type FullSaveState = "unsaved" | "dirty" | "saving" | "saved" | "failed";

interface FullBlock {
  id: string;
  sourceSentenceIds: string[];
  lineBreakAfterTokenIndexes: number[];
  sentence: RecitationSentence;
}

interface FullLineBlock {
  id: string;
  blockId: string;
  tokenIndexes: number[];
  cropIndex: number;
  displayOrder: number;
}

interface FullSelection {
  blockId: string;
  tokenIndex: number;
  x: number;
  y: number;
}

const EMPTY_ENDING_TONES: ReadonlyMap<number, EndingTone> = new Map();
const EMPTY_FULL_LINE_BLOCKS: ReadonlyMap<string, FullLineBlock> = new Map();
const EMPTY_FULL_SCENES: ReadonlyMap<string, { url?: string; alt?: string }> = new Map();
const EMPTY_FULL_LINE_SCENES: ReadonlyMap<string, { url?: string; prompt?: string }> = new Map();

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
  if (/^\s+$/u.test(value)) return " ";
  return value;
}

function lineSignature(lines: GraphTokenUnit[][]) {
  return lines.map((line) => line.map((unit) => unit.token.index).join(",")).join("|");
}

function fullLineId(blockId: string, line: GraphTokenUnit[]) {
  const first = line[0]?.token.index ?? 0;
  const last = line.at(-1)?.token.index ?? first;
  return `${blockId}:line:${first}-${last}`;
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

function setPauseAt(sentence: RecitationSentence, token: TimedToken, type: PauseMark["type"]) {
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
    pauses: [...sentence.pauses.filter((pause) => pause.afterTokenIndex !== token.index), next]
      .sort((left, right) => left.afterTokenIndex - right.afterTokenIndex),
  };
}

function setBreathAt(sentence: RecitationSentence, token: TimedToken, type: BreathMark["type"]) {
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
    breaths: [...(sentence.breaths ?? []).filter((breath) => breath.afterTokenIndex !== token.index), next]
      .sort((left, right) => left.afterTokenIndex - right.afterTokenIndex),
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

function FullSceneTechniqueGlyph({ type }: { type: SceneTechniqueMark["type"] }) {
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

function FullTokenUnit({
  unit,
  sentence,
  focused,
  editable,
  selected,
  showSceneTechniqueRow,
  endingTone,
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
  endingTone?: EndingTone;
  characterRef?: (element: HTMLElement | null) => void;
  measureRef?: (element: HTMLSpanElement | null) => void;
  onSelect?: (anchor: HTMLElement) => void;
}) {
  const pause = pauseAt(sentence, unit.token.index);
  const prolong = prolongAt(sentence, unit.token.index);
  const breath = breathAt(sentence, unit.token.index);
  const sceneTechnique = sceneTechniqueAt(sentence, unit.token.index);
  const virtualVoice = deliveryTechniqueAt(sentence, unit.token.index, "virtual_voice");
  const distanceView = distanceViewAt(sentence, unit.token.index);
  const tone = endingTone && endingTone !== "level" ? endingTone : undefined;
  const select = (anchor: HTMLElement) => onSelect?.(anchor);
  const charContent = unit.token.char;
  return (
    <span className="full-token-unit" ref={measureRef} data-full-token-index={unit.token.index}>
      <span className="full-token-manuscript">
        {unit.prefixPunctuation.map((token) => (
          <span className="full-source-punctuation" key={token.id}>{visibleSourceCharacter(token.char)}</span>
        ))}
        {distanceView ? (
          <span
            className={`full-distance-marker is-${distanceView.type}`}
            aria-label={distanceView.type === "distant_view" ? "远景" : "近景"}
          >
            <DistanceViewGlyph type={distanceView.type} />
          </span>
        ) : null}
        {breath ? (
          <span
            className={`full-breath full-breath-${breath.type === "breath_major" ? "major" : "minor"}`}
            data-marker="breath"
            aria-label={breath.type === "breath_major" ? "换气" : "偷气"}
          >
            {breath.type === "breath_major" ? "V" : "v"}
          </span>
        ) : null}
        <span className={`full-spoken-token ${showSceneTechniqueRow ? "has-scene-technique-row" : ""}`}>
          {showSceneTechniqueRow ? (
            <span
              className={`full-scene-technique-slot ${sceneTechnique ? `is-${sceneTechnique.type}` : ""}`}
              aria-label={sceneTechnique?.type === "real" ? "实景" : sceneTechnique?.type === "virtual" ? "虚景" : undefined}
            >
              {sceneTechnique ? <FullSceneTechniqueGlyph type={sceneTechnique.type} /> : null}
            </span>
          ) : null}
          <span className="full-token-pinyin" aria-hidden="true">
            {unit.token.displayPinyin ?? unit.token.pinyin ?? " "}
          </span>
          {editable ? (
            <button
              type="button"
              className={`full-token-char ${focused ? "is-focus" : ""} ${virtualVoice ? "is-virtual-voice" : ""} ${selected ? "is-selected" : ""}`}
              ref={characterRef as (element: HTMLButtonElement | null) => void}
              onClick={(event) => select(event.currentTarget)}
              aria-label={`编辑“${unit.token.char}”及其后方标识`}
            >
              {charContent}
            </button>
          ) : (
            <span className={`full-token-char ${focused ? "is-focus" : ""} ${virtualVoice ? "is-virtual-voice" : ""}`} ref={characterRef}>
              {charContent}
            </span>
          )}
        </span>
        {prolong ? (
          <span
            className="full-prolong-mark"
            data-marker="prolongation"
            aria-label="拖音"
          >—</span>
        ) : null}
        {pause || tone ? (
          <span className="full-token-marker">
            {pause ? (
              <span
                className={`full-pause full-pause-${pause.type}`}
                aria-label={pause.type === "long" ? "长停" : "短停"}
              >
                {pause.type === "long" ? "///" : "/"}
              </span>
            ) : null}
            {tone ? (
              <span className="full-ending-tone">{tone === "rising" ? "↗" : "↘"}</span>
            ) : null}
          </span>
        ) : null}
        {unit.suffixPunctuation.map((token) => (
          <span className="full-source-punctuation" key={token.id}>{visibleSourceCharacter(token.char)}</span>
        ))}
      </span>
      {editable ? (
        <button
          type="button"
          className="full-boundary-trigger"
          data-export-exclude="true"
          onClick={(event) => select(event.currentTarget.parentElement?.querySelector<HTMLElement>(".full-token-char") ?? event.currentTarget)}
          aria-label={`在“${unit.token.char}”后添加停顿或换气`}
        >
          +
        </button>
      ) : null}
    </span>
  );
}

function FullGraphLine({
  units,
  sentence,
  focused,
  points,
  editable,
  showSceneTechniqueRow,
  showProsodyCurve,
  selectedTokenIndex,
  endingToneByTokenIndex = EMPTY_ENDING_TONES,
  onSelectToken,
  onPointChange,
}: {
  units: GraphTokenUnit[];
  sentence: RecitationSentence;
  focused: Set<number>;
  points: TeachingProsodyPoint[];
  editable: boolean;
  showSceneTechniqueRow: boolean;
  showProsodyCurve: boolean;
  selectedTokenIndex?: number;
  endingToneByTokenIndex: ReadonlyMap<number, EndingTone>;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const characterRefs = useRef(new Map<number, HTMLElement>());
  return (
    <div className={`full-graph-line ${showSceneTechniqueRow ? "is-scene-technique" : ""}`} ref={setRowElement}>
      <div className="full-token-row">
        {units.map((unit) => (
          <FullTokenUnit
            unit={unit}
            sentence={sentence}
            focused={focused.has(unit.token.index)}
            editable={editable}
            selected={selectedTokenIndex === unit.token.index}
            showSceneTechniqueRow={showSceneTechniqueRow}
            endingTone={endingToneByTokenIndex.get(unit.token.index)}
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
      {showProsodyCurve ? (
        <TeachingProsodyTrack
          units={units}
          points={points}
          characterRefs={characterRefs}
          rowElement={rowElement}
          editable={editable}
          curveHeight={FULL_CURVE_HEIGHT}
          curvePadding={FULL_CURVE_PADDING}
          className="full-prosody-curve"
          onPointChange={onPointChange}
        />
      ) : null}
    </div>
  );
}

function FullGraphTrack({
  sentence,
  measure = false,
  lineTokenIndexes,
  endingToneByTokenIndex = EMPTY_ENDING_TONES,
  showSceneTechniqueRow = false,
  showProsodyCurve = true,
  editable,
  selectedTokenIndex,
  onSelectToken,
  onPointChange,
}: {
  sentence: RecitationSentence;
  measure?: boolean;
  lineTokenIndexes?: readonly number[];
  endingToneByTokenIndex: ReadonlyMap<number, EndingTone>;
  showSceneTechniqueRow?: boolean;
  showProsodyCurve?: boolean;
  editable: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const probeRefs = useRef(new Map<number, HTMLSpanElement>());
  const units = useMemo(() => buildGraphTokenUnits(sentence), [sentence]);
  const [lines, setLines] = useState<GraphTokenUnit[][]>(() => units.length ? [units] : []);
  const fixedLine = useMemo(() => {
    if (!lineTokenIndexes) return undefined;
    const included = new Set(lineTokenIndexes);
    return units.filter((unit) => included.has(unit.token.index));
  }, [lineTokenIndexes, units]);
  const displayedLines = fixedLine ? [fixedLine] : lines;
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
    if (!track || !units.length || track.clientWidth <= 0) return;
    const styles = window.getComputedStyle(track);
    const unitGap = Number.parseFloat(styles.getPropertyValue("--full-token-gap")) || 4;
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
    for (const element of probeRefs.current.values()) observer.observe(element);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [fitLines]);

  if (!units.length) return <p className="full-graph-fallback">{sentence.text}</p>;

  return (
    <div className="full-graph-track" ref={trackRef} aria-label={sentence.text}>
      <div className="full-token-width-probe" aria-hidden="true">
        {units.map((unit) => (
          <FullTokenUnit
            unit={unit}
            sentence={sentence}
            focused={focused.has(unit.token.index)}
            editable={false}
            selected={false}
            showSceneTechniqueRow={showSceneTechniqueRow}
            endingTone={endingToneByTokenIndex.get(unit.token.index)}
            key={`probe-${unit.key}`}
            measureRef={(element) => {
              if (element) probeRefs.current.set(unit.token.index, element);
              else probeRefs.current.delete(unit.token.index);
            }}
          />
        ))}
      </div>
      <div className="full-graph-lines">
        {displayedLines.map((line, index) => {
          const lineId = fullLineId(sentence.id, line);
          return (
            <div
              className="full-visual-line"
              data-full-line-measure-id={measure ? lineId : undefined}
              data-full-layout-block-id={measure ? sentence.id : undefined}
              data-full-token-indexes={measure
                ? line.map((unit) => unit.token.index).join(",")
                : undefined}
              data-full-crop-index={measure ? index : undefined}
              key={lineId}
            >
              <FullGraphLine
                units={line}
                sentence={sentence}
                focused={focused}
                points={points}
                editable={editable}
                showSceneTechniqueRow={showSceneTechniqueRow}
                showProsodyCurve={showProsodyCurve}
                selectedTokenIndex={selectedTokenIndex}
                endingToneByTokenIndex={endingToneByTokenIndex}
                onSelectToken={onSelectToken}
                onPointChange={onPointChange}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FullSceneCard({
  imageUrl,
  imageAlt,
  order,
  sourceOrder,
  cropIndex = 0,
  rhythm,
}: {
  imageUrl?: string;
  imageAlt?: string;
  order: number;
  sourceOrder?: number;
  cropIndex?: number;
  rhythm: Rhythm;
}) {
  const [failed, setFailed] = useState<string>();
  const available = Boolean(imageUrl && imageUrl !== failed);
  const label = rhythmLabel(rhythm);
  const cropPositions = ["center 42%", "center 56%", "center 68%"] as const;
  return (
    <aside className="full-scene-card" aria-label={imageAlt ?? `第 ${order} 句情景小卡`}>
      {available && imageUrl ? (
        // Generated scene assets are same-origin persisted R2 objects.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={imageAlt ?? ""}
          loading="lazy"
          decoding="async"
          style={{ objectPosition: cropPositions[((sourceOrder ?? order) - 1 + cropIndex) % cropPositions.length] }}
          onError={() => setFailed(imageUrl)}
        />
      ) : (
        <div className="full-scene-placeholder" role="img" aria-label="情景图片生成中" />
      )}
      <span className="full-scene-order">{String(order).padStart(2, "0")}</span>
      <span className="full-rhythm-label" aria-label={label ? `节奏：${label}` : "节奏未标注"}>
        {label ?? "未标"}
      </span>
    </aside>
  );
}

function FullSentenceRow({
  block,
  lineBlock,
  sceneImageUrl,
  sceneImageAlt,
  endingToneByTokenIndex,
  showSceneTechniqueRow = false,
  showProsodyCurve = true,
  measure = false,
  editable = false,
  selectedTokenIndex,
  onSelectToken,
  onPointChange,
}: {
  block: FullBlock;
  lineBlock?: FullLineBlock;
  sceneImageUrl?: string;
  sceneImageAlt?: string;
  endingToneByTokenIndex: ReadonlyMap<number, EndingTone>;
  showSceneTechniqueRow?: boolean;
  showProsodyCurve?: boolean;
  measure?: boolean;
  editable?: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  return (
    <section
      className="full-sentence-row"
      data-full-block-id={measure ? undefined : (lineBlock?.id ?? block.id)}
    >
      <FullSceneCard
        imageUrl={sceneImageUrl}
        imageAlt={sceneImageAlt}
        order={lineBlock?.displayOrder ?? block.sentence.order}
        sourceOrder={block.sentence.order}
        cropIndex={lineBlock?.cropIndex}
        rhythm={block.sentence.rhythm}
      />
      <div className={`full-sentence-body ${showSceneTechniqueRow ? "is-scene-technique" : ""}`}>
        <FullGraphTrack
          sentence={block.sentence}
          measure={measure}
          lineTokenIndexes={lineBlock?.tokenIndexes}
          endingToneByTokenIndex={endingToneByTokenIndex}
          showSceneTechniqueRow={showSceneTechniqueRow}
          showProsodyCurve={showProsodyCurve}
          editable={editable}
          selectedTokenIndex={selectedTokenIndex}
          onSelectToken={onSelectToken}
          onPointChange={onPointChange}
        />
      </div>
    </section>
  );
}

function FullPageHeader({ work, page, total }: {
  work: RecitationWork;
  page: number;
  total: number;
}) {
  const displayTitle = (work.title || "未命名作品")
    .replace(/^《+\s*/, "")
    .replace(/\s*》+$/, "");
  return (
    <header className="full-page-header full-page-header-first">
      <div>
        <p className="full-header-kicker">朗诵情感图谱</p>
        <h1 className="full-header-title">《{displayTitle}》</h1>
        {work.author ? <p className="full-header-author">作者：{work.author}</p> : null}
      </div>
      <span className="full-header-page">{page} / {total}</span>
    </header>
  );
}

function FullLegendGlyph({ id }: { id: CompactLegendItemId }) {
  if (id === "breath-major") return <b className="full-legend-major">V</b>;
  if (id === "breath-minor") return <b className="full-legend-minor">v</b>;
  if (id === "pause-short") return <b>/</b>;
  if (id === "pause-long") return <b className="full-legend-long-pause">{"///"}</b>;
  if (id === "focus") return <b className="full-legend-focus">红</b>;
  if (id === "prosody-curve") return <i className="full-legend-curve" aria-hidden="true" />;
  if (id === "intonation-rising") return <b className="full-legend-arrow">↗</b>;
  if (id === "intonation-falling") return <b className="full-legend-arrow">↘</b>;
  if (id === "prolong") return <b className="full-legend-prolong">—</b>;
  if (id === "staccato") return <b className="full-legend-staccato">/红/红</b>;
  if (id === "real-scene") return <FullSceneTechniqueGlyph type="real" />;
  if (id === "virtual-scene") return <FullSceneTechniqueGlyph type="virtual" />;
  if (id === "virtual-voice") return <b className="full-legend-virtual-voice">声</b>;
  if (id === "distant-view") return <DistanceViewGlyph type="distant_view" />;
  return <DistanceViewGlyph type="close_view" />;
}

const FULL_LEGEND_LABELS: Record<CompactLegendItemId, string> = {
  "breath-major": "换气",
  "breath-minor": "偷气",
  "pause-short": "短停",
  "pause-long": "长停",
  focus: "重音",
  "prosody-curve": "语势曲线",
  "intonation-rising": "上扬",
  "intonation-falling": "下降",
  prolong: "拖音",
  staccato: "一字一顿",
  "real-scene": "实景",
  "virtual-scene": "虚景",
  "virtual-voice": "虚声",
  "distant-view": "远景",
  "close-view": "近景",
};

function FullPageLegend({ items }: { items: readonly CompactLegendItemId[] }) {
  return (
    <footer className={`full-page-legend ${items.length ? "" : "is-empty"}`} aria-label="朗诵标识图例">
      {items.map((id) => (
        <span className={`full-legend-item full-legend-item-${id}`} key={id}>
          <FullLegendGlyph id={id} />
          {FULL_LEGEND_LABELS[id]}
        </span>
      ))}
    </footer>
  );
}

function FullA4Page({
  work,
  plan,
  blocksById,
  lineBlocksById = EMPTY_FULL_LINE_BLOCKS,
  sceneAssetsByBlockId = EMPTY_FULL_SCENES,
  sceneAssetsByLineId = EMPTY_FULL_LINE_SCENES,
  endingToneByTokenIndex = EMPTY_ENDING_TONES,
  legendItems,
  showSceneTechniqueRow,
  showProsodyCurve,
  total,
  selection,
  onSelectToken,
  onPointChange,
}: {
  work: RecitationWork;
  plan: PrintPagePlan;
  blocksById: ReadonlyMap<string, FullBlock>;
  lineBlocksById: ReadonlyMap<string, FullLineBlock>;
  sceneAssetsByBlockId: ReadonlyMap<string, { url?: string; alt?: string }>;
  sceneAssetsByLineId: ReadonlyMap<string, { url?: string; prompt?: string }>;
  endingToneByTokenIndex: ReadonlyMap<number, EndingTone>;
  legendItems: readonly CompactLegendItemId[];
  showSceneTechniqueRow: boolean;
  showProsodyCurve: boolean;
  total: number;
  selection?: FullSelection;
  onSelectToken: (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => void;
  onPointChange: (sentence: RecitationSentence, tokenIndex: number, visualLevel: number) => void;
}) {
  const slotLines: Array<FullLineBlock | undefined> = [0, 1, 2, 3].map(
    (slotIndex) => lineBlocksById.get(plan.blockIds[slotIndex] ?? ""),
  );
  return (
    <article
      className="full-a4-page"
      data-full-pdf-page={plan.index + 1}
      aria-label={`A4 第 ${plan.index + 1} 页，共 ${total} 页`}
    >
      <div className="full-a4-background" aria-hidden="true" />
      <div className="full-a4-content">
        <div className="full-watermark-layer" aria-hidden="true">
          {FULL_WATERMARKS.map((position, index) => (
            <span
              key={index}
              className="full-watermark"
              style={{ left: position.x, top: position.y }}
            >
              忆岁朗诵院
            </span>
          ))}
        </div>
        <FullPageHeader work={work} page={plan.index + 1} total={total} />
        <div className="full-page-body full-page-body-slots">
          {slotLines.map((lineBlock, slotIndex) => {
            const block = lineBlock ? blocksById.get(lineBlock.blockId) : undefined;
            const lineScene = lineBlock ? sceneAssetsByLineId.get(lineBlock.id) : undefined;
            const blockScene = block ? sceneAssetsByBlockId.get(block.id) : undefined;
            const scene = lineScene
              ? { url: lineScene.url, alt: lineScene.prompt }
              : blockScene;
            return (
              <div className="full-slot" key={slotIndex} data-full-slot={slotIndex + 1}>
                {block ? (
                  <FullSentenceRow
                    block={block}
                    lineBlock={lineBlock}
                    sceneImageUrl={scene?.url}
                    sceneImageAlt={scene?.alt}
                    endingToneByTokenIndex={endingToneByTokenIndex}
                    showSceneTechniqueRow={showSceneTechniqueRow}
                    showProsodyCurve={showProsodyCurve}
                    editable
                    selectedTokenIndex={selection?.blockId === block.id ? selection.tokenIndex : undefined}
                    onSelectToken={(token, anchor) => onSelectToken(block.sentence, token, anchor)}
                    onPointChange={(tokenIndex, visualLevel) => onPointChange(block.sentence, tokenIndex, visualLevel)}
                    key={block.id}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        <FullPageLegend items={legendItems} />
      </div>
      <div className="full-logo-footer" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/full-logo.jpeg" alt="忆岁朗诵院" />
      </div>
    </article>
  );
}

function saveStateLabel(state: FullSaveState) {
  if (state === "saving") return "正在保存…";
  if (state === "dirty") return "有未保存修改";
  if (state === "failed") return "保存失败，请重试";
  if (state === "saved") return "工程已保存";
  return "等待编辑";
}

export function FullA4Editor({
  work,
  saveState,
  onSentenceChange,
  onLayoutRowsChange,
  onPinyinOverrideChange,
  onSave,
  onOpenLibrary,
  onSwitchCompact,
}: {
  work: RecitationWork;
  saveState: FullSaveState;
  onSentenceChange: (sentence: RecitationSentence) => void;
  onLayoutRowsChange: (rows: EditionLayoutRow[]) => void;
  onPinyinOverrideChange: (tokenId: string, value: string) => void;
  onSave: () => void;
  onOpenLibrary: () => void;
  onSwitchCompact: () => void;
}) {
  const spec = work.controlSpec;
  const chushibiaoVirtualVoiceSpacing = usesChushibiaoVirtualVoiceSpacing(work.id);
  const springSceneTechniqueMode = isSpringSceneTechniqueWork(work.title);
  const legendItems = useMemo(
    () => usedCompactLegendItems(spec?.sentences ?? [], {
      showProsodyCurve: true,
    }),
    [spec?.sentences],
  );
  const canonicalSentences = useMemo(
    () => (spec?.sentences ?? []).map((sentence) => (
      applyPinyinOverrides(sentence, spec?.pinyinOverrides ?? {})
    )),
    [spec],
  );
  const blocks = useMemo<FullBlock[]>(
    () => {
      if (!spec) return [];
      const renderSpec = { ...spec, sentences: canonicalSentences };
      return buildEditionSentenceRows(renderSpec, resolveFullLayoutRows(spec)).map((row) => ({
        id: row.id,
        sourceSentenceIds: row.sourceSentenceIds,
        lineBreakAfterTokenIndexes: row.lineBreakAfterTokenIndexes,
        sentence: row.sentence,
      }));
    },
    [canonicalSentences, spec],
  );
  const blocksById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const sentenceOwners = useMemo(
    () => sentenceOwnerByTokenIndex(canonicalSentences),
    [canonicalSentences],
  );
  const endingToneByTokenIndex = useMemo(
    () => endingTonesByTokenIndex(canonicalSentences),
    [canonicalSentences],
  );
  const sceneAssetsBySentenceId = useMemo(
    () => mapSceneAssetsToSentences(work.visuals, spec?.sentences ?? []),
    [work.visuals, spec],
  );
  const sceneAssetsByBlockId = useMemo(
    () => new Map(blocks.flatMap((block) => {
      const asset = block.sourceSentenceIds
        .map((sentenceId) => sceneAssetsBySentenceId.get(sentenceId))
        .find(Boolean);
      return asset ? [[block.id, { url: asset.url, alt: asset.prompt }] as const] : [];
    })),
    [blocks, sceneAssetsBySentenceId],
  );
  const sceneAssetsByLineId = useMemo(
    () => mapActiveSceneAssetsBySceneId(work.visuals),
    [work.visuals],
  );
  const measureRootRef = useRef<HTMLDivElement>(null);
  const pageStackRef = useRef<HTMLDivElement>(null);
  const lineSignatureRef = useRef("");
  const [lineBlocks, setLineBlocks] = useState<FullLineBlock[]>([]);
  const [selection, setSelection] = useState<FullSelection>();
  const [pinyinEditorOpen, setPinyinEditorOpen] = useState(false);
  const [pinyinDraft, setPinyinDraft] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const workspaceStyle = { "--full-a4-margin": `${FULL_MARGIN_MM}mm` } as CSSProperties;
  const lineBlocksById = useMemo(
    () => new Map(lineBlocks.map((lineBlock) => [lineBlock.id, lineBlock])),
    [lineBlocks],
  );

  const calculateFullLines = useCallback(() => {
    const root = measureRootRef.current;
    if (!root || !blocks.length) {
      lineSignatureRef.current = "";
      setLineBlocks([]);
      return;
    }
    const measuredLines = Array.from(root.querySelectorAll<HTMLElement>("[data-full-line-measure-id]"));
    if (!measuredLines.length) return;
    const nextLines = measuredLines.map((element, index) => ({
      id: element.dataset.fullLineMeasureId ?? "",
      blockId: element.dataset.fullLayoutBlockId ?? "",
      tokenIndexes: (element.dataset.fullTokenIndexes ?? "")
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter(Number.isFinite),
      cropIndex: Number.parseInt(element.dataset.fullCropIndex ?? "0", 10) || 0,
      displayOrder: index + 1,
    }));
    if (nextLines.some((line) => !line.id || !line.blockId || !line.tokenIndexes.length)) return;
    const signature = nextLines.map((line) => (
      `${line.id}:${line.blockId}:${line.tokenIndexes.join(",")}`
    )).join("|");
    if (lineSignatureRef.current !== signature) {
      lineSignatureRef.current = signature;
      setLineBlocks(nextLines);
    }
  }, [blocks]);

  useLayoutEffect(() => {
    const root = measureRootRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => window.requestAnimationFrame(calculateFullLines));
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-full-line-measure-id], .full-graph-track")
      .forEach((element) => observer.observe(element));
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [blocks, calculateFullLines]);

  // Full owns its measured visual lines. Each physical slot receives exactly
  // one line, so Compact row edits can never create overflowing Full cards.
  const pages = useMemo<PrintPagePlan[]>(() => {
    if (!lineBlocks.length) return [];
    const pageCount = Math.ceil(lineBlocks.length / 4);
    return Array.from({ length: pageCount }, (_, index) => ({
      index,
      blockIds: lineBlocks
        .slice(index * 4, index * 4 + 4)
        .map((line) => line.id),
      usedHeightPx: 0,
      capacityPx: 0,
      hasOversizedBlock: false,
    }));
  }, [lineBlocks]);

  const layoutMessage = exportStatus
    || (lineBlocks.length
      ? `完整版独立排成 ${lineBlocks.length} 行、${pages.length} 页；每页 4 行`
      : "正在按完整版字宽独立分行…");

  const openSelection = (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const width = 386;
    setSelection({
      blockId: sentence.id,
      tokenIndex: token.index,
      x: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)),
      y: Math.max(80, Math.min(window.innerHeight - 238, rect.bottom + 10)),
    });
    setPinyinEditorOpen(false);
    setPinyinDraft(token.displayPinyin ?? token.pinyin ?? "");
  };

  const changePoint = (_sentence: RecitationSentence, tokenIndex: number, visualLevel: number) => {
    const owner = sentenceOwners.get(tokenIndex);
    if (!owner) return;
    onSentenceChange({
      ...owner,
      prosodyPointOverrides: upsertProsodyPointOverride(
        owner.prosodyPointOverrides ?? [],
        tokenIndex,
        visualLevel,
      ),
    });
  };

  const selectedSentence = selection ? sentenceOwners.get(selection.tokenIndex) : undefined;
  const selectedToken = selectedSentence?.tokens.find((token) => token.index === selection?.tokenIndex);
  const selectedPause = selectedSentence && selectedToken ? pauseAt(selectedSentence, selectedToken.index) : undefined;
  const selectedBreath = selectedSentence && selectedToken ? breathAt(selectedSentence, selectedToken.index) : undefined;
  const selectedFocused = Boolean(selectedSentence && selectedToken && focusIndexes(selectedSentence).has(selectedToken.index));
  const selectedProlong = Boolean(selectedSentence && selectedToken && prolongAt(selectedSentence, selectedToken.index));
  const selectedVirtualVoice = Boolean(selectedSentence && selectedToken && (
    deliveryTechniqueAt(selectedSentence, selectedToken.index, "virtual_voice")
  ));
  const selectedDistanceView = selectedSentence && selectedToken
    ? distanceViewAt(selectedSentence, selectedToken.index)
    : undefined;
  const selectedLineBlockIndex = selectedToken
    ? lineBlocks.findIndex((lineBlock) => lineBlock.tokenIndexes.includes(selectedToken.index))
    : -1;
  const canMergeIntoPreviousLine = selectedLineBlockIndex > 0;
  const canMergeIntoNextLine = selectedLineBlockIndex >= 0
    && selectedLineBlockIndex < lineBlocks.length - 1;

  const editSelected = (transform: (sentence: RecitationSentence, token: TimedToken) => RecitationSentence) => {
    if (!selectedSentence || !selectedToken) return;
    onSentenceChange(transform(selectedSentence, selectedToken));
  };

  const mergeSelectedIntoLine = (direction: "previous" | "next") => {
    if (!spec || !selectedToken) return;
    const nextRows = mergeFullLayoutRowsAtToken(
      spec,
      lineBlocks.map((lineBlock) => ({
        rowId: lineBlock.blockId,
        tokenIndexes: lineBlock.tokenIndexes,
      })),
      selectedToken.index,
      direction,
    );
    if (!nextRows) return;
    onLayoutRowsChange(nextRows);
    setSelection(undefined);
    setPinyinEditorOpen(false);
  };

  const saveSelectedPinyin = () => {
    const value = pinyinDraft.trim();
    if (!selectedToken) return;
    onPinyinOverrideChange(selectedToken.id, value);
    setPinyinEditorOpen(false);
  };

  const scenesIncomplete = lineBlocks.some((lineBlock) => {
    if (sceneAssetsByLineId.get(lineBlock.id)?.url) return false;
    return !sceneAssetsByBlockId.get(lineBlock.blockId)?.url;
  });

  const exportPdf = async () => {
    if (exportingPdf || !pages.length) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setSelection(undefined);
    setExportingPdf(true);
    setExportError(undefined);
    setExportStatus(`正在生成 ${pages.length} 页 PDF…`);
    try {
      await document.fonts?.ready;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      const stack = pageStackRef.current;
      const pageElements = stack
        ? Array.from(stack.querySelectorAll<HTMLElement>("[data-full-pdf-page]"))
        : [];
      if (!pageElements.length) throw new Error("A4 页面还没有排版完成");
      const [{ toCanvas }, { jsPDF }] = await Promise.all([
        import("html-to-image"),
        import("jspdf"),
      ]);
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      for (let index = 0; index < pageElements.length; index += 1) {
        const page = pageElements[index];
        const canvas = await toCanvas(page, {
          backgroundColor: "#fffdf8",
          cacheBust: true,
          pixelRatio: FULL_RENDER_DPR,
          width: page.scrollWidth,
          height: page.scrollHeight,
          filter: (node) => !(node instanceof Element)
            || node.getAttribute("data-export-exclude") !== "true",
          style: { boxShadow: "none", margin: "0", transform: "none" },
        });
        if (index > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(canvas, "PNG", 0, 0, 210, 297, undefined, "FAST");
        setExportStatus(`正在生成 PDF：${index + 1} / ${pageElements.length} 页`);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      pdf.save(safePrintFilename(work.title, "pdf"));
      setExportStatus(`PDF 已生成：${pageElements.length} 页 A4`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportError(`PDF 导出失败：${message}`);
      setExportStatus("PDF 导出失败，请重试");
    } finally {
      setExportingPdf(false);
    }
  };

  if (!spec || !blocks.length) {
    return (
      <section className="full-editor-empty">
        <h1>完整版还没有可编辑文稿</h1>
        <p>请先在准备作品阶段生成朗诵图谱，再进入完整版编辑。</p>
        <button type="button" className="primary-button" onClick={onSwitchCompact}>切换到紧凑版</button>
      </section>
    );
  }

  return (
    <section
      className={`full-editor-workspace ${exportingPdf ? "is-exporting" : ""} ${springSceneTechniqueMode ? "is-spring-scene-technique" : ""} ${chushibiaoVirtualVoiceSpacing ? "is-chushibiao-virtual-spacing" : ""}`}
      style={workspaceStyle}
      aria-label="完整版 A4 朗诵谱编辑器"
    >
      <div className="full-editor-toolbar" data-export-exclude="true">
        <div className="full-toolbar-title">
          <p>完整版 · 朗诵情感图谱</p>
          <strong>{work.title || "未命名作品"}</strong>
          <small>{layoutMessage}</small>
        </div>
        <div className="full-toolbar-status" aria-live="polite">
          <span className={`full-save-state state-${saveState}`}>{saveStateLabel(saveState)}</span>
          <span>A4 纵向</span>
          <span>{pages.length || "计算中"} 页</span>
        </div>
        <div className="full-toolbar-actions">
          <button type="button" className="text-button" onClick={onOpenLibrary}>作品库</button>
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
            className="primary-button full-export-button"
            onClick={() => {
              if (scenesIncomplete && !window.confirm("部分情景图片尚未完成，将使用当前占位状态导出。")) return;
              void exportPdf();
            }}
            disabled={!pages.length || exportingPdf}
          >
            {exportingPdf ? "正在导出…" : "导出 PDF"}
          </button>
        </div>
      </div>

      {exportError ? <p className="full-export-error" role="alert">{exportError}</p> : null}

      <div className="full-page-stack" ref={pageStackRef}>
        {pages.map((page) => (
          <FullA4Page
            work={work}
            plan={page}
            blocksById={blocksById}
            lineBlocksById={lineBlocksById}
            sceneAssetsByBlockId={sceneAssetsByBlockId}
            sceneAssetsByLineId={sceneAssetsByLineId}
            endingToneByTokenIndex={endingToneByTokenIndex}
            legendItems={legendItems}
            showSceneTechniqueRow={springSceneTechniqueMode}
            showProsodyCurve
            total={pages.length}
            selection={selection}
            onSelectToken={openSelection}
            onPointChange={changePoint}
            key={`full-page-${page.index}-${page.blockIds.join("-")}`}
          />
        ))}
      </div>

      <div className="full-measure-layer" aria-hidden="true" ref={measureRootRef}>
        {blocks.map((block) => (
          <FullSentenceRow
            block={block}
            endingToneByTokenIndex={endingToneByTokenIndex}
            showSceneTechniqueRow={springSceneTechniqueMode}
            showProsodyCurve
            measure
            key={`full-measure-${block.id}`}
          />
        ))}
      </div>

      {selectedSentence && selectedToken && selection ? (
        <aside
          className="full-marker-popover"
          data-export-exclude="true"
          style={{ left: selection.x, top: selection.y }}
          role="dialog"
          aria-label={`编辑“${selectedToken.char}”的朗诵标识`}
        >
          <div className="full-popover-heading">
            <span>“{selectedToken.char}”及字后位置</span>
            <button type="button" onClick={() => { setSelection(undefined); setPinyinEditorOpen(false); }} aria-label="关闭标识工具">×</button>
          </div>
          <div className="full-marker-groups">
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
            <div className="full-other-markers">
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
                className={`full-virtual-voice-button ${selectedVirtualVoice ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setDeliveryTechniqueAt(sentence, token, "virtual_voice"))}
              ><span aria-hidden="true">声</span>虚声</button>
              <button
                type="button"
                className={`full-distance-button ${selectedDistanceView?.type === "distant_view" ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setDeliveryTechniqueAt(sentence, token, "distant_view"))}
              ><DistanceViewGlyph type="distant_view" />远景</button>
              <button
                type="button"
                className={`full-distance-button ${selectedDistanceView?.type === "close_view" ? "active" : ""}`}
                onClick={() => editSelected((sentence, token) => setDeliveryTechniqueAt(sentence, token, "close_view"))}
              ><DistanceViewGlyph type="close_view" />近景</button>
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
          <div className="full-line-break-editor">
            <div className="full-line-break-copy">
              <strong>调整行分界</strong>
              <small>移动现有上下行的文字，不额外插入空行</small>
            </div>
            <div className="full-line-break-actions">
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
          {pinyinEditorOpen ? (
            <div className="full-pinyin-editor">
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
    </section>
  );
}
