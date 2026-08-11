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
import { importControlSpec, parseControlSpecText } from "@/lib/control-spec-import";
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
type WorkflowStep = 1 | 2 | 3 | 4 | 5;
type AudioSource = "reference" | "ai_demo";
type AnalysisJobStatus = "idle" | "queued" | "processing" | "succeeded" | "failed";

const workflowSteps: Array<{
  id: WorkflowStep;
  title: string;
  subtitle: string;
}> = [
  { id: 1, title: "准备作品", subtitle: "正文 · 真人参考朗诵" },
  { id: 2, title: "导入控制谱", subtitle: "失败时的 JSON 兜底" },
  { id: 3, title: "编辑图谱", subtitle: "人工复核 · 单句修正" },
  { id: 4, title: "核对示范", subtitle: "同源标准声音 · 时间戳" },
  { id: 5, title: "预览发布", subtitle: "观看端 · 同步高亮" },
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

function punctuationOnly(char: string) {
  return /[，。！？、；：\s]/.test(char);
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

function primaryProsody(sentence: RecitationSentence): ProsodyEvent | undefined {
  return sentence.prosody[0];
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
  if ((work.standardAiAudio ?? work.aiDemoAudio)?.timeline && work.controlSpec) return 5;
  if (work.controlSpec) return 4;
  if (!work.id.startsWith("draft-")) return 2;
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

interface AnalysisJobPayload {
  analysis_job_id: string;
  work_id: string;
  status: Exclude<AnalysisJobStatus, "idle">;
  progress?: number;
  error?: string | { message?: string };
  control_spec?: unknown;
  work?: RecitationWork;
}

interface ElevenPromptDebugSnapshot {
  request_state: "preview" | "sent";
  model_id: string;
  voice_id: string;
  stability: number;
  stability_preset: string;
  final_eleven_text: string;
  control_spec_version_id?: string;
  audio_version_id?: string;
  generated_at?: string;
}

interface ElevenPromptDebugPayload {
  preview: ElevenPromptDebugSnapshot;
  last_sent: ElevenPromptDebugSnapshot | null;
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
  activeStart: number;
  activeEnd: number;
  coreStart: number;
  coreEnd: number;
  tokenCenters: Record<number, number>;
}

function ProsodyCurve({
  type,
  strength,
  metrics,
  active,
}: {
  type: ProsodyType;
  strength: 1 | 2 | 3;
  metrics: CurveMetrics;
  active: boolean;
}) {
  const { width, height } = metrics;
  if (width <= 0) return null;

  const top = 8;
  const bottom = height - 8;
  const middle = height / 2;
  const amplitude = 8 + strength * 7;
  const left = Math.max(4, metrics.trackStart);
  const right = Math.min(width - 4, metrics.trackEnd);
  const activeLeft = Math.max(left, Math.min(right, metrics.activeStart));
  const activeRight = Math.max(activeLeft, Math.min(right, metrics.activeEnd));
  const coreLeft = Math.max(activeLeft, Math.min(activeRight, metrics.coreStart));
  const coreRight = Math.max(coreLeft, Math.min(activeRight, metrics.coreEnd));
  const anchor = (coreLeft + coreRight) / 2;
  const leftControl = activeLeft + (coreLeft - activeLeft) * 0.65;
  const rightControl = activeRight - (activeRight - coreRight) * 0.65;

  let dotX = anchor;
  let dotY = middle;
  let path = "";
  if (type === "peak") {
    dotY = Math.max(top, middle - amplitude);
    path = `M ${left} ${middle} L ${activeLeft} ${middle} C ${leftControl} ${middle}, ${coreLeft} ${dotY}, ${anchor} ${dotY} C ${coreRight} ${dotY}, ${rightControl} ${middle}, ${activeRight} ${middle} L ${right} ${middle}`;
  } else if (type === "valley") {
    dotY = Math.min(bottom, middle + amplitude);
    path = `M ${left} ${middle} L ${activeLeft} ${middle} C ${leftControl} ${middle}, ${coreLeft} ${dotY}, ${anchor} ${dotY} C ${coreRight} ${dotY}, ${rightControl} ${middle}, ${activeRight} ${middle} L ${right} ${middle}`;
  } else if (type === "rising") {
    dotX = coreRight;
    dotY = Math.max(top, middle - amplitude);
    path = `M ${left} ${middle} L ${activeLeft} ${middle} C ${coreLeft} ${middle + amplitude * 0.35}, ${coreRight} ${dotY + 5}, ${activeRight} ${dotY} L ${right} ${dotY}`;
  } else {
    dotX = coreRight;
    dotY = Math.min(bottom, middle + amplitude);
    path = `M ${left} ${middle} L ${activeLeft} ${middle} C ${coreLeft} ${middle - amplitude * 0.35}, ${coreRight} ${dotY - 5}, ${activeRight} ${dotY} L ${right} ${dotY}`;
  }

  const gradientId = `curve-${type}-${active ? "active" : "idle"}`;
  return (
    <svg
      className="prosody-curve"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${PROSODY_LABELS[type]}语势，强度 ${strength}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1">
          <stop offset="0" stopColor={active ? "#dc6a4d" : "#9c8278"} />
          <stop offset="0.55" stopColor={active ? "#bd3f2d" : "#755e56"} />
          <stop offset="1" stopColor={active ? "#e29a59" : "#ad8b75"} />
        </linearGradient>
      </defs>
      <line
        className="curve-baseline"
        x1={left}
        x2={right}
        y1={middle}
        y2={middle}
      />
      <path
        className={active ? "curve-path active" : "curve-path"}
        d={path}
        stroke={`url(#${gradientId})`}
      />
      <circle
        className={active ? "curve-dot active" : "curve-dot"}
        data-prosody-anchor="true"
        cx={dotX}
        cy={dotY}
        r={active ? 4.5 : 3.5}
      />
    </svg>
  );
}

function smoothPointPath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middleX = (previous.x + point.x) / 2;
    return `${path} C ${middleX} ${previous.y}, ${middleX} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

function AcousticProsodyCurve({
  sentence,
  metrics,
  active,
}: {
  sentence: RecitationSentence;
  metrics: CurveMetrics;
  active: boolean;
}) {
  const macro = sentence.macroProsodyPath;
  const acousticPoints = (macro?.points ?? []).flatMap((point) => {
    const x = metrics.tokenCenters[point.tokenIndex];
    return Number.isFinite(x) ? [{ ...point, x }] : [];
  });
  if (metrics.width <= 0 || acousticPoints.length < 2) return null;

  const height = metrics.height;
  const levels = acousticPoints.map((point) => point.normalizedLevel);
  const rawMin = Math.min(...levels);
  const rawMax = Math.max(...levels);
  const center = (rawMin + rawMax) / 2;
  const range = Math.max(2, rawMax - rawMin + 0.8);
  const yFor = (level: number) => height / 2 - ((level - center) / range) * (height - 16);
  const points = acousticPoints.map((point) => ({
    ...point,
    y: yFor(point.normalizedLevel),
  }));
  const baselineY = yFor(0);
  const label = sentence.prosody.length
    ? sentence.prosody.map((event) => PROSODY_LABELS[event.type]).join("、")
    : "真实宏观声音路径";

  return (
    <svg
      className="prosody-curve acoustic-prosody-curve"
      viewBox={`0 0 ${metrics.width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}；声学连续曲线`}
    >
      <line
        className="curve-baseline"
        x1={points[0].x}
        x2={points.at(-1)?.x ?? points[0].x}
        y1={baselineY}
        y2={baselineY}
      />
      <path className="curve-path acoustic-path" d={smoothPointPath(points)} />
      {sentence.prosody.map((event) => {
        let eventPoints = points.filter(
          (point) => point.tokenIndex >= event.activeSpan.start && point.tokenIndex <= event.activeSpan.end,
        );
        if (eventPoints.length === 1) {
          const position = points.findIndex((point) => point.tokenIndex === eventPoints[0].tokenIndex);
          eventPoints = points.slice(Math.max(0, position - 1), Math.min(points.length, position + 2));
        }
        if (eventPoints.length < 2) return null;
        const corePoints = eventPoints.filter(
          (point) => point.tokenIndex >= event.coreZone.start && point.tokenIndex <= event.coreZone.end,
        );
        const candidates = corePoints.length ? corePoints : eventPoints;
        const anchor = event.type === "peak"
          ? candidates.reduce((best, point) => point.y < best.y ? point : best)
          : event.type === "valley"
            ? candidates.reduce((best, point) => point.y > best.y ? point : best)
            : candidates.at(-1)!;
        return (
          <g key={event.id} aria-label={`${PROSODY_LABELS[event.type]}，强度 ${event.strength}`}>
            <path
              className={active ? "curve-path event-path active" : "curve-path event-path"}
              d={smoothPointPath(eventPoints)}
            />
            <circle
              className={active ? "curve-dot active" : "curve-dot"}
              data-prosody-anchor="true"
              cx={anchor.x}
              cy={anchor.y}
              r={active ? 4.5 : 3.5}
            />
          </g>
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
  active,
}: {
  sentence: RecitationSentence;
  activeTokenId?: string;
  active: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const tokenRefs = useRef(new Map<number, HTMLSpanElement>());
  const [metrics, setMetrics] = useState<CurveMetrics>({
    width: 0,
    height: 64,
    trackStart: 0,
    trackEnd: 0,
    activeStart: 0,
    activeEnd: 0,
    coreStart: 0,
    coreEnd: 0,
    tokenCenters: {},
  });
  const prosody = primaryProsody(sentence);
  const focused = focusSet(sentence);
  const spokenTokens = useMemo(
    () => sentence.tokens.filter((token) => !punctuationOnly(token.char)),
    [sentence.tokens],
  );
  const lastSpokenIndex = spokenTokens.at(-1)?.index;

  const measure = useCallback(() => {
    const track = trackRef.current;
    const first = spokenTokens[0] && tokenRefs.current.get(spokenTokens[0].index);
    const last = lastSpokenIndex === undefined ? undefined : tokenRefs.current.get(lastSpokenIndex);
    const activeStart = prosody && tokenRefs.current.get(prosody.activeSpan.start);
    const activeEnd = prosody && tokenRefs.current.get(prosody.activeSpan.end);
    const coreStart = prosody && tokenRefs.current.get(prosody.coreZone.start);
    const coreEnd = prosody && tokenRefs.current.get(prosody.coreZone.end);
    if (!track || !first || !last) return;

    const trackRect = track.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const activeStartRect = activeStart?.getBoundingClientRect();
    const activeEndRect = activeEnd?.getBoundingClientRect();
    const coreStartRect = coreStart?.getBoundingClientRect();
    const coreEndRect = coreEnd?.getBoundingClientRect();
    const tokenCenters = Object.fromEntries(
      sentence.tokens.flatMap((token) => {
        const element = tokenRefs.current.get(token.index);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [[token.index, rect.left - trackRect.left + rect.width / 2]];
      }),
    );
    setMetrics({
      width: trackRect.width,
      height: 64,
      trackStart: firstRect.left - trackRect.left + firstRect.width / 2,
      trackEnd: lastRect.left - trackRect.left + lastRect.width / 2,
      activeStart: activeStartRect ? activeStartRect.left - trackRect.left : firstRect.left - trackRect.left,
      activeEnd: activeEndRect ? activeEndRect.right - trackRect.left : lastRect.right - trackRect.left,
      coreStart: coreStartRect ? coreStartRect.left - trackRect.left : firstRect.left - trackRect.left,
      coreEnd: coreEndRect ? coreEndRect.right - trackRect.left : lastRect.right - trackRect.left,
      tokenCenters,
    });
  }, [lastSpokenIndex, prosody, sentence.tokens, spokenTokens]);

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

  const columns = sentence.tokens
    .map((token) =>
      punctuationOnly(token.char) ? "minmax(20px, .58fr)" : "minmax(42px, 1fr)",
    )
    .join(" ");
  const minWidth = sentence.tokens.reduce(
    (total, token) => total + (punctuationOnly(token.char) ? 20 : 42),
    0,
  );
  const trackStyle = {
    "--track-columns": columns,
    "--track-min-width": `${minWidth}px`,
  } as CSSProperties;

  return (
    <div className="graph-track-layout">
      <div className="track-labels" aria-hidden="true">
        <span>拼音</span>
        <span className="strong">文稿</span>
        <span>语势</span>
      </div>
      <div className="indexed-track-scroll">
        <div className="indexed-track" ref={trackRef} style={trackStyle}>
          <div className="indexed-row pinyin-row" aria-label="拼音">
            {sentence.tokens.map((token) => (
              <span
                className={`token-cell ${punctuationOnly(token.char) ? "punctuation-token" : ""} ${activeTokenId === token.id ? "playing-token" : ""}`}
                key={`pinyin-${token.id}`}
                aria-hidden="true"
              >
                {token.displayPinyin ?? " "}
              </span>
            ))}
          </div>
          <div className="indexed-row text-row" aria-label={sentence.text}>
            {sentence.tokens.map((token) => {
              const pause = pauseAfter(sentence, token.index);
              const prolong = prolongFor(sentence, token.index);
              const tokenClass = [
                "token-cell",
                focused.has(token.index) ? "focus-token" : "",
                activeTokenId === token.id ? "playing-token" : "",
                punctuationOnly(token.char) ? "punctuation-token" : "",
                prolong ? "prolong-token" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <span
                  className={tokenClass}
                  data-token-index={token.index}
                  key={token.id}
                  ref={(element) => {
                    if (element) tokenRefs.current.set(token.index, element);
                    else tokenRefs.current.delete(token.index);
                  }}
                >
                  <span className="token-char">{token.char}</span>
                  {prolong ? <span className="prolong-mark">——</span> : null}
                  {pause ? (
                    <span className={`pause-mark pause-${pause.type}`}>
                      {pause.type === "long" ? "///" : "/"}
                    </span>
                  ) : null}
                  {token.index === lastSpokenIndex ? (
                    <ToneArrow type={sentence.endingIntonation.type} />
                  ) : null}
                </span>
              );
            })}
          </div>
          <div className="curve-layer">
            {sentence.macroProsodyPath?.points.length ? (
              <AcousticProsodyCurve
                sentence={sentence}
                metrics={metrics}
                active={active}
              />
            ) : prosody ? (
              <ProsodyCurve
                type={prosody.type}
                strength={prosody.strength}
                metrics={metrics}
                active={active}
              />
            ) : null}
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
  onSelect,
  onPlay,
}: {
  sentence: RecitationSentence;
  selected?: boolean;
  active?: boolean;
  activeTokenId?: string;
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
      <div className="sentence-card-topline">
        <div className="sentence-badges">
          <span className="sentence-number">{String(sentence.order).padStart(2, "0")}</span>
          <span className="soft-tag">{RHYTHM_LABELS[sentence.rhythm]}</span>
        </div>
        {onPlay ? (
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
        ) : null}
      </div>

      <IndexedGraphTrack
        sentence={sentence}
        activeTokenId={activeTokenId}
        active={Boolean(active)}
      />
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
  hasAiDemo,
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
  hasAiDemo: boolean;
  compact?: boolean;
}) {
  const progress = track.durationMs > 0
    ? Math.min(100, (currentMs / track.durationMs) * 100)
    : 0;
  const activeSentence = activeSentenceAt(sentences, track.timeline, currentMs);

  return (
    <div className={`player ${compact ? "player-compact" : ""}`}>
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
              ? `标准 AI 朗诵 · ${title}`
              : `${source === "reference" ? "真人原始朗诵" : "标准 AI 朗诵"}${activeSentence ? ` · 第 ${activeSentence.order} 句` : ""}`}
          </span>
          <strong>{activeSentence?.text ?? track.filename}</strong>
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
        {!compact && onSourceChange && hasReference && hasAiDemo ? (
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
              className={source === "ai_demo" ? "active" : ""}
              onClick={() => onSourceChange("ai_demo")}
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
  onManualImport,
}: {
  work: RecitationWork;
  jobStatus: AnalysisJobStatus;
  analysisStatus: string;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAnalyze: () => void;
  onManualImport: () => void;
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
                      ? "本次没有生成控制谱。你可以重新解析，或使用下方的手动 JSON 导入兜底。"
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
          {hasWorkInfo && !isAnalyzing ? (
            <button type="button" className="text-button" onClick={onManualImport}>
              {jobStatus === "failed" ? "改为手动导入控制谱 JSON" : "已有控制谱 JSON，直接导入"} →
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ControlImportStage({
  work,
  onImport,
  onBack,
}: {
  work: RecitationWork;
  onImport: (jsonText: string) => Promise<void>;
  onBack: () => void;
}) {
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const submitImport = async () => {
    setImportError(null);
    setIsImporting(true);
    try {
      await onImport(importText);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <section className="stage analysis-result-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">02 · 导入控制谱</p>
          <h1>自动分析失败时，手动导入 control_spec</h1>
          <p className="stage-lead">
            网站会逐字校验 token、时间戳、拼音和句子范围。只要与已保存正文有一处不一致，导入就会停止，正文绝不会被改写。
          </p>
        </div>
        <span className="ready-badge"><i /> 正文已保存</span>
      </div>

      <div className="analysis-result-grid">
        <div className="paper-card analysis-package-card">
          <div className="card-title-row">
            <div><p className="eyebrow">备用通道</p><h2>{work.title}</h2></div>
            <span className="json-chip">JSON 兜底</span>
          </div>
          <div className="analysis-facts">
            <span><strong>1</strong><small>保留完整 tokens</small></span>
            <span><strong>2</strong><small>核对正文与时间戳</small></span>
            <span><strong>3</strong><small>导入后人工编辑</small></span>
          </div>
          <p className="analysis-package-note">
            这是自动分析失败时的备用入口。JSON 必须对应当前正文，并保留 tokens 中的 index、char、start_ms、end_ms 和拼音字段。
          </p>
        </div>

        <div className="paper-card control-import-card">
          <div className="card-title-row compact-title-row">
            <div><p className="eyebrow">导入控制谱</p><h2>粘贴 ChatGPT 返回的 JSON</h2></div>
          </div>
          <textarea
            aria-label="control spec JSON"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={'可粘贴纯 JSON、```json 代码块，或 { "control_spec": { ... } }'}
            rows={12}
          />
          {importError ? <p className="import-error" role="alert">{importError}</p> : null}
          <button
            type="button"
            className="primary-button import-button"
            disabled={!importText.trim() || isImporting}
            onClick={submitImport}
          >
            {isImporting ? "正在校验并保存" : "导入控制谱"}
          </button>
        </div>
      </div>
      <button type="button" className="text-button analysis-back" onClick={onBack}>← 返回准备作品</button>
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
  const editingSentence =
    spec.sentences.find((item) => item.id === editingSentenceId) ?? null;
  const active = activeSentenceAt(spec.sentences, timeline, currentMs);

  return (
    <section className="stage editor-stage">
      <div className="stage-heading editor-heading">
        <div>
          <p className="eyebrow">03 · 人工复核</p>
          <h1>图谱本身，就是编辑器</h1>
          <p className="stage-lead">
            点击任意一句图谱，在单句面板中修正节奏、语势、重音、停顿、句尾语调和拖音。
          </p>
        </div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={onSave}>
            保存草稿
          </button>
          <button type="button" className="primary-button" onClick={onContinue}>
            确认图谱，进入生成示范 <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <div className="editor-layout editor-layout-single">
        <div className="graph-editor">
          <div className="graph-toolbar">
            <div>
              <span className="toolbar-title">三层情感图谱</span>
              <span className="toolbar-subtitle">{spec.sentences.length} 个图谱句 · 控制谱 v{spec.version}</span>
            </div>
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

function ElevenPromptDebugDrawer({
  debug,
  onClose,
  onCopy,
}: {
  debug: ElevenPromptDebugPayload | null;
  onClose: () => void;
  onCopy: (text: string) => void;
}) {
  if (!debug) return null;
  const sections = [
    debug.last_sent ? {
      key: "sent",
      kicker: "最近一次实际发送",
      title: "已保存的 Eleven 请求",
      snapshot: debug.last_sent,
    } : null,
    {
      key: "preview",
      kicker: "当前生成前预览",
      title: "此刻重新生成将发送",
      snapshot: debug.preview,
    },
  ].filter(Boolean) as Array<{
    key: string;
    kicker: string;
    title: string;
    snapshot: ElevenPromptDebugSnapshot;
  }>;

  return (
    <div className="sentence-drawer-backdrop prompt-debug-backdrop">
      <button
        type="button"
        className="sentence-drawer-scrim"
        aria-label="关闭 Eleven 提示词面板"
        onClick={onClose}
      />
      <aside
        className="sentence-drawer prompt-debug-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eleven-prompt-debug-title"
      >
        <div className="sentence-drawer-heading">
          <div>
            <p className="eyebrow">仅创作端可见 · 不包含 API Key</p>
            <h2 id="eleven-prompt-debug-title">Eleven 最终提示词</h2>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭提示词面板">
            ×
          </button>
        </div>
        <div className="sentence-drawer-body prompt-debug-body">
          {!debug.last_sent ? (
            <div className="prompt-debug-empty">
              当前控制谱还没有实际生成记录；下面显示生成前预览。
            </div>
          ) : null}
          {sections.map(({ key, kicker, title, snapshot }) => (
            <section className="drawer-section prompt-debug-section" key={key}>
              <div className="prompt-debug-title-row">
                <div>
                  <p className="eyebrow">{kicker}</p>
                  <h3>{title}</h3>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onCopy(snapshot.final_eleven_text)}
                >
                  复制正文
                </button>
              </div>
              <dl className="prompt-debug-meta">
                <div><dt>model_id</dt><dd>{snapshot.model_id}</dd></div>
                <div><dt>voice_id</dt><dd>{snapshot.voice_id || "未配置"}</dd></div>
                <div><dt>stability</dt><dd>{snapshot.stability} · {snapshot.stability_preset}</dd></div>
                {snapshot.generated_at ? (
                  <div><dt>generated_at</dt><dd>{snapshot.generated_at}</dd></div>
                ) : null}
              </dl>
              <div className="prompt-debug-text-heading">
                <span>final_eleven_text</span>
                <small>{Array.from(snapshot.final_eleven_text).length} 字符</small>
              </div>
              <pre className="prompt-debug-text">{snapshot.final_eleven_text}</pre>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}

function AudioStage({
  work,
  isGenerating,
  isPromptDebugLoading,
  promptDebug,
  onGenerate,
  onViewPrompt,
  onClosePrompt,
  onCopyPrompt,
  onContinue,
  onBack,
}: {
  work: RecitationWork;
  isGenerating: boolean;
  isPromptDebugLoading: boolean;
  promptDebug: ElevenPromptDebugPayload | null;
  onGenerate: () => void;
  onViewPrompt: () => void;
  onClosePrompt: () => void;
  onCopyPrompt: (text: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const spec = work.controlSpec;
  if (!spec) return null;
  const reference = work.referenceAudioOriginal ?? work.referenceAudio;
  const standardAudio = work.standardAiAudio;
  const legacyDemo = !standardAudio && work.aiDemoAudio?.kind === "ai_demo"
    ? work.aiDemoAudio
    : undefined;
  const playback = standardAudio ?? legacyDemo;
  const isSynced = work.audioSyncStatus === "synced";
  return (
    <section className="stage audio-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">04 · 示范声音</p>
          <h1>{standardAudio ? "核对与图谱同源的标准 AI 朗诵" : "旧作品示范声音兼容入口"}</h1>
          <p className="stage-lead">
            {standardAudio
              ? "这条声音由真人参考朗诵经 Voice Changer 生成；Forced Alignment、Parselmouth、控制谱和播放器都使用它。"
              : "这篇旧作品还没有同源标准声音，可暂时使用原有 Eleven v3 示范流程；新作品不会走这条旧链路。"}
          </p>
        </div>
        <span className={`provider-chip ${isSynced ? "ready" : ""}`}>
          {isSynced ? "声音与图谱同步" : work.audioSyncStatus === "modified" ? "图谱已人工修改" : `图谱版本 v${spec.version}`}
        </span>
      </div>

      <div className="audio-source-compare" aria-label="真人参考朗诵和标准 AI 朗诵">
        <div className="paper-card audio-source-card source-reference">
          <span className="source-kicker">原始来源证据</span>
          <strong>真人参考朗诵</strong>
          <p>{reference?.filename ?? "未提供"}</p>
          <small>{reference ? `${formatTime(reference.durationMs)} · 原始声音已保留` : "控制谱来自手动导入"}</small>
        </div>
        <span className="source-arrow" aria-hidden="true">→</span>
        <div className={`paper-card audio-source-card source-ai ${playback ? "ready" : ""}`}>
          <span className="source-kicker">分析与播放对象</span>
          <strong>{standardAudio ? "标准 AI 朗诵" : "旧版 AI 示范"}</strong>
          <p>{playback?.filename ?? "等待生成"}</p>
          <small>{playback ? `${formatTime(playback.durationMs)} · 字符时间轴已就绪` : "旧作品可生成兼容示范"}</small>
        </div>
      </div>

      <div className="audio-grid audio-grid-single">
        <div className="paper-card generation-card">
          <div className="card-title-row">
            <div>
              <p className="eyebrow">当前标准声音</p>
              <h2>{standardAudio ? "同源标准 AI 朗诵" : "旧版 AI 示范"}</h2>
            </div>
            <span className={`status-pill ${playback ? "ready" : ""}`}>
              {playback ? "已就绪" : "待生成"}
            </span>
          </div>

          <div className={`waveform ${isGenerating ? "generating" : ""}`} aria-hidden="true">
            {Array.from({ length: 68 }, (_, index) => (
              <span key={index} style={{ "--bar": `${20 + ((index * 37) % 70)}%` } as CSSProperties} />
            ))}
          </div>
          <div className="audio-metadata">
            <span>{playback ? formatTime(playback.durationMs) : "时长生成后确定"}</span>
            <span>中文普通话</span>
            <span>{spec.sentences.length} 个图谱句</span>
            <span>字符级时间轴</span>
          </div>

          <div className="generation-button-row">
            <button
              type="button"
              className="primary-button generate-wide"
              onClick={onGenerate}
              disabled={isGenerating}
            >
              {isGenerating ? <span className="button-spinner" /> : <span aria-hidden="true">✦</span>}
              {standardAudio
                ? "试听标准 AI 朗诵"
                : isGenerating ? "正在生成旧版示范" : legacyDemo ? "重新生成旧版示范" : "生成旧版兼容示范"}
            </button>
            {!standardAudio ? (
              <button
                type="button"
                className="secondary-button prompt-debug-button"
                onClick={onViewPrompt}
                disabled={isPromptDebugLoading}
              >
                {isPromptDebugLoading ? "正在读取" : "查看旧版 Eleven 提示词"}
              </button>
            ) : null}
          </div>
          <p className="demo-disclaimer">
            {standardAudio
              ? isSynced
                ? "当前图谱由这条声音分析得到，播放与逐字高亮使用同一时间轴。"
                : "你已经人工修改图谱，标准声音仍可播放，但可能不再完全对应最新图谱。"
              : "仅用于旧作品兼容；新作品统一使用 Voice Changer 生成的同源标准声音。"}
          </p>
        </div>
      </div>

      <div className="stage-footer-actions">
        <button type="button" className="text-button" onClick={onBack}>← 返回编辑</button>
        <button
          type="button"
          className="primary-button"
          disabled={!playback?.timeline}
          onClick={onContinue}
        >
          进入发布预览 <span aria-hidden="true">→</span>
        </button>
      </div>

      {!standardAudio ? (
        <ElevenPromptDebugDrawer
          debug={promptDebug}
          onClose={onClosePrompt}
          onCopy={onCopyPrompt}
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
          <p className="eyebrow">05 · 发布作品</p>
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
            <span className="cover-meta">抒情朗诵 · 舒缓 · 克制</span>
          </div>
          <div className="release-details">
            <p className="eyebrow">发布版本</p>
            <h3>{work.title} · v1</h3>
            <p>包含 {spec.sentences.length} 个图谱句、三层图谱、AI 标准朗诵和字符时间轴。</p>
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
            ["正文与控制谱一致", "导入时已逐字校验"],
            ["控制谱无阻塞错误", `${spec.sentences.length} 个图谱句`],
            ["标准 AI 朗诵可播放", standardAudio.label],
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
      <button type="button" className="text-button publish-back" onClick={onBack}>← 返回声音版本</button>
    </section>
  );
}

function StudioView({
  work,
  step,
  highestStep,
  editingSentenceId,
  analysisJobStatus,
  analysisStatus,
  isGenerating,
  isPromptDebugLoading,
  promptDebug,
  currentMs,
  activeTokenId,
  timeline,
  onStep,
  onWorkChange,
  onReferenceFile,
  onDeleteReference,
  onAnalyze,
  onManualImport,
  onImportControlSpec,
  onEditSentence,
  onCloseEditor,
  onSaveSentence,
  onPlaySentence,
  onSave,
  onGenerateStage,
  onGenerate,
  onViewPrompt,
  onClosePrompt,
  onCopyPrompt,
  onPublishStage,
  onPreview,
  onPublish,
}: {
  work: RecitationWork;
  step: WorkflowStep;
  highestStep: WorkflowStep;
  editingSentenceId: string | null;
  analysisJobStatus: AnalysisJobStatus;
  analysisStatus: string;
  isGenerating: boolean;
  isPromptDebugLoading: boolean;
  promptDebug: ElevenPromptDebugPayload | null;
  currentMs: number;
  activeTokenId?: string;
  timeline?: AudioTimeline;
  onStep: (step: WorkflowStep) => void;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAnalyze: () => void;
  onManualImport: () => void;
  onImportControlSpec: (jsonText: string) => Promise<void>;
  onEditSentence: (id: string) => void;
  onCloseEditor: () => void;
  onSaveSentence: (sentence: RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSave: () => void;
  onGenerateStage: () => void;
  onGenerate: () => void;
  onViewPrompt: () => void;
  onClosePrompt: () => void;
  onCopyPrompt: (text: string) => void;
  onPublishStage: () => void;
  onPreview: () => void;
  onPublish: () => void;
}) {
  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <div className="work-summary">
          <span className="work-monogram">{Array.from(work.title.trim())[0] ?? "声"}</span>
          <div>
            <small>正在创作</small>
            <strong>{work.title}</strong>
          </div>
          <button type="button" aria-label="更多作品选项">•••</button>
        </div>
        <WorkflowRail step={step} highestStep={highestStep} onStep={onStep} />
        <div className="sidebar-footer">
          <span>自动保存</span>
          <b>刚刚</b>
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
            onManualImport={onManualImport}
          />
        ) : null}
        {step === 2 ? (
          <ControlImportStage
            work={work}
            onImport={onImportControlSpec}
            onBack={() => onStep(1)}
          />
        ) : null}
        {step === 3 ? (
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
            onContinue={onGenerateStage}
          />
        ) : null}
        {step === 4 ? (
          <AudioStage
            work={work}
            isGenerating={isGenerating}
            isPromptDebugLoading={isPromptDebugLoading}
            promptDebug={promptDebug}
            onGenerate={onGenerate}
            onViewPrompt={onViewPrompt}
            onClosePrompt={onClosePrompt}
            onCopyPrompt={onCopyPrompt}
            onContinue={onPublishStage}
            onBack={() => onStep(3)}
          />
        ) : null}
        {step === 5 ? (
          <PublishStage
            work={work}
            onBack={() => onStep(4)}
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
}: {
  work: RecitationWork;
  currentMs: number;
  activeTokenId?: string;
  isPlaying: boolean;
  onPlayAll: () => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSeekSentence: (sentence: RecitationSentence) => void;
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
    <div className="viewer-shell">
      <section className="viewer-hero">
        <div className="hero-orb hero-orb-one" />
        <div className="hero-orb hero-orb-two" />
        <div className="viewer-hero-inner">
          <div className="viewer-breadcrumb">
            <span>作品库</span><b>›</b><strong>{work.title}</strong>
          </div>
          <div className="viewer-title-row">
            <div>
              <p className="eyebrow">朗诵情感图谱</p>
              <h1>{work.title}</h1>
              <p className="viewer-author">{work.author}</p>
            </div>
            <button type="button" className="hero-play" onClick={onPlayAll}>
              <span>{isPlaying ? "Ⅱ" : "▶"}</span>
              <div>
                <strong>{isPlaying ? "暂停示范" : "播放整篇"}</strong>
                <small>{formatTime(standardAudio.durationMs)} · 标准 AI 朗诵 · 逐字跟随</small>
              </div>
            </button>
          </div>
        </div>
      </section>

      <section className="viewer-content">
        <div className="viewer-section-heading">
          <div>
            <p className="eyebrow">三层情感图谱</p>
            <h2>跟着红字、停顿和声音曲线来听</h2>
          </div>
          <div className="legend viewer-legend">
            <span><i className="legend-focus" />表达焦点</span>
            <span><b>/</b> 短停</span>
            <span><b>{"///"}</b> 长停</span>
            <span><b>——</b> 拖音</span>
            <span><b>↗ ↘ →</b> 句尾语调</span>
          </div>
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
      </section>
    </div>
  );
}

export function RecitationStudio() {
  const [mode, setMode] = useState<ProductMode>("studio");
  const [work, setWork] = useState<RecitationWork>(() => createEmptyWork());
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [isWorkDirty, setIsWorkDirty] = useState(true);
  const [step, setStep] = useState<WorkflowStep>(1);
  const [editingSentenceId, setEditingSentenceId] = useState<string | null>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>("reference");
  const [analysisJobStatus, setAnalysisJobStatus] = useState<AnalysisJobStatus>("idle");
  const [analysisStatus, setAnalysisStatus] = useState("等待参考朗诵");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPromptDebugLoading, setIsPromptDebugLoading] = useState(false);
  const [promptDebug, setPromptDebug] = useState<ElevenPromptDebugPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [segmentEndMs, setSegmentEndMs] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const standardPlayback = work.standardAiAudio ?? work.aiDemoAudio;
  const activeTrack = audioSource === "reference" ? work.referenceAudio : standardPlayback;
  const analysisInFlight = analysisJobStatus === "queued" || analysisJobStatus === "processing";
  const highestStep = isWorkDirty || analysisInFlight ? 1 : highestAvailableStep(work);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const workId = params.get("work");
    if (!workId) return;
    let cancelled = false;
    const publishedQuery = params.get("view") === "1" ? "?published=1" : "";
    void fetch(`/api/works/${encodeURIComponent(workId)}${publishedQuery}`)
      .then((response) => apiJson<{ work: RecitationWork }>(response))
      .then(({ work: stored }) => {
        if (cancelled) return;
        setWork(stored);
        setIsWorkDirty(false);
        if (params.get("view") === "1") {
          setMode("viewer");
          setAudioSource("ai_demo");
        } else if (stored.controlSpec) {
          setStep(3);
          setAudioSource((stored.standardAiAudio ?? stored.aiDemoAudio)?.timeline ? "ai_demo" : "reference");
        } else {
          setStep(1);
          setAudioSource("reference");
          setAnalysisStatus(
            stored.standardAiAudio
              ? "标准 AI 声音已生成，等待完成分析"
              : stored.referenceAudio ? "真人参考朗诵已保存，可以开始生成与解析" : "等待参考朗诵",
          );
        }
      })
      .catch((error) => !cancelled && showToast(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, [showToast]);

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
    if (next <= 3) {
      setAudioSource(work.controlSpec && standardPlayback?.timeline ? "ai_demo" : "reference");
    }
    if (next >= 4 && standardPlayback) setAudioSource("ai_demo");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleWorkChange = (field: "title" | "author" | "sourceText", value: string) => {
    const sourceChanged = field === "sourceText" && value !== work.sourceText;
    const keepsLocalReference = Boolean(work.referenceAudio?.url.startsWith("blob:"));
    setIsWorkDirty(true);
    setAnalysisJobStatus("idle");
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
      updatedAt: new Date().toISOString(),
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
      if (work.referenceAudio?.url.startsWith("blob:")) URL.revokeObjectURL(work.referenceAudio.url);
      setReferenceFile(file);
      setIsWorkDirty(true);
      setAnalysisJobStatus("idle");
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
        updatedAt: new Date().toISOString(),
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
    if (work.referenceAudio?.url.startsWith("blob:")) URL.revokeObjectURL(work.referenceAudio.url);
    audioRef.current?.pause();
    setReferenceFile(null);
    setIsWorkDirty(true);
    setAnalysisJobStatus("idle");
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
      updatedAt: new Date().toISOString(),
    }));
    setStep(1);
    setAudioSource("reference");
    showToast("参考朗诵已从当前草稿移除");
  };

  const persistWorkRecord = async () => {
    if (!work.title.trim() || !work.sourceText.trim()) { showToast("请先填写作品名称和完整正文"); return; }
    const result = await apiJson<{ work: RecitationWork }>(
      await fetch("/api/works", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(!work.id.startsWith("draft-") ? { work_id: work.id } : {}),
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
    const url = new URL(window.location.href);
    url.searchParams.set("work", result.work.id);
    url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
    return result.work;
  };

  const handleManualImport = async () => {
    try {
      const saved = isWorkDirty || work.id.startsWith("draft-") ? await persistWorkRecord() : work;
      if (!saved) return;
      setStep(2);
      setAudioSource("reference");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
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
      let saved = await persistWorkRecord();
      if (!saved) throw new Error("作品正文保存失败。");

      if (referenceFile) {
        const form = new FormData();
        form.set("reference_audio_file", referenceFile);
        form.set("duration_ms", String(work.referenceAudio.durationMs));
        await apiJson<Record<string, unknown>>(
          await fetch(`/api/works/${encodeURIComponent(saved.id)}/reference-audio`, {
            method: "POST",
            body: form,
          }),
        );
        const refreshed = await apiJson<{ work: RecitationWork }>(
          await fetch(`/api/works/${encodeURIComponent(saved.id)}`),
        );
        if (!refreshed.work.referenceAudio) {
          throw new Error("参考朗诵上传后未能读取，请重新上传。");
        }
        if (work.referenceAudio.url.startsWith("blob:")) URL.revokeObjectURL(work.referenceAudio.url);
        saved = refreshed.work;
        setReferenceFile(null);
        setWork(saved);
      } else if (!saved.referenceAudio) {
        const refreshed = await apiJson<{ work: RecitationWork }>(
          await fetch(`/api/works/${encodeURIComponent(saved.id)}`),
        );
        saved = refreshed.work;
        if (!saved.referenceAudio) throw new Error("当前作品没有已保存的参考朗诵，请重新选择音频。");
        setWork(saved);
      }

      const created = await apiJson<AnalysisJobPayload>(
        await fetch(`/api/works/${encodeURIComponent(saved.id)}/analysis-jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      if (!created.analysis_job_id) throw new Error("分析任务创建失败：服务端没有返回任务编号。");
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
            throw new Error("分析任务已结束，但没有返回当前正文的控制谱。请重试或手动导入 JSON。");
          }
          setWork(completedWork);
          setIsWorkDirty(false);
          setAnalysisJobStatus("succeeded");
          setAnalysisStatus("标准 AI 朗诵解析完成，声音与图谱同源");
          setAudioSource("ai_demo");
          setStep(3);
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
      showToast(message);
    }
  };

  const handleImportControlSpec = async (jsonText: string) => {
    const parsed = parseControlSpecText(jsonText);
    const controlSpec = importControlSpec(
      parsed,
      work.sourceText,
      work.id,
      work.standardAiAudio?.id ?? work.referenceAudio?.id,
      work.referenceAudioOriginal?.id,
    );
    const result = await apiJson<{ work: RecitationWork; control_spec: ControlSpec }>(
      await fetch(`/api/works/${encodeURIComponent(work.id)}/control-spec`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ control_spec: controlSpec, source: "chatgpt_import" }),
      }),
    );
    setWork(result.work);
    setAudioSource(result.work.standardAiAudio?.timeline ? "ai_demo" : "reference");
    setStep(3);
    window.scrollTo({ top: 0, behavior: "smooth" });
    showToast(`控制谱已校验并保存：${result.control_spec.sentences.length} 句`);
  };

  const persistControlSpec = async (controlSpec: ControlSpec, message?: string) => {
    const result = await apiJson<{ work: RecitationWork }>(
      await fetch(`/api/works/${encodeURIComponent(work.id)}/control-spec`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ control_spec: controlSpec, source: "human" }),
      }),
    );
    setWork(result.work);
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
    setEditingSentenceId(null);
    setAudioSource(work.standardAiAudio?.timeline ? "ai_demo" : "reference");
    try {
      await persistControlSpec(nextSpec, `第 ${nextSentence.order} 句图谱已保存`);
    } catch (error) {
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
    audio.currentTime = timing.startMs / 1000;
    setCurrentMs(timing.startMs);
    setSegmentEndMs(timing.endMs);
    try { await audio.play(); } catch { showToast("浏览器暂时无法播放，请再点一次“听本句”"); }
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

  const handleViewElevenPrompt = async () => {
    if (isPromptDebugLoading) return;
    if (work.id.startsWith("draft-") || !work.controlSpec) {
      showToast("请先保存并确认控制谱");
      return;
    }
    setIsPromptDebugLoading(true);
    try {
      const result = await apiJson<ElevenPromptDebugPayload>(
        await fetch(`/api/works/${encodeURIComponent(work.id)}/ai-demo-prompt`),
      );
      setPromptDebug(result);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPromptDebugLoading(false);
    }
  };

  const handleCopyElevenPrompt = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("final_eleven_text 已复制");
    } catch {
      showToast("浏览器未允许复制，请在面板中手动选择文本");
    }
  };

  const handleGenerate = async () => {
    if (isGenerating) return;
    if (!work.controlSpec) { showToast("请先导入并确认情感图谱"); return; }
    if (work.standardAiAudio?.timeline) {
      setAudioSource("ai_demo");
      setSegmentEndMs(null);
      window.setTimeout(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.currentTime * 1000 >= work.standardAiAudio!.durationMs - 100) {
          audio.currentTime = 0;
          setCurrentMs(0);
        }
        void audio.play().catch(() => showToast("浏览器暂时无法播放，请再点一次试听"));
      }, 0);
      return;
    }
    setIsGenerating(true);
    try {
      const result = await apiJson<{ work: RecitationWork }>(
        await fetch(`/api/works/${encodeURIComponent(work.id)}/ai-demo`, { method: "POST" }),
      );
      setWork(result.work);
      setPromptDebug(null);
      setAudioSource("ai_demo");
      showToast("旧版 Eleven v3 示范与字符时间戳已保存");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePublish = async () => {
    try {
      const result = await apiJson<{ work: RecitationWork; public_url: string }>(
        await fetch(`/api/works/${encodeURIComponent(work.id)}/publish`, { method: "POST" }),
      );
      setWork(result.work);
      window.history.replaceState({}, "", result.public_url);
      setAudioSource("ai_demo");
      setMode("viewer");
      showToast("作品已发布，当前显示用户观看端");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const sentences = work.controlSpec?.sentences ?? [];
  const showPlayer = Boolean(
    standardPlayback?.timeline && work.controlSpec && (mode === "viewer" || step >= 3),
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
              setAudioSource(work.controlSpec && standardPlayback?.timeline ? "ai_demo" : "reference");
            }}
          ><span aria-hidden="true">✦</span> 创作端</button>
          <button
            type="button"
            className={mode === "viewer" ? "active" : ""}
            disabled={!standardPlayback?.timeline}
            onClick={() => { setAudioSource("ai_demo"); setMode("viewer"); }}
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
          isGenerating={isGenerating}
          isPromptDebugLoading={isPromptDebugLoading}
          promptDebug={promptDebug}
          currentMs={currentMs}
          activeTokenId={activeTokenId}
          timeline={activeTrack?.timeline}
          onStep={setWorkflowStep}
          onWorkChange={handleWorkChange}
          onReferenceFile={handleReferenceFile}
          onDeleteReference={handleDeleteReference}
          onAnalyze={handleAnalyze}
          onManualImport={handleManualImport}
          onImportControlSpec={handleImportControlSpec}
          onEditSentence={setEditingSentenceId}
          onCloseEditor={() => setEditingSentenceId(null)}
          onSaveSentence={saveSentence}
          onPlaySentence={playSentence}
          onSave={() => work.controlSpec && void persistControlSpec(work.controlSpec, "控制谱草稿已保存")}
          onGenerateStage={() => setWorkflowStep(4)}
          onGenerate={handleGenerate}
          onViewPrompt={handleViewElevenPrompt}
          onClosePrompt={() => setPromptDebug(null)}
          onCopyPrompt={(text) => void handleCopyElevenPrompt(text)}
          onPublishStage={() => setWorkflowStep(5)}
          onPreview={() => { setAudioSource("ai_demo"); setMode("viewer"); }}
          onPublish={handlePublish}
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
          hasAiDemo={Boolean(standardPlayback?.timeline)}
          compact={mode === "viewer"}
        />
      ) : null}

      <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">
        <span>{toast?.includes("失败") || toast?.includes("错误") ? "!" : "✓"}</span>{toast}
      </div>
    </main>
  );
}
