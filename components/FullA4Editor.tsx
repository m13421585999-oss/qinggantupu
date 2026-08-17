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
import { mapSceneAssetsToSentences } from "@/lib/visual-assets";
import { RHYTHM_LABELS } from "@/lib/recitation-schema";
import type {
  BreathMark,
  EndingTone,
  PauseMark,
  RecitationSentence,
  RecitationWork,
  Rhythm,
  TimedToken,
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
  sentence: RecitationSentence;
}

interface FullSelection {
  sentenceId: string;
  tokenIndex: number;
  x: number;
  y: number;
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
  if (/^\s+$/u.test(value)) return " ";
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

function FullTokenUnit({
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
  // Full only renders the four primary recitation cues: 重音, short pause /,
  // sentence-final tone ↗/↘ and the prosody curve. Breath (V/v), long pause
  // (///) and prolongation (—) are intentionally NOT rendered here — the
  // underlying ControlSpec data is untouched and Compact still shows them.
  const shortPause = sentence.pauses.find(
    (pause) => pause.afterTokenIndex === unit.token.index && pause.type === "short",
  );
  const isEndingHost = endingTokenIndex === unit.token.index;
  const tone = isEndingHost && sentence.endingIntonation.type !== "level"
    ? sentence.endingIntonation.type
    : undefined;
  const select = (anchor: HTMLElement) => onSelect?.(anchor);
  return (
    <span className="full-token-unit" ref={measureRef} data-full-token-index={unit.token.index}>
      <span className="full-token-manuscript">
        {unit.prefixPunctuation.map((token) => (
          <span className="full-source-punctuation" key={token.id}>{visibleSourceCharacter(token.char)}</span>
        ))}
        <span className="full-spoken-token">
          <span className="full-token-pinyin" aria-hidden="true">
            {unit.token.displayPinyin ?? unit.token.pinyin ?? " "}
          </span>
          {editable ? (
            <button
              type="button"
              className={`full-token-char ${focused ? "is-focus" : ""} ${selected ? "is-selected" : ""}`}
              ref={characterRef as (element: HTMLButtonElement | null) => void}
              onClick={(event) => select(event.currentTarget)}
              aria-label={`编辑“${unit.token.char}”及其后方标识`}
            >
              {unit.token.char}
            </button>
          ) : (
            <span className={`full-token-char ${focused ? "is-focus" : ""}`} ref={characterRef}>
              {unit.token.char}
            </span>
          )}
          {shortPause || tone ? (
            <span className="full-token-marker">
              {shortPause ? <span className="full-pause">/</span> : null}
              {tone ? (
                <span className="full-ending-tone">{tone === "rising" ? "↗" : "↘"}</span>
              ) : null}
            </span>
          ) : null}
        </span>
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
    <div className="full-graph-line" ref={setRowElement}>
      <div className="full-token-row">
        {units.map((unit) => (
          <FullTokenUnit
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
    </div>
  );
}

function FullGraphTrack({
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
            endingTokenIndex={endingTokenIndex}
            key={`probe-${unit.key}`}
            measureRef={(element) => {
              if (element) probeRefs.current.set(unit.token.index, element);
              else probeRefs.current.delete(unit.token.index);
            }}
          />
        ))}
      </div>
      <div className="full-graph-lines">
        {lines.map((line, index) => (
          <FullGraphLine
            units={line}
            sentence={sentence}
            focused={focused}
            points={points}
            editable={editable}
            selectedTokenIndex={selectedTokenIndex}
            endingTokenIndex={endingTokenIndex}
            onSelectToken={onSelectToken}
            onPointChange={onPointChange}
            key={`${sentence.id}-full-line-${index}-${line[0]?.token.index}`}
          />
        ))}
      </div>
    </div>
  );
}

function FullSceneCard({
  imageUrl,
  imageAlt,
  order,
  rhythm,
}: {
  imageUrl?: string;
  imageAlt?: string;
  order: number;
  rhythm: Rhythm;
}) {
  const [failed, setFailed] = useState<string>();
  const available = Boolean(imageUrl && imageUrl !== failed);
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
          onError={() => setFailed(imageUrl)}
        />
      ) : (
        <div className="full-scene-placeholder" role="img" aria-label="情景图片生成中" />
      )}
      <span className="full-scene-order">{String(order).padStart(2, "0")}</span>
      <span className="full-rhythm-label" aria-label={`节奏：${RHYTHM_LABELS[rhythm]}`}>
        {RHYTHM_LABELS[rhythm]}
      </span>
    </aside>
  );
}

function FullSentenceRow({
  block,
  sceneImageUrl,
  sceneImageAlt,
  measure = false,
  editable = false,
  selectedTokenIndex,
  onSelectToken,
  onPointChange,
}: {
  block: FullBlock;
  sceneImageUrl?: string;
  sceneImageAlt?: string;
  measure?: boolean;
  editable?: boolean;
  selectedTokenIndex?: number;
  onSelectToken?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number) => void;
}) {
  return (
    <section
      className="full-sentence-row"
      data-full-block-id={measure ? undefined : block.id}
      data-full-measure-id={measure ? block.id : undefined}
    >
      <FullSceneCard
        imageUrl={sceneImageUrl}
        imageAlt={sceneImageAlt}
        order={block.sentence.order}
        rhythm={block.sentence.rhythm}
      />
      <div className="full-sentence-body">
        <FullGraphTrack
          sentence={block.sentence}
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

function FullPageLegend() {
  // Full only displays short pause, tone, 重音 and the prosody curve, so the
  // footer legend is kept to exactly those cues.
  return (
    <footer className="full-page-legend">
      <span><b>/</b> 短停</span>
      <span><b>↗ ↘</b> 语调</span>
      <span><b className="full-legend-focus">红</b> 重音</span>
      <span><i className="full-legend-curve" aria-hidden="true" /> 语势曲线</span>
    </footer>
  );
}

function FullA4Page({
  work,
  plan,
  blocksById,
  sceneAssetsBySentenceId,
  total,
  selection,
  onSelectToken,
  onPointChange,
}: {
  work: RecitationWork;
  plan: PrintPagePlan;
  blocksById: ReadonlyMap<string, FullBlock>;
  sceneAssetsBySentenceId: ReadonlyMap<string, { url?: string; alt?: string }>;
  total: number;
  selection?: FullSelection;
  onSelectToken: (sentence: RecitationSentence, token: TimedToken, anchor: HTMLElement) => void;
  onPointChange: (sentence: RecitationSentence, tokenIndex: number, visualLevel: number) => void;
}) {
  const slotBlocks: Array<FullBlock | undefined> = [0, 1, 2, 3].map(
    (slotIndex) => {
      const blockId = plan.blockIds[slotIndex];
      return blockId ? blocksById.get(blockId) : undefined;
    },
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
          {slotBlocks.map((block, slotIndex) => {
            const scene = block ? sceneAssetsBySentenceId.get(block.id) : undefined;
            return (
              <div className="full-slot" key={slotIndex} data-full-slot={slotIndex + 1}>
                {block ? (
                  <FullSentenceRow
                    block={block}
                    sceneImageUrl={scene?.url}
                    sceneImageAlt={scene?.alt}
                    editable
                    selectedTokenIndex={selection?.sentenceId === block.sentence.id ? selection.tokenIndex : undefined}
                    onSelectToken={(token, anchor) => onSelectToken(block.sentence, token, anchor)}
                    onPointChange={(tokenIndex, visualLevel) => onPointChange(block.sentence, tokenIndex, visualLevel)}
                    key={block.id}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        <FullPageLegend />
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
  onPinyinOverrideChange,
  onSave,
  onOpenLibrary,
  onSwitchCompact,
}: {
  work: RecitationWork;
  saveState: FullSaveState;
  onSentenceChange: (sentence: RecitationSentence) => void;
  onPinyinOverrideChange: (tokenId: string, value: string) => void;
  onSave: () => void;
  onOpenLibrary: () => void;
  onSwitchCompact: () => void;
}) {
  const spec = work.controlSpec;
  const blocks = useMemo<FullBlock[]>(
    () => (spec?.sentences ?? []).map((sentence) => ({
      id: sentence.id,
      sentence: applyPinyinOverrides(sentence, spec?.pinyinOverrides ?? {}),
    })),
    [spec],
  );
  const blocksById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const sceneAssetsBySentenceId = useMemo(
    () => mapSceneAssetsToSentences(work.visuals, spec?.sentences ?? []),
    [work.visuals, spec],
  );
  const sceneAssetsView = useMemo(
    () => new Map([...sceneAssetsBySentenceId.entries()].map(([id, asset]) => [
      id,
      { url: asset.url, alt: asset.prompt },
    ])),
    [sceneAssetsBySentenceId],
  );
  const pageStackRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<FullSelection>();
  const [pinyinEditorOpen, setPinyinEditorOpen] = useState(false);
  const [pinyinDraft, setPinyinDraft] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const workspaceStyle = { "--full-a4-margin": `${FULL_MARGIN_MM}mm` } as CSSProperties;

  // Fixed four-slot layout: every page carries exactly four equal slots, each
  // holding one sentence row vertically centered inside it. Pages are cut at
  // 4 sentences/page; a final short page keeps its remaining slots empty
  // instead of re-spreading content.
  const pages = useMemo<PrintPagePlan[]>(() => {
    const pageCount = Math.max(1, Math.ceil(blocks.length / 4));
    return Array.from({ length: pageCount }, (_, index) => ({
      index,
      blockIds: blocks
        .slice(index * 4, index * 4 + 4)
        .map((block) => block.id),
      usedHeightPx: 0,
      capacityPx: 0,
      hasOversizedBlock: false,
    }));
  }, [blocks]);

  const layoutMessage = exportStatus
    || (blocks.length
      ? `已按每页 4 句排成 ${pages.length} 页；每句在各自槽位垂直居中`
      : "正在按每页 4 句排布 A4…");

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

  const selectedSentence = selection ? blocksById.get(selection.sentenceId)?.sentence : undefined;
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
    if (!selectedToken) return;
    onPinyinOverrideChange(selectedToken.id, value);
    setPinyinEditorOpen(false);
  };

  const scenesIncomplete = blocks.some((block) => !sceneAssetsBySentenceId.get(block.id)?.url);

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
      className={`full-editor-workspace ${exportingPdf ? "is-exporting" : ""}`}
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
            sceneAssetsBySentenceId={sceneAssetsView}
            total={pages.length}
            selection={selection}
            onSelectToken={openSelection}
            onPointChange={changePoint}
            key={`full-page-${page.index}-${page.blockIds.join("-")}`}
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
