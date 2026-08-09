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
import { buildChatGptAnalysisPrompt } from "@/lib/analysis-package";
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

const workflowSteps: Array<{
  id: WorkflowStep;
  title: string;
  subtitle: string;
}> = [
  { id: 1, title: "准备作品", subtitle: "作品信息 · 正文 · 参考朗诵" },
  { id: 2, title: "声音分析", subtitle: "复制结果 · 导入控制谱" },
  { id: 3, title: "编辑图谱", subtitle: "人工复核 · 单句修正" },
  { id: 4, title: "生成示范", subtitle: "Eleven v3 · 时间戳" },
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

function highestAvailableStep(work: RecitationWork): WorkflowStep {
  if (work.aiDemoAudio?.timeline && work.controlSpec) return 5;
  if (work.controlSpec) return 4;
  if (work.analysisPackage) return 2;
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

interface CurveMetrics {
  width: number;
  height: number;
  trackStart: number;
  trackEnd: number;
  activeStart: number;
  activeEnd: number;
  coreStart: number;
  coreEnd: number;
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
    if (!track || !first || !last || !activeStart || !activeEnd || !coreStart || !coreEnd) return;

    const trackRect = track.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const activeStartRect = activeStart.getBoundingClientRect();
    const activeEndRect = activeEnd.getBoundingClientRect();
    const coreStartRect = coreStart.getBoundingClientRect();
    const coreEndRect = coreEnd.getBoundingClientRect();
    setMetrics({
      width: trackRect.width,
      height: 64,
      trackStart: firstRect.left - trackRect.left + firstRect.width / 2,
      trackEnd: lastRect.left - trackRect.left + lastRect.width / 2,
      activeStart: activeStartRect.left - trackRect.left,
      activeEnd: activeEndRect.right - trackRect.left,
      coreStart: coreStartRect.left - trackRect.left,
      coreEnd: coreEndRect.right - trackRect.left,
    });
  }, [lastSpokenIndex, prosody, spokenTokens]);

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
            {prosody ? (
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
  onFile,
  onDelete,
}: {
  audio?: AudioTrack;
  onFile: (file: File) => void;
  onDelete: () => void;
}) {
  return (
    <div className="paper-card reference-audio-card">
      <div className="card-title-row compact-title-row">
        <div>
          <p className="eyebrow">参考朗诵</p>
          <h2>声音依据</h2>
        </div>
        <span className="secure-note">仅创作端可见</span>
      </div>
      <p className="reference-explainer">
        参考朗诵是生成情感图谱的主要声音依据。请上传与正文逐字对应的优质朗诵。
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
          {/* Reference recitation has no separate caption asset; the exact transcript is shown beside it. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio className="reference-preview" controls preload="metadata" src={audio.url} />
          <div className="reference-actions">
            <label className="secondary-button replace-audio">
              替换音频
              <input
                className="visually-hidden"
                type="file"
                accept="audio/*,.wav,.m4a,.mp3"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) onFile(file);
                }}
              />
            </label>
            <button type="button" className="text-button delete-audio" onClick={onDelete}>
              删除音频
            </button>
          </div>
        </div>
      ) : (
        <label className="reference-dropzone">
          <input
            className="visually-hidden"
            type="file"
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
  const progress = Math.min(100, (currentMs / track.durationMs) * 100);
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
              ? `AI 示范 · ${title}`
              : `${source === "reference" ? "参考朗诵" : "AI 示范"}${activeSentence ? ` · 第 ${activeSentence.order} 句` : ""}`}
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
              参考
            </button>
            <button
              type="button"
              className={source === "ai_demo" ? "active" : ""}
              onClick={() => onSourceChange("ai_demo")}
            >
              AI 示范
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
          <strong>正式创作流程</strong>
          声音分析只提供事实；控制谱由你确认并导入，不会回退固定示例。
        </p>
      </div>
    </nav>
  );
}

function MaterialStage({
  work,
  isAnalyzing,
  analysisStatus,
  onWorkChange,
  onReferenceFile,
  onDeleteReference,
  onAnalyze,
}: {
  work: RecitationWork;
  isAnalyzing: boolean;
  analysisStatus: string;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAnalyze: () => void;
}) {
  const hasWorkInfo = Boolean(work.title.trim() && work.sourceText.trim());
  const canAnalyze = Boolean(work.referenceAudio && hasWorkInfo && !isAnalyzing);

  return (
    <section className="stage material-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">01 · 准备作品</p>
          <h1>把一段好朗诵，变成一张能听的声音地图</h1>
          <p className="stage-lead">
            填写准确正文并提供对应参考朗诵。系统会真实保存音频，对齐文字并提取精简的声音事实包。
          </p>
        </div>
        <span className="version-chip">控制谱 v1.1</span>
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
                onChange={(event) => onWorkChange("title", event.target.value)}
              />
            </label>
            <label>
              <span>作者 / 来源（可选）</span>
              <input
                value={work.author ?? ""}
                onChange={(event) => onWorkChange("author", event.target.value)}
              />
            </label>
          </div>
          <label className="text-field">
            <span>完整正文</span>
            <textarea
              rows={8}
              value={work.sourceText}
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
            onFile={onReferenceFile}
            onDelete={onDeleteReference}
          />

          <div className="analysis-card">
            <div className="analysis-orbit" aria-hidden="true">
              <span>声</span>
            </div>
            <div className="analysis-copy">
              <p className="eyebrow">声音解析</p>
              <h3>
                {isAnalyzing
                  ? analysisStatus
                  : work.referenceAudio
                    ? "参考朗诵已就绪"
                    : "等待参考朗诵"}
              </h3>
              <p>
                {isAnalyzing
                  ? "正在把声音表现转换为可编辑的情感图谱。"
                  : work.referenceAudio
                    ? "将对齐正文与声音，提取字符时间轴、停顿、时值、宏观音高与能量事实。"
                    : "请先提供与正文对应的优质朗诵音频。"}
              </p>
            </div>
            <button
              type="button"
              className="primary-button analyze-button"
              disabled={!canAnalyze}
              onClick={onAnalyze}
            >
              {isAnalyzing ? <span className="button-spinner" /> : <span aria-hidden="true">✦</span>}
              {isAnalyzing ? "解析中" : "解析参考朗诵"}
            </button>
          </div>
          {!work.referenceAudio ? (
            <p className="analysis-requirement" role="status">
              请先上传参考朗诵，系统将根据实际声音表现生成情感图谱。
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

function AnalysisResultStage({
  work,
  onImport,
  onBack,
  onNotify,
}: {
  work: RecitationWork;
  onImport: (jsonText: string) => Promise<void>;
  onBack: () => void;
  onNotify: (message: string) => void;
}) {
  const analysis = work.analysisPackage;
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  if (!analysis) return null;

  const copyAnalysis = async () => {
    try {
      await navigator.clipboard.writeText(buildChatGptAnalysisPrompt(analysis));
      onNotify("分析结果与控制谱要求已复制，可直接粘贴给 ChatGPT");
    } catch {
      onNotify("浏览器未允许复制，请使用“下载分析 JSON”保存结果");
    }
  };

  const downloadAnalysis = () => {
    const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${work.title || "朗诵"}-声音分析.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

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
          <p className="eyebrow">02 · 声音分析完成</p>
          <h1>声音事实已提取，等待导入控制谱</h1>
          <p className="stage-lead">
            将分析结果交给 ChatGPT 解释；拿到 control_spec JSON 后粘贴回来。网站会校验正文和每个 token index，绝不会擅自改写文稿。
          </p>
        </div>
        <span className="ready-badge"><i /> 分析完成</span>
      </div>

      <div className="analysis-result-grid">
        <div className="paper-card analysis-package-card">
          <div className="card-title-row">
            <div><p className="eyebrow">朗诵分析包</p><h2>{work.title}</h2></div>
            <span className="json-chip">JSON v{analysis.schema_version}</span>
          </div>
          <div className="analysis-facts">
            <span><strong>{analysis.tokens.length}</strong><small>字符时间戳</small></span>
            <span><strong>{analysis.pauses.length}</strong><small>明显停顿</small></span>
            <span><strong>{analysis.elongations.length}</strong><small>相对延长</small></span>
            <span><strong>{analysis.sentences.length}</strong><small>句段摘要</small></span>
          </div>
          <p className="analysis-package-note">
            已包含 Eleven 对齐质量、局部时值比、平滑宏观音高、明显能量变化与逐句摘要；不含逐帧 F0，也没有自动生成教学标签。
          </p>
          <div className="analysis-package-actions">
            <button type="button" className="primary-button" onClick={copyAnalysis}>复制分析结果</button>
            <button type="button" className="secondary-button" onClick={downloadAnalysis}>下载分析 JSON</button>
          </div>
        </div>

        <div className="paper-card control-import-card">
          <div className="card-title-row compact-title-row">
            <div><p className="eyebrow">导入控制谱</p><h2>粘贴 ChatGPT 返回的 JSON</h2></div>
          </div>
          <textarea
            aria-label="control spec JSON"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={'可直接粘贴纯 JSON，或包含在 ```json 代码块中的 JSON'}
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
  const currentProsody = primaryProsody(draft) ?? {
    id: `${draft.id}-prosody-manual`,
    type: "peak" as const,
    activeSpan: { start: sentenceMin, end: sentenceMax },
    coreZone: { start: sentenceMin, end: sentenceMax },
    strength: 2 as const,
  };
  const updateProsody = (change: Partial<ProsodyEvent>) => {
    const next = { ...currentProsody, ...change };
    setDraft({ ...draft, prosody: [next, ...draft.prosody.slice(1)] });
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
              <small>选择当前句的主要声音走向</small>
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
                onPlay={() => onPlaySentence(sentence)}
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

function AudioStage({
  work,
  isGenerating,
  onGenerate,
  onContinue,
  onBack,
}: {
  work: RecitationWork;
  isGenerating: boolean;
  onGenerate: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const spec = work.controlSpec;
  if (!spec) return null;
  const reference = work.referenceAudio;
  const aiDemo = work.aiDemoAudio;
  return (
    <section className="stage audio-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">04 · 示范声音</p>
          <h1>根据确认后的图谱，生成 AI 标准朗诵</h1>
          <p className="stage-lead">
            这一步读取已经确认的控制谱，单独生成 AI 示范音频及其字符时间轴。参考朗诵不会被覆盖。
          </p>
        </div>
        <span className="provider-chip">图谱版本 v{spec.version}</span>
      </div>

      <div className="audio-source-compare" aria-label="参考朗诵和 AI 示范">
        <div className="paper-card audio-source-card source-reference">
          <span className="source-kicker">分析依据</span>
          <strong>参考朗诵</strong>
          <p>{reference?.filename ?? "未提供"}</p>
          <small>{reference ? `${formatTime(reference.durationMs)} · 原始声音` : "返回第一步上传"}</small>
        </div>
        <span className="source-arrow" aria-hidden="true">→</span>
        <div className={`paper-card audio-source-card source-ai ${aiDemo ? "ready" : ""}`}>
          <span className="source-kicker">最终成品</span>
          <strong>AI 示范</strong>
          <p>{aiDemo?.filename ?? "等待生成"}</p>
          <small>{aiDemo ? `${formatTime(aiDemo.durationMs)} · 字符时间轴已就绪` : "由当前图谱生成"}</small>
        </div>
      </div>

      <div className="audio-grid audio-grid-single">
        <div className="paper-card generation-card">
          <div className="card-title-row">
            <div>
              <p className="eyebrow">当前生成版本</p>
              <h2>AI 标准朗诵</h2>
            </div>
            <span className={`status-pill ${aiDemo ? "ready" : ""}`}>
              {aiDemo ? "已生成" : "待生成"}
            </span>
          </div>

          <div className={`waveform ${isGenerating ? "generating" : ""}`} aria-hidden="true">
            {Array.from({ length: 68 }, (_, index) => (
              <span key={index} style={{ "--bar": `${20 + ((index * 37) % 70)}%` } as CSSProperties} />
            ))}
          </div>
          <div className="audio-metadata">
            <span>预计 00:12</span>
            <span>中文普通话</span>
            <span>{spec.sentences.length} 个图谱句</span>
            <span>字符级时间轴</span>
          </div>

          <button
            type="button"
            className="primary-button generate-wide"
            onClick={onGenerate}
            disabled={isGenerating}
          >
            {isGenerating ? <span className="button-spinner" /> : <span aria-hidden="true">✦</span>}
            {isGenerating ? "正在生成声音与时间轴" : aiDemo ? "重新生成 AI 示范" : "生成 AI 示范"}
          </button>
          <p className="demo-disclaimer">
            正式调用 Eleven v3 TTS with timestamps；生成失败会显示错误，不会使用占位音频。
          </p>
        </div>
      </div>

      <div className="stage-footer-actions">
        <button type="button" className="text-button" onClick={onBack}>← 返回编辑</button>
        <button
          type="button"
          className="primary-button"
          disabled={!aiDemo?.timeline}
          onClick={onContinue}
        >
          进入发布预览 <span aria-hidden="true">→</span>
        </button>
      </div>
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
  const aiDemo = work.aiDemoAudio;
  if (!spec || !aiDemo) return null;
  return (
    <section className="stage publish-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">05 · 发布作品</p>
          <h1>把创作参数收起来，只把“看得懂、听得到”交给用户</h1>
          <p className="stage-lead">
            发布会冻结当前控制谱、示范音频和时间轴。后续修改草稿，不会改变已经分享的版本。
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
            ["正文与音频一致", "已通过演示校验"],
            ["控制谱无阻塞错误", `${spec.sentences.length} 个图谱句`],
            ["AI 示范可播放", aiDemo.label],
            ["字符时间轴完整", "逐字高亮已就绪"],
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
  isAnalyzing,
  analysisStatus,
  isGenerating,
  currentMs,
  activeTokenId,
  timeline,
  onStep,
  onWorkChange,
  onReferenceFile,
  onDeleteReference,
  onAnalyze,
  onImportControlSpec,
  onEditSentence,
  onCloseEditor,
  onSaveSentence,
  onPlaySentence,
  onSave,
  onGenerateStage,
  onGenerate,
  onPublishStage,
  onPreview,
  onPublish,
  onNotify,
}: {
  work: RecitationWork;
  step: WorkflowStep;
  highestStep: WorkflowStep;
  editingSentenceId: string | null;
  isAnalyzing: boolean;
  analysisStatus: string;
  isGenerating: boolean;
  currentMs: number;
  activeTokenId?: string;
  timeline?: AudioTimeline;
  onStep: (step: WorkflowStep) => void;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onReferenceFile: (file: File) => void;
  onDeleteReference: () => void;
  onAnalyze: () => void;
  onImportControlSpec: (jsonText: string) => Promise<void>;
  onEditSentence: (id: string) => void;
  onCloseEditor: () => void;
  onSaveSentence: (sentence: RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSave: () => void;
  onGenerateStage: () => void;
  onGenerate: () => void;
  onPublishStage: () => void;
  onPreview: () => void;
  onPublish: () => void;
  onNotify: (message: string) => void;
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
            isAnalyzing={isAnalyzing}
            analysisStatus={analysisStatus}
            onWorkChange={onWorkChange}
            onReferenceFile={onReferenceFile}
            onDeleteReference={onDeleteReference}
            onAnalyze={onAnalyze}
          />
        ) : null}
        {step === 2 ? (
          <AnalysisResultStage
            work={work}
            onImport={onImportControlSpec}
            onBack={() => onStep(1)}
            onNotify={onNotify}
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
            onGenerate={onGenerate}
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
  const aiDemo = work.aiDemoAudio;
  if (!spec || !aiDemo?.timeline) {
    return (
      <div className="viewer-shell viewer-empty-shell">
        <section className="viewer-empty">
          <span aria-hidden="true">声</span>
          <p className="eyebrow">用户观看端</p>
          <h1>作品还没有可播放的 AI 示范</h1>
          <p>请先在创作端解析参考朗诵、确认情感图谱并生成 AI 示范。</p>
        </section>
      </div>
    );
  }
  const active = activeSentenceAt(spec.sentences, aiDemo.timeline, currentMs);

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
                <small>{formatTime(aiDemo.durationMs)} · AI 示范 · 逐字跟随</small>
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
  const [step, setStep] = useState<WorkflowStep>(1);
  const [editingSentenceId, setEditingSentenceId] = useState<string | null>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>("reference");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState("等待提交");
  const [isGenerating, setIsGenerating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [segmentEndMs, setSegmentEndMs] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeTrack = audioSource === "reference" ? work.referenceAudio : work.aiDemoAudio;
  const highestStep = highestAvailableStep(work);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const workId = params.get("work");
    if (!workId) return;
    let cancelled = false;
    void fetch(`/api/works/${encodeURIComponent(workId)}`)
      .then((response) => apiJson<{ work: RecitationWork }>(response))
      .then(({ work: stored }) => {
        if (cancelled) return;
        setWork(stored);
        if (params.get("view") === "1") {
          setMode("viewer");
          setAudioSource("ai_demo");
        } else if (stored.controlSpec) {
          setStep(stored.aiDemoAudio ? 5 : 3);
          setAudioSource(stored.aiDemoAudio ? "ai_demo" : "reference");
        } else if (stored.analysisPackage) {
          setStep(2);
          setAudioSource("reference");
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

  const activeSentence = useMemo(
    () => activeSentenceAt(work.controlSpec?.sentences ?? [], activeTrack?.timeline, currentMs),
    [activeTrack?.timeline, currentMs, work.controlSpec?.sentences],
  );
  const activeTokenId = activeSentence && activeTrack?.timeline
    ? activeTrack.timeline.tokens.find((token) => currentMs >= token.startMs && currentMs < token.endMs)?.tokenId
    : undefined;

  const setWorkflowStep = (next: WorkflowStep) => {
    if (next > highestStep) return;
    setStep(next);
    setEditingSentenceId(null);
    if (next <= 3) setAudioSource("reference");
    if (next >= 4 && work.aiDemoAudio) setAudioSource("ai_demo");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleWorkChange = (field: "title" | "author" | "sourceText", value: string) => {
    const sourceChanged = field === "sourceText" && value !== work.sourceText;
    setWork((current) => ({
      ...current,
      [field]: value,
      ...(sourceChanged ? {
        status: "draft" as const,
        analysisPackage: undefined,
        analysisJobId: undefined,
        controlSpec: undefined,
        currentSpecVersionId: undefined,
        aiDemoAudio: undefined,
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
      setWork((current) => ({
        ...current,
        status: "draft",
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
        analysisPackage: undefined,
        analysisJobId: undefined,
        controlSpec: undefined,
        currentSpecVersionId: undefined,
        aiDemoAudio: undefined,
        updatedAt: new Date().toISOString(),
      }));
      setStep(1);
      setAudioSource("reference");
      showToast(`${file.name} 已就绪；点击“解析参考朗诵”后会真实上传`);
    } catch {
      URL.revokeObjectURL(url);
      showToast("无法读取这段音频，请换用 WAV、M4A 或 MP3 文件");
    }
  };

  const handleDeleteReference = () => {
    if (work.referenceAudio?.url.startsWith("blob:")) URL.revokeObjectURL(work.referenceAudio.url);
    audioRef.current?.pause();
    setReferenceFile(null);
    setWork((current) => ({
      ...current,
      status: "draft",
      referenceAudio: undefined,
      analysisPackage: undefined,
      analysisJobId: undefined,
      controlSpec: undefined,
      currentSpecVersionId: undefined,
      aiDemoAudio: undefined,
      updatedAt: new Date().toISOString(),
    }));
    setStep(1);
    setAudioSource("reference");
    showToast("参考朗诵已从当前作品移除");
  };

  const obtainUploadFile = async () => {
    if (referenceFile) return referenceFile;
    if (!work.referenceAudio?.url.startsWith("/api/assets/")) return null;
    const response = await fetch(work.referenceAudio.url);
    if (!response.ok) throw new Error("无法从 R2 重新读取参考音频。");
    const blob = await response.blob();
    return new File([blob], work.referenceAudio.filename, { type: work.referenceAudio.mimeType || blob.type });
  };

  const handleAnalyze = async () => {
    if (isAnalyzing) return;
    if (!work.referenceAudio) { showToast("请先上传参考朗诵"); return; }
    if (!work.title.trim() || !work.sourceText.trim()) { showToast("请先填写作品名称和完整正文"); return; }
    setIsAnalyzing(true);
    setAnalysisStatus("正在上传正文与参考音频");
    setWork((current) => ({ ...current, status: "analyzing" }));
    try {
      const uploadFile = await obtainUploadFile();
      if (!uploadFile) throw new Error("参考音频只存在于浏览器预览中，请重新选择文件。");
      const form = new FormData();
      if (!work.id.startsWith("draft-")) form.set("work_id", work.id);
      form.set("title", work.title.trim());
      form.set("author", work.author?.trim() ?? "");
      form.set("full_text", work.sourceText);
      form.set("duration_ms", String(work.referenceAudio.durationMs));
      form.set("reference_audio_file", uploadFile);
      const created = await apiJson<{
        analysis_job_id: string;
        work_id: string;
        status: string;
        reference_audio: AudioTrack;
      }>(await fetch("/api/analysis-jobs", { method: "POST", body: form }));
      setReferenceFile(null);
      setWork((current) => ({
        ...current,
        id: created.work_id,
        analysisJobId: created.analysis_job_id,
        referenceAudio: created.reference_audio,
      }));
      const url = new URL(window.location.href);
      url.searchParams.set("work", created.work_id);
      url.searchParams.delete("view");
      window.history.replaceState({}, "", url);

      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        const job = await apiJson<{
          status: "queued" | "processing" | "succeeded" | "failed";
          progress: number;
          work?: RecitationWork;
          error?: { message?: string };
        }>(await fetch(`/api/analysis-jobs/${encodeURIComponent(created.analysis_job_id)}`));
        if (job.status === "failed") throw new Error(job.error?.message || "声音分析失败。");
        if (job.status === "succeeded" && job.work?.analysisPackage) {
          setWork(job.work);
          setAudioSource("reference");
          setStep(2);
          setAnalysisStatus("声音分析完成");
          window.scrollTo({ top: 0, behavior: "smooth" });
          showToast("声音分析完成；请复制结果到 ChatGPT 生成控制谱");
          return;
        }
        setAnalysisStatus(job.status === "queued" ? "等待音频分析服务" : "正在执行 Eleven 对齐与声学分析");
        await new Promise((resolve) => window.setTimeout(resolve, 1600));
      }
      throw new Error("声音分析等待超过 20 分钟，请稍后重新打开作品检查任务状态。");
    } catch (error) {
      setWork((current) => ({ ...current, status: "draft" }));
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleImportControlSpec = async (jsonText: string) => {
    if (!work.analysisPackage) throw new Error("当前作品还没有声音分析包。");
    const parsed = parseControlSpecText(jsonText);
    const controlSpec = importControlSpec(parsed, work.analysisPackage, work.id, work.referenceAudio?.id);
    const result = await apiJson<{ work: RecitationWork; control_spec: ControlSpec }>(
      await fetch(`/api/works/${encodeURIComponent(work.id)}/control-spec`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ control_spec: controlSpec, source: "chatgpt_import" }),
      }),
    );
    setWork(result.work);
    setAudioSource("reference");
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
    setWork((current) => ({ ...current, status: "review", controlSpec: nextSpec, aiDemoAudio: undefined }));
    setEditingSentenceId(null);
    setAudioSource("reference");
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
    const nextTrack = source === "reference" ? work.referenceAudio : work.aiDemoAudio;
    if (nextTrack) setAudioSource(source);
  };

  const handleGenerate = async () => {
    if (isGenerating) return;
    if (!work.controlSpec) { showToast("请先导入并确认情感图谱"); return; }
    setIsGenerating(true);
    try {
      const result = await apiJson<{ work: RecitationWork }>(
        await fetch(`/api/works/${encodeURIComponent(work.id)}/ai-demo`, { method: "POST" }),
      );
      setWork(result.work);
      setAudioSource("ai_demo");
      showToast("Eleven v3 AI 示范与真实字符时间戳已保存");
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
    activeTrack?.timeline && work.controlSpec && (mode === "viewer" || step >= 3),
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
            onClick={() => { setMode("studio"); if (step <= 3 || !work.aiDemoAudio) setAudioSource("reference"); }}
          ><span aria-hidden="true">✦</span> 创作端</button>
          <button
            type="button"
            className={mode === "viewer" ? "active" : ""}
            disabled={!work.aiDemoAudio?.timeline}
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
          isAnalyzing={isAnalyzing}
          analysisStatus={analysisStatus}
          isGenerating={isGenerating}
          currentMs={currentMs}
          activeTokenId={activeTokenId}
          timeline={activeTrack?.timeline}
          onStep={setWorkflowStep}
          onWorkChange={handleWorkChange}
          onReferenceFile={handleReferenceFile}
          onDeleteReference={handleDeleteReference}
          onAnalyze={handleAnalyze}
          onImportControlSpec={handleImportControlSpec}
          onEditSentence={setEditingSentenceId}
          onCloseEditor={() => setEditingSentenceId(null)}
          onSaveSentence={saveSentence}
          onPlaySentence={playSentence}
          onSave={() => work.controlSpec && void persistControlSpec(work.controlSpec, "控制谱草稿已保存")}
          onGenerateStage={() => setWorkflowStep(4)}
          onGenerate={handleGenerate}
          onPublishStage={() => setWorkflowStep(5)}
          onPreview={() => { setAudioSource("ai_demo"); setMode("viewer"); }}
          onPublish={handlePublish}
          onNotify={showToast}
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
          hasReference={Boolean(work.referenceAudio?.timeline)}
          hasAiDemo={Boolean(work.aiDemoAudio?.timeline)}
          compact={mode === "viewer"}
        />
      ) : null}

      <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">
        <span>{toast?.includes("失败") || toast?.includes("错误") ? "!" : "✓"}</span>{toast}
      </div>
    </main>
  );
}
