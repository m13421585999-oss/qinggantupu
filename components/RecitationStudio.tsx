"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type CSSProperties,
} from "react";
import { importControlSpec } from "@/lib/control-spec-import";
import {
  buildGraphTokenUnits,
  isGraphPunctuation,
} from "@/lib/graph-track";
import { sentencePlaybackWindow } from "@/lib/sentence-playback";
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
import {
  splitGraphUnitsByMeasuredWidth,
} from "@/lib/semantic-scene-lines";
import { ViewerScaleWrapper } from "@/components/ViewerScaleWrapper";
import { WorkVisualPanel } from "@/components/WorkVisualPanel";
import {
  ENDING_LABELS,
  PROSODY_LABELS,
  RHYTHM_LABELS,
  type AiTtsProduction,
  type AudioTimeline,
  type AudioTrack,
  type AudioSourceType,
  type ControlSpec,
  type EndingTone,
  type RecitationSentence,
  type RecitationWork,
  type TimedToken,
} from "@/lib/recitation-schema";
import {
  generateWorkVisualAssets,
  mapSceneAssetsToSentences,
  mapSceneSpecsToSentences,
  type VisualAssetKind,
  type WorkVisualBundle,
} from "@/lib/visual-assets";

type ProductMode = "studio" | "viewer";
type WorkflowStep = 1 | 2 | 3;
type AudioSource = "reference" | "standard";
type AnalysisJobStatus = "idle" | "queued" | "processing" | "succeeded" | "failed";
type SaveState = "unsaved" | "dirty" | "saving" | "saved" | "failed";
type PendingWorkAction = { kind: "open"; workId: string } | { kind: "new" };
type DestructiveChangeKind = "source" | "reference" | "remove_reference";

interface WorkSummary {
  id: string;
  slug: string;
  title: string;
  author?: string;
  status: RecitationWork["status"];
  audioSyncStatus: RecitationWork["audioSyncStatus"];
  hasReferenceAudio: boolean;
  hasStandardAudio: boolean;
  hasControlSpec: boolean;
  hasPublishedVersion: boolean;
  createdAt: string;
  updatedAt: string;
}

const workflowSteps: Array<{
  id: WorkflowStep;
  title: string;
  subtitle: string;
}> = [
  { id: 1, title: "准备作品", subtitle: "正文 · 参考朗诵来源" },
  { id: 2, title: "编辑图谱", subtitle: "人工复核 · 单句修正" },
  { id: 3, title: "预览发布", subtitle: "观看端 · 同步高亮" },
];

const editableEndingOptions: EndingTone[] = ["rising", "falling"];

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatSavedTime(value?: string) {
  if (!value) return "尚未保存";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatUpdatedTime(value: string) {
  const updated = new Date(value);
  const today = new Date();
  const sameDay = updated.getFullYear() === today.getFullYear()
    && updated.getMonth() === today.getMonth()
    && updated.getDate() === today.getDate();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
  ).format(updated);
}

function workStatusLabel(work: WorkSummary) {
  if (work.status === "published") return "已发布";
  if (work.hasControlSpec) return "待确认";
  if (work.hasReferenceAudio) return "素材已保存";
  return "草稿";
}

function punctuationOnly(char: string) {
  return isGraphPunctuation(char);
}

function sourceDecorationText(char: string) {
  if (/\r|\n/u.test(char)) return "";
  if (/^\s+$/u.test(char)) return " ";
  return char;
}

async function seekAudioBeforePlayback(audio: HTMLAudioElement, targetSeconds: number) {
  const duration = Number.isFinite(audio.duration) ? audio.duration : undefined;
  const target = Math.max(
    0,
    duration === undefined ? targetSeconds : Math.min(targetSeconds, Math.max(0, duration - 0.001)),
  );
  const needsSeek = Math.abs(audio.currentTime - target) > 0.015;
  if (!needsSeek) {
    audio.currentTime = target;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.removeEventListener("seeked", finish);
      resolve();
    };
    audio.addEventListener("seeked", finish, { once: true });
    timeout = window.setTimeout(finish, 1600);
    audio.currentTime = target;
  });
}

async function prepareViewerImagesForExport(target: HTMLElement) {
  const images = Array.from(target.querySelectorAll("img"));
  await Promise.all(images.map(async (image) => {
    image.loading = "eager";
    if (!image.complete) {
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
        window.setTimeout(finish, 5_000);
      });
    }
    if (image.complete && image.naturalWidth > 0) {
      await image.decode?.().catch(() => undefined);
    }
  }));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => (
    window.requestAnimationFrame(() => resolve())
  )));
}

function focusSet(sentence: RecitationSentence) {
  return new Set(sentence.focus.flatMap((target) => target.tokenIndexes));
}

function pauseAfter(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.pauses.find((pause) => pause.afterTokenIndex === tokenIndex);
}

function prolongFor(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.prolongations.find((prolong) => prolong.tokenIndex === tokenIndex);
}

function toggleSentenceFocus(sentence: RecitationSentence, token: TimedToken) {
  const contains = sentence.focus.some((target) => target.tokenIndexes.includes(token.index));
  let nextFocus = sentence.focus
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
    if (nextFocus[0]) {
      nextFocus = nextFocus.map((target, index) => index === 0 ? {
        ...target,
        tokenIds: [...target.tokenIds, token.id],
        tokenIndexes: [...target.tokenIndexes, token.index].sort((left, right) => left - right),
      } : target);
    } else {
      nextFocus = [{
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
  return { ...sentence, focus: nextFocus };
}

function cycleSentencePause(sentence: RecitationSentence, token: TimedToken) {
  const existing = sentence.pauses.find((pause) => pause.afterTokenIndex === token.index);
  if (!existing) {
    return {
      ...sentence,
      pauses: [...sentence.pauses, {
        id: `${sentence.id}-pause-${token.index}`,
        afterTokenId: token.id,
        afterTokenIndex: token.index,
        type: "short" as const,
        source: "human" as const,
      }],
    };
  }
  if (existing.type === "short") {
    return {
      ...sentence,
      pauses: sentence.pauses.map((pause) => pause.id === existing.id
        ? { ...pause, type: "long" as const, source: "human" as const }
        : pause),
    };
  }
  return { ...sentence, pauses: sentence.pauses.filter((pause) => pause.id !== existing.id) };
}

function toggleSentenceProlong(sentence: RecitationSentence, token: TimedToken) {
  const existing = sentence.prolongations.find((prolong) => prolong.tokenIndex === token.index);
  return {
    ...sentence,
    prolongations: existing
      ? sentence.prolongations.filter((prolong) => prolong.id !== existing.id)
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

function setSentenceEnding(sentence: RecitationSentence, type: EndingTone) {
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

function sentenceTiming(
  timeline: AudioTimeline | undefined,
  sentenceId: string,
) {
  return timeline?.sentences.find((item) => item.sentenceId === sentenceId);
}

function activeSentenceAt(
  sentences: RecitationSentence[],
  timeline: AudioTimeline | undefined,
  currentMs: number,
) {
  const timing = timeline?.sentences.find(
    (item) => currentMs >= item.startMs && currentMs < item.endMs,
  );
  return timing
    ? sentences.find((sentence) => sentence.id === timing.sentenceId)
    : undefined;
}

function activeTokenAt(timeline: AudioTimeline | undefined, currentMs: number) {
  const sentence = timeline?.sentences.find(
    (item) => currentMs >= item.startMs && currentMs < item.endMs,
  );
  if (!timeline || !sentence) return undefined;
  const eligible = timeline.tokens.filter(
    (token) => token.endMs > token.startMs
      && token.startMs >= sentence.startMs
      && token.endMs <= sentence.endMs,
  );
  const exact = eligible.find(
    (token) => currentMs >= token.startMs && currentMs < token.endMs,
  );
  if (exact) return exact.tokenId;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (eligible[index].startMs <= currentMs) return eligible[index].tokenId;
  }
  return undefined;
}

function highestAvailableStep(work: RecitationWork): WorkflowStep {
  if ((work.standardAiAudio ?? work.aiDemoAudio)?.timeline && work.controlSpec) return 3;
  if (work.controlSpec) return 2;
  return 1;
}

function readAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const durationMs = Math.round(audio.duration * 1000);
      audio.removeAttribute("src");
      audio.load();
      if (Number.isFinite(durationMs) && durationMs > 0) resolve(durationMs);
      else reject(new Error("invalid audio duration"));
    };
    audio.onerror = () => reject(new Error("audio metadata unavailable"));
    audio.src = url;
  });
}

function createEmptyWork(): RecitationWork {
  const createdAt = new Date().toISOString();
  return {
    id: `draft-${crypto.randomUUID()}`,
    slug: "",
    title: "",
    author: "",
    genre: "other",
    language: "zh-CN",
    sourceText: "",
    audioSourceType: "human_reference",
    status: "draft",
    audioSyncStatus: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

async function apiJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error && typeof payload.error === "object"
      ? payload.error as Record<string, unknown>
      : {};
    throw new Error(String(error.message ?? `请求失败（HTTP ${response.status}）`));
  }
  return payload as T;
}

function exportFilename(title: string) {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80);
  return `${base || "朗诵情感图谱"}-朗诵图谱.png`;
}

interface AnalysisJobPayload {
  analysis_job_id: string;
  work_id: string;
  status: Exclude<AnalysisJobStatus, "idle">;
  progress?: number;
  error?: string | { message?: string };
  control_spec?: unknown;
  work?: RecitationWork;
}

interface AiTtsJobPayload {
  ai_tts_job_id: string;
  work_id: string;
  status: AiTtsProduction["status"];
  progress?: number;
  performance_plan?: AiTtsProduction["performancePlan"];
  tts_text?: string;
  audio_asset_id?: string;
  analysis_job_id?: string;
  error?: { code?: string; message?: string };
  work?: RecitationWork;
}

function aiTtsStatusText(status?: AiTtsProduction["status"]) {
  switch (status) {
    case "queued": return "正在理解文稿……";
    case "tts_plan_generating": return "正在设计朗诵……";
    case "tts_plan_ready": return "朗诵方案已生成";
    case "tts_audio_generating": return "正在生成 AI 参考声音……";
    case "tts_audio_ready": return "AI 参考声音生成完成";
    case "audio_analyzing": return "正在分析声音并生成情感图谱……";
    case "llm_interpreting": return "正在生成情感图谱……";
    case "graph_ready": return "AI 参考朗诵与情感图谱已生成";
    case "error": return "AI 参考朗诵任务未完成";
    default: return "等待生成 AI 参考朗诵";
  }
}

function analysisErrorMessage(error: AnalysisJobPayload["error"]) {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return "标准 AI 朗诵分析失败。";
}

interface CurveMetrics {
  width: number;
  height: number;
  trackStart: number;
  trackEnd: number;
  tokenCenters: Record<number, number>;
}

interface CurveRowMetrics extends CurveMetrics {
  key: string;
  top: number;
}

const VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE = 56;
const VIEWER_MANUSCRIPT_MIN_FONT_SIZE = 38;

function protectedSentenceBoundaries(sentence: RecitationSentence) {
  const protectedIndexes = new Set<number>();
  const protectInside = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) protectedIndexes.add(index);
  };
  sentence.focus.forEach((target) => {
    const indexes = [...target.tokenIndexes].sort((left, right) => left - right);
    if (indexes.length > 1) protectInside(indexes[0], indexes.at(-1)!);
  });
  sentence.prosody.forEach((event) => protectInside(event.coreZone.start, event.coreZone.end));
  return [...protectedIndexes];
}

function AcousticProsodyCurve({
  sentence,
  metrics,
  teachingPoints,
  activeTokenIndex,
  editing,
  onPointChange,
  onPointCancel,
}: {
  sentence: RecitationSentence;
  metrics: CurveMetrics;
  teachingPoints: TeachingProsodyPoint[];
  activeTokenIndex?: number;
  editing: boolean;
  onPointChange?: (tokenIndex: number, visualLevel: number, commit: boolean) => void;
  onPointCancel?: (tokenIndex: number, visualLevel: number, wasOverridden: boolean) => void;
}) {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    tokenIndex: number;
    initialVisualLevel: number;
    initialOverridden: boolean;
  } | undefined>(undefined);
  const rowPoints = teachingPoints.filter((point) => Number.isFinite(metrics.tokenCenters[point.tokenIndex]));
  if (metrics.width <= 0 || !rowPoints.length) return null;

  const height = metrics.height;
  const verticalPadding = 7;
  const visualStep = (height - verticalPadding * 2) / (PROSODY_VISUAL_LEVEL_COUNT - 1);
  const points = rowPoints.map((point) => ({
    ...point,
    x: metrics.tokenCenters[point.tokenIndex],
    y: height - verticalPadding - point.visualLevel * visualStep,
  }));
  const neutralFallback = rowPoints.every((point) => point.isNeutralFallback);
  const baselineY = height - verticalPadding - ((PROSODY_VISUAL_LEVEL_COUNT - 1) / 2) * visualStep;
  const label = sentence.prosody.length
    ? sentence.prosody.map((event) => PROSODY_LABELS[event.type]).join("、")
    : "教学宏观语势";
  const drawingPoints = extendProsodyCurveToTokenEdges(
    points,
    metrics.trackStart,
    metrics.trackEnd,
    verticalPadding,
    height - verticalPadding,
  );
  const spline = monotoneSplinePath(drawingPoints);
  const fillPath = `${spline} L ${drawingPoints.at(-1)!.x} ${height + 1} L ${drawingPoints[0].x} ${height + 1} Z`;
  const visualLevelFromPointer = (clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.height) return undefined;
    return prosodyVisualLevelFromPointerY({
      clientY,
      rectTop: rect.top,
      rectHeight: rect.height,
      viewBoxHeight: height,
      verticalPadding,
    });
  };
  const updateDraggedPoint = (clientY: number, commit: boolean) => {
    const drag = dragRef.current;
    const visualLevel = visualLevelFromPointer(clientY);
    if (!drag || visualLevel === undefined) return;
    onPointChange?.(drag.tokenIndex, visualLevel, commit);
  };
  const cancelDraggedPoint = (pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = undefined;
    onPointCancel?.(drag.tokenIndex, drag.initialVisualLevel, drag.initialOverridden);
  };

  return (
    <svg
      ref={svgRef}
      className={`prosody-curve acoustic-prosody-curve ${editing ? "editing" : ""}`}
      data-prosody-source={neutralFallback ? "neutral-fallback" : "acoustic"}
      viewBox={`0 0 ${metrics.width} ${height}`}
      preserveAspectRatio="none"
      role={editing ? "group" : "img"}
      aria-label={`${label}；每字宏观语势曲线${neutralFallback ? "；当前为中性后备路径" : ""}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b6452e" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#b6452e" stopOpacity="0.015" />
        </linearGradient>
      </defs>
      <path
        className="curve-fill"
        d={fillPath}
        fill={`url(#${gradientId})`}
        stroke="none"
      />
      <line
        className="curve-baseline"
        x1={drawingPoints[0].x}
        x2={drawingPoints.at(-1)?.x ?? drawingPoints[0].x}
        y1={baselineY}
        y2={baselineY}
        stroke="rgba(128, 91, 57, 0.18)"
        strokeWidth="1"
        strokeDasharray="3 6"
      />
      <path
        className="curve-path acoustic-path"
        d={spline}
        fill="none"
        stroke="#b6452e"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity="0.9"
      />
      {points.map((point) => {
        const playing = point.tokenIndex === activeTokenIndex;
        return (
          <g key={point.tokenIndex}>
          {editing && onPointChange ? (
            <ellipse
              className="prosody-anchor-hit-target"
              data-export-exclude="true"
              cx={point.x}
              cy={point.y}
              rx="24"
              ry="38"
              role="slider"
              tabIndex={0}
              aria-label={`调整第 ${point.tokenIndex + 1} 个字的语势高度`}
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={PROSODY_VISUAL_LEVEL_COUNT - 1}
              aria-valuenow={point.visualLevel}
              aria-valuetext={`第 ${point.visualLevel + 1} 级`}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.pointerType === "mouse" && event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                dragRef.current = {
                  pointerId: event.pointerId,
                  tokenIndex: point.tokenIndex,
                  initialVisualLevel: point.visualLevel,
                  initialOverridden: Boolean(point.isOverridden),
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                updateDraggedPoint(event.clientY, false);
              }}
              onPointerMove={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                event.preventDefault();
                updateDraggedPoint(event.clientY, false);
              }}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                event.preventDefault();
                updateDraggedPoint(event.clientY, true);
                dragRef.current = undefined;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={(event) => cancelDraggedPoint(event.pointerId)}
              onLostPointerCapture={(event) => cancelDraggedPoint(event.pointerId)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                event.stopPropagation();
                onPointChange(
                  point.tokenIndex,
                  point.visualLevel + (event.key === "ArrowUp" ? 1 : -1),
                  true,
                );
              }}
            />
          ) : null}
          <circle
            className={`token-prosody-anchor ${playing ? "playing" : ""}`}
            data-prosody-anchor="true"
            data-token-index={point.tokenIndex}
            data-visual-level={point.visualLevel}
            cx={point.x}
            cy={point.y}
            r={playing ? 4.75 : editing ? 3.4 : 2.9}
            fill={playing ? "#a93627" : editing ? "#a95b49" : "#b6452e"}
            opacity={playing ? 1 : editing ? 0.95 : 0.9}
            stroke={playing ? "#fff5e8" : "rgba(255, 250, 240, 0.92)"}
            strokeWidth={playing ? 2 : editing ? 1.25 : 1.2}
            vectorEffect="non-scaling-stroke"
          />
          </g>
        );
      })}
    </svg>
  );
}

function ToneArrow({ type }: { type: EndingTone }) {
  if (type === "level") return null;
  return (
    <span className={`tone-arrow tone-${type}`} aria-label={ENDING_LABELS[type]}>
      {type === "rising" ? "↗" : "↘"}
    </span>
  );
}

function IndexedGraphTrack({
  sentence,
  activeTokenId,
  editing = false,
  semanticLines = false,
  onTokenEdit,
  onPointChange,
  onPointCancel,
}: {
  sentence: RecitationSentence;
  activeTokenId?: string;
  editing?: boolean;
  semanticLines?: boolean;
  onTokenEdit?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number, commit: boolean) => void;
  onPointCancel?: (tokenIndex: number, visualLevel: number, wasOverridden: boolean) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const tokenRefs = useRef(new Map<number, HTMLSpanElement>());
  const unitRefs = useRef(new Map<number, HTMLSpanElement>());
  const curveSlotRefs = useRef(new Map<number, HTMLSpanElement>());
  const [curveRows, setCurveRows] = useState<CurveRowMetrics[]>([]);
  const focused = focusSet(sentence);
  const tokenUnits = useMemo(
    () => buildGraphTokenUnits(sentence),
    [sentence],
  );
  const viewerLayoutKey = useMemo(() => tokenUnits.map((unit) => [
    unit.token.id,
    unit.token.char,
    unit.token.displayPinyin,
    unit.prolongation?.id,
    unit.pause?.id,
    unit.pause?.type,
    unit.endingTone,
    ...unit.prefixPunctuation.map((token) => token.id),
    ...unit.suffixPunctuation.map((token) => token.id),
  ].join(":" )).join("|"), [tokenUnits]);
  const [viewerLayout, setViewerLayout] = useState<{
    key: string;
    fontSize: number;
    lines: Array<typeof tokenUnits>;
  }>(() => ({
    key: viewerLayoutKey,
    fontSize: VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE,
    lines: tokenUnits.length ? [tokenUnits] : [],
  }));
  const viewerFontSize = viewerLayout.key === viewerLayoutKey
    ? viewerLayout.fontSize
    : VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE;
  const readingLines = useMemo(() => (
    viewerLayout.key === viewerLayoutKey
      ? viewerLayout.lines
      : tokenUnits.length ? [tokenUnits] : []
  ), [tokenUnits, viewerLayout, viewerLayoutKey]);
  const activeTokenIndex = sentence.tokens.find((token) => token.id === activeTokenId)?.index;
  const teachingProsodyPoints = useMemo(
    () => applyProsodyPointOverrides(
      buildTeachingProsodyPoints(
        tokenUnits.map((unit) => unit.token.index),
        sentence.macroProsodyPath?.points ?? [],
      ),
      sentence.prosodyPointOverrides,
    ),
    [sentence.macroProsodyPath, sentence.prosodyPointOverrides, tokenUnits],
  );
  const fitViewerManuscript = useCallback(() => {
    const track = trackRef.current;
    if (!track || !semanticLines || !tokenUnits.length) return;

    const availableWidth = track.clientWidth;
    const currentLine = track.querySelector<HTMLElement>(".semantic-token-line");
    if (availableWidth <= 0 || !currentLine) return;

    const renderedWidth = currentLine.scrollWidth;
    if (readingLines.length === 1 && renderedWidth <= availableWidth + 0.5) {
      if (viewerFontSize < VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE) {
        const nextSize = Math.min(
          VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE,
          Math.floor(viewerFontSize * availableWidth / Math.max(renderedWidth, 1)),
        );
        if (nextSize > viewerFontSize) {
          setViewerLayout({ key: viewerLayoutKey, fontSize: nextSize, lines: [tokenUnits] });
        }
      }
      return;
    }

    if (readingLines.length === 1 && viewerFontSize > VIEWER_MANUSCRIPT_MIN_FONT_SIZE) {
      const nextSize = Math.max(
        VIEWER_MANUSCRIPT_MIN_FONT_SIZE,
        Math.min(viewerFontSize - 1, Math.floor(viewerFontSize * availableWidth / Math.max(renderedWidth, 1))),
      );
      setViewerLayout({ key: viewerLayoutKey, fontSize: nextSize, lines: [tokenUnits] });
      return;
    }

    if (readingLines.length !== 1 || viewerFontSize !== VIEWER_MANUSCRIPT_MIN_FONT_SIZE) return;

    const computedStyle = window.getComputedStyle(currentLine);
    const unitGap = Number.parseFloat(computedStyle.columnGap) || 0;
    const trackRect = track.getBoundingClientRect();
    const coordinateScale = track.offsetWidth > 0 ? trackRect.width / track.offsetWidth : 1;
    const localScale = Number.isFinite(coordinateScale) && coordinateScale > 0
      ? coordinateScale
      : 1;
    const unitWidths = new Map(tokenUnits.flatMap((unit) => {
      const element = unitRefs.current.get(unit.token.index);
      return element ? [[unit.token.index, element.getBoundingClientRect().width / localScale]] : [];
    }));
    const splitLines = splitGraphUnitsByMeasuredWidth(tokenUnits, {
      maxLineWidth: availableWidth,
      unitWidths,
      unitGap,
      preferredBoundaryIndexes: sentence.prosody.map((event) => event.activeSpan.end),
      protectedBoundaryIndexes: protectedSentenceBoundaries(sentence),
    });
    if (splitLines.length > 1) {
      setViewerLayout({
        key: viewerLayoutKey,
        fontSize: VIEWER_MANUSCRIPT_MIN_FONT_SIZE,
        lines: splitLines,
      });
    }
  }, [readingLines, semanticLines, sentence, tokenUnits, viewerFontSize, viewerLayoutKey]);

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track || !tokenUnits.length) {
      setCurveRows([]);
      return;
    }

    const trackRect = track.getBoundingClientRect();
    // The viewer artboard is transformed as a whole on narrow landscape screens.
    // DOMRect values are post-transform pixels, whereas positioned curve layers use
    // the artboard's unscaled coordinate space. Normalize once so screen, playback
    // and the unscaled PNG export all share the same token centers and row heights.
    const coordinateScale = track.offsetWidth > 0
      ? trackRect.width / track.offsetWidth
      : 1;
    const localScale = Number.isFinite(coordinateScale) && coordinateScale > 0
      ? coordinateScale
      : 1;
    const localX = (value: number) => value / localScale;
    const visualRows: Array<{
      unitTop: number;
      curveTop: number;
      curveHeight: number;
      indexes: number[];
      characters: HTMLSpanElement[];
    }> = [];

    for (const unit of tokenUnits) {
      const unitElement = unitRefs.current.get(unit.token.index);
      const characterElement = tokenRefs.current.get(unit.token.index);
      const curveSlot = curveSlotRefs.current.get(unit.token.index);
      if (!unitElement || !characterElement || !curveSlot) continue;

      const unitRect = unitElement.getBoundingClientRect();
      const curveRect = curveSlot.getBoundingClientRect();
      const unitTop = localX(unitRect.top - trackRect.top);
      let row = visualRows.find((candidate) => Math.abs(candidate.unitTop - unitTop) < 2);
      if (!row) {
        row = {
          unitTop,
          curveTop: localX(curveRect.top - trackRect.top),
          curveHeight: localX(curveRect.height),
          indexes: [],
          characters: [],
        };
        visualRows.push(row);
      }
      row.indexes.push(...unit.sourceTokenIndexes);
      row.characters.push(characterElement);
    }

    setCurveRows(visualRows.map((row, rowIndex) => {
      const first = row.characters[0];
      const last = row.characters.at(-1)!;
      const firstRect = first.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const uniqueIndexes = [...new Set(row.indexes)].sort((left, right) => left - right);
      const tokenCenters = Object.fromEntries(uniqueIndexes.flatMap((index) => {
        const element = tokenRefs.current.get(index);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [[index, localX(rect.left - trackRect.left + rect.width / 2)]];
      }));

      return {
        key: `${sentence.id}-curve-row-${rowIndex}`,
        top: row.curveTop,
        width: localX(trackRect.width),
        height: row.curveHeight,
        trackStart: localX(firstRect.left - trackRect.left),
        trackEnd: localX(lastRect.right - trackRect.left),
        tokenCenters,
      };
    }));
  }, [sentence.id, tokenUnits]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(track);
    for (const unit of unitRefs.current.values()) observer.observe(unit);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [measure]);

  useLayoutEffect(() => {
    if (!semanticLines) return;
    const track = trackRef.current;
    if (!track) return;
    let frame = window.requestAnimationFrame(fitViewerManuscript);
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitViewerManuscript);
    });
    observer.observe(track);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitViewerManuscript, semanticLines]);

  const viewerTrackStyle = semanticLines ? {
    "--manuscript-font-size": `${viewerFontSize}px`,
    "--token-char-width": `${viewerFontSize}px`,
    "--pinyin-font-size": `${Math.max(15, Math.round(21 * viewerFontSize / VIEWER_MANUSCRIPT_DEFAULT_FONT_SIZE))}px`,
    "--token-unit-gap": `${viewerFontSize <= 42 ? 2 : 4}px`,
  } as CSSProperties : undefined;

  return (
    <div className="graph-track-layout" style={viewerTrackStyle}>
      <div className="graph-track-viewport">
        <div className="attached-token-track">
          <div
            className={`token-unit-flow ${semanticLines ? "semantic-token-flow" : ""}`}
            ref={trackRef}
            aria-label={sentence.text}
          >
            {readingLines.map((line, lineIndex) => (
              <div
                className="semantic-token-line"
                data-semantic-line={lineIndex + 1}
                key={`${sentence.id}-line-${lineIndex}`}
              >
                {line.map((unit) => {
              const unitIsPlaying = activeTokenIndex !== undefined
                && unit.sourceTokenIndexes.includes(activeTokenIndex);
              return (
                <span
                  className="graph-token-unit"
                  data-host-token-index={unit.token.index}
                  key={unit.key}
                  ref={(element) => {
                    if (element) unitRefs.current.set(unit.token.index, element);
                    else unitRefs.current.delete(unit.token.index);
                  }}
                >
                  <span
                    className={`token-pinyin ${unitIsPlaying ? "playing-token" : ""}`}
                    aria-hidden="true"
                  >
                    {unit.token.displayPinyin ?? " "}
                  </span>
                  <span className="manuscript-token">
                    <span className="attached-prefix">
                      {unit.prefixPunctuation.map((punctuation) => (
                        <span
                          className={`source-punctuation ${activeTokenId === punctuation.id ? "playing-punctuation" : ""}`}
                          data-source-token-index={punctuation.index}
                          key={punctuation.id}
                        >
                          {sourceDecorationText(punctuation.char)}
                        </span>
                      ))}
                    </span>
                    <span
                      className={`token-char ${focused.has(unit.token.index) ? "focus-token" : ""} ${unitIsPlaying ? "playing-token" : ""} ${editing ? "editable-token" : ""}`}
                      data-token-index={unit.token.index}
                      role={editing ? "button" : undefined}
                      tabIndex={editing ? 0 : undefined}
                      aria-label={editing ? `编辑“${unit.token.char}”的朗诵标记` : undefined}
                      onClick={editing && onTokenEdit ? (event) => {
                        event.stopPropagation();
                        onTokenEdit(unit.token, event.currentTarget);
                      } : undefined}
                      onKeyDown={editing && onTokenEdit ? (event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        onTokenEdit(unit.token, event.currentTarget);
                      } : undefined}
                      ref={(element) => {
                        for (const sourceIndex of unit.sourceTokenIndexes) {
                          if (element) tokenRefs.current.set(sourceIndex, element);
                          else tokenRefs.current.delete(sourceIndex);
                        }
                      }}
                    >
                      {unit.token.char}
                    </span>
                    <span
                      className="attached-decorations"
                      data-attached-to-index={unit.token.index}
                    >
                      {unit.prolongation ? (
                        <span
                          className="attached-decoration prolongation-decoration"
                          data-marker="prolongation"
                          data-token-index={unit.token.index}
                          aria-label="拖音"
                        >
                          <span className="prolong-mark" aria-hidden="true" />
                        </span>
                      ) : null}
                      {unit.endingTone ? (
                        <span
                          className="attached-decoration ending-decoration"
                          data-marker="ending-intonation"
                          data-token-index={unit.token.index}
                        >
                          <ToneArrow type={unit.endingTone} />
                        </span>
                      ) : null}
                      {unit.pause ? (
                        <span
                          className={`attached-decoration pause-mark pause-${unit.pause.type}`}
                          data-marker="pause"
                          data-boundary-after-index={unit.pause.afterTokenIndex}
                        >
                          {unit.pause.type === "long" ? "///" : "/"}
                        </span>
                      ) : null}
                      {unit.suffixPunctuation.map((punctuation) => (
                        <span
                          className={`source-punctuation ${activeTokenId === punctuation.id ? "playing-punctuation" : ""}`}
                          data-source-token-index={punctuation.index}
                          key={punctuation.id}
                        >
                          {sourceDecorationText(punctuation.char)}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span
                    className="token-curve-slot"
                    aria-hidden="true"
                    ref={(element) => {
                      if (element) curveSlotRefs.current.set(unit.token.index, element);
                      else curveSlotRefs.current.delete(unit.token.index);
                    }}
                  />
                </span>
              );
                })}
              </div>
            ))}
            <div className="wrapped-curve-layer">
              {curveRows.map((row) => (
                <div
                  className="curve-line"
                  key={row.key}
                  style={{ top: `${row.top}px`, height: `${row.height}px` }}
                >
                  {teachingProsodyPoints.length ? (
                    <AcousticProsodyCurve
                      sentence={sentence}
                      metrics={row}
                      teachingPoints={teachingProsodyPoints}
                      activeTokenIndex={activeTokenIndex}
                      editing={editing}
                      onPointChange={onPointChange}
                      onPointCancel={onPointCancel}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GraphSentence({
  sentence,
  selected,
  active,
  activeTokenId,
  editing,
  onSelect,
  onPlay,
  onTokenEdit,
  onPointChange,
  onPointCancel,
  onSceneImageEdit,
  viewerSceneImageUrl,
  viewerSceneAlt,
  viewerSceneImagePriority = false,
}: {
  sentence: RecitationSentence;
  selected?: boolean;
  active?: boolean;
  activeTokenId?: string;
  editing?: boolean;
  onSelect?: () => void;
  onPlay?: () => void;
  onTokenEdit?: (token: TimedToken, anchor: HTMLElement) => void;
  onPointChange?: (tokenIndex: number, visualLevel: number, commit: boolean) => void;
  onPointCancel?: (tokenIndex: number, visualLevel: number, wasOverridden: boolean) => void;
  onSceneImageEdit?: () => void;
  viewerSceneImageUrl?: string;
  viewerSceneAlt?: string;
  viewerSceneImagePriority?: boolean;
}) {
  const isViewerScene = viewerSceneAlt !== undefined;
  const [failedSceneImageUrl, setFailedSceneImageUrl] = useState<string>();
  const sceneImageAvailable = Boolean(
    viewerSceneImageUrl && viewerSceneImageUrl !== failedSceneImageUrl,
  );
  return (
    <div
      className={`graph-sentence ${selected ? "selected" : ""} ${active ? "active" : ""}`}
      onClick={editing ? undefined : onSelect}
      onKeyDown={(event) => {
        if (!editing && onSelect && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      role={!editing && onSelect ? "button" : undefined}
      tabIndex={!editing && onSelect ? 0 : undefined}
      aria-label={!editing && onSelect ? `选择第 ${sentence.order} 句：${sentence.text}` : undefined}
    >
      <div className={`sentence-rail ${isViewerScene ? "scene-visual-rail" : ""}`}>
        {isViewerScene ? (
          <div className={`scene-visual-frame ${active ? "active" : ""}`}>
            {sceneImageAvailable && viewerSceneImageUrl ? (
              // Generated scene assets are same-origin persisted R2 objects.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={viewerSceneImageUrl}
                alt={viewerSceneAlt}
                loading={viewerSceneImagePriority ? "eager" : "lazy"}
                fetchPriority={viewerSceneImagePriority ? "high" : "auto"}
                decoding="async"
                onError={() => setFailedSceneImageUrl(viewerSceneImageUrl)}
              />
            ) : (
              <div className="scene-visual-fallback" role="img" aria-label={`${viewerSceneAlt}，使用作品视觉后备背景`} />
            )}
            <div className="scene-visual-meta">
              <span className="sentence-number">{String(sentence.order).padStart(2, "0")}</span>
              <span className="soft-tag">{RHYTHM_LABELS[sentence.rhythm]}</span>
            </div>
            {editing && onSceneImageEdit ? (
              <button
                type="button"
                className="visual-edit-hotspot visual-edit-cover"
                data-export-exclude="true"
                onClick={(event) => {
                  event.stopPropagation();
                  onSceneImageEdit();
                }}
                aria-label={`编辑第 ${sentence.order} 句意境图`}
              >
                <span>编辑图片</span>
                <small>替换 · 裁切 · 重生成</small>
              </button>
            ) : null}
            {onPlay ? (
              <span className={`scene-play-overlay ${editing ? "scene-play-overlay-editing" : ""}`} data-export-exclude="true">
                <button
                  type="button"
                  className="sentence-play"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlay();
                  }}
                  aria-label={`播放第 ${sentence.order} 句`}
                >
                  <span aria-hidden="true">▶</span>
                  听本句
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
        {!isViewerScene ? <div>
          <span className="sentence-number">{String(sentence.order).padStart(2, "0")}</span>
          <span className="soft-tag">{RHYTHM_LABELS[sentence.rhythm]}</span>
        </div> : null}
        {onPlay && !isViewerScene ? (
          <span data-export-exclude="true">
            <button
              type="button"
              className="sentence-play"
              onClick={(event) => {
                event.stopPropagation();
                onPlay();
              }}
              aria-label={`播放第 ${sentence.order} 句`}
            >
              <span aria-hidden="true">▶</span>
              听本句
            </button>
          </span>
        ) : null}
      </div>

      <div className="sentence-body">
        <IndexedGraphTrack
          sentence={sentence}
          activeTokenId={activeTokenId}
          editing={Boolean(editing)}
          semanticLines={isViewerScene}
          onTokenEdit={onTokenEdit}
          onPointChange={onPointChange}
          onPointCancel={onPointCancel}
        />
      </div>
    </div>
  );
}

function ReferenceAudioPanel({
  audio,
  disabled = false,
  onFile,
  onDelete,
}: {
  audio?: AudioTrack;
  disabled?: boolean;
  onFile: (file: File) => void;
  onDelete?: () => void;
}) {
  return (
    <div className="paper-card reference-audio-card">
      <div className="card-title-row compact-title-row">
        <div>
          <p className="eyebrow">真人参考朗诵</p>
          <h2>保留原始来源证据</h2>
        </div>
        <span className="secure-note">仅创作端可见</span>
      </div>
      <p className="reference-explainer">
        上传与正文逐字对应的优质朗诵。系统先用 Voice Changer 统一音色，再分析并播放同一条标准 AI 声音。
      </p>
      {audio ? (
        <div className="reference-audio-ready">
          <div className="audio-file-row">
            <span className="upload-icon has-audio" aria-hidden="true">声</span>
            <div>
              <strong>{audio.filename}</strong>
              <small>{formatTime(audio.durationMs)} · {audio.label}</small>
            </div>
          </div>
          {/* The exact transcript is displayed in the work manuscript beside this reference audio. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio className="reference-preview" controls preload="metadata" src={audio.url} />
          <div className="reference-actions">
            <label className="secondary-button replace-audio">
              替换音频
              <input
                className="visually-hidden"
                type="file"
                disabled={disabled}
                accept="audio/*,.wav,.m4a,.mp3"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) onFile(file);
                }}
              />
            </label>
            {onDelete ? (
              <button type="button" className="text-button delete-audio" disabled={disabled} onClick={onDelete}>
                删除音频
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <label className="reference-dropzone">
          <input
            className="visually-hidden"
            type="file"
            disabled={disabled}
            accept="audio/*,.wav,.m4a,.mp3"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) onFile(file);
            }}
          />
          <span className="upload-icon" aria-hidden="true">声</span>
          <span>
            <strong>上传优质参考朗诵</strong>
            <small>WAV / M4A / MP3，单人清晰人声最佳</small>
          </span>
          <b>选择音频</b>
        </label>
      )}
    </div>
  );
}

function AiReferenceAudioPanel({
  work,
  disabled,
}: {
  work: RecitationWork;
  disabled: boolean;
}) {
  const aiTts = work.aiTts;
  const audio = aiTts?.audioUrl ? work.standardAiAudio : undefined;
  return (
    <div className="paper-card reference-audio-card ai-reference-card">
      <div className="card-title-row compact-title-row">
        <div>
          <p className="eyebrow">AI 参考朗诵</p>
          <h2>由文稿直接生成标准声音</h2>
        </div>
        <span className="secure-note">Eleven v3</span>
      </div>
      <p className="reference-explainer">
        GPT-5.6 Sol 先设计克制、自然的朗诵表达，再由固定标准 Voice 生成可试听音频；音频随后进入同一套声学分析。
      </p>
      {audio ? (
        <div className="reference-audio-ready ai-audio-ready">
          <div className="audio-file-row">
            <span className="upload-icon has-audio" aria-hidden="true">AI</span>
            <div>
              <strong>{work.title || audio.filename}</strong>
              <small>{formatTime(audio.durationMs)} · AI 参考朗诵</small>
            </div>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio className="reference-preview" controls preload="metadata" src={audio.url} />
        </div>
      ) : (
        <div className="ai-reference-placeholder" aria-live="polite">
          <span aria-hidden="true">文</span>
          <div>
            <strong>不需要上传音频</strong>
            <small>填写正文后，点击下方按钮即可生成并分析。</small>
          </div>
        </div>
      )}
      <ol className="ai-stage-list" aria-label="AI 参考朗诵任务进度">
        <li className={aiTts?.performancePlan ? "complete" : disabled ? "active" : ""}>
          <span>{aiTts?.performancePlan ? "✓" : "1"}</span>朗诵方案
        </li>
        <li className={audio ? "complete" : aiTts?.status === "tts_audio_generating" ? "active" : ""}>
          <span>{audio ? "✓" : "2"}</span>参考声音
        </li>
        <li className={aiTts?.status === "graph_ready" ? "complete" : aiTts?.status === "audio_analyzing" ? "active" : ""}>
          <span>{aiTts?.status === "graph_ready" ? "✓" : "3"}</span>声音分析与图谱
        </li>
      </ol>
    </div>
  );
}

function Player({
  title,
  track,
  sentences,
  source,
  currentMs,
  isPlaying,
  playbackRate,
  onToggle,
  onSeek,
  onRateChange,
  onSourceChange,
  hasReference,
  hasStandard,
  compact = false,
}: {
  title: string;
  track: AudioTrack;
  sentences: RecitationSentence[];
  source: AudioSource;
  currentMs: number;
  isPlaying: boolean;
  playbackRate: number;
  onToggle: () => void;
  onSeek: (value: number) => void;
  onRateChange: (rate: number) => void;
  onSourceChange?: (source: AudioSource) => void;
  hasReference: boolean;
  hasStandard: boolean;
  compact?: boolean;
}) {
  const progress = track.durationMs > 0
    ? Math.min(100, (currentMs / track.durationMs) * 100)
    : 0;
  const activeSentence = activeSentenceAt(sentences, track.timeline, currentMs);

  return (
    <div className={`player ${compact ? "player-compact" : ""} ${isPlaying ? "playing" : ""}`}>
      <button
        type="button"
        className="play-main"
        onClick={onToggle}
        aria-label={isPlaying ? "暂停" : "播放整篇"}
      >
        {isPlaying ? "Ⅱ" : "▶"}
      </button>
      <div className="player-copy">
        <div className="player-now">
          <span>
            {compact
              ? "标准朗诵 · 整篇"
              : `${source === "reference" ? "真人原始朗诵" : "标准 AI 朗诵"}${activeSentence ? ` · 第 ${activeSentence.order} 句` : ""}`}
          </span>
          <strong>{compact ? title : activeSentence?.text ?? title}</strong>
        </div>
        <label className="progress-wrap">
          <span className="visually-hidden">播放进度</span>
          <input
            type="range"
            min={0}
            max={track.durationMs}
            value={Math.min(currentMs, track.durationMs)}
            onChange={(event) => onSeek(Number(event.target.value))}
            style={{ "--progress": `${progress}%` } as CSSProperties}
          />
        </label>
        <div className="time-row">
          <span>{formatTime(currentMs)}</span>
          <span>{formatTime(track.durationMs)}</span>
        </div>
      </div>
      <div className="player-controls">
        {!compact && onSourceChange && hasReference && hasStandard ? (
          <div className="audio-source-switch" aria-label="播放音频源">
            <button
              type="button"
              className={source === "reference" ? "active" : ""}
              onClick={() => onSourceChange("reference")}
            >
              真人原声
            </button>
            <button
              type="button"
              className={source === "standard" ? "active" : ""}
              onClick={() => onSourceChange("standard")}
            >
              标准 AI
            </button>
          </div>
        ) : null}
        <label className="rate-control">
          <span className="visually-hidden">播放速度</span>
          <select
            value={playbackRate}
            onChange={(event) => onRateChange(Number(event.target.value))}
          >
            <option value={0.75}>0.75×</option>
            <option value={1}>1.0×</option>
            <option value={1.25}>1.25×</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function WorkflowRail({
  step,
  highestStep,
  onStep,
}: {
  step: WorkflowStep;
  highestStep: WorkflowStep;
  onStep: (step: WorkflowStep) => void;
}) {
  return (
    <nav className="workflow-rail" aria-label="创作流程">
      <p className="eyebrow rail-eyebrow">作品流程</p>
      {workflowSteps.map((item) => {
        const available = item.id <= highestStep;
        const completed = item.id < highestStep;
        return (
          <button
            type="button"
            key={item.id}
            className={`workflow-step ${step === item.id ? "current" : ""} ${completed ? "complete" : ""}`}
            disabled={!available}
            onClick={() => available && onStep(item.id)}
          >
            <span className="step-dot">{completed ? "✓" : item.id}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.subtitle}</small>
            </span>
          </button>
        );
      })}
      <div className="rail-note">
        <span aria-hidden="true">◎</span>
        <p>
          <strong>声音与图谱同源</strong>
          新作品先转换为标准 AI 声音；时间戳、声学事实、控制谱和最终播放都使用这同一条音频。
        </p>
      </div>
    </nav>
  );
}

function MaterialStage({
  work,
  jobStatus,
  analysisStatus,
  onWorkChange,
  onReferenceFile,
  onDeleteReference,
  onAudioSourceTypeChange,
  onAnalyze,
}: {
  work: RecitationWork;
  jobStatus: AnalysisJobStatus;
  analysisStatus: string;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAudioSourceTypeChange: (source: AudioSourceType) => void;
  onAnalyze: () => void;
}) {
  const hasWorkInfo = Boolean(work.title.trim() && work.sourceText.trim());
  const isAnalyzing = jobStatus === "queued" || jobStatus === "processing";
  const sourceType = work.audioSourceType ?? "human_reference";
  const canAnalyze = Boolean(
    hasWorkInfo
    && !isAnalyzing
    && (sourceType === "ai_tts" || work.referenceAudio),
  );
  const aiHasAudio = Boolean(work.aiTts?.audioUrl || (
    sourceType === "ai_tts" && work.standardAiAudio
  ));
  const aiErrorCode = work.aiTts?.error?.code ?? "";
  const aiRetryingAudio = aiErrorCode === "TTS_AUDIO_GENERATION_FAILED";
  const aiRetryingAnalysis = aiHasAudio && Boolean(aiErrorCode);

  return (
    <section className="stage material-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">01 · 准备作品</p>
          <h1>把一段好朗诵，变成一张能听的声音地图</h1>
          <p className="stage-lead">
            填写准确正文，再选择真人参考朗诵或 AI 参考朗诵。两条路径最终都基于真实音频执行文字对齐、声学分析和控制谱生成。
          </p>
        </div>
        <span className="version-chip">控制谱 v2.0</span>
      </div>

      <div className="reference-source-choice" role="radiogroup" aria-label="参考朗诵来源">
        <button
          type="button"
          role="radio"
          aria-checked={sourceType === "human_reference"}
          className={sourceType === "human_reference" ? "active" : ""}
          disabled={isAnalyzing}
          onClick={() => onAudioSourceTypeChange("human_reference")}
        >
          <span aria-hidden="true">真</span>
          <strong>模式 A｜真人参考朗诵</strong>
          <small>上传优秀真人朗诵，统一声音后进行分析。</small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sourceType === "ai_tts"}
          className={sourceType === "ai_tts" ? "active" : ""}
          disabled={isAnalyzing}
          onClick={() => onAudioSourceTypeChange("ai_tts")}
        >
          <span aria-hidden="true">AI</span>
          <strong>模式 B｜AI 参考朗诵</strong>
          <small>没有真人素材时，从当前文稿一键生成并分析。</small>
        </button>
      </div>

      <div className="material-grid">
        <div className="paper-card manuscript-card">
          <div className="card-title-row">
            <div>
              <p className="eyebrow">作品信息</p>
              <h2>文稿与来源</h2>
            </div>
            <span className="draft-pill">草稿</span>
          </div>
          <div className="field-row two-fields">
            <label>
              <span>作品名称</span>
              <input
                value={work.title}
                disabled={isAnalyzing}
                onChange={(event) => onWorkChange("title", event.target.value)}
              />
            </label>
            <label>
              <span>作者 / 来源（可选）</span>
              <input
                value={work.author ?? ""}
                disabled={isAnalyzing}
                onChange={(event) => onWorkChange("author", event.target.value)}
              />
            </label>
          </div>
          <label className="text-field">
            <span>完整正文</span>
            <textarea
              rows={8}
              value={work.sourceText}
              disabled={isAnalyzing}
              onChange={(event) => onWorkChange("sourceText", event.target.value)}
            />
          </label>
          <div className="manuscript-footer">
            <span>{Array.from(work.sourceText).filter((char) => !/\s/.test(char)).length} 字</span>
            <span>建议 1～3 分钟</span>
            <span className="matched-copy">正文仅在此处维护</span>
          </div>
        </div>

        <div className="asset-column">
          {sourceType === "human_reference" ? (
            <ReferenceAudioPanel
              audio={work.referenceAudio}
              disabled={isAnalyzing}
              onFile={onReferenceFile}
              onDelete={work.referenceAudio?.url.startsWith("blob:") ? onDeleteReference : undefined}
            />
          ) : (
            <AiReferenceAudioPanel work={work} disabled={isAnalyzing} />
          )}

          <div className="analysis-card">
            <div className="analysis-orbit" aria-hidden="true">
              <span>声</span>
            </div>
            <div className="analysis-copy">
              <p className="eyebrow">
                {sourceType === "ai_tts" ? "AI 参考朗诵生产" : "标准声音生成与解析"}
              </p>
              <h3>{analysisStatus}</h3>
              <p>
                {sourceType === "ai_tts"
                  ? jobStatus === "failed"
                    ? aiHasAudio
                      ? "AI 参考声音已保留，可直接重新分析，不会重复调用 TTS。"
                      : aiRetryingAudio
                        ? "朗诵方案与脚本已保留，可直接重试声音生成。"
                        : "朗诵方案未能完成，请重新生成。"
                    : "系统会分阶段保存朗诵方案、AI 参考声音和分析结果，刷新页面后仍可继续。"
                  : jobStatus === "queued"
                    ? "真人原声和正文已经保存，正在生成标准 AI 声音并等待分析服务。"
                    : jobStatus === "processing"
                      ? "正在分析标准 AI 声音的字符时间戳、停顿、时值、音高和能量，并生成控制谱。"
                      : jobStatus === "failed"
                        ? "本次没有生成控制谱。请根据错误提示检查正文、音频或服务配置后重新解析。"
                        : "标准 AI 声音既是控制谱的分析对象，也是最终播放给用户的示范声音。"}
              </p>
            </div>
            <button
              type="button"
              className="primary-button analyze-button"
              disabled={!canAnalyze}
              onClick={onAnalyze}
            >
              {isAnalyzing ? <span className="button-spinner" /> : <span aria-hidden="true">✦</span>}
              {isAnalyzing
                ? sourceType === "ai_tts" ? "正在生成并分析" : "正在生成并解析"
                : sourceType === "ai_tts"
                  ? aiRetryingAnalysis
                    ? "重新分析 AI 参考声音"
                    : aiRetryingAudio
                      ? "重新生成 AI 参考声音"
                      : work.aiTts?.status && !["graph_ready", "error"].includes(work.aiTts.status)
                        ? "继续生成 AI 参考朗诵并分析"
                        : work.aiTts?.status === "graph_ready"
                          ? "重新生成 AI 参考朗诵并分析"
                          : "生成 AI 参考朗诵并分析"
                : jobStatus === "failed" || jobStatus === "succeeded"
                  ? "重新生成标准声音并解析"
                  : "生成标准 AI 声音并解析"}
            </button>
          </div>
          {sourceType === "human_reference" && !work.referenceAudio ? (
            <p className="analysis-requirement" role="status">
              请先上传真人参考朗诵，系统将先统一音色，再根据标准 AI 声音生成情感图谱。
            </p>
          ) : !hasWorkInfo ? (
            <p className="analysis-requirement" role="status">
              请先填写作品名称和完整正文。
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function EditorStage({
  work,
  currentMs,
  activeTokenId,
  timeline,
  onSaveSentence,
  onPlaySentence,
  onVisualsChange,
  onBack,
  onSave,
  onContinue,
}: {
  work: RecitationWork;
  currentMs: number;
  activeTokenId?: string;
  timeline?: AudioTimeline;
  onSaveSentence: (sentence: RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onVisualsChange: (visuals: WorkVisualBundle) => void;
  onBack: () => void;
  onSave: () => void;
  onContinue: () => void;
}) {
  const spec = work.controlSpec;
  const [failedHeroImageUrl, setFailedHeroImageUrl] = useState<string>();
  const [tokenEditor, setTokenEditor] = useState<{
    sentenceId: string;
    tokenIndex: number;
    x: number;
    y: number;
  }>();
  const [visualEditor, setVisualEditor] = useState<{ kind: VisualAssetKind; sceneId?: string }>();
  const [curveDrafts, setCurveDrafts] = useState<Record<string, RecitationSentence>>({});
  if (!spec) return null;
  const canPublish = Boolean((work.standardAiAudio ?? work.aiDemoAudio)?.timeline);
  const active = activeSentenceAt(spec.sentences, timeline, currentMs);
  const heroAsset = work.visuals?.heroAsset?.url ? work.visuals.heroAsset : undefined;
  const showHeroImage = Boolean(heroAsset?.url && heroAsset.url !== failedHeroImageUrl);
  const sceneSpecs = work.visuals?.sceneSpecs ?? [];
  const sceneSpecsBySentenceId = mapSceneSpecsToSentences(sceneSpecs, spec.sentences);
  const sceneAssetsBySentenceId = mapSceneAssetsToSentences(work.visuals, spec.sentences);
  const sentenceFor = (sentence: RecitationSentence) => curveDrafts[sentence.id] ?? sentence;
  const selectedSentence = tokenEditor
    ? curveDrafts[tokenEditor.sentenceId]
      ?? spec.sentences.find((sentence) => sentence.id === tokenEditor.sentenceId)
    : undefined;
  const selectedToken = selectedSentence?.tokens.find((token) => token.index === tokenEditor?.tokenIndex);
  const selectedFocused = Boolean(selectedSentence && selectedToken && focusSet(selectedSentence).has(selectedToken.index));
  const selectedProlong = Boolean(selectedSentence && selectedToken && prolongFor(selectedSentence, selectedToken.index));
  const selectedPause = selectedSentence && selectedToken ? pauseAfter(selectedSentence, selectedToken.index) : undefined;
  const tokenPosition = selectedSentence && selectedToken
    ? selectedSentence.tokens.findIndex((token) => token.index === selectedToken.index)
    : -1;
  const adjacentHasPunctuation = Boolean(selectedSentence && tokenPosition >= 0 && (
    punctuationOnly(selectedSentence.tokens[tokenPosition]?.char ?? "")
    || punctuationOnly(selectedSentence.tokens[tokenPosition + 1]?.char ?? "")
  ));
  const isLastSpokenToken = Boolean(selectedSentence && selectedToken
    && selectedSentence.tokens.filter((token) => !punctuationOnly(token.char)).at(-1)?.index === selectedToken.index);

  const previewSentenceEdit = (sentence: RecitationSentence) => {
    setCurveDrafts((current) => ({ ...current, [sentence.id]: sentence }));
  };
  const discardSentenceDraft = (sentenceId: string) => {
    setCurveDrafts((current) => {
      if (!current[sentenceId]) return current;
      const copy = { ...current };
      delete copy[sentenceId];
      return copy;
    });
  };
  const closeInlineEditor = () => {
    const sentenceId = tokenEditor?.sentenceId;
    setTokenEditor(undefined);
    if (sentenceId) discardSentenceDraft(sentenceId);
  };
  const openTokenEditor = (
    sentence: RecitationSentence,
    token: TimedToken,
    anchor: HTMLElement,
  ) => {
    if (tokenEditor?.sentenceId && tokenEditor.sentenceId !== sentence.id) {
      discardSentenceDraft(tokenEditor.sentenceId);
    }
    const rect = anchor.getBoundingClientRect();
    setTokenEditor({
      sentenceId: sentence.id,
      tokenIndex: token.index,
      x: Math.min(window.innerWidth - 312, Math.max(12, rect.left + rect.width / 2 - 145)),
      y: Math.min(window.innerHeight - 270, rect.bottom + 12),
    });
  };
  const commitSentenceEdit = (sentence: RecitationSentence) => {
    setTokenEditor(undefined);
    setCurveDrafts((current) => {
      const copy = { ...current };
      delete copy[sentence.id];
      return copy;
    });
    onSaveSentence(sentence);
  };
  const previewCurvePoint = (
    sentence: RecitationSentence,
    tokenIndex: number,
    visualLevel: number,
    commit: boolean,
  ) => {
    setCurveDrafts((current) => {
      const nextDrafts = { ...current };
      if (tokenEditor?.sentenceId && tokenEditor.sentenceId !== sentence.id) {
        delete nextDrafts[tokenEditor.sentenceId];
      }
      const base = current[sentence.id] ?? sentence;
      nextDrafts[sentence.id] = {
        ...base,
        prosodyPointOverrides: upsertProsodyPointOverride(
          base.prosodyPointOverrides ?? [],
          tokenIndex,
          visualLevel,
        ),
      };
      return nextDrafts;
    });
    if (commit) {
      setTokenEditor({
        sentenceId: sentence.id,
        tokenIndex: -1,
        x: Math.max(12, Math.min(window.innerWidth - 312, window.innerWidth / 2 - 145)),
        y: Math.max(76, Math.min(window.innerHeight - 270, window.innerHeight / 2 - 130)),
      });
    }
  };
  const cancelCurvePoint = (
    sentence: RecitationSentence,
    tokenIndex: number,
    visualLevel: number,
    wasOverridden: boolean,
  ) => {
    setCurveDrafts((current) => {
      const base = current[sentence.id] ?? sentence;
      const existing = base.prosodyPointOverrides ?? [];
      const prosodyPointOverrides = wasOverridden
        ? upsertProsodyPointOverride(existing, tokenIndex, visualLevel)
        : existing.filter((point) => point.tokenIndex !== tokenIndex);
      return {
        ...current,
        [sentence.id]: {
          ...base,
          prosodyPointOverrides: prosodyPointOverrides.length ? prosodyPointOverrides : undefined,
        },
      };
    });
  };
  return (
    <section className="stage editor-stage inline-paper-editor">
      <div className="inline-editor-toolbar" data-export-exclude="true">
        <div>
          <p className="eyebrow">02 · 直接编辑作品纸面</p>
          <strong>点文字改标记，拖曲线点改语势，点图片即可替换</strong>
        </div>
        <div className="heading-actions">
          <button type="button" className="text-button" onClick={onBack}>返回作品资料</button>
          <button type="button" className="secondary-button" onClick={onSave}>保存草稿</button>
          <button type="button" className="primary-button" onClick={onContinue} disabled={!canPublish}>
            {canPublish ? "进入发布预览" : "标准声音尚未就绪"} <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <ViewerScaleWrapper>
        <div className="viewer-shell editor-paper-shell">
          <div className="viewer-paper editable-viewer-paper">
            <section className={`viewer-hero ${showHeroImage ? "has-generated-hero" : "uses-fallback-hero"}`}>
              {showHeroImage && heroAsset ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="viewer-hero-image"
                  src={heroAsset.url}
                  alt={`${work.title}作品主视觉`}
                  onError={() => setFailedHeroImageUrl(heroAsset.url)}
                />
              ) : <div className="viewer-hero-art" aria-hidden="true" />}
              <button
                type="button"
                className="hero-visual-edit-hotspot"
                data-export-exclude="true"
                onClick={() => setVisualEditor({ kind: "hero" })}
              >
                <span>编辑作品主视觉</span>
                <small>替换 · 裁切 · 重生成</small>
              </button>
              <div className="viewer-hero-inner">
                <div className={`viewer-title-row ${showHeroImage ? "generated-hero-title-row" : ""}`}>
                  <div className={showHeroImage ? "visually-hidden" : "viewer-title-block"}>
                    <p className="viewer-title-kicker"><span aria-hidden="true" />朗诵情感图谱</p>
                    <h1>{work.title}</h1>
                    {work.author ? <p className="viewer-author">作者 · {work.author}</p> : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="viewer-content">
              <div className="legend viewer-legend inline-edit-legend" aria-label="编辑说明">
                <span><b className="legend-focus-char">字</b> 点击正文编辑</span>
                <span><b>↕</b> 拖动圆点调曲线</span>
                <span><b>图</b> 点击插图替换</span>
                <span>所有人工修改会标记为图音已调整</span>
              </div>
              <div className="viewer-graph-list">
                {spec.sentences.map((sentence, sentenceIndex) => {
                  const displaySentence = sentenceFor(sentence);
                  const isActive = active?.id === sentence.id && currentMs > 0;
                  const sceneAsset = sceneAssetsBySentenceId.get(sentence.id);
                  const sceneSpec = sceneSpecsBySentenceId.get(sentence.id);
                  return (
                    <div className="viewer-sentence-wrap" key={sentence.id}>
                      <GraphSentence
                        sentence={displaySentence}
                        editing
                        active={isActive}
                        activeTokenId={isActive ? activeTokenId : undefined}
                        onPlay={timeline ? () => onPlaySentence(sentence) : undefined}
                        onTokenEdit={(token, anchor) => openTokenEditor(sentence, token, anchor)}
                        onPointChange={(tokenIndex, level, commit) => previewCurvePoint(sentence, tokenIndex, level, commit)}
                        onPointCancel={(tokenIndex, level, wasOverridden) => cancelCurvePoint(
                          sentence,
                          tokenIndex,
                          level,
                          wasOverridden,
                        )}
                        onSceneImageEdit={() => setVisualEditor({ kind: "scene", sceneId: sceneSpec?.sceneId ?? sentence.id })}
                        viewerSceneImageUrl={sceneAsset?.url}
                        viewerSceneAlt={`${sentence.text}的意境图`}
                        viewerSceneImagePriority={sentenceIndex === 0}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </ViewerScaleWrapper>

      {tokenEditor && selectedSentence && selectedToken ? (
        <div
          className="token-inline-popover"
          data-export-exclude="true"
          style={{ left: tokenEditor.x, top: tokenEditor.y }}
          role="dialog"
          aria-label={`编辑“${selectedToken.char}”`}
        >
          <div className="token-inline-heading">
            <strong>{selectedToken ? `“${selectedToken.char}”的朗诵标记` : "语势曲线已调整"}</strong>
            <button type="button" onClick={closeInlineEditor} aria-label="关闭并放弃本句未保存修改">×</button>
          </div>
          {selectedToken ? <div className="token-inline-actions">
            <button
              type="button"
              className={selectedFocused ? "chosen" : ""}
              onClick={() => previewSentenceEdit(toggleSentenceFocus(selectedSentence, selectedToken))}
            >{selectedFocused ? "取消重音" : "设为重音"}</button>
            <button
              type="button"
              className={selectedProlong ? "chosen" : ""}
              onClick={() => previewSentenceEdit(toggleSentenceProlong(selectedSentence, selectedToken))}
            >{selectedProlong ? "取消拖音" : "添加拖音 ——"}</button>
            <button
              type="button"
              disabled={adjacentHasPunctuation}
              onClick={() => previewSentenceEdit(cycleSentencePause(selectedSentence, selectedToken))}
              title={adjacentHasPunctuation ? "原文标点已承担停连提示" : undefined}
            >{adjacentHasPunctuation ? "原文已有标点" : selectedPause?.type === "short" ? "短停 / → 长停 ///" : selectedPause?.type === "long" ? "移除长停 ///" : "添加短停 /"}</button>
          </div> : null}
          {selectedToken && isLastSpokenToken ? (
            <div className="token-inline-ending">
              <span>句尾语调</span>
              {editableEndingOptions.map((type) => (
                <button
                  type="button"
                  key={type}
                  className={selectedSentence.endingIntonation.type === type ? "chosen" : ""}
                  onClick={() => previewSentenceEdit(setSentenceEnding(selectedSentence, type))}
                >{type === "rising" ? "↗" : "↘"}</button>
              ))}
            </div>
          ) : null}
          <div className="token-inline-footer">
            <button type="button" className="token-inline-more" onClick={closeInlineEditor}>取消</button>
            <button type="button" className="token-inline-save" onClick={() => commitSentenceEdit(selectedSentence)}>保存本句</button>
          </div>
        </div>
      ) : tokenEditor && selectedSentence ? (
        <div
          className="token-inline-popover curve-save-popover"
          data-export-exclude="true"
          style={{ left: tokenEditor.x, top: tokenEditor.y }}
          role="dialog"
          aria-label="保存语势曲线"
        >
          <div className="token-inline-heading">
            <strong>语势曲线已调整</strong>
            <button type="button" onClick={closeInlineEditor} aria-label="关闭并放弃本句未保存曲线修改">×</button>
          </div>
          <p>拖动只改变教学曲线，不会改写声学事实。</p>
          <div className="token-inline-footer">
            <button type="button" className="token-inline-more" onClick={closeInlineEditor}>取消</button>
            <button type="button" className="token-inline-save" onClick={() => commitSentenceEdit(selectedSentence)}>保存本句</button>
          </div>
        </div>
      ) : null}

      {visualEditor ? (
        <WorkVisualPanel
          workId={work.id}
          title={work.title}
          author={work.author}
          compact
          initialKind={visualEditor.kind}
          initialSceneId={visualEditor.sceneId}
          onClose={() => setVisualEditor(undefined)}
          onVisualsChange={onVisualsChange}
        />
      ) : null}
    </section>
  );
}

function PublishStage({
  work,
  onBack,
  onPreview,
  onPublish,
}: {
  work: RecitationWork;
  onBack: () => void;
  onPreview: () => void;
  onPublish: () => void;
}) {
  const spec = work.controlSpec;
  const standardAudio = work.standardAiAudio ?? work.aiDemoAudio;
  if (!spec || !standardAudio) return null;
  return (
    <section className="stage publish-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">03 · 发布作品</p>
          <h1>把创作参数收起来，只把“看得懂、听得到”交给用户</h1>
          <p className="stage-lead">
            发布会冻结当前控制谱、标准 AI 音频和时间轴。后续修改草稿，不会改变已经分享的版本。
          </p>
        </div>
        <span className="ready-badge"><i /> 准备发布</span>
      </div>

      <div className="publish-grid">
        <div className="paper-card release-card">
          <div className="release-cover">
            <span className="cover-kicker">朗诵情感图谱</span>
            <h2>{work.title}</h2>
            <p>{work.author}</p>
            <div className="cover-arc" aria-hidden="true">
              <i /><i /><i />
            </div>
          </div>
          <div className="release-details">
            <p className="eyebrow">发布版本</p>
            <h3>{work.title} · v1</h3>
            <div className="slug-box">
              <span>稳定分享地址</span>
              <code>/works/{work.slug}</code>
            </div>
          </div>
        </div>

        <div className="paper-card publish-checklist">
          <p className="eyebrow">发布检查</p>
          <h2>作品包完整</h2>
          {[
            ["正文与控制谱一致", "分析时已逐字校验"],
            ["控制谱无阻塞错误", "当前版本已确认"],
            ["示范音频可播放", "播放时间轴已就绪"],
            ["字符时间轴完整", "逐字高亮已就绪"],
            [
              "声音与图谱关系已标明",
              work.audioSyncStatus === "synced" ? "当前完全同源" : "图谱已修改，声音可能存在差异",
            ],
          ].map(([title, detail]) => (
            <div className="check-row" key={title}>
              <span>✓</span>
              <p><strong>{title}</strong><small>{detail}</small></p>
            </div>
          ))}
          <div className="publish-actions">
            <button type="button" className="secondary-button" onClick={onPreview}>
              先看用户页面
            </button>
            <button type="button" className="primary-button publish-button" onClick={onPublish}>
              发布作品 <span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>
      </div>
      <button type="button" className="text-button publish-back" onClick={onBack}>← 返回编辑图谱</button>
    </section>
  );
}

function WorkLibrary({
  open,
  loading,
  query,
  items,
  currentWorkId,
  onClose,
  onQuery,
  onNew,
  onOpen,
  onDelete,
  deletingWorkId,
}: {
  open: boolean;
  loading: boolean;
  query: string;
  items: WorkSummary[];
  currentWorkId: string;
  onClose: () => void;
  onQuery: (value: string) => void;
  onNew: () => void;
  onOpen: (workId: string) => void;
  onDelete: (work: WorkSummary) => void;
  deletingWorkId?: string;
}) {
  if (!open) return null;
  return (
    <div className="work-library-backdrop">
      <button
        type="button"
        className="work-library-scrim"
        onClick={onClose}
        aria-label="关闭作品库"
      />
      <aside className="work-library" role="dialog" aria-modal="true" aria-labelledby="work-library-title">
        <div className="work-library-heading">
          <div>
            <p className="eyebrow">创作端 · 云端作品</p>
            <h2 id="work-library-title">作品库</h2>
            <p>打开任何已保存作品，正文、音频、图谱与分析结果会一起恢复。</p>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭作品库">×</button>
        </div>
        <div className="work-library-actions">
          <label className="work-library-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="搜索作品名称或作者"
            />
          </label>
          <button type="button" className="primary-button work-new-button" onClick={onNew}>＋ 新建作品</button>
        </div>
        <div className="work-list" aria-busy={loading}>
          {loading ? <div className="work-list-message">正在读取作品库…</div> : null}
          {!loading && !items.length ? (
            <div className="work-list-empty">
              <span>卷</span>
              <strong>{query ? "没有找到匹配的作品" : "还没有已保存作品"}</strong>
              <p>{query ? "换一个名称或作者试试。" : "新建作品并保存后，会出现在这里。"}</p>
            </div>
          ) : null}
          {items.map((item) => {
            const current = item.id === currentWorkId;
            return (
              <article className={`work-list-item ${current ? "current" : ""}`} key={item.id}>
                <span className="work-list-monogram">{Array.from(item.title.trim())[0] ?? "声"}</span>
                <div className="work-list-copy">
                  <div className="work-list-title-row">
                    <strong>{item.title}</strong>
                    {current ? <span className="current-work-badge">当前</span> : null}
                  </div>
                  <p>{item.author || "未填写作者"}</p>
                  <div className="work-list-meta">
                    <span className={`work-state-badge state-${item.status}`}>{workStatusLabel(item)}</span>
                    {item.hasStandardAudio ? <span>标准声音</span> : item.hasReferenceAudio ? <span>真人音频</span> : null}
                    <span>{formatUpdatedTime(item.updatedAt)} 更新</span>
                  </div>
                </div>
                <div className="work-list-buttons">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onOpen(item.id)}
                    disabled={current}
                  >
                    {current ? "正在编辑" : "打开编辑"}
                  </button>
                  {item.hasPublishedVersion ? (
                    <a
                      className="text-button"
                      href={`/?work=${encodeURIComponent(item.id)}&view=1`}
                      target="_blank"
                      rel="noreferrer"
                    >查看发布版 ↗</a>
                  ) : null}
                  <button
                    type="button"
                    className="text-button work-delete-button"
                    onClick={() => onDelete(item)}
                    disabled={deletingWorkId === item.id}
                  >{deletingWorkId === item.id ? "正在删除" : "删除作品"}</button>
                </div>
              </article>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function DeleteWorkDialog({
  work,
  deleting,
  current,
  hasUnsavedChanges,
  onCancel,
  onConfirm,
}: {
  work: WorkSummary | null;
  deleting: boolean;
  current: boolean;
  hasUnsavedChanges: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!work) return null;
  return (
    <div className="switch-work-dialog-backdrop">
      <section className="switch-work-dialog delete-work-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-work-title">
        <span className="switch-work-icon" aria-hidden="true">删</span>
        <p className="eyebrow">永久删除作品</p>
        <h2 id="delete-work-title">确定删除《{work.title}》吗？</h2>
        <p>
          正文、参考朗诵、标准 AI 音频、分析结果、控制谱和发布版都会永久删除，且无法恢复。
          {current && hasUnsavedChanges ? " 当前尚未保存的修改也会一起丢失。" : ""}
        </p>
        <div className="switch-work-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={deleting}>取消</button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={deleting}>
            {deleting ? <span className="button-spinner" aria-hidden="true" /> : null}
            {deleting ? "正在删除" : "永久删除"}
          </button>
        </div>
      </section>
    </div>
  );
}

function SwitchWorkDialog({
  open,
  saving,
  onCancel,
  onDiscard,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (!open) return null;
  return (
    <div className="switch-work-dialog-backdrop">
      <section className="switch-work-dialog" role="alertdialog" aria-modal="true" aria-labelledby="switch-work-title">
        <span className="switch-work-icon" aria-hidden="true">未</span>
        <p className="eyebrow">切换作品</p>
        <h2 id="switch-work-title">当前修改还没有保存</h2>
        <p>现在切换会丢失本次修改。你可以先把整份作品保存到云端，再继续打开目标作品。</p>
        <div className="switch-work-actions">
          <button type="button" className="text-button" onClick={onCancel} disabled={saving}>取消</button>
          <button type="button" className="secondary-button" onClick={onDiscard} disabled={saving}>放弃修改并打开</button>
          <button type="button" className="primary-button" onClick={onSave} disabled={saving}>
            {saving ? <span className="button-spinner" aria-hidden="true" /> : null}
            {saving ? "正在保存" : "保存并打开"}
          </button>
        </div>
      </section>
    </div>
  );
}

function SourceChangeDialog({
  open,
  saving,
  kind,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  saving: boolean;
  kind: DestructiveChangeKind;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  const copy = kind === "source"
    ? {
      eyebrow: "保存正文变更",
      title: "这会让现有声音与图谱失效",
      detail: "正文已经改变。保存后，旧参考音频、标准 AI 音频、分析结果和发布状态会归档，需要上传匹配的新朗诵并重新解析。",
      confirm: "确认保存并重置图音",
    }
    : kind === "reference"
      ? {
        eyebrow: "替换参考朗诵",
        title: "新音频需要重新生成整套图谱",
        detail: "保存新参考朗诵后，当前标准 AI 音频、分析结果、控制谱和发布状态会归档，并以新音频重新生成。",
        confirm: "确认替换参考朗诵",
      }
      : {
        eyebrow: "移除参考朗诵",
        title: "这会清除当前图音关联",
        detail: "保存后，当前参考音频、标准 AI 音频、分析结果、控制谱和发布状态会归档；重新上传参考朗诵后才能再次分析。",
        confirm: "确认移除参考朗诵",
      };
  return (
    <div className="switch-work-dialog-backdrop">
      <section className="switch-work-dialog destructive-save-dialog" role="alertdialog" aria-modal="true" aria-labelledby="source-change-title">
        <span className="switch-work-icon" aria-hidden="true">变</span>
        <p className="eyebrow">{copy.eyebrow}</p>
        <h2 id="source-change-title">{copy.title}</h2>
        <p>{copy.detail}</p>
        <div className="switch-work-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>取消</button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={saving}>
            {saving ? <span className="button-spinner" aria-hidden="true" /> : null}
            {saving ? "正在保存" : copy.confirm}
          </button>
        </div>
      </section>
    </div>
  );
}

function StudioView({
  work,
  step,
  highestStep,
  analysisJobStatus,
  analysisStatus,
  currentMs,
  activeTokenId,
  timeline,
  onStep,
  onWorkChange,
  onReferenceFile,
  onDeleteReference,
  onAudioSourceTypeChange,
  onAnalyze,
  onSaveSentence,
  onPlaySentence,
  onVisualsChange,
  onBackToMaterials,
  onSave,
  onPublishStage,
  onPreview,
  onPublish,
  saveState,
  lastSavedAt,
  onOpenLibrary,
  onSaveWork,
}: {
  work: RecitationWork;
  step: WorkflowStep;
  highestStep: WorkflowStep;
  analysisJobStatus: AnalysisJobStatus;
  analysisStatus: string;
  currentMs: number;
  activeTokenId?: string;
  timeline?: AudioTimeline;
  onStep: (step: WorkflowStep) => void;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAudioSourceTypeChange: (source: AudioSourceType) => void;
  onAnalyze: () => void;
  onSaveSentence: (sentence: RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onVisualsChange: (visuals: WorkVisualBundle) => void;
  onBackToMaterials: () => void;
  onSave: () => void;
  onPublishStage: () => void;
  onPreview: () => void;
  onPublish: () => void;
  saveState: SaveState;
  lastSavedAt?: string;
  onOpenLibrary: () => void;
  onSaveWork: () => void;
}) {
  const saveLabel = saveState === "saving"
    ? "保存中"
    : saveState === "failed"
      ? "保存失败，点击重试"
      : saveState === "dirty"
        ? "有未保存修改"
        : saveState === "saved"
          ? `已保存 ${formatSavedTime(lastSavedAt)}`
          : "未保存";
  return (
    <div className={`studio-shell ${step === 2 ? "studio-shell-paper-editor" : ""}`}>
      {step !== 2 ? <aside className="studio-sidebar">
        <button type="button" className="work-summary" onClick={onOpenLibrary} aria-label="打开作品库">
          <span className="work-monogram">{Array.from(work.title.trim())[0] ?? "声"}</span>
          <div>
            <small>作品库 · 正在创作</small>
            <strong>{work.title || "未命名作品"}</strong>
          </div>
          <span className="work-library-chevron" aria-hidden="true">›</span>
        </button>
        <WorkflowRail step={step} highestStep={highestStep} onStep={onStep} />
        <div className="sidebar-footer">
          <span className={`save-status save-${saveState}`}>
            <i aria-hidden="true" />{saveLabel}
          </span>
          <button
            type="button"
            className="save-button"
            onClick={onSaveWork}
            disabled={saveState === "saving" || saveState === "saved"}
          >
            {saveState === "saving" ? "保存中…" : "保存作品"}
          </button>
        </div>
      </aside> : null}

      <div className="studio-main">
        {step === 1 ? (
          <MaterialStage
            work={work}
            jobStatus={analysisJobStatus}
            analysisStatus={analysisStatus}
            onWorkChange={onWorkChange}
            onReferenceFile={onReferenceFile}
            onDeleteReference={onDeleteReference}
            onAudioSourceTypeChange={onAudioSourceTypeChange}
            onAnalyze={onAnalyze}
          />
        ) : null}
        {step === 2 ? (
          <EditorStage
            work={work}
            currentMs={currentMs}
            activeTokenId={activeTokenId}
            timeline={timeline}
            onSaveSentence={onSaveSentence}
            onPlaySentence={onPlaySentence}
            onVisualsChange={onVisualsChange}
            onBack={onBackToMaterials}
            onSave={onSave}
            onContinue={onPublishStage}
          />
        ) : null}
        {step === 3 ? (
          <PublishStage
            work={work}
            onBack={() => onStep(2)}
            onPreview={onPreview}
            onPublish={onPublish}
          />
        ) : null}
      </div>
    </div>
  );
}

function ViewerView({
  work,
  currentMs,
  activeTokenId,
  isPlaying,
  onPlayAll,
  onPlaySentence,
  onSeekSentence,
  exportTargetRef,
  exporting,
  onExport,
}: {
  work: RecitationWork;
  currentMs: number;
  activeTokenId?: string;
  isPlaying: boolean;
  onPlayAll: () => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSeekSentence: (sentence: RecitationSentence) => void;
  exportTargetRef: RefObject<HTMLDivElement | null>;
  exporting: boolean;
  onExport: () => void;
}) {
  const heroAsset = work.visuals?.heroAsset?.url ? work.visuals.heroAsset : undefined;
  const [failedHeroImageUrl, setFailedHeroImageUrl] = useState<string>();
  const showHeroImage = Boolean(heroAsset?.url && heroAsset.url !== failedHeroImageUrl);
  const spec = work.controlSpec;
  const standardAudio = work.standardAiAudio ?? work.aiDemoAudio;
  if (!spec || !standardAudio?.timeline) {
    return (
      <div className="viewer-shell viewer-empty-shell">
        <section className="viewer-empty">
          <span aria-hidden="true">声</span>
          <p className="eyebrow">用户观看端</p>
          <h1>作品还没有可播放的标准 AI 朗诵</h1>
          <p>请先在创作端生成标准 AI 声音、完成解析并确认情感图谱。</p>
        </section>
      </div>
    );
  }
  const active = activeSentenceAt(spec.sentences, standardAudio.timeline, currentMs);
  const visuals = work.visuals;
  const sceneAssetsBySentenceId = mapSceneAssetsToSentences(visuals, spec.sentences);
  const activeSentenceIndex = Math.max(0, spec.sentences.findIndex((sentence) => sentence.id === active?.id));

  return (
    <ViewerScaleWrapper artboardRef={exportTargetRef}>
    <div className="viewer-shell">
      <div className="viewer-paper">
      <section className={`viewer-hero ${showHeroImage ? "has-generated-hero" : "uses-fallback-hero"}`}>
        {showHeroImage && heroAsset ? (
          // Generated Hero assets are reviewed, persisted and served from the same site.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="viewer-hero-image"
            src={heroAsset.url}
            alt={`${work.title}${work.author ? `，${work.author}` : ""}，朗诵情感图谱主视觉`}
            decoding="async"
            fetchPriority="high"
            onError={() => setFailedHeroImageUrl(heroAsset.url)}
          />
        ) : <div className="viewer-hero-art" aria-hidden="true" />}
        <div className="viewer-hero-inner">
          <div className="viewer-breadcrumb">
            <span>作品库</span><b>›</b><strong>{work.title}</strong>
          </div>
          <div className={`viewer-title-row ${showHeroImage ? "generated-hero-title-row" : ""}`}>
            <div className={showHeroImage ? "visually-hidden" : "viewer-title-block"}>
              <p className="viewer-title-kicker"><span aria-hidden="true" />朗诵情感图谱</p>
              <h1>{work.title}</h1>
              {work.author ? <p className="viewer-author">作者 · {work.author}</p> : null}
            </div>
            <div className="viewer-hero-actions" data-export-exclude="true">
              <button type="button" className="export-image-button" onClick={onExport} disabled={exporting}>
                <span aria-hidden="true">⇩</span>
                {exporting ? "正在生成图片" : "导出本页图片"}
              </button>
              <button type="button" className={`hero-play ${isPlaying ? "playing" : ""}`} onClick={onPlayAll}>
                <span>{isPlaying ? "Ⅱ" : "▶"}</span>
                <div>
                  <strong>{isPlaying ? "暂停示范" : "播放整篇"}</strong>
                  <small>{isPlaying ? "正在逐字跟随播放" : `${formatTime(standardAudio.durationMs)} · 逐字跟随`}</small>
                </div>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="viewer-content">
        <div className="legend viewer-legend" aria-label="图谱符号说明">
          <span><b className="legend-focus-char">春</b> 红字：表达焦点</span>
          <span><b>/</b> 短停</span>
          <span><b>{"///"}</b> 长停</span>
          <span><b className="legend-prolong">——</b> 拖音</span>
          <span><b>↗ ↘</b> 句尾语调</span>
          <span>
            <svg className="legend-curve" viewBox="0 0 34 12" aria-hidden="true">
              <path
                d="M2 9 C 8 9 9 3 15 3 S 24 8 32 5"
                fill="none"
                stroke="#a93627"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            曲线：宏观语势
          </span>
        </div>

        <div className="viewer-graph-list">
          {spec.sentences.map((sentence, sentenceIndex) => {
            const isActive = active?.id === sentence.id && currentMs > 0;
            const sceneAsset = sceneAssetsBySentenceId.get(sentence.id);
            return (
              <div className="viewer-sentence-wrap" key={sentence.id}>
                <GraphSentence
                  sentence={sentence}
                  active={isActive}
                  activeTokenId={isActive ? activeTokenId : undefined}
                  onSelect={() => onSeekSentence(sentence)}
                  onPlay={() => onPlaySentence(sentence)}
                  viewerSceneImageUrl={sceneAsset?.url}
                  viewerSceneAlt={`${sentence.text}的意境图`}
                  viewerSceneImagePriority={sentenceIndex === 0 || sentenceIndex === activeSentenceIndex || sentenceIndex === activeSentenceIndex + 1}
                />
              </div>
            );
          })}
        </div>

      </section>
      </div>
    </div>
    </ViewerScaleWrapper>
  );
}

export function RecitationStudio() {
  const [mode, setMode] = useState<ProductMode>("studio");
  const [work, setWork] = useState<RecitationWork>(() => createEmptyWork());
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [isWorkDirty, setIsWorkDirty] = useState(true);
  const [controlSpecDirty, setControlSpecDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("unsaved");
  const [lastSavedAt, setLastSavedAt] = useState<string>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryItems, setLibraryItems] = useState<WorkSummary[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [workPendingDelete, setWorkPendingDelete] = useState<WorkSummary | null>(null);
  const [deletingWorkId, setDeletingWorkId] = useState<string>();
  const [pendingWorkAction, setPendingWorkAction] = useState<PendingWorkAction | null>(null);
  const [sourceChangeConfirmOpen, setSourceChangeConfirmOpen] = useState(false);
  const [destructiveChangeKind, setDestructiveChangeKind] = useState<DestructiveChangeKind>("source");
  const savedSourceTextRef = useRef("");
  const savedUpdatedAtRef = useRef<string | undefined>(undefined);
  const savedReferenceIdRef = useRef<string | undefined>(undefined);
  const savedHasDerivedAssetsRef = useRef(false);
  const removeSavedReferenceRef = useRef(false);
  const localReferenceUrlRef = useRef<string | undefined>(undefined);
  const pendingSaveRef = useRef<((saved?: RecitationWork) => void) | null>(null);
  const [step, setStep] = useState<WorkflowStep>(1);
  const [audioSource, setAudioSource] = useState<AudioSource>("reference");
  const [analysisJobStatus, setAnalysisJobStatus] = useState<AnalysisJobStatus>("idle");
  const [analysisStatus, setAnalysisStatus] = useState("等待参考朗诵");
  const [toast, setToast] = useState<string | null>(null);
  const [exportingImage, setExportingImage] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [segmentEndMs, setSegmentEndMs] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const viewerExportRef = useRef<HTMLDivElement>(null);
  const standardPlayback = work.standardAiAudio ?? work.aiDemoAudio;
  const activeTrack = audioSource === "reference" ? work.referenceAudio : standardPlayback;
  const analysisInFlight = analysisJobStatus === "queued" || analysisJobStatus === "processing";
  const highestStep = isWorkDirty || analysisInFlight ? 1 : highestAvailableStep(work);
  const hasDraftContent = Boolean(
    work.title.trim() || work.author?.trim() || work.sourceText.trim() || work.referenceAudio,
  );
  const hasUnsavedChanges = Boolean(referenceFile)
    || controlSpecDirty
    || (isWorkDirty && (!work.id.startsWith("draft-") || hasDraftContent));

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const resetPlaybackAndEditorState = useCallback(() => {
    audioRef.current?.pause();
    setCurrentMs(0);
    setIsPlaying(false);
    setSegmentEndMs(null);
    setPlaybackRate(1);
  }, []);

  const applyStoredWork = useCallback((stored: RecitationWork, published = false) => {
    if (localReferenceUrlRef.current) URL.revokeObjectURL(localReferenceUrlRef.current);
    localReferenceUrlRef.current = undefined;
    resetPlaybackAndEditorState();
    setWork(stored);
    setReferenceFile(null);
    setIsWorkDirty(false);
    setControlSpecDirty(false);
    setSaveState("saved");
    setLastSavedAt(stored.updatedAt);
    savedSourceTextRef.current = stored.sourceText;
    savedUpdatedAtRef.current = stored.updatedAt;
    savedReferenceIdRef.current = stored.referenceAudioOriginal?.id ?? stored.referenceAudio?.id;
    savedHasDerivedAssetsRef.current = Boolean(
      stored.standardAiAudio || stored.aiDemoAudio || stored.aiTts || stored.controlSpec || stored.publishedRevisionId,
    );
    removeSavedReferenceRef.current = false;
    const aiTtsStatus = stored.aiTts?.status;
    setAnalysisJobStatus(
      aiTtsStatus === "graph_ready"
        ? "succeeded"
        : aiTtsStatus === "error"
          ? "failed"
          : stored.analysisJobStatus ?? "idle",
    );
    if (published) {
      setMode("viewer");
      setAudioSource("standard");
      return;
    }
    setMode("studio");
    if (stored.controlSpec) {
      setStep(2);
      setAudioSource((stored.standardAiAudio ?? stored.aiDemoAudio)?.timeline ? "standard" : "reference");
      setAnalysisStatus("标准 AI 朗诵解析完成，声音与图谱同源");
    } else {
      setStep(1);
      setAudioSource(stored.audioSourceType === "ai_tts" && stored.standardAiAudio ? "standard" : "reference");
      setAnalysisStatus(
        stored.audioSourceType === "ai_tts"
          ? stored.aiTts?.error?.message ?? aiTtsStatusText(stored.aiTts?.status)
          : stored.standardAiAudio
          ? "标准 AI 声音已生成，等待完成分析"
          : stored.referenceAudio ? "真人参考朗诵已保存，可以开始生成与解析" : "等待参考朗诵",
      );
    }
  }, [resetPlaybackAndEditorState]);

  const loadStoredWork = useCallback(async (workId: string, published = false) => {
    const publishedQuery = published ? "?published=1" : "";
    const result = await apiJson<{ work: RecitationWork }>(
      await fetch(`/api/works/${encodeURIComponent(workId)}${publishedQuery}`),
    );
    applyStoredWork(result.work, published);
    const url = new URL(window.location.href);
    url.searchParams.set("work", result.work.id);
    if (published) url.searchParams.set("view", "1");
    else url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
    return result.work;
  }, [applyStoredWork]);

  /* eslint-disable react-hooks/set-state-in-effect -- URL loading is the external route synchronization boundary. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const workId = params.get("work");
    if (!workId) return;
    void loadStoredWork(workId, params.get("view") === "1")
      .catch((error) => showToast(error instanceof Error ? error.message : String(error)));
  // The URL-backed work is intentionally loaded only once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!libraryOpen) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setLibraryLoading(true);
      const params = new URLSearchParams({ limit: "60" });
      if (libraryQuery.trim()) params.set("q", libraryQuery.trim());
      void fetch(`/api/works?${params}`)
        .then((response) => apiJson<{ items: WorkSummary[] }>(response))
        .then((result) => { if (!cancelled) setLibraryItems(result.items); })
        .catch((error) => !cancelled && showToast(error instanceof Error ? error.message : String(error)))
        .finally(() => { if (!cancelled) setLibraryLoading(false); });
    }, libraryQuery ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [libraryOpen, libraryQuery, showToast]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const update = () => {
      const nextMs = audio.currentTime * 1000;
      setCurrentMs(nextMs);
      if (segmentEndMs !== null && nextMs >= segmentEndMs - 25) {
        audio.pause();
        audio.currentTime = segmentEndMs / 1000;
        setCurrentMs(segmentEndMs);
        setSegmentEndMs(null);
      }
    };
    const playing = () => setIsPlaying(true);
    const paused = () => setIsPlaying(false);
    const ended = () => { setIsPlaying(false); setSegmentEndMs(null); };
    audio.addEventListener("timeupdate", update);
    audio.addEventListener("play", playing);
    audio.addEventListener("pause", paused);
    audio.addEventListener("ended", ended);
    return () => {
      audio.removeEventListener("timeupdate", update);
      audio.removeEventListener("play", playing);
      audio.removeEventListener("pause", paused);
      audio.removeEventListener("ended", ended);
    };
  }, [segmentEndMs]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const nextMs = audio.currentTime * 1000;
        setCurrentMs(nextMs);
        if (segmentEndMs !== null && nextMs >= segmentEndMs - 25) {
          audio.pause();
          audio.currentTime = segmentEndMs / 1000;
          setCurrentMs(segmentEndMs);
          setSegmentEndMs(null);
          return;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, segmentEndMs]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.load();
    setCurrentMs(0);
    setSegmentEndMs(null);
  }, [activeTrack?.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [activeTrack?.id, playbackRate]);

  const activeSentence = useMemo(
    () => activeSentenceAt(work.controlSpec?.sentences ?? [], activeTrack?.timeline, currentMs),
    [activeTrack?.timeline, currentMs, work.controlSpec?.sentences],
  );
  const activeTokenId = activeSentence
    ? activeTokenAt(activeTrack?.timeline, currentMs)
    : undefined;

  const setWorkflowStep = (next: WorkflowStep) => {
    if (next > highestStep) return;
    setStep(next);
    if (next <= 2) {
      setAudioSource(work.controlSpec && standardPlayback?.timeline ? "standard" : "reference");
    }
    if (next === 3 && standardPlayback) setAudioSource("standard");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleWorkChange = (field: "title" | "author" | "sourceText", value: string) => {
    const sourceChanged = field === "sourceText" && value !== work.sourceText;
    const keepsLocalReference = Boolean(work.referenceAudio?.url.startsWith("blob:"));
    setIsWorkDirty(true);
    setSaveState(work.id.startsWith("draft-") ? "unsaved" : "dirty");
    setAnalysisJobStatus("idle");
    setControlSpecDirty(false);
    setAnalysisStatus(
      sourceChanged && work.audioSourceType === "ai_tts"
        ? "正文已修改，请重新生成 AI 参考朗诵"
        : sourceChanged && !keepsLocalReference
        ? "正文已修改，请重新上传匹配的参考朗诵"
        : work.referenceAudio ? "内容已修改，请重新解析" : "等待参考朗诵",
    );
    setWork((current) => ({
      ...current,
      [field]: value,
      ...(sourceChanged ? {
        status: "draft" as const,
        audioSyncStatus: "pending" as const,
        referenceAudio: current.referenceAudio?.url.startsWith("blob:")
          ? { ...current.referenceAudio, timeline: undefined }
          : undefined,
        referenceAudioOriginal: current.referenceAudio?.url.startsWith("blob:")
          ? current.referenceAudioOriginal
          : undefined,
        controlSpec: undefined,
        currentSpecVersionId: undefined,
        aiDemoAudio: undefined,
        standardAiAudio: undefined,
        aiTts: undefined,
        analysisPackage: undefined,
      } : {}),
    }));
    if (sourceChanged) {
      setStep(1);
      setAudioSource("reference");
    }
  };

  const handleAudioSourceTypeChange = (source: AudioSourceType) => {
    if (source === (work.audioSourceType ?? "human_reference")) return;
    setIsWorkDirty(true);
    setSaveState(work.id.startsWith("draft-") ? "unsaved" : "dirty");
    setAnalysisJobStatus("idle");
    setWork((current) => ({ ...current, audioSourceType: source }));
    setAudioSource(source === "ai_tts" && work.standardAiAudio ? "standard" : "reference");
    setAnalysisStatus(
      source === "ai_tts"
        ? work.aiTts?.error?.message ?? aiTtsStatusText(work.aiTts?.status)
        : work.referenceAudio ? "真人参考朗诵已保存，可以开始生成与解析" : "等待参考朗诵",
    );
  };

  const handleReferenceFile = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const durationMs = await readAudioDuration(url);
      if (localReferenceUrlRef.current) URL.revokeObjectURL(localReferenceUrlRef.current);
      localReferenceUrlRef.current = url;
      setReferenceFile(file);
      removeSavedReferenceRef.current = false;
      setIsWorkDirty(true);
      setSaveState(work.id.startsWith("draft-") ? "unsaved" : "dirty");
      setAnalysisJobStatus("idle");
      setControlSpecDirty(false);
      setAnalysisStatus("参考朗诵已就绪");
      setWork((current) => ({
        ...current,
        audioSourceType: "human_reference",
        status: "draft",
        audioSyncStatus: "pending",
        referenceAudio: {
          id: `local-${crypto.randomUUID()}`,
          kind: "reference",
          url,
          filename: file.name,
          mimeType: file.type || undefined,
          durationMs,
          provider: "upload",
          label: "待上传的优质参考朗诵",
        },
        referenceAudioOriginal: undefined,
        controlSpec: undefined,
        currentSpecVersionId: undefined,
        aiDemoAudio: undefined,
        standardAiAudio: undefined,
        analysisPackage: undefined,
      }));
      setStep(1);
      setAudioSource("reference");
      showToast(`${file.name} 已就绪；点击“生成标准 AI 声音并解析”后会真实上传`);
    } catch {
      URL.revokeObjectURL(url);
      showToast("无法读取这段音频，请换用 WAV、M4A 或 MP3 文件");
    }
  };

  const handleDeleteReference = () => {
    if (localReferenceUrlRef.current) URL.revokeObjectURL(localReferenceUrlRef.current);
    localReferenceUrlRef.current = undefined;
    audioRef.current?.pause();
    setReferenceFile(null);
    removeSavedReferenceRef.current = Boolean(savedReferenceIdRef.current);
    setIsWorkDirty(true);
    setSaveState(work.id.startsWith("draft-") ? "unsaved" : "dirty");
    setAnalysisJobStatus("idle");
    setControlSpecDirty(false);
    setAnalysisStatus("等待参考朗诵");
    setWork((current) => ({
      ...current,
      status: "draft",
      audioSyncStatus: "pending",
      referenceAudio: undefined,
      referenceAudioOriginal: undefined,
      controlSpec: undefined,
      currentSpecVersionId: undefined,
      aiDemoAudio: undefined,
      standardAiAudio: undefined,
      analysisPackage: undefined,
    }));
    setStep(1);
    setAudioSource("reference");
    showToast("参考朗诵已从当前草稿移除");
  };

  const persistReferenceFile = async (savedWork: RecitationWork) => {
    if (!referenceFile || !work.referenceAudio) return savedWork;
    const form = new FormData();
    form.set("reference_audio_file", referenceFile);
    form.set("duration_ms", String(work.referenceAudio.durationMs));
    form.set("expected_updated_at", savedWork.updatedAt);
    const result = await apiJson<{ work: RecitationWork }>(
      await fetch(`/api/works/${encodeURIComponent(savedWork.id)}/reference-audio`, {
        method: "POST",
        body: form,
      }),
    );
    if (localReferenceUrlRef.current) URL.revokeObjectURL(localReferenceUrlRef.current);
    localReferenceUrlRef.current = undefined;
    setReferenceFile(null);
    return result.work;
  };

  const persistWorkRecord = async () => {
    if (!work.title.trim() || !work.sourceText.trim()) {
      showToast("请先填写作品名称和完整正文");
      throw new Error("作品名称和完整正文不能为空。");
    }
    const result = await apiJson<{ work: RecitationWork }>(
      await fetch("/api/works", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(!work.id.startsWith("draft-") ? {
            work_id: work.id,
            expected_updated_at: savedUpdatedAtRef.current ?? work.updatedAt,
          } : {}),
          title: work.title.trim(),
          author: work.author?.trim() ?? "",
          full_text: work.sourceText,
          audio_source_type: work.audioSourceType ?? "human_reference",
        }),
      }),
    );
    setWork((current) => ({
      ...result.work,
      referenceAudio: current.referenceAudio?.url.startsWith("blob:")
        ? current.referenceAudio
        : result.work.referenceAudio,
      referenceAudioOriginal: result.work.referenceAudioOriginal,
      controlSpec: result.work.controlSpec ?? current.controlSpec,
      currentSpecVersionId: result.work.currentSpecVersionId ?? current.currentSpecVersionId,
      aiDemoAudio: result.work.aiDemoAudio,
      standardAiAudio: result.work.standardAiAudio,
      aiTts: result.work.aiTts,
    }));
    setIsWorkDirty(false);
    savedUpdatedAtRef.current = result.work.updatedAt;
    savedSourceTextRef.current = result.work.sourceText;
    const url = new URL(window.location.href);
    url.searchParams.set("work", result.work.id);
    url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
    return result.work;
  };

  const performSaveCurrentWork = async (confirmSourceChange = false) => {
    const sourceInvalidatesAssets = !work.id.startsWith("draft-")
      && savedSourceTextRef.current !== work.sourceText
      && Boolean(savedReferenceIdRef.current || savedHasDerivedAssetsRef.current);
    const referenceInvalidatesAssets = Boolean(
      referenceFile
      && savedReferenceIdRef.current
    );
    const removalInvalidatesAssets = Boolean(removeSavedReferenceRef.current && savedReferenceIdRef.current);
    if ((sourceInvalidatesAssets || referenceInvalidatesAssets || removalInvalidatesAssets) && !confirmSourceChange) {
      setDestructiveChangeKind(
        sourceInvalidatesAssets ? "source" : referenceInvalidatesAssets ? "reference" : "remove_reference",
      );
      setSourceChangeConfirmOpen(true);
      return;
    }
    setSaveState("saving");
    try {
      const metadataDirty = work.id.startsWith("draft-")
        || work.title.trim() !== work.title
        || savedSourceTextRef.current !== work.sourceText
        || isWorkDirty && !controlSpecDirty;
      let saved = metadataDirty
        ? await persistWorkRecord()
        : work;
      if (referenceFile) saved = await persistReferenceFile(saved);
      else if (removeSavedReferenceRef.current) {
        saved = (await apiJson<{ work: RecitationWork }>(
          await fetch(`/api/works/${encodeURIComponent(saved.id)}/reference-audio`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expected_updated_at: saved.updatedAt }),
          }),
        )).work;
      }
      if (controlSpecDirty && work.controlSpec) {
        saved = (await apiJson<{ work: RecitationWork }>(
          await fetch(`/api/works/${encodeURIComponent(saved.id)}/control-spec`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              control_spec: work.controlSpec,
              source: "human",
              expected_updated_at: saved.updatedAt,
            }),
          }),
        )).work;
      }
      setWork(saved);
      setIsWorkDirty(false);
      setSaveState("saved");
      setLastSavedAt(saved.updatedAt);
      savedSourceTextRef.current = saved.sourceText;
      savedUpdatedAtRef.current = saved.updatedAt;
      savedReferenceIdRef.current = saved.referenceAudioOriginal?.id ?? saved.referenceAudio?.id;
      savedHasDerivedAssetsRef.current = Boolean(
        saved.standardAiAudio || saved.aiDemoAudio || saved.aiTts || saved.controlSpec || saved.publishedRevisionId,
      );
      removeSavedReferenceRef.current = false;
      setControlSpecDirty(false);
      setSourceChangeConfirmOpen(false);
      setLibraryItems((items) => items.filter((item) => item.id !== saved.id));
      showToast("作品已完整保存到云端");
      const continuation = pendingSaveRef.current;
      pendingSaveRef.current = null;
      continuation?.(saved);
      return saved;
    } catch (error) {
      setSaveState("failed");
      pendingSaveRef.current = null;
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAiAnalyze = async () => {
    if (analysisJobStatus === "queued" || analysisJobStatus === "processing") return;
    if (!work.title.trim() || !work.sourceText.trim()) {
      showToast("请先填写作品名称和完整正文");
      return;
    }
    setAnalysisJobStatus("queued");
    setAnalysisStatus("正在保存作品并创建 AI 参考朗诵任务");
    try {
      const canReuseSavedWork = !work.id.startsWith("draft-")
        && !isWorkDirty
        && savedSourceTextRef.current === work.sourceText;
      setSaveState(canReuseSavedWork ? "saved" : "saving");
      const saved = canReuseSavedWork ? work : await persistWorkRecord();
      setWork(saved);
      setSaveState("saved");
      setLastSavedAt(saved.updatedAt);
      savedSourceTextRef.current = saved.sourceText;
      savedUpdatedAtRef.current = saved.updatedAt;

      const existing = saved.aiTts;
      let createResponse: Response;
      if (existing?.status === "error" && existing.jobId && existing.error?.code === "TTS_AUDIO_GENERATION_FAILED") {
        createResponse = await fetch(`/api/ai-tts-jobs/${encodeURIComponent(existing.jobId)}/retry-audio`, {
          method: "POST",
        });
      } else if (existing?.status === "error" && existing.jobId && existing.audioAssetId) {
        const retryPath = existing.error?.code === "LLM_INTERPRETATION_FAILED"
          ? "retry-interpretation"
          : "retry-analysis";
        createResponse = await fetch(`/api/ai-tts-jobs/${encodeURIComponent(existing.jobId)}/${retryPath}`, {
          method: "POST",
        });
      } else {
        createResponse = await fetch(`/api/works/${encodeURIComponent(saved.id)}/ai-tts-jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }
      const created = await apiJson<AiTtsJobPayload>(createResponse);
      if (!created.ai_tts_job_id) throw new Error("AI 参考朗诵任务创建失败：服务端没有返回任务编号。");
      const jobId = created.ai_tts_job_id;

      void generateWorkVisualAssets(saved.id, { type: "all" })
        .then((visuals) => {
          setWork((current) => current.id === saved.id ? { ...current, visuals } : current);
          showToast("作品视觉已同步生成");
        })
        .catch((visualError) => {
          const message = visualError instanceof Error ? visualError.message : String(visualError);
          showToast(`AI 朗诵继续；作品视觉生成未完成：${message}`);
        });

      setAnalysisJobStatus("processing");
      setAnalysisStatus(aiTtsStatusText(created.status));

      const deadline = Date.now() + 30 * 60 * 1000;
      let transientFailures = 0;
      while (Date.now() < deadline) {
        const response = await fetch(`/api/ai-tts-jobs/${encodeURIComponent(jobId)}`);
        if (response.status === 524 || response.status === 502 || response.status === 503) {
          transientFailures += 1;
          if (transientFailures > 8) {
            throw new Error(`AI 参考朗诵服务连续返回 HTTP ${response.status}，任务成果已保留，请稍后继续。`);
          }
          await new Promise((resolve) => window.setTimeout(resolve, 2400));
          continue;
        }
        transientFailures = 0;
        const job = await apiJson<AiTtsJobPayload>(response);
        const progress = typeof job.progress === "number" ? ` ${Math.round(job.progress)}%` : "";
        setAnalysisStatus(`${aiTtsStatusText(job.status)}${progress}`);
        setAnalysisJobStatus(job.status === "graph_ready" ? "succeeded" : job.status === "error" ? "failed" : "processing");
        if (job.work) {
          setWork(job.work);
          setLastSavedAt(job.work.updatedAt);
          savedUpdatedAtRef.current = job.work.updatedAt;
          savedHasDerivedAssetsRef.current = Boolean(
            job.work.aiTts || job.work.standardAiAudio || job.work.controlSpec,
          );
        }
        if (job.status === "error") {
          throw new Error(job.error?.message || "AI 参考朗诵任务未完成。");
        }
        if (job.status === "graph_ready") {
          const completedWork = job.work?.controlSpec
            ? job.work
            : (await apiJson<{ work: RecitationWork }>(
              await fetch(`/api/works/${encodeURIComponent(saved.id)}`),
            )).work;
          if (!completedWork.controlSpec) {
            throw new Error("AI 参考声音已经生成，但情感图谱尚未完成。");
          }
          setWork(completedWork);
          setIsWorkDirty(false);
          setSaveState("saved");
          setLastSavedAt(completedWork.updatedAt);
          savedSourceTextRef.current = completedWork.sourceText;
          savedUpdatedAtRef.current = completedWork.updatedAt;
          savedHasDerivedAssetsRef.current = true;
          setControlSpecDirty(false);
          setAnalysisJobStatus("succeeded");
          setAnalysisStatus("AI 参考朗诵与情感图谱已生成");
          setAudioSource("standard");
          setStep(2);
          window.scrollTo({ top: 0, behavior: "smooth" });
          showToast(`AI 参考朗诵与同源控制谱已生成：${completedWork.controlSpec.sentences.length} 句`);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1400));
      }
      throw new Error("AI 参考朗诵任务等待超过 30 分钟，已完成的方案和声音仍会保留。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAnalysisJobStatus("failed");
      setAnalysisStatus(`生成失败：${message}`);
      setSaveState("saved");
      try {
        if (!work.id.startsWith("draft-")) {
          const refreshed = (await apiJson<{ work: RecitationWork }>(
            await fetch(`/api/works/${encodeURIComponent(work.id)}`),
          )).work;
          setWork(refreshed);
          savedUpdatedAtRef.current = refreshed.updatedAt;
          setLastSavedAt(refreshed.updatedAt);
        }
      } catch {
        // The saved task remains recoverable even when this refresh is unavailable.
      }
      showToast(message);
    }
  };

  const handleAnalyze = async () => {
    if ((work.audioSourceType ?? "human_reference") === "ai_tts") {
      await handleAiAnalyze();
      return;
    }
    if (analysisJobStatus === "queued" || analysisJobStatus === "processing") return;
    if (!work.title.trim() || !work.sourceText.trim()) { showToast("请先填写作品名称和完整正文"); return; }
    if (!work.referenceAudio) { showToast("请先上传参考朗诵"); return; }
    setAnalysisJobStatus("queued");
    setAnalysisStatus("正在保存作品与真人参考音频");
    try {
      setSaveState("saving");
      let saved = await persistWorkRecord();

      if (referenceFile) {
        saved = await persistReferenceFile(saved);
        if (!saved.referenceAudio) {
          throw new Error("参考朗诵上传后未能读取，请重新上传。");
        }
        setWork(saved);
      } else if (!saved.referenceAudio) {
        const refreshed = await apiJson<{ work: RecitationWork }>(
          await fetch(`/api/works/${encodeURIComponent(saved.id)}`),
        );
        saved = refreshed.work;
        if (!saved.referenceAudio) throw new Error("当前作品没有已保存的参考朗诵，请重新选择音频。");
        setWork(saved);
      }
      setSaveState("saved");
      setLastSavedAt(saved.updatedAt);
      savedSourceTextRef.current = saved.sourceText;
      savedUpdatedAtRef.current = saved.updatedAt;
      savedReferenceIdRef.current = saved.referenceAudioOriginal?.id ?? saved.referenceAudio?.id;
      savedHasDerivedAssetsRef.current = Boolean(saved.standardAiAudio || saved.aiDemoAudio || saved.aiTts || saved.controlSpec);

      // Visual planning and image generation are independent of the acoustic
      // pipeline. Start them before awaiting the analysis request so the two
      // long-running jobs make progress in parallel. The visual flow is
      // versioned: failed attempts keep the currently active Hero/Scene assets.
      void generateWorkVisualAssets(saved.id, { type: "all" })
        .then((visuals) => {
          setWork((current) => current.id === saved.id ? { ...current, visuals } : current);
          showToast("作品视觉已同步生成");
        })
        .catch((visualError) => {
          const message = visualError instanceof Error ? visualError.message : String(visualError);
          showToast(`声音分析继续；作品视觉生成未完成：${message}`);
        });

      const created = await apiJson<AnalysisJobPayload>(
        await fetch(`/api/works/${encodeURIComponent(saved.id)}/analysis-jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      if (!created.analysis_job_id) throw new Error("分析任务创建失败：服务端没有返回任务编号。");
      const analyzingWork = (await apiJson<{ work: RecitationWork }>(
        await fetch(`/api/works/${encodeURIComponent(saved.id)}`),
      )).work;
      savedUpdatedAtRef.current = analyzingWork.updatedAt;
      setLastSavedAt(analyzingWork.updatedAt);
      setWork((current) => ({ ...current, analysisJobId: created.analysis_job_id, status: "analyzing" }));
      setAnalysisStatus("标准 AI 声音已生成，已进入分析队列");

      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        const job = await apiJson<AnalysisJobPayload>(
          await fetch(`/api/analysis-jobs/${encodeURIComponent(created.analysis_job_id)}`),
        );
        setAnalysisJobStatus(job.status);
        const progressValue = typeof job.progress === "number"
          ? (job.progress > 0 && job.progress <= 1 ? job.progress * 100 : job.progress)
          : undefined;
        const progress = progressValue === undefined ? "" : ` ${Math.round(progressValue)}%`;
        if (job.status === "queued") {
          setAnalysisStatus(`等待分析服务${progress}`);
        } else if (job.status === "processing") {
          setAnalysisStatus(`正在分析标准 AI 朗诵${progress}`);
        } else if (job.status === "failed") {
          throw new Error(analysisErrorMessage(job.error));
        } else if (job.status === "succeeded") {
          let completedWork = job.work;
          if (!completedWork?.controlSpec) {
            completedWork = (await apiJson<{ work: RecitationWork }>(
              await fetch(`/api/works/${encodeURIComponent(saved.id)}`),
            )).work;
          }
          if (!completedWork.controlSpec && job.control_spec) {
            const controlSpec = importControlSpec(
              job.control_spec,
              work.sourceText,
              saved.id,
              completedWork.standardAiAudio?.id ?? completedWork.referenceAudio?.id,
              completedWork.referenceAudioOriginal?.id,
            );
            completedWork = (await apiJson<{ work: RecitationWork }>(
              await fetch(`/api/works/${encodeURIComponent(saved.id)}/control-spec`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ control_spec: controlSpec, source: "analysis" }),
              }),
            )).work;
          }
          if (!completedWork.controlSpec) {
            throw new Error("分析任务已结束，但没有返回当前正文的控制谱。请重新解析。");
          }
          setWork(completedWork);
          setIsWorkDirty(false);
          setSaveState("saved");
          setLastSavedAt(completedWork.updatedAt);
          savedSourceTextRef.current = completedWork.sourceText;
          savedUpdatedAtRef.current = completedWork.updatedAt;
          savedReferenceIdRef.current = completedWork.referenceAudioOriginal?.id ?? completedWork.referenceAudio?.id;
          savedHasDerivedAssetsRef.current = Boolean(
            completedWork.standardAiAudio || completedWork.aiDemoAudio || completedWork.aiTts || completedWork.controlSpec,
          );
          setControlSpecDirty(false);
          setAnalysisJobStatus("succeeded");
          setAnalysisStatus("标准 AI 朗诵解析完成，声音与图谱同源");
          setAudioSource("standard");
          setStep(2);
          window.scrollTo({ top: 0, behavior: "smooth" });
          showToast(`同源控制谱已生成：${completedWork.controlSpec.sentences.length} 句`);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1600));
      }
      throw new Error("分析等待超过 20 分钟，请稍后重新打开作品检查任务状态。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAnalysisJobStatus("failed");
      setAnalysisStatus(`分析失败：${message}`);
      setWork((current) => ({ ...current, status: "draft" }));
      setSaveState(hasUnsavedChanges ? "dirty" : "saved");
      showToast(message);
    }
  };

  const persistControlSpec = async (controlSpec: ControlSpec, message?: string) => {
    const result = await apiJson<{ work: RecitationWork }>(
      await fetch(`/api/works/${encodeURIComponent(work.id)}/control-spec`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          control_spec: controlSpec,
          source: "human",
          expected_updated_at: savedUpdatedAtRef.current ?? work.updatedAt,
        }),
      }),
    );
    setWork(result.work);
    setIsWorkDirty(false);
    setSaveState("saved");
    setLastSavedAt(result.work.updatedAt);
    savedUpdatedAtRef.current = result.work.updatedAt;
    savedSourceTextRef.current = result.work.sourceText;
    savedHasDerivedAssetsRef.current = Boolean(
      result.work.standardAiAudio || result.work.aiDemoAudio || result.work.aiTts || result.work.controlSpec || result.work.publishedRevisionId,
    );
    setControlSpecDirty(false);
    if (message) showToast(message);
  };

  const saveSentence = async (nextSentence: RecitationSentence) => {
    if (!work.controlSpec) return;
    const nextSpec: ControlSpec = {
      ...work.controlSpec,
      source: "hybrid",
      sentences: work.controlSpec.sentences.map((sentence) => sentence.id === nextSentence.id ? nextSentence : sentence),
    };
    setWork((current) => ({
      ...current,
      status: "review",
      audioSyncStatus: current.standardAiAudio ? "modified" : "pending",
      controlSpec: nextSpec,
    }));
    setIsWorkDirty(true);
    setControlSpecDirty(true);
    setSaveState("dirty");
    setAudioSource(work.standardAiAudio?.timeline ? "standard" : "reference");
    try {
      await persistControlSpec(nextSpec, `第 ${nextSentence.order} 句图谱已保存`);
    } catch (error) {
      setIsWorkDirty(true);
      setSaveState("failed");
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const playAll = async () => {
    const audio = audioRef.current;
    if (!audio || !activeTrack) return;
    setSegmentEndMs(null);
    if (isPlaying) { audio.pause(); return; }
    if (audio.currentTime * 1000 >= activeTrack.durationMs - 100) {
      audio.currentTime = 0;
      setCurrentMs(0);
    }
    try { await audio.play(); } catch { showToast("浏览器暂时无法播放，请再点一次播放"); }
  };

  const playSentence = async (sentence: RecitationSentence) => {
    const audio = audioRef.current;
    const timing = sentenceTiming(activeTrack?.timeline, sentence.id);
    if (!audio || !timing) { showToast("当前音频还没有这句话的真实时间戳"); return; }
    const playbackWindow = sentencePlaybackWindow(timing, activeTrack?.durationMs);
    audio.pause();
    setSegmentEndMs(null);
    try {
      await seekAudioBeforePlayback(audio, playbackWindow.startMs / 1000);
      setCurrentMs(playbackWindow.startMs);
      setSegmentEndMs(playbackWindow.endMs);
      await audio.play();
    } catch {
      setSegmentEndMs(null);
      showToast("浏览器暂时无法播放，请再点一次“听本句”");
    }
  };

  const seekSentence = (sentence: RecitationSentence) => {
    const timing = sentenceTiming(activeTrack?.timeline, sentence.id);
    if (!timing) return;
    if (audioRef.current) audioRef.current.currentTime = timing.startMs / 1000;
    setSegmentEndMs(null);
    setCurrentMs(timing.startMs);
  };

  const seek = (value: number) => {
    if (!audioRef.current) return;
    setSegmentEndMs(null);
    audioRef.current.currentTime = value / 1000;
    setCurrentMs(value);
  };

  const changeRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  };

  const changeAudioSource = (source: AudioSource) => {
    const nextTrack = source === "reference" ? work.referenceAudio : standardPlayback;
    if (nextTrack) setAudioSource(source);
  };

  const exportViewerImage = async () => {
    const artboard = viewerExportRef.current;
    const target = artboard?.querySelector<HTMLElement>(".viewer-shell") ?? artboard;
    if (!target || exportingImage) return;
    setExportingImage(true);
    try {
      await document.fonts?.ready;
      await prepareViewerImagesForExport(target);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      const { toBlob } = await import("html-to-image");
      const width = Math.ceil(target.scrollWidth);
      const styles = window.getComputedStyle(target);
      const currentBottomPadding = Number.parseFloat(styles.paddingBottom) || 0;
      const exportBottomPadding = 28;
      const height = Math.max(
        1,
        Math.ceil(target.scrollHeight - currentBottomPadding + exportBottomPadding),
      );
      const pixelRatio = Math.max(1, Math.min(2, 15000 / Math.max(width, height)));
      const blob = await toBlob(target, {
        width,
        height,
        canvasWidth: width,
        canvasHeight: height,
        pixelRatio,
        backgroundColor: "#f4efe8",
        cacheBust: true,
        filter: (node) => !(node instanceof Element) || node.getAttribute("data-export-exclude") !== "true",
        style: {
          minHeight: "0",
          paddingBottom: "28px",
          position: "relative",
          top: "0",
          left: "0",
          margin: "0",
          transform: "none",
          transformOrigin: "top left",
          width: "1600px",
        },
      });
      if (!blob) throw new Error("浏览器未能生成图片文件。");
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = exportFilename(work.title);
      link.href = href;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      window.setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(href);
      }, 60_000);
      showToast("本页图谱 PNG 已导出");
    } catch (error) {
      console.error("viewer image export failed", error);
      showToast("图片导出失败，请刷新页面后重试");
    } finally {
      setExportingImage(false);
    }
  };

  const shareViewer = async () => {
    const shareData = {
      title: `${work.title} · 朗诵情感图谱`,
      text: `${work.title}${work.author ? ` · ${work.author}` : ""}的可播放朗诵情感图谱`,
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(shareData.url);
      showToast("观看链接已复制");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      showToast("暂时无法分享，请复制浏览器地址");
    }
  };

  const createNewWork = () => {
    if (localReferenceUrlRef.current) URL.revokeObjectURL(localReferenceUrlRef.current);
    localReferenceUrlRef.current = undefined;
    resetPlaybackAndEditorState();
    const empty = createEmptyWork();
    setWork(empty);
    setReferenceFile(null);
    setIsWorkDirty(true);
    setSaveState("unsaved");
    setLastSavedAt(undefined);
    savedSourceTextRef.current = "";
    savedUpdatedAtRef.current = undefined;
    savedReferenceIdRef.current = undefined;
    savedHasDerivedAssetsRef.current = false;
    removeSavedReferenceRef.current = false;
    setAnalysisJobStatus("idle");
    setAnalysisStatus("等待参考朗诵");
    setStep(1);
    setAudioSource("reference");
    setMode("studio");
    setLibraryOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("work");
    url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
  };

  const performPendingWorkAction = async (action: PendingWorkAction) => {
    setPendingWorkAction(null);
    setLibraryOpen(false);
    if (action.kind === "new") {
      createNewWork();
      return;
    }
    try {
      await loadStoredWork(action.workId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const requestWorkAction = (action: PendingWorkAction) => {
    if (hasUnsavedChanges) {
      setPendingWorkAction(action);
      return;
    }
    void performPendingWorkAction(action);
  };

  const saveThenContinue = () => {
    const action = pendingWorkAction;
    if (!action) return;
    pendingSaveRef.current = (saved) => {
      if (!saved) return;
      void performPendingWorkAction(action);
    };
    void performSaveCurrentWork();
  };

  const discardAndContinue = () => {
    const action = pendingWorkAction;
    if (!action) return;
    setPendingWorkAction(null);
    void performPendingWorkAction(action);
  };

  const handleDeleteWork = async () => {
    const target = workPendingDelete;
    if (!target || deletingWorkId) return;
    setDeletingWorkId(target.id);
    try {
      await apiJson<{ ok: true; deleted_work: { id: string; title: string } }>(
        await fetch(`/api/works/${encodeURIComponent(target.id)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_updated_at: target.updatedAt }),
        }),
      );
      const deletingCurrentWork = target.id === work.id;
      setLibraryItems((items) => items.filter((item) => item.id !== target.id));
      setWorkPendingDelete(null);
      if (deletingCurrentWork) createNewWork();
      showToast(`《${target.title}》已永久删除`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingWorkId(undefined);
    }
  };

  const handlePublish = async () => {
    try {
      const result = await apiJson<{ work: RecitationWork; public_url: string }>(
        await fetch(`/api/works/${encodeURIComponent(work.id)}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_updated_at: savedUpdatedAtRef.current ?? work.updatedAt }),
        }),
      );
      setWork(result.work);
      setIsWorkDirty(false);
      setSaveState("saved");
      setLastSavedAt(result.work.updatedAt);
      savedSourceTextRef.current = result.work.sourceText;
      savedUpdatedAtRef.current = result.work.updatedAt;
      savedReferenceIdRef.current = result.work.referenceAudioOriginal?.id ?? result.work.referenceAudio?.id;
      savedHasDerivedAssetsRef.current = true;
      window.history.replaceState({}, "", result.public_url);
      setAudioSource("standard");
      setMode("viewer");
      showToast("作品已发布，当前显示用户观看端");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const sentences = work.controlSpec?.sentences ?? [];
  const showPlayer = Boolean(
    standardPlayback?.timeline && work.controlSpec && (mode === "viewer" || step >= 2),
  );

  return (
    <main className={`product-app mode-${mode} ${mode === "studio" && step === 2 ? "mode-inline-editor" : ""}`}>
      {/* The synchronized graph is the exact on-screen transcript for this audio. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={activeTrack?.url} preload="metadata" />
      <header className="app-header">
        {mode === "viewer" ? (
          <Link className="brand" href="/" aria-label="返回声图作品库">
            <span className="brand-mark">声</span>
            <span className="brand-copy"><strong>声图</strong><small>朗诵情感图谱</small></span>
          </Link>
        ) : (
          <button
            type="button"
            className="brand"
            onClick={() => { setMode("studio"); setAudioSource("reference"); setWorkflowStep(1); }}
            aria-label="声图首页"
          >
            <span className="brand-mark">声</span>
            <span className="brand-copy"><strong>声图</strong><small>朗诵情感图谱</small></span>
          </button>
        )}

        <nav className="mode-switch" aria-label="产品端切换">
          <button
            type="button"
            className={mode === "studio" ? "active" : ""}
            onClick={() => {
              setMode("studio");
              setAudioSource(work.controlSpec && standardPlayback?.timeline ? "standard" : "reference");
            }}
          ><span aria-hidden="true">✦</span> 创作端</button>
          <button
            type="button"
            className={mode === "viewer" ? "active" : ""}
            disabled={!standardPlayback?.timeline}
            onClick={() => { setAudioSource("standard"); setMode("viewer"); }}
          ><span aria-hidden="true">◉</span> 用户观看端</button>
        </nav>

        <div className="header-status">
          <span className={`status-dot status-${work.status}`} />
          <span>{work.status === "published" ? "已发布" : "正式创作 · 单人版"}</span>
          <button type="button" className="avatar-button" aria-label="创作者账户">创</button>
        </div>

        {mode === "viewer" ? (
          <nav className="viewer-header-actions" aria-label="观看页操作">
            <Link href="/">返回作品库</Link>
            <button type="button" onClick={() => void shareViewer()}>分享</button>
          </nav>
        ) : null}
      </header>

      {mode === "studio" ? (
        <StudioView
          work={work}
          step={step}
          highestStep={highestStep}
          analysisJobStatus={analysisJobStatus}
          analysisStatus={analysisStatus}
          currentMs={currentMs}
          activeTokenId={activeTokenId}
          timeline={activeTrack?.timeline}
          onStep={setWorkflowStep}
          onWorkChange={handleWorkChange}
          onReferenceFile={handleReferenceFile}
          onDeleteReference={handleDeleteReference}
          onAudioSourceTypeChange={handleAudioSourceTypeChange}
          onAnalyze={handleAnalyze}
          onSaveSentence={saveSentence}
          onPlaySentence={playSentence}
          onVisualsChange={(visuals) => {
            setWork((current) => ({ ...current, visuals }));
            showToast("作品图片已更新");
          }}
          onBackToMaterials={() => setWorkflowStep(1)}
          onSave={() => work.controlSpec && void persistControlSpec(work.controlSpec, "控制谱草稿已保存")}
          onPublishStage={() => setWorkflowStep(3)}
          onPreview={() => { setAudioSource("standard"); setMode("viewer"); }}
          onPublish={handlePublish}
          saveState={saveState}
          lastSavedAt={lastSavedAt}
          onOpenLibrary={() => setLibraryOpen(true)}
          onSaveWork={() => void performSaveCurrentWork()}
        />
      ) : (
        <ViewerView
          work={work}
          currentMs={currentMs}
          activeTokenId={activeTokenId}
          isPlaying={isPlaying}
          onPlayAll={playAll}
          onPlaySentence={playSentence}
          onSeekSentence={seekSentence}
          exportTargetRef={viewerExportRef}
          exporting={exportingImage}
          onExport={() => void exportViewerImage()}
        />
      )}

      {showPlayer && activeTrack ? (
        <Player
          title={work.title}
          track={activeTrack}
          sentences={sentences}
          source={audioSource}
          currentMs={currentMs}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          onToggle={playAll}
          onSeek={seek}
          onRateChange={changeRate}
          onSourceChange={mode === "studio" ? changeAudioSource : undefined}
          hasReference={Boolean(work.referenceAudio)}
          hasStandard={Boolean(standardPlayback?.timeline)}
          compact={mode === "viewer"}
        />
      ) : null}

      {mode === "studio" ? (
        <WorkLibrary
          open={libraryOpen}
          loading={libraryLoading}
          query={libraryQuery}
          items={libraryItems}
          currentWorkId={work.id}
          onClose={() => setLibraryOpen(false)}
          onQuery={setLibraryQuery}
          onNew={() => requestWorkAction({ kind: "new" })}
          onOpen={(workId) => requestWorkAction({ kind: "open", workId })}
          onDelete={setWorkPendingDelete}
          deletingWorkId={deletingWorkId}
        />
      ) : null}

      <DeleteWorkDialog
        work={workPendingDelete}
        deleting={Boolean(deletingWorkId)}
        current={workPendingDelete?.id === work.id}
        hasUnsavedChanges={hasUnsavedChanges}
        onCancel={() => setWorkPendingDelete(null)}
        onConfirm={() => void handleDeleteWork()}
      />

      <SwitchWorkDialog
        open={Boolean(pendingWorkAction)}
        saving={saveState === "saving"}
        onCancel={() => setPendingWorkAction(null)}
        onDiscard={discardAndContinue}
        onSave={saveThenContinue}
      />

      <SourceChangeDialog
        open={sourceChangeConfirmOpen}
        saving={saveState === "saving"}
        kind={destructiveChangeKind}
        onCancel={() => {
          setSourceChangeConfirmOpen(false);
          pendingSaveRef.current = null;
        }}
        onConfirm={() => void performSaveCurrentWork(true)}
      />

      <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">
        <span>{toast?.includes("失败") || toast?.includes("错误") ? "!" : "✓"}</span>{toast}
      </div>
    </main>
  );
}
