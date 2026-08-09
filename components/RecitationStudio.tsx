"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cloneDemoWork } from "@/lib/demo-work";
import {
  ENDING_LABELS,
  FOCUS_LABELS,
  PROSODY_LABELS,
  RHYTHM_LABELS,
  VOICE_LABELS,
  type EndingTone,
  type FocusRealization,
  type ProsodyType,
  type RecitationSentence,
  type RecitationWork,
  type Rhythm,
  type TimedToken,
  type VoiceQuality,
} from "@/lib/recitation-schema";

type ProductMode = "studio" | "viewer";
type WorkflowStep = 1 | 2 | 3 | 4;
type UploadKind = "manuscript" | "reference" | "knowledge";

const workflowSteps: Array<{
  id: WorkflowStep;
  title: string;
  subtitle: string;
}> = [
  { id: 1, title: "准备素材", subtitle: "文稿 · 参考音频 · 知识库" },
  { id: 2, title: "编辑图谱", subtitle: "控制谱与人工复核" },
  { id: 3, title: "生成示范", subtitle: "声音与字符时间轴" },
  { id: 4, title: "预览发布", subtitle: "冻结版本并分享" },
];

const prosodyOptions = Object.keys(PROSODY_LABELS) as ProsodyType[];
const rhythmOptions = Object.keys(RHYTHM_LABELS) as Rhythm[];
const endingOptions = Object.keys(ENDING_LABELS) as EndingTone[];
const voiceOptions = Object.keys(VOICE_LABELS) as VoiceQuality[];
const focusOptions = Object.keys(FOCUS_LABELS) as FocusRealization[];

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
  return new Set(sentence.focus.flatMap((target) => target.tokenIds));
}

function pauseAfter(sentence: RecitationSentence, tokenId: string) {
  return sentence.pauses.find((pause) => pause.afterTokenId === tokenId);
}

function prolongFor(sentence: RecitationSentence, tokenId: string) {
  return sentence.prolongs.find((prolong) => prolong.tokenId === tokenId);
}

function activeSentenceAt(sentences: RecitationSentence[], currentMs: number) {
  return (
    sentences.find(
      (sentence) =>
        currentMs >= sentence.timeRange.startMs &&
        currentMs < sentence.timeRange.endMs,
    ) ?? sentences.at(-1)
  );
}

function ProsodyCanvas({
  type,
  strength,
  anchorRatio,
  active,
}: {
  type: ProsodyType;
  strength: 1 | 2 | 3;
  anchorRatio: number;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);

      const width = rect.width;
      const height = rect.height;
      const pad = 10;
      const left = pad;
      const right = width - pad;
      const top = 10;
      const bottom = height - 12;
      const middle = height / 2;
      const amplitude = 11 + strength * 5;
      const anchor = Math.max(width * 0.22, Math.min(width * 0.78, width * anchorRatio));

      context.clearRect(0, 0, width, height);
      context.beginPath();
      context.setLineDash([3, 6]);
      context.moveTo(left, middle);
      context.lineTo(right, middle);
      context.strokeStyle = "rgba(78, 75, 68, 0.16)";
      context.lineWidth = 1;
      context.stroke();
      context.setLineDash([]);

      const path = new Path2D();
      let anchorY = middle;
      if (type === "crest") {
        anchorY = Math.max(top, middle - amplitude);
        path.moveTo(left, middle + 7);
        path.bezierCurveTo(width * 0.18, middle + 5, anchor - width * 0.16, anchorY, anchor, anchorY);
        path.bezierCurveTo(anchor + width * 0.17, anchorY, width * 0.8, middle + 8, right, middle + 10);
      } else if (type === "trough") {
        anchorY = Math.min(bottom, middle + amplitude);
        path.moveTo(left, middle - 6);
        path.bezierCurveTo(width * 0.2, middle - 4, anchor - width * 0.16, anchorY, anchor, anchorY);
        path.bezierCurveTo(anchor + width * 0.18, anchorY, width * 0.82, middle - 7, right, middle - 8);
      } else if (type === "rising") {
        anchorY = Math.max(top, middle - amplitude);
        path.moveTo(left, bottom - 2);
        path.bezierCurveTo(width * 0.34, bottom - 5, width * 0.7, middle + 3, right, anchorY);
      } else {
        anchorY = Math.min(bottom, middle + amplitude);
        path.moveTo(left, top + 2);
        path.bezierCurveTo(width * 0.3, top + 5, width * 0.7, middle - 2, right, anchorY);
      }

      const gradient = context.createLinearGradient(left, 0, right, 0);
      gradient.addColorStop(0, active ? "#dc6a4d" : "#9c8278");
      gradient.addColorStop(0.55, active ? "#bd3f2d" : "#755e56");
      gradient.addColorStop(1, active ? "#e29a59" : "#ad8b75");
      context.strokeStyle = gradient;
      context.lineWidth = active ? 3.5 : 2.5;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.shadowColor = active ? "rgba(189, 63, 45, 0.2)" : "transparent";
      context.shadowBlur = active ? 8 : 0;
      context.stroke(path);
      context.shadowBlur = 0;

      const dotX = type === "rising" || type === "falling" ? right : anchor;
      context.beginPath();
      context.arc(dotX, anchorY, active ? 4.5 : 3.5, 0, Math.PI * 2);
      context.fillStyle = active ? "#bd3f2d" : "#81665d";
      context.fill();
      context.beginPath();
      context.arc(dotX, anchorY, active ? 8 : 6.5, 0, Math.PI * 2);
      context.strokeStyle = active ? "rgba(189, 63, 45, 0.22)" : "rgba(129, 102, 93, 0.16)";
      context.lineWidth = 2;
      context.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [type, strength, anchorRatio, active]);

  return (
    <canvas
      ref={canvasRef}
      className="prosody-canvas"
      role="img"
      aria-label={`${PROSODY_LABELS[type]}语势，强度 ${strength}`}
    />
  );
}

function ToneArrow({ type }: { type: EndingTone }) {
  return (
    <span className={`tone-arrow tone-${type}`} aria-label={ENDING_LABELS[type]}>
      {type === "rise" ? "↗" : type === "fall" ? "↘" : "→"}
    </span>
  );
}

function TokenRow({
  sentence,
  layer,
  activeTokenId,
  editable,
  onTokenClick,
}: {
  sentence: RecitationSentence;
  layer: "pinyin" | "text";
  activeTokenId?: string;
  editable?: boolean;
  onTokenClick?: (token: TimedToken) => void;
}) {
  const focused = focusSet(sentence);

  return (
    <div
      className={`token-row ${layer === "pinyin" ? "pinyin-row" : "text-row"}`}
      style={{ "--token-count": sentence.tokens.length } as CSSProperties}
    >
      {sentence.tokens.map((token, index) => {
        const pause = pauseAfter(sentence, token.id);
        const prolong = prolongFor(sentence, token.id);
        const tokenClass = [
          "token-cell",
          focused.has(token.id) ? "focus-token" : "",
          activeTokenId === token.id ? "playing-token" : "",
          punctuationOnly(token.char) ? "punctuation-token" : "",
          prolong ? "prolong-token" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (layer === "pinyin") {
          return (
            <span className={tokenClass} key={token.id} aria-hidden="true">
              {token.pinyin ? (
                <>
                  {token.pinyin}
                  <sup>{token.tone === 0 ? "·" : token.tone}</sup>
                </>
              ) : (
                " "
              )}
            </span>
          );
        }

        const content = (
          <>
            <span className="token-char">{token.char}</span>
            {prolong ? <span className="prolong-mark">—</span> : null}
            {pause ? (
              <span className={`pause-mark pause-${pause.type}`}>
                {pause.type === "long" ? "///" : "/"}
              </span>
            ) : null}
            {index === sentence.tokens.length - 1 ? (
              <ToneArrow type={sentence.endingTone.type} />
            ) : null}
          </>
        );

        return editable && !punctuationOnly(token.char) ? (
          <button
            className={`${tokenClass} editable-token`}
            key={token.id}
            type="button"
            aria-label={`${focused.has(token.id) ? "取消" : "设为"}表达焦点：${token.char}`}
            aria-pressed={focused.has(token.id)}
            onClick={() => onTokenClick?.(token)}
          >
            {content}
          </button>
        ) : (
          <span className={tokenClass} key={token.id}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

function GraphSentence({
  sentence,
  selected,
  active,
  activeTokenId,
  editable,
  onSelect,
  onTokenClick,
  onPlay,
}: {
  sentence: RecitationSentence;
  selected?: boolean;
  active?: boolean;
  activeTokenId?: string;
  editable?: boolean;
  onSelect?: () => void;
  onTokenClick?: (token: TimedToken) => void;
  onPlay?: () => void;
}) {
  const anchorIndex = Math.max(
    0,
    sentence.tokens.findIndex((token) =>
      sentence.prosody.anchorTokenIds.includes(token.id),
    ),
  );
  const anchorRatio = (anchorIndex + 0.5) / Math.max(1, sentence.tokens.length);

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
          <span className={`prosody-tag prosody-${sentence.prosody.type}`}>
            {PROSODY_LABELS[sentence.prosody.type]}
          </span>
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

      <div className="graph-layers">
        <span className="layer-label">拼音</span>
        <div className="layer-content scrollable-layer">
          <TokenRow sentence={sentence} layer="pinyin" activeTokenId={activeTokenId} />
        </div>

        <span className="layer-label layer-label-strong">文稿</span>
        <div className="layer-content scrollable-layer">
          <TokenRow
            sentence={sentence}
            layer="text"
            activeTokenId={activeTokenId}
            editable={editable}
            onTokenClick={onTokenClick}
          />
        </div>

        <span className="layer-label">语势</span>
        <div className="layer-content curve-layer">
          <ProsodyCanvas
            type={sentence.prosody.type}
            strength={sentence.prosody.strength}
            anchorRatio={anchorRatio}
            active={Boolean(active)}
          />
          <span className="curve-caption">
            {PROSODY_LABELS[sentence.prosody.type]} · 强度 {sentence.prosody.strength}
          </span>
        </div>
      </div>
    </div>
  );
}

function UploadCard({
  kind,
  icon,
  title,
  helper,
  accept,
  filename,
  onFile,
}: {
  kind: UploadKind;
  icon: string;
  title: string;
  helper: string;
  accept: string;
  filename?: string;
  onFile: (kind: UploadKind, file: File) => void;
}) {
  return (
    <label className={`upload-card ${filename ? "has-file" : ""}`}>
      <input
        className="visually-hidden"
        type="file"
        accept={accept}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(kind, file);
        }}
      />
      <span className="upload-icon" aria-hidden="true">
        {filename ? "✓" : icon}
      </span>
      <span className="upload-copy">
        <strong>{filename ?? title}</strong>
        <small>{filename ? "已选择，可随时替换" : helper}</small>
      </span>
      <span className="upload-action">{filename ? "替换" : "选择文件"}</span>
    </label>
  );
}

function Player({
  work,
  currentMs,
  isPlaying,
  playbackRate,
  onToggle,
  onSeek,
  onRateChange,
  compact = false,
}: {
  work: RecitationWork;
  currentMs: number;
  isPlaying: boolean;
  playbackRate: number;
  onToggle: () => void;
  onSeek: (value: number) => void;
  onRateChange: (rate: number) => void;
  compact?: boolean;
}) {
  const progress = Math.min(100, (currentMs / work.audio.durationMs) * 100);
  const activeSentence = activeSentenceAt(work.controlSpec.sentences, currentMs);

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
            {compact ? work.title : `正在示范 · 第 ${activeSentence?.order ?? 1} 句`}
          </span>
          <strong>{activeSentence?.text ?? work.title}</strong>
        </div>
        <label className="progress-wrap">
          <span className="visually-hidden">播放进度</span>
          <input
            type="range"
            min={0}
            max={work.audio.durationMs}
            value={Math.min(currentMs, work.audio.durationMs)}
            onChange={(event) => onSeek(Number(event.target.value))}
            style={{ "--progress": `${progress}%` } as CSSProperties}
          />
        </label>
        <div className="time-row">
          <span>{formatTime(currentMs)}</span>
          <span>{formatTime(work.audio.durationMs)}</span>
        </div>
      </div>
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
          <strong>当前为纵向切片</strong>
          真实 AI 接入后，这套编辑器和观看端无需重做。
        </p>
      </div>
    </nav>
  );
}

function MaterialStage({
  work,
  uploads,
  isAnalyzing,
  analysisStatus,
  onWorkChange,
  onFile,
  onAnalyze,
}: {
  work: RecitationWork;
  uploads: Partial<Record<UploadKind, string>>;
  isAnalyzing: boolean;
  analysisStatus: string;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onFile: (kind: UploadKind, file: File) => void;
  onAnalyze: () => void;
}) {
  return (
    <section className="stage material-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">01 · 准备一篇作品</p>
          <h1>把一段好朗诵，变成一张能听的声音地图</h1>
          <p className="stage-lead">
            原文、参考声音与教学知识会一起进入分析。AI 先做初稿，老师只负责关键判断。
          </p>
        </div>
        <span className="version-chip">控制谱 v1.0</span>
      </div>

      <div className="material-grid">
        <div className="paper-card manuscript-card">
          <div className="card-title-row">
            <div>
              <p className="eyebrow">作品信息</p>
              <h2>文稿</h2>
            </div>
            <span className="draft-pill">草稿</span>
          </div>
          <div className="field-row two-fields">
            <label>
              <span>作品名</span>
              <input
                value={work.title}
                onChange={(event) => onWorkChange("title", event.target.value)}
              />
            </label>
            <label>
              <span>作者 / 来源</span>
              <input
                value={work.author ?? ""}
                onChange={(event) => onWorkChange("author", event.target.value)}
              />
            </label>
          </div>
          <label className="text-field">
            <span>正文</span>
            <textarea
              rows={8}
              value={work.sourceText}
              onChange={(event) => onWorkChange("sourceText", event.target.value)}
            />
          </label>
          <div className="manuscript-footer">
            <span>{Array.from(work.sourceText).filter((char) => !/\s/.test(char)).length} 字</span>
            <span>建议 1～3 分钟</span>
            <span className="matched-copy">✓ 演示稿已匹配</span>
          </div>
        </div>

        <div className="asset-column">
          <div className="paper-card asset-card">
            <div className="card-title-row compact-title-row">
              <div>
                <p className="eyebrow">输入素材</p>
                <h2>参考与知识</h2>
              </div>
              <span className="secure-note">仅创作端可见</span>
            </div>
            <div className="upload-stack">
              <UploadCard
                kind="manuscript"
                icon="文"
                title="上传完整文稿"
                helper="TXT / MD / DOCX / PDF"
                accept=".txt,.md,.doc,.docx,.pdf"
                filename={uploads.manuscript}
                onFile={onFile}
              />
              <UploadCard
                kind="reference"
                icon="声"
                title="上传优质参考朗诵"
                helper="WAV / M4A / MP3，单人清晰人声最佳"
                accept="audio/*,.wav,.m4a,.mp3"
                filename={uploads.reference}
                onFile={onFile}
              />
              <UploadCard
                kind="knowledge"
                icon="知"
                title="选择朗诵知识库"
                helper="规则、课程讲义与典型案例"
                accept=".txt,.md,.doc,.docx,.pdf,.xls,.xlsx"
                filename={uploads.knowledge}
                onFile={onFile}
              />
            </div>
          </div>

          <div className="analysis-card">
            <div className="analysis-orbit" aria-hidden="true">
              <span>声</span>
            </div>
            <div className="analysis-copy">
              <p className="eyebrow">AI 反向分析</p>
              <h3>{isAnalyzing ? analysisStatus : "素材已具备演示条件"}</h3>
              <p>
                {isAnalyzing
                  ? "正在把声音证据翻译成可编辑控制谱。"
                  : "将提取文字时间轴、停顿、语势与表达焦点，再结合知识库生成初稿。"}
              </p>
            </div>
            <button
              type="button"
              className="primary-button analyze-button"
              disabled={isAnalyzing}
              onClick={onAnalyze}
            >
              {isAnalyzing ? <span className="button-spinner" /> : <span aria-hidden="true">✦</span>}
              {isAnalyzing ? "分析中" : "生成控制谱"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function EditorInspector({
  sentence,
  onChange,
}: {
  sentence: RecitationSentence;
  onChange: (updater: (sentence: RecitationSentence) => RecitationSentence) => void;
}) {
  const primaryFocus = sentence.focus[0];
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">句子 {String(sentence.order).padStart(2, "0")}</p>
          <h2>朗诵导演台</h2>
        </div>
        <span className="confidence-chip">{Math.round(sentence.confidence * 100)}% 可信</span>
      </div>

      <div className="inspector-section">
        <div className="section-label-row">
          <span className="control-label">主要语势</span>
          <span>一条句子选一种</span>
        </div>
        <div className="choice-grid four-choices">
          {prosodyOptions.map((option) => (
            <button
              type="button"
              key={option}
              className={sentence.prosody.type === option ? "chosen" : ""}
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  prosody: { ...current.prosody, type: option },
                }))
              }
            >
              <span className={`mini-curve mini-${option}`} aria-hidden="true" />
              {PROSODY_LABELS[option]}
            </button>
          ))}
        </div>
        <label className="range-field">
          <span>
            语势强度 <strong>{sentence.prosody.strength}</strong>
          </span>
          <input
            type="range"
            min={1}
            max={3}
            value={sentence.prosody.strength}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                prosody: {
                  ...current.prosody,
                  strength: Number(event.target.value) as 1 | 2 | 3,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="inspector-section split-controls">
        <label>
          <span>句尾语调</span>
          <select
            value={sentence.endingTone.type}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                endingTone: {
                  ...current.endingTone,
                  type: event.target.value as EndingTone,
                },
              }))
            }
          >
            {endingOptions.map((option) => (
              <option key={option} value={option}>
                {ENDING_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>节奏</span>
          <select
            value={sentence.rhythm}
            onChange={(event) =>
              onChange((current) => ({ ...current, rhythm: event.target.value as Rhythm }))
            }
          >
            {rhythmOptions.map((option) => (
              <option key={option} value={option}>
                {RHYTHM_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="inspector-section">
        <div className="section-label-row">
          <span className="control-label">表达焦点</span>
          <span>点击左侧文字切换红字</span>
        </div>
        <label className="select-field">
          <span>推荐实现方式</span>
          <select
            value={primaryFocus?.preferredRealization ?? "free"}
            disabled={!primaryFocus}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                focus: current.focus.map((item, index) =>
                  index === 0
                    ? {
                        ...item,
                        preferredRealization: event.target.value as FocusRealization,
                      }
                    : item,
                ),
              }))
            }
          >
            {focusOptions.map((option) => (
              <option key={option} value={option}>
                {FOCUS_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="inspector-section split-controls">
        <label>
          <span>句首声音</span>
          <select
            value={sentence.voiceQuality.start}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                voiceQuality: {
                  ...current.voiceQuality,
                  start: event.target.value as VoiceQuality,
                },
              }))
            }
          >
            {voiceOptions.map((option) => (
              <option key={option} value={option}>
                {VOICE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>句尾声音</span>
          <select
            value={sentence.voiceQuality.end}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                voiceQuality: {
                  ...current.voiceQuality,
                  end: event.target.value as VoiceQuality,
                },
              }))
            }
          >
            {voiceOptions.map((option) => (
              <option key={option} value={option}>
                {VOICE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="inspector-section">
        <label className="text-field cue-field">
          <span>教师口令</span>
          <textarea
            rows={4}
            value={sentence.teachingCue}
            onChange={(event) =>
              onChange((current) => ({ ...current, teachingCue: event.target.value }))
            }
          />
        </label>
      </div>

      <div className="inspector-tip">
        <span aria-hidden="true">i</span>
        <p>
          红字表示“要成为听觉焦点”，并不规定必须提高音量。声音质感保存在控制层，不增加学习页符号。
        </p>
      </div>
    </aside>
  );
}

function EditorStage({
  work,
  selectedSentenceId,
  currentMs,
  activeTokenId,
  onSelectSentence,
  onTokenClick,
  onSentenceChange,
  onPlaySentence,
  onSave,
  onContinue,
}: {
  work: RecitationWork;
  selectedSentenceId: string;
  currentMs: number;
  activeTokenId?: string;
  onSelectSentence: (id: string) => void;
  onTokenClick: (sentenceId: string, token: TimedToken) => void;
  onSentenceChange: (
    id: string,
    updater: (sentence: RecitationSentence) => RecitationSentence,
  ) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSave: () => void;
  onContinue: () => void;
}) {
  const selected =
    work.controlSpec.sentences.find((item) => item.id === selectedSentenceId) ??
    work.controlSpec.sentences[0];
  const active = activeSentenceAt(work.controlSpec.sentences, currentMs);

  return (
    <section className="stage editor-stage">
      <div className="stage-heading editor-heading">
        <div>
          <p className="eyebrow">02 · 人工复核</p>
          <h1>AI 做初稿，老师决定它究竟该怎么读</h1>
          <p className="stage-lead">
            点击文稿中的字切换表达焦点；选择句子后，可在右侧调整语势、节奏与隐藏的声音质感。
          </p>
        </div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={onSave}>
            保存草稿
          </button>
          <button type="button" className="primary-button" onClick={onContinue}>
            生成示范音频 <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <div className="editor-layout">
        <div className="graph-editor">
          <div className="graph-toolbar">
            <div>
              <span className="toolbar-title">三层情感图谱</span>
              <span className="toolbar-subtitle">4 个图谱句 · 控制谱 v{work.controlSpec.version}</span>
            </div>
            <div className="legend compact-legend">
              <span><i className="legend-focus" />表达焦点</span>
              <span><b>/</b> 短停</span>
              <span><b>{"///"}</b> 长停</span>
              <span><b>↘</b> 句尾</span>
            </div>
          </div>
          <div className="graph-list editor-graph-list">
            {work.controlSpec.sentences.map((sentence) => (
              <GraphSentence
                key={sentence.id}
                sentence={sentence}
                selected={selected.id === sentence.id}
                active={active?.id === sentence.id && currentMs > 0}
                activeTokenId={active?.id === sentence.id ? activeTokenId : undefined}
                editable
                onSelect={() => onSelectSentence(sentence.id)}
                onTokenClick={(token) => onTokenClick(sentence.id, token)}
                onPlay={() => onPlaySentence(sentence)}
              />
            ))}
          </div>
        </div>
        <EditorInspector
          sentence={selected}
          onChange={(updater) => onSentenceChange(selected.id, updater)}
        />
      </div>
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
  const firstSentence = work.controlSpec.sentences[0];
  return (
    <section className="stage audio-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">03 · 示范声音</p>
          <h1>从同一份控制谱，编译出可追溯的标准朗诵</h1>
          <p className="stage-lead">
            正式版会生成多个 Eleven v3 候选并保存字符级时间戳；当前先用占位声音验证完整播放体验。
          </p>
        </div>
        <span className="provider-chip">ELEVEN v3 · ADAPTER READY</span>
      </div>

      <div className="audio-grid">
        <div className="paper-card generation-card">
          <div className="card-title-row">
            <div>
              <p className="eyebrow">当前生成版本</p>
              <h2>标准朗诵 · 候选 A</h2>
            </div>
            <span className={`status-pill ${work.status === "audio_ready" ? "ready" : ""}`}>
              {work.status === "audio_ready" ? "已生成" : "待生成"}
            </span>
          </div>

          <div className={`waveform ${isGenerating ? "generating" : ""}`} aria-hidden="true">
            {Array.from({ length: 68 }, (_, index) => (
              <span key={index} style={{ "--bar": `${20 + ((index * 37) % 70)}%` } as CSSProperties} />
            ))}
          </div>
          <div className="audio-metadata">
            <span>预计 00:12</span>
            <span>中文 · 女声</span>
            <span>Natural</span>
            <span>{work.controlSpec.sentences.length} 个图谱句</span>
          </div>

          <button
            type="button"
            className="primary-button generate-wide"
            onClick={onGenerate}
            disabled={isGenerating}
          >
            {isGenerating ? <span className="button-spinner" /> : <span aria-hidden="true">✦</span>}
            {isGenerating ? "正在编译控制谱与时间轴" : work.status === "audio_ready" ? "重新生成候选" : "生成示范音频"}
          </button>
          <p className="demo-disclaimer">
            当前音频由本机中文声音生成，仅用于交互开发；不会冒充最终 Eleven 朗诵效果。
          </p>
        </div>

        <div className="paper-card compiler-card">
          <div className="card-title-row compact-title-row">
            <div>
              <p className="eyebrow">TTS 编译预览</p>
              <h2>供应商适配层</h2>
            </div>
            <span className="json-chip">JSON → PROMPT</span>
          </div>
          <div className="prompt-preview">
            <span className="prompt-tag">[poetic, warm, restrained, moderately slow, smooth and continuous]</span>
            <p>{firstSentence.text}</p>
          </div>
          <dl className="compiler-facts">
            <div><dt>语势</dt><dd>{PROSODY_LABELS[firstSentence.prosody.type]} · 强度 {firstSentence.prosody.strength}</dd></div>
            <div><dt>焦点</dt><dd>月光下的中国 · 综合实现</dd></div>
            <div><dt>句尾</dt><dd>{ENDING_LABELS[firstSentence.endingTone.type]}</dd></div>
            <div><dt>声音</dt><dd>{VOICE_LABELS[firstSentence.voiceQuality.start]} → {VOICE_LABELS[firstSentence.voiceQuality.end]}</dd></div>
          </dl>
          <div className="adapter-row">
            <span className="adapter active">Eleven v3 <b>优先</b></span>
            <span className="adapter">Fish <b>预留</b></span>
            <span className="adapter">Qwen <b>预留</b></span>
          </div>
        </div>
      </div>

      <div className="stage-footer-actions">
        <button type="button" className="text-button" onClick={onBack}>← 返回编辑</button>
        <button
          type="button"
          className="primary-button"
          disabled={work.status !== "audio_ready"}
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
  return (
    <section className="stage publish-stage">
      <div className="stage-heading">
        <div>
          <p className="eyebrow">04 · 发布作品</p>
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
            <p>包含 4 个图谱句、三层图谱、标准示范音频和字符时间轴。</p>
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
            ["控制谱无阻塞错误", `${work.controlSpec.sentences.length} 个图谱句`],
            ["示范音频可播放", work.audio.label],
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
  selectedSentenceId,
  uploads,
  isAnalyzing,
  analysisStatus,
  isGenerating,
  currentMs,
  activeTokenId,
  onStep,
  onWorkChange,
  onFile,
  onAnalyze,
  onSelectSentence,
  onTokenClick,
  onSentenceChange,
  onPlaySentence,
  onSave,
  onGenerateStage,
  onGenerate,
  onPublishStage,
  onPreview,
  onPublish,
}: {
  work: RecitationWork;
  step: WorkflowStep;
  highestStep: WorkflowStep;
  selectedSentenceId: string;
  uploads: Partial<Record<UploadKind, string>>;
  isAnalyzing: boolean;
  analysisStatus: string;
  isGenerating: boolean;
  currentMs: number;
  activeTokenId?: string;
  onStep: (step: WorkflowStep) => void;
  onWorkChange: (field: "title" | "author" | "sourceText", value: string) => void;
  onFile: (kind: UploadKind, file: File) => void;
  onAnalyze: () => void;
  onSelectSentence: (id: string) => void;
  onTokenClick: (sentenceId: string, token: TimedToken) => void;
  onSentenceChange: (id: string, updater: (sentence: RecitationSentence) => RecitationSentence) => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
  onSave: () => void;
  onGenerateStage: () => void;
  onGenerate: () => void;
  onPublishStage: () => void;
  onPreview: () => void;
  onPublish: () => void;
}) {
  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <div className="work-summary">
          <span className="work-monogram">月</span>
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
            uploads={uploads}
            isAnalyzing={isAnalyzing}
            analysisStatus={analysisStatus}
            onWorkChange={onWorkChange}
            onFile={onFile}
            onAnalyze={onAnalyze}
          />
        ) : null}
        {step === 2 ? (
          <EditorStage
            work={work}
            selectedSentenceId={selectedSentenceId}
            currentMs={currentMs}
            activeTokenId={activeTokenId}
            onSelectSentence={onSelectSentence}
            onTokenClick={onTokenClick}
            onSentenceChange={onSentenceChange}
            onPlaySentence={onPlaySentence}
            onSave={onSave}
            onContinue={onGenerateStage}
          />
        ) : null}
        {step === 3 ? (
          <AudioStage
            work={work}
            isGenerating={isGenerating}
            onGenerate={onGenerate}
            onContinue={onPublishStage}
            onBack={() => onStep(2)}
          />
        ) : null}
        {step === 4 ? (
          <PublishStage
            work={work}
            onBack={() => onStep(3)}
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
}: {
  work: RecitationWork;
  currentMs: number;
  activeTokenId?: string;
  isPlaying: boolean;
  onPlayAll: () => void;
  onPlaySentence: (sentence: RecitationSentence) => void;
}) {
  const [expandedSentenceId, setExpandedSentenceId] = useState<string | null>("s001");
  const active = activeSentenceAt(work.controlSpec.sentences, currentMs);
  const profile = work.controlSpec.documentProfile;

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
              <p className="eyebrow">智能朗诵谱 · 样章</p>
              <h1>{work.title}</h1>
              <p className="viewer-author">{work.author}</p>
              <div className="profile-tags">
                <span>抒情朗诵</span>
                <span>{RHYTHM_LABELS[profile.baseRhythm]}</span>
                {profile.emotionalTone.map((tone) => <span key={tone}>{tone}</span>)}
                <span>{VOICE_LABELS[profile.voiceQuality]}</span>
              </div>
            </div>
            <button type="button" className="hero-play" onClick={onPlayAll}>
              <span>{isPlaying ? "Ⅱ" : "▶"}</span>
              <div>
                <strong>{isPlaying ? "暂停示范" : "播放整篇"}</strong>
                <small>约 12 秒 · 逐字跟随</small>
              </div>
            </button>
          </div>
          <div className="reading-guide">
            <span className="guide-mark">读</span>
            <p><strong>本篇怎么读</strong>从宁静低位进入，保持温暖与克制；中段柔中见力，最后把画面轻轻收住。</p>
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
          {work.controlSpec.sentences.map((sentence) => {
            const isActive = active?.id === sentence.id && currentMs > 0;
            const expanded = expandedSentenceId === sentence.id;
            return (
              <div className="viewer-sentence-wrap" key={sentence.id}>
                <GraphSentence
                  sentence={sentence}
                  active={isActive}
                  activeTokenId={isActive ? activeTokenId : undefined}
                  onSelect={() => setExpandedSentenceId(expanded ? null : sentence.id)}
                  onPlay={() => onPlaySentence(sentence)}
                />
                <div className={`teaching-drawer ${expanded ? "expanded" : ""}`}>
                  <span className="drawer-line" />
                  <div>
                    <p className="eyebrow">读法提示</p>
                    <strong>{sentence.teachingCue}</strong>
                  </div>
                  <div className="avoid-note">
                    <span>避免</span>
                    <p>{sentence.avoid.join("；")}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="viewer-footnote">
          <span>i</span>
          <p><strong>红字为什么不等于大声？</strong>它只表示这里要成为听觉焦点。可以通过轻读、放慢、压低、气声或增加重量来实现。</p>
        </div>
      </section>
    </div>
  );
}

export function RecitationStudio() {
  const [mode, setMode] = useState<ProductMode>("studio");
  const [work, setWork] = useState<RecitationWork>(() => cloneDemoWork());
  const [step, setStep] = useState<WorkflowStep>(1);
  const [highestStep, setHighestStep] = useState<WorkflowStep>(1);
  const [selectedSentenceId, setSelectedSentenceId] = useState("s001");
  const [uploads, setUploads] = useState<Partial<Record<UploadKind, string>>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState("正在读取音频");
  const [isGenerating, setIsGenerating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [segmentEndMs, setSegmentEndMs] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

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
    const ended = () => {
      setIsPlaying(false);
      setSegmentEndMs(null);
    };

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

  const activeSentence = useMemo(
    () => activeSentenceAt(work.controlSpec.sentences, currentMs),
    [currentMs, work.controlSpec.sentences],
  );

  const activeTokenId = useMemo(() => {
    if (!activeSentence) return undefined;
    return activeSentence.tokens.find(
      (token) =>
        !punctuationOnly(token.char) &&
        currentMs >= token.startMs &&
        currentMs < token.endMs,
    )?.id;
  }, [activeSentence, currentMs]);

  const setWorkflowStep = (next: WorkflowStep) => {
    setStep(next);
    setHighestStep((current) => Math.max(current, next) as WorkflowStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleWorkChange = (
    field: "title" | "author" | "sourceText",
    value: string,
  ) => setWork((current) => ({ ...current, [field]: value, updatedAt: new Date().toISOString() }));

  const handleFile = (kind: UploadKind, file: File) => {
    setUploads((current) => ({ ...current, [kind]: file.name }));
    showToast(`${file.name} 已加入素材区`);
  };

  const handleAnalyze = async () => {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    const stages = [
      ["正在读取音频", 520],
      ["对齐正文与声音", 720],
      ["提取停顿与语势", 720],
      ["结合知识库生成控制谱", 820],
    ] as const;
    for (const [label, delay] of stages) {
      setAnalysisStatus(label);
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    setIsAnalyzing(false);
    setWork((current) => ({ ...current, status: "review" }));
    setWorkflowStep(2);
    showToast("控制谱初稿已生成：4 个图谱句等待复核");
  };

  const updateSentence = (
    id: string,
    updater: (sentence: RecitationSentence) => RecitationSentence,
  ) => {
    setWork((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      controlSpec: {
        ...current.controlSpec,
        source: "hybrid",
        sentences: current.controlSpec.sentences.map((sentence) =>
          sentence.id === id ? updater(sentence) : sentence,
        ),
      },
    }));
  };

  const toggleFocusToken = (sentenceId: string, token: TimedToken) => {
    updateSentence(sentenceId, (sentence) => {
      const existingIndex = sentence.focus.findIndex((target) =>
        target.tokenIds.includes(token.id),
      );
      if (existingIndex >= 0) {
        const nextFocus = sentence.focus
          .map((target, index) =>
            index === existingIndex
              ? { ...target, tokenIds: target.tokenIds.filter((id) => id !== token.id) }
              : target,
          )
          .filter((target) => target.tokenIds.length > 0);
        return { ...sentence, focus: nextFocus };
      }

      if (sentence.focus[0]) {
        return {
          ...sentence,
          focus: sentence.focus.map((target, index) =>
            index === 0 ? { ...target, tokenIds: [...target.tokenIds, token.id] } : target,
          ),
        };
      }

      return {
        ...sentence,
        focus: [
          {
            id: `${sentence.id}-focus-manual`,
            tokenIds: [token.id],
            level: "primary",
            preferredRealization: "free",
            allowedRealizations: ["free", "combined"],
            avoid: ["shouting"],
          },
        ],
      };
    });
  };

  const playAll = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setSegmentEndMs(null);
    if (isPlaying) {
      audio.pause();
      return;
    }
    if (audio.currentTime * 1000 >= work.audio.durationMs - 100) {
      audio.currentTime = 0;
      setCurrentMs(0);
    }
    try {
      await audio.play();
    } catch {
      showToast("浏览器暂时无法播放，请再点一次播放");
    }
  };

  const playSentence = async (sentence: RecitationSentence) => {
    const audio = audioRef.current;
    if (!audio) return;
    setSelectedSentenceId(sentence.id);
    audio.currentTime = sentence.timeRange.startMs / 1000;
    setCurrentMs(sentence.timeRange.startMs);
    setSegmentEndMs(sentence.timeRange.endMs);
    try {
      await audio.play();
    } catch {
      showToast("浏览器暂时无法播放，请再点一次“听本句”");
    }
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    setSegmentEndMs(null);
    audio.currentTime = value / 1000;
    setCurrentMs(value);
  };

  const changeRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  };

  const handleGenerate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    await new Promise((resolve) => window.setTimeout(resolve, 2200));
    setWork((current) => ({ ...current, status: "audio_ready" }));
    setIsGenerating(false);
    showToast("示范音频与字符时间轴已就绪");
  };

  const handlePublish = () => {
    setWork((current) => ({
      ...current,
      status: "published",
      publishedRevisionId: "publication-moonlight-v1",
    }));
    setMode("viewer");
    showToast("作品 v1 已发布，当前显示用户观看页");
  };

  return (
    <main className={`product-app mode-${mode}`}>
      <audio ref={audioRef} src={work.audio.url} preload="metadata">
        <track
          kind="captions"
          src="/demo-captions.vtt"
          srcLang="zh"
          label="中文"
          default
        />
      </audio>
      <header className="app-header">
        <button
          type="button"
          className="brand"
          onClick={() => {
            setMode("studio");
            setWorkflowStep(1);
          }}
          aria-label="声图首页"
        >
          <span className="brand-mark">声</span>
          <span className="brand-copy">
            <strong>声图</strong>
            <small>朗诵情感图谱</small>
          </span>
        </button>

        <nav className="mode-switch" aria-label="产品端切换">
          <button
            type="button"
            className={mode === "studio" ? "active" : ""}
            onClick={() => setMode("studio")}
          >
            <span aria-hidden="true">✦</span> 创作端
          </button>
          <button
            type="button"
            className={mode === "viewer" ? "active" : ""}
            onClick={() => setMode("viewer")}
          >
            <span aria-hidden="true">◉</span> 用户观看端
          </button>
        </nav>

        <div className="header-status">
          <span className={`status-dot status-${work.status}`} />
          <span>{work.status === "published" ? "已发布 v1" : "演示作品 · 自动保存"}</span>
          <button type="button" className="avatar-button" aria-label="创作者账户">林</button>
        </div>
      </header>

      {mode === "studio" ? (
        <StudioView
          work={work}
          step={step}
          highestStep={highestStep}
          selectedSentenceId={selectedSentenceId}
          uploads={uploads}
          isAnalyzing={isAnalyzing}
          analysisStatus={analysisStatus}
          isGenerating={isGenerating}
          currentMs={currentMs}
          activeTokenId={activeTokenId}
          onStep={setWorkflowStep}
          onWorkChange={handleWorkChange}
          onFile={handleFile}
          onAnalyze={handleAnalyze}
          onSelectSentence={setSelectedSentenceId}
          onTokenClick={toggleFocusToken}
          onSentenceChange={updateSentence}
          onPlaySentence={playSentence}
          onSave={() => showToast("控制谱草稿已保存")}
          onGenerateStage={() => setWorkflowStep(3)}
          onGenerate={handleGenerate}
          onPublishStage={() => setWorkflowStep(4)}
          onPreview={() => setMode("viewer")}
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
        />
      )}

      {mode === "viewer" || step === 2 ? (
        <Player
          work={work}
          currentMs={currentMs}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          onToggle={playAll}
          onSeek={seek}
          onRateChange={changeRate}
          compact={mode === "viewer"}
        />
      ) : null}

      <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">
        <span>✓</span>{toast}
      </div>
    </main>
  );
}
