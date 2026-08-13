"use client";

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
  buildTeachingProsodyPoints,
  monotoneSplinePath,
  PROSODY_VISUAL_LEVEL_COUNT,
  type TeachingProsodyPoint,
} from "@/lib/prosody-visual";
import {
  ENDING_LABELS,
  PROSODY_LABELS,
  RHYTHM_LABELS,
  type AudioTimeline,
  type AudioTrack,
  type ControlSpec,
  type EndingTone,
  type ProsodyType,
  type ProsodyEvent,
  type RecitationSentence,
  type RecitationWork,
  type Rhythm,
  type TimedToken,
} from "@/lib/recitation-schema";

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
  { id: 1, title: "准备作品", subtitle: "正文 · 真人参考朗诵" },
  { id: 2, title: "编辑图谱", subtitle: "人工复核 · 单句修正" },
  { id: 3, title: "预览发布", subtitle: "观看端 · 同步高亮" },
];

const prosodyOptions = Object.keys(PROSODY_LABELS) as ProsodyType[];
const rhythmOptions = Object.keys(RHYTHM_LABELS) as Rhythm[];
const endingOptions = Object.keys(ENDING_LABELS) as EndingTone[];

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

function focusSet(sentence: RecitationSentence) {
  return new Set(sentence.focus.flatMap((target) => target.tokenIndexes));
}

function pauseAfter(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.pauses.find((pause) => pause.afterTokenIndex === tokenIndex);
}

function prolongFor(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.prolongations.find((prolong) => prolong.tokenIndex === tokenIndex);
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

function AcousticProsodyCurve({
  sentence,
  metrics,
  teachingPoints,
  activeTokenIndex,
  editing,
}: {
  sentence: RecitationSentence;
  metrics: CurveMetrics;
  teachingPoints: TeachingProsodyPoint[];
  activeTokenIndex?: number;
  editing: boolean;
}) {
  const gradientId = useId();
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
  const baselineY = height - verticalPadding - ((PROSODY_VISUAL_LEVEL_COUNT - 1) / 2) * visualStep;
  const label = sentence.prosody.length
    ? sentence.prosody.map((event) => PROSODY_LABELS[event.type]).join("、")
    : "教学宏观语势";
  const spline = monotoneSplinePath(points);
  const fillPath = `${spline} L ${points.at(-1)!.x} ${height + 1} L ${points[0].x} ${height + 1} Z`;

  return (
    <svg
      className={`prosody-curve acoustic-prosody-curve ${editing ? "editing" : ""}`}
      viewBox={`0 0 ${metrics.width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}；每字宏观语势曲线`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b6452e" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#b6452e" stopOpacity="0.015" />
        </linearGradient>
      </defs>
      <path className="curve-fill" d={fillPath} fill={`url(#${gradientId})`} />
      <line
        className="curve-baseline"
        x1={points[0].x}
        x2={points.at(-1)?.x ?? points[0].x}
        y1={baselineY}
        y2={baselineY}
      />
      <path className="curve-path acoustic-path" d={spline} />
      {points.map((point) => {
        const playing = point.tokenIndex === activeTokenIndex;
        return (
          <circle
            className={`token-prosody-anchor ${playing ? "playing" : ""}`}
            data-prosody-anchor="true"
            data-token-index={point.tokenIndex}
            data-visual-level={point.visualLevel}
            key={point.tokenIndex}
            cx={point.x}
            cy={point.y}
            r={playing ? 4.75 : editing ? 3.4 : 2.9}
          />
        );
      })}
    </svg>
  );
}

function ToneArrow({ type }: { type: EndingTone }) {
  return (
    <span className={`tone-arrow tone-${type}`} aria-label={ENDING_LABELS[type]}>
      {type === "rising" ? "↗" : type === "falling" ? "↘" : "→"}
    </span>
  );
}

function IndexedGraphTrack({
  sentence,
  activeTokenId,
  editing = false,
}: {
  sentence: RecitationSentence;
  activeTokenId?: string;
  editing?: boolean;
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
  const activeTokenIndex = sentence.tokens.find((token) => token.id === activeTokenId)?.index;
  const teachingProsodyPoints = useMemo(
    () => buildTeachingProsodyPoints(
      tokenUnits.map((unit) => unit.token.index),
      sentence.macroProsodyPath?.points ?? [],
    ),
    [sentence.macroProsodyPath, tokenUnits],
  );

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track || !tokenUnits.length) {
      setCurveRows([]);
      return;
    }

    const trackRect = track.getBoundingClientRect();
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
      const unitTop = unitRect.top - trackRect.top;
      let row = visualRows.find((candidate) => Math.abs(candidate.unitTop - unitTop) < 2);
      if (!row) {
        row = {
          unitTop,
          curveTop: curveRect.top - trackRect.top,
          curveHeight: curveRect.height,
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
        return [[index, rect.left - trackRect.left + rect.width / 2]];
      }));

      return {
        key: `${sentence.id}-curve-row-${rowIndex}`,
        top: row.curveTop,
        width: trackRect.width,
        height: row.curveHeight,
        trackStart: firstRect.left - trackRect.left + firstRect.width / 2,
        trackEnd: lastRect.left - trackRect.left + lastRect.width / 2,
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

  return (
    <div className="graph-track-layout">
      <div className="graph-track-viewport">
        <div className="attached-token-track">
          <div className="token-unit-flow" ref={trackRef} aria-label={sentence.text}>
            {tokenUnits.map((unit) => {
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
                      className={`token-char ${focused.has(unit.token.index) ? "focus-token" : ""} ${unitIsPlaying ? "playing-token" : ""}`}
                      data-token-index={unit.token.index}
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
            <div className="wrapped-curve-layer">
              {curveRows.map((row) => (
                <div
                  className="curve-line"
                  key={row.key}
                  style={{ top: `${row.top}px`, height: `${row.height}px` }}
                >
                  {sentence.macroProsodyPath?.points.length ? (
                    <AcousticProsodyCurve
                      sentence={sentence}
                      metrics={row}
                      teachingPoints={teachingProsodyPoints}
                      activeTokenIndex={activeTokenIndex}
                      editing={editing}
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
}: {
  sentence: RecitationSentence;
  selected?: boolean;
  active?: boolean;
  activeTokenId?: string;
  editing?: boolean;
  onSelect?: () => void;
  onPlay?: () => void;
}) {
  return (
    <div
      className={`graph-sentence ${selected ? "selected" : ""} ${active ? "active" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (onSelect && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `选择第 ${sentence.order} 句：${sentence.text}` : undefined}
    >
      <div className="sentence-rail">
        <span className="sentence-number">{String(sentence.order).padStart(2, "0")}</span>
        <span className="soft-tag">{RHYTHM_LABELS[sentence.rhythm]}</span>
        {onPlay ? (
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
              ? `标准 AI 朗诵${activeSentence ? ` · 第 ${activeSentence.order} 句` : " · 整篇"}`
              : `${source === "reference" ? "真人原始朗诵" : "标准 AI 朗诵"}${activeSentence ? ` · 第 ${activeSentence.order} 句` : ""}`}
          </span>
          <strong>{activeSentence?.text ?? title}</strong>
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
  onAnalyze,
}: {
  work: RecitationWork;
  jobStatus: AnalysisJobStatus;
  analysisStatus: string;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAnalyze: () => void;
}) {
  const hasWorkInfo = Boolean(work.title.trim() && work.sourceText.trim());
  const isAnalyzing = jobStatus === "queued" || jobStatus === "processing";
  const canAnalyze = Boolean(work.referenceAudio && hasWorkInfo && !isAnalyzing);

  return (
    <section className="stage material-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">01 · 准备作品</p>
          <h1>把一段好朗诵，变成一张能听的声音地图</h1>
          <p className="stage-lead">
            填写准确正文并上传对应真人朗诵。系统会先生成统一音色的标准 AI 朗诵，再对它执行文字对齐、声学分析和控制谱生成。
          </p>
        </div>
        <span className="version-chip">控制谱 v2.0</span>
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
          <ReferenceAudioPanel
            audio={work.referenceAudio}
            disabled={isAnalyzing}
            onFile={onReferenceFile}
            onDelete={work.referenceAudio?.url.startsWith("blob:") ? onDeleteReference : undefined}
          />

          <div className="analysis-card">
            <div className="analysis-orbit" aria-hidden="true">
              <span>声</span>
            </div>
            <div className="analysis-copy">
              <p className="eyebrow">标准声音生成与解析</p>
              <h3>{analysisStatus}</h3>
              <p>
                {jobStatus === "queued"
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
                ? "正在生成并解析"
                : jobStatus === "failed" || jobStatus === "succeeded"
                  ? "重新生成标准声音并解析"
                  : "生成标准 AI 声音并解析"}
            </button>
          </div>
          {!work.referenceAudio ? (
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

function SentenceTokenEditor({
  sentence,
  mode,
  onToken,
  onBoundary,
}: {
  sentence: RecitationSentence;
  mode: "focus" | "pause" | "prolong";
  onToken?: (token: TimedToken) => void;
  onBoundary?: (token: TimedToken) => void;
}) {
  const focused = focusSet(sentence);
  const lastIndex = sentence.tokens.at(-1)?.index;
  return (
    <div className={`sentence-token-editor mode-${mode}`}>
      {sentence.tokens.map((token) => {
        const isPunctuation = punctuationOnly(token.char);
        const pause = pauseAfter(sentence, token.index);
        const prolong = prolongFor(sentence, token.index);
        return (
          <span className="annotation-unit" key={`${mode}-${token.id}`}>
            {mode === "pause" || isPunctuation ? (
              <span className={isPunctuation ? "annotation-char punctuation" : "annotation-char"}>
                {token.char}
              </span>
            ) : (
              <button
                type="button"
                className={`annotation-char ${mode === "focus" && focused.has(token.index) ? "selected-focus" : ""} ${mode === "prolong" && prolong ? "selected-prolong" : ""}`}
                aria-pressed={mode === "focus" ? focused.has(token.index) : Boolean(prolong)}
                onClick={() => onToken?.(token)}
              >
                {token.char}{mode === "prolong" && prolong ? <small>——</small> : null}
              </button>
            )}
            {mode === "pause" && token.index !== lastIndex ? (
              <button
                type="button"
                className={`pause-boundary ${pause ? "marked" : ""}`}
                aria-label={`在“${token.char}”后设置停顿`}
                onClick={() => onBoundary?.(token)}
              >
                {pause ? (pause.type === "long" ? "///" : "/") : "+"}
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function SentenceEditDrawer({
  sentence,
  onClose,
  onSave,
}: {
  sentence: RecitationSentence | null;
  onClose: () => void;
  onSave: (sentence: RecitationSentence) => void;
}) {
  const [draft, setDraft] = useState<RecitationSentence | null>(() =>
    sentence ? structuredClone(sentence) : null,
  );
  const [prosodyIndex, setProsodyIndex] = useState(0);

  useEffect(() => {
    if (!sentence) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, sentence]);

  if (!sentence || !draft) return null;

  const toggleFocus = (token: TimedToken) => {
    setDraft((current) => {
      if (!current) return current;
      const contains = current.focus.some((target) =>
        target.tokenIndexes.includes(token.index),
      );
      let nextFocus = current.focus
        .map((target) => ({
          ...target,
          tokenIds: contains
            ? target.tokenIds.filter((id) => id !== token.id)
            : target.tokenIds,
          tokenIndexes: contains
            ? target.tokenIndexes.filter((index) => index !== token.index)
            : target.tokenIndexes,
        }))
        .filter((target) => target.tokenIndexes.length > 0);

      if (!contains) {
        if (nextFocus[0]) {
          nextFocus = nextFocus.map((target, index) =>
            index === 0
              ? {
                  ...target,
                  tokenIds: [...target.tokenIds, token.id],
                  tokenIndexes: [...target.tokenIndexes, token.index].sort((a, b) => a - b),
                }
              : target,
          );
        } else {
          nextFocus = [
            {
              id: `${current.id}-focus-manual`,
              tokenIds: [token.id],
              tokenIndexes: [token.index],
              level: "primary",
              preferredRealization: "free",
              allowedRealizations: ["free", "combined"],
              avoid: ["shouting"],
            },
          ];
        }
      }

      return {
        ...current,
        focus: nextFocus,
      };
    });
  };

  const cyclePause = (token: TimedToken) => {
    setDraft((current) => {
      if (!current) return current;
      const existing = current.pauses.find(
        (pause) => pause.afterTokenIndex === token.index,
      );
      if (!existing) {
        return {
          ...current,
          pauses: [
            ...current.pauses,
            {
              id: `${current.id}-pause-${token.index}`,
              afterTokenId: token.id,
              afterTokenIndex: token.index,
              type: "short",
              source: "human",
            },
          ],
        };
      }
      if (existing.type === "short") {
        return {
          ...current,
          pauses: current.pauses.map((pause) =>
            pause.id === existing.id ? { ...pause, type: "long" } : pause,
          ),
        };
      }
      return {
        ...current,
        pauses: current.pauses.filter((pause) => pause.id !== existing.id),
      };
    });
  };

  const toggleProlong = (token: TimedToken) => {
    setDraft((current) => {
      if (!current) return current;
      const existing = current.prolongations.find(
        (prolong) => prolong.tokenIndex === token.index,
      );
      return {
        ...current,
        prolongations: existing
          ? current.prolongations.filter((prolong) => prolong.id !== existing.id)
          : [
              ...current.prolongations,
              {
                id: `${current.id}-prolong-${token.index}`,
                tokenId: token.id,
                tokenIndex: token.index,
                degree: 1,
              },
            ],
      };
    });
  };

  const spokenIndexes = draft.tokens
    .filter((token) => !punctuationOnly(token.char))
    .map((token) => token.index);
  const sentenceMin = spokenIndexes[0] ?? draft.tokens[0]?.index ?? 0;
  const sentenceMax = spokenIndexes.at(-1) ?? draft.tokens.at(-1)?.index ?? sentenceMin;
  const currentProsody = draft.prosody[prosodyIndex] ?? {
    id: `${draft.id}-prosody-manual`,
    type: "peak" as const,
    activeSpan: { start: sentenceMin, end: sentenceMax },
    coreZone: { start: sentenceMin, end: sentenceMax },
    strength: 2 as const,
  };
  const updateProsody = (change: Partial<ProsodyEvent>) => {
    const next = { ...currentProsody, ...change };
    const prosody = [...draft.prosody];
    prosody[prosodyIndex] = next;
    setDraft({ ...draft, prosody });
  };
  const addProsody = () => {
    const next: ProsodyEvent = {
      id: `${draft.id}-prosody-manual-${draft.prosody.length + 1}`,
      type: "rising",
      activeSpan: { start: sentenceMin, end: sentenceMax },
      coreZone: { start: sentenceMin, end: sentenceMax },
      strength: 1,
      confidence: 1,
    };
    setDraft({ ...draft, prosody: [...draft.prosody, next] });
    setProsodyIndex(draft.prosody.length);
  };
  const removeProsody = () => {
    const next = draft.prosody.filter((_, index) => index !== prosodyIndex);
    setDraft({ ...draft, prosody: next });
    setProsodyIndex(Math.max(0, Math.min(prosodyIndex, next.length - 1)));
  };
  const updateSpan = (
    field: "activeSpan" | "coreZone",
    edge: "start" | "end",
    value: number,
  ) => {
    const span = { ...currentProsody[field], [edge]: value };
    if (span.start > span.end) {
      if (edge === "start") span.end = value;
      else span.start = value;
    }
    if (field === "activeSpan") {
      const coreZone = {
        start: Math.max(span.start, currentProsody.coreZone.start),
        end: Math.min(span.end, currentProsody.coreZone.end),
      };
      if (coreZone.start > coreZone.end) coreZone.start = coreZone.end = span.start;
      updateProsody({ activeSpan: span, coreZone });
    } else {
      updateProsody({
        coreZone: {
          start: Math.max(currentProsody.activeSpan.start, span.start),
          end: Math.min(currentProsody.activeSpan.end, span.end),
        },
      });
    }
  };

  return (
    <div className="sentence-drawer-backdrop">
      <button
        type="button"
        className="sentence-drawer-scrim"
        aria-label="关闭编辑面板"
        onClick={onClose}
      />
      <aside
        className="sentence-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sentence-drawer-title"
      >
        <div className="sentence-drawer-heading">
          <div>
            <p className="eyebrow">句子 {String(draft.order).padStart(2, "0")}</p>
            <h2 id="sentence-drawer-title">编辑当前图谱句</h2>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭编辑面板">
            ×
          </button>
        </div>

        <div className="sentence-drawer-body">
          <section className="drawer-section split-controls">
            <label>
              <span>节奏</span>
              <select
                value={draft.rhythm}
                onChange={(event) =>
                  setDraft({ ...draft, rhythm: event.target.value as Rhythm })
                }
              >
                {rhythmOptions.map((option) => (
                  <option key={option} value={option}>{RHYTHM_LABELS[option]}</option>
                ))}
              </select>
            </label>
            <div className="drawer-field">
              <span>句尾语调</span>
              <div className="segmented-choice ending-choice">
                {endingOptions.map((option) => (
                  <button
                    type="button"
                    key={option}
                    className={draft.endingIntonation.type === option ? "chosen" : ""}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        endingIntonation: { ...draft.endingIntonation, type: option },
                      })
                    }
                  >
                    {ENDING_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="drawer-section">
            <div className="drawer-label-row">
              <span>语势</span>
              <small>可以保留一句内部多个连续事件；曲线高度仍来自真实声音路径</small>
            </div>
            <div className="segmented-choice prosody-event-tabs">
              {draft.prosody.map((event, index) => (
                <button
                  type="button"
                  key={event.id}
                  className={prosodyIndex === index ? "chosen" : ""}
                  onClick={() => setProsodyIndex(index)}
                >
                  {index + 1} · {PROSODY_LABELS[event.type]}
                </button>
              ))}
              <button type="button" onClick={addProsody}>＋ 新增</button>
              {draft.prosody.length ? (
                <button type="button" onClick={removeProsody}>删除当前</button>
              ) : null}
            </div>
            <div className="choice-grid four-choices">
              {prosodyOptions.map((option) => (
                <button
                  type="button"
                  key={option}
                  className={currentProsody.type === option ? "chosen" : ""}
                  onClick={() => updateProsody({ type: option })}
                >
                  <span className={`mini-curve mini-${option}`} aria-hidden="true" />
                  {PROSODY_LABELS[option]}
                </button>
              ))}
            </div>
            <div className="drawer-field strength-field">
              <span>语势强度</span>
              <div className="segmented-choice">
                {([1, 2, 3] as const).map((strength) => (
                  <button
                    type="button"
                    key={strength}
                    className={currentProsody.strength === strength ? "chosen" : ""}
                    onClick={() => updateProsody({ strength })}
                  >
                    {strength === 1 ? "轻" : strength === 2 ? "中" : "强"}
                  </button>
                ))}
              </div>
            </div>
            <div className="prosody-span-editor">
              <div className="drawer-label-row">
                <span>语势区间</span>
                <small>按 token index 设置局部变化与核心区，曲线会按文字真实位置重算</small>
              </div>
              <div className="span-select-grid">
                {([
                  ["变化开始", "activeSpan", "start", currentProsody.activeSpan.start],
                  ["变化结束", "activeSpan", "end", currentProsody.activeSpan.end],
                  ["核心开始", "coreZone", "start", currentProsody.coreZone.start],
                  ["核心结束", "coreZone", "end", currentProsody.coreZone.end],
                ] as const).map(([label, field, edge, value]) => (
                  <label key={`${field}-${edge}`}>
                    <span>{label}</span>
                    <select value={value} onChange={(event) => updateSpan(field, edge, Number(event.target.value))}>
                      {draft.tokens.filter((token) => !punctuationOnly(token.char)).map((token) => (
                        <option key={token.id} value={token.index}>{token.index} · {token.char}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="drawer-section annotation-section">
            <div className="drawer-label-row">
              <span>重音</span>
              <small>点击字词设置表达焦点；红字不等于必须增大音量</small>
            </div>
            <SentenceTokenEditor sentence={draft} mode="focus" onToken={toggleFocus} />
          </section>

          <section className="drawer-section annotation-section">
            <div className="drawer-label-row">
              <span>短停 / 长停</span>
              <small>点击字间位置循环：无 → / → ///</small>
            </div>
            <SentenceTokenEditor sentence={draft} mode="pause" onBoundary={cyclePause} />
          </section>

          <section className="drawer-section annotation-section">
            <div className="drawer-label-row">
              <span>拖音</span>
              <small>点击目标字开启或关闭“——”</small>
            </div>
            <SentenceTokenEditor sentence={draft} mode="prolong" onToken={toggleProlong} />
          </section>
        </div>

        <div className="sentence-drawer-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onSave(draft)}
          >
            保存本句
          </button>
        </div>
      </aside>
    </div>
  );
}

function EditorStage({
  work,
  editingSentenceId,
  currentMs,
  activeTokenId,
  timeline,
  onEditSentence,
  onCloseEditor,
  onSaveSentence,
  onPlaySentence,
  onSave,
  onContinue,
}: {
  work: RecitationWork;
  editingSentenceId: string | null;
  currentMs: number;
  activeTokenId?: string;
  timeline?: AudioTimeline;
  onEditSentence: (id: string) => void;
  onCloseEditor: () => void;
  onSaveSentence: (sentence: RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSave: () => void;
  onContinue: () => void;
}) {
  const spec = work.controlSpec;
  if (!spec) return null;
  const canPublish = Boolean((work.standardAiAudio ?? work.aiDemoAudio)?.timeline);
  const editingSentence =
    spec.sentences.find((item) => item.id === editingSentenceId) ?? null;
  const active = activeSentenceAt(spec.sentences, timeline, currentMs);

  return (
    <section className="stage editor-stage">
      <div className="stage-heading editor-heading">
        <div>
          <p className="eyebrow">02 · 人工复核</p>
          <h1>图谱本身，就是编辑器</h1>
          <p className="stage-lead">
            点击任意一句图谱，在单句面板中修正节奏、语势、重音、停顿、句尾语调和拖音。
          </p>
        </div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={onSave}>
            保存草稿
          </button>
          <button type="button" className="primary-button" onClick={onContinue} disabled={!canPublish}>
            {canPublish ? "确认图谱，进入发布预览" : "标准声音尚未就绪"} <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <div className="editor-layout editor-layout-single">
        <div className="graph-editor">
          <div className="graph-toolbar">
            <div className="legend compact-legend">
              <span><i className="legend-focus" />表达焦点</span>
              <span><b>/</b> 短停</span>
              <span><b>{"///"}</b> 长停</span>
              <span><b>↘</b> 句尾</span>
            </div>
          </div>
          <div className="graph-list editor-graph-list">
            {spec.sentences.map((sentence) => (
              <GraphSentence
                key={sentence.id}
                sentence={sentence}
                selected={editingSentenceId === sentence.id}
                editing
                active={active?.id === sentence.id && currentMs > 0}
                activeTokenId={active?.id === sentence.id && currentMs > 0 ? activeTokenId : undefined}
                onSelect={() => onEditSentence(sentence.id)}
                onPlay={timeline ? () => onPlaySentence(sentence) : undefined}
              />
            ))}
          </div>
        </div>
      </div>
      <SentenceEditDrawer
        key={editingSentence?.id ?? "closed"}
        sentence={editingSentence}
        onClose={onCloseEditor}
        onSave={onSaveSentence}
      />
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
  editingSentenceId,
  analysisJobStatus,
  analysisStatus,
  currentMs,
  activeTokenId,
  timeline,
  onStep,
  onWorkChange,
  onReferenceFile,
  onDeleteReference,
  onAnalyze,
  onEditSentence,
  onCloseEditor,
  onSaveSentence,
  onPlaySentence,
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
  editingSentenceId: string | null;
  analysisJobStatus: AnalysisJobStatus;
  analysisStatus: string;
  currentMs: number;
  activeTokenId?: string;
  timeline?: AudioTimeline;
  onStep: (step: WorkflowStep) => void;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAnalyze: () => void;
  onEditSentence: (id: string) => void;
  onCloseEditor: () => void;
  onSaveSentence: (sentence: RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
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
    <div className="studio-shell">
      <aside className="studio-sidebar">
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
      </aside>

      <div className="studio-main">
        {step === 1 ? (
          <MaterialStage
            work={work}
            jobStatus={analysisJobStatus}
            analysisStatus={analysisStatus}
            onWorkChange={onWorkChange}
            onReferenceFile={onReferenceFile}
            onDeleteReference={onDeleteReference}
            onAnalyze={onAnalyze}
          />
        ) : null}
        {step === 2 ? (
          <EditorStage
            work={work}
            editingSentenceId={editingSentenceId}
            currentMs={currentMs}
            activeTokenId={activeTokenId}
            timeline={timeline}
            onEditSentence={onEditSentence}
            onCloseEditor={onCloseEditor}
            onSaveSentence={onSaveSentence}
            onPlaySentence={onPlaySentence}
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

  return (
    <div className="viewer-shell" ref={exportTargetRef}>
      <section className="viewer-hero">
        <div className="viewer-hero-art" aria-hidden="true" />
        <div className="viewer-hero-inner">
          <div className="viewer-breadcrumb">
            <span>作品库</span><b>›</b><strong>{work.title}</strong>
          </div>
          <div className="viewer-title-row">
            <div className="viewer-title-block">
              <p className="eyebrow">朗诵情感图谱</p>
              <h1>{work.title}</h1>
              {work.author ? <p className="viewer-author">{work.author}</p> : null}
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
          <span><b>↗ ↘ →</b> 句尾语调</span>
          <span>
            <svg className="legend-curve" viewBox="0 0 34 12" aria-hidden="true">
              <path d="M2 9 C 8 9 9 3 15 3 S 24 8 32 5" />
            </svg>
            曲线：宏观语势
          </span>
        </div>

        <div className="viewer-graph-list">
          {spec.sentences.map((sentence) => {
            const isActive = active?.id === sentence.id && currentMs > 0;
            return (
              <div className="viewer-sentence-wrap" key={sentence.id}>
                <GraphSentence
                  sentence={sentence}
                  active={isActive}
                  activeTokenId={isActive ? activeTokenId : undefined}
                  onSelect={() => onSeekSentence(sentence)}
                  onPlay={() => onPlaySentence(sentence)}
                />
              </div>
            );
          })}
        </div>

        <div className="viewer-footnote">
          <span aria-hidden="true">同</span>
          <p>
            <strong>声音与图谱同源。</strong>
            你听到的每一个字都来自同一条标准 AI 朗诵；逐字高亮与语势曲线以字符级时间戳同步。
          </p>
        </div>
      </section>
    </div>
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
  const [editingSentenceId, setEditingSentenceId] = useState<string | null>(null);
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
    setEditingSentenceId(null);
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
      stored.standardAiAudio || stored.aiDemoAudio || stored.controlSpec || stored.publishedRevisionId,
    );
    removeSavedReferenceRef.current = false;
    setAnalysisJobStatus(stored.analysisJobStatus ?? "idle");
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
      setAudioSource("reference");
      setAnalysisStatus(
        stored.standardAiAudio
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
    setEditingSentenceId(null);
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
      sourceChanged && !keepsLocalReference
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
        analysisPackage: undefined,
      } : {}),
    }));
    if (sourceChanged) {
      setStep(1);
      setEditingSentenceId(null);
      setAudioSource("reference");
    }
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
        saved.standardAiAudio || saved.aiDemoAudio || saved.controlSpec || saved.publishedRevisionId,
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

  const handleAnalyze = async () => {
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
      savedHasDerivedAssetsRef.current = Boolean(saved.standardAiAudio || saved.aiDemoAudio || saved.controlSpec);

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
            completedWork.standardAiAudio || completedWork.aiDemoAudio || completedWork.controlSpec,
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
      result.work.standardAiAudio || result.work.aiDemoAudio || result.work.controlSpec || result.work.publishedRevisionId,
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
    setEditingSentenceId(null);
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
    const target = viewerExportRef.current;
    if (!target || exportingImage) return;
    setExportingImage(true);
    try {
      await document.fonts?.ready;
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
        filter: (node) => !(node instanceof HTMLElement) || node.dataset.exportExclude !== "true",
        style: {
          minHeight: "0",
          paddingBottom: "28px",
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
    <main className={`product-app mode-${mode}`}>
      {/* The synchronized graph is the exact on-screen transcript for this audio. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={activeTrack?.url} preload="metadata" />
      <header className="app-header">
        <button
          type="button"
          className="brand"
          onClick={() => { setMode("studio"); setAudioSource("reference"); setWorkflowStep(1); }}
          aria-label="声图首页"
        >
          <span className="brand-mark">声</span>
          <span className="brand-copy"><strong>声图</strong><small>朗诵情感图谱</small></span>
        </button>

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
      </header>

      {mode === "studio" ? (
        <StudioView
          work={work}
          step={step}
          highestStep={highestStep}
          editingSentenceId={editingSentenceId}
          analysisJobStatus={analysisJobStatus}
          analysisStatus={analysisStatus}
          currentMs={currentMs}
          activeTokenId={activeTokenId}
          timeline={activeTrack?.timeline}
          onStep={setWorkflowStep}
          onWorkChange={handleWorkChange}
          onReferenceFile={handleReferenceFile}
          onDeleteReference={handleDeleteReference}
          onAnalyze={handleAnalyze}
          onEditSentence={setEditingSentenceId}
          onCloseEditor={() => setEditingSentenceId(null)}
          onSaveSentence={saveSentence}
          onPlaySentence={playSentence}
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
