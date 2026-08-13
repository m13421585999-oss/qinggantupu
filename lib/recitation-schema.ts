export type WorkStatus =
  | "draft"
  | "analyzing"
  | "analysis_ready"
  | "review"
  | "audio_ready"
  | "published";

export type AudioSyncStatus = "pending" | "synced" | "modified";

export type ProsodyType = "peak" | "valley" | "rising" | "falling";
export type EndingTone = "rising" | "falling" | "level";
export type Rhythm =
  | "light"
  | "solemn"
  | "relaxed"
  | "tense"
  | "soaring"
  | "low";
export type VoiceQuality =
  | "solid"
  | "slightly_breathy"
  | "breathy"
  | "mixed"
  | "neutral"
  | "breathy_to_supported"
  | "breathy_to_mixed"
  | "mixed_to_solid"
  | "solid_to_soft";

export type FocusStyle =
  | "supported"
  | "soft"
  | "slower"
  | "lower_weighted"
  | "breathy"
  | "breathy_to_supported";

export interface HiddenPerformanceProfile {
  sourceControlRef?: string;
  deliveryMode?: "natural_narration" | "lyrical_recitation" | "stage_recitation";
  emotionTone?: string[];
  continuity?: "connected" | "balanced" | "segmented";
  voiceQuality?: VoiceQuality;
  focusStyle?: FocusStyle;
  expressionAmplitude?: "low" | "medium" | "high";
  avoid?: string[];
}

export type GlobalPace = "slow" | "moderately_slow" | "medium" | "brisk";
export type PauseHierarchyLevel = "light" | "marked" | "paragraph";
export type PhraseExpansion =
  | "compressed"
  | "baseline"
  | "expanded"
  | "strongly_expanded";
export type ProlongationTimingStrength = "subtle" | "clear" | "strong";

export interface TimingProfile {
  source: "acoustic";
  sourceControlRef: string;
  globalPace: {
    value: GlobalPace;
    speakingRateCharsPerSec: number;
    confidence: number;
    sourceControlRef: string;
  };
  pauseHierarchy: Array<{
    afterTokenIndex: number;
    level: PauseHierarchyLevel;
    observedGapMs: number;
    relativeRatio: number;
    confidence: number;
    sourceControlRef: string;
  }>;
  phraseDurationProfile: Array<{
    sentenceId?: string;
    startIndex: number;
    endIndex: number;
    speakingRateCharsPerSec: number;
    relativeExpansion: number;
    expansion: PhraseExpansion;
    confidence: number;
    sourceControlRef: string;
  }>;
  prolongationStrength: Array<{
    tokenIndex: number;
    localDurationRatio: number;
    strength: ProlongationTimingStrength;
    phraseExpansion: PhraseExpansion;
    confidence: number;
    sourceControlRef: string;
  }>;
}

export type FocusRealization =
  | "free"
  | "stronger"
  | "soft_emphasis"
  | "slower"
  | "lower_weighted"
  | "breathy"
  | "voice_shift"
  | "combined";

export interface TimedToken {
  id: string;
  index: number;
  char: string;
  machinePinyin?: string;
  displayPinyin?: string;
  /** @deprecated v1.0 compatibility; the UI uses displayPinyin. */
  pinyin?: string;
  /** @deprecated v1.0 compatibility; the tone is encoded in machinePinyin. */
  tone?: 0 | 1 | 2 | 3 | 4;
  pronunciationSource?: "default" | "dictionary" | "human";
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface FocusTarget {
  id: string;
  sourceControlRef?: string;
  tokenIds: string[];
  tokenIndexes: number[];
  /** Acoustic core inside the teaching-facing focus span. */
  coreTokenIds?: string[];
  coreTokenIndexes?: number[];
  level: "primary" | "secondary";
  confidence?: number;
  explanation?: string;
  preferredRealization: FocusRealization;
  allowedRealizations: FocusRealization[];
  avoid: string[];
}

export interface PauseMark {
  id: string;
  sourceControlRef?: string;
  afterTokenId: string;
  afterTokenIndex: number;
  type: "short" | "long";
  observedDurationMs?: number;
  source: "observed" | "inferred" | "human";
}

export interface ProlongMark {
  id: string;
  sourceControlRef?: string;
  tokenId: string;
  tokenIndex: number;
  degree: 1 | 2 | 3;
  /** Preserved acoustic evidence; TTS will not infer missing values. */
  localDurationRatio?: number;
  confidence?: number;
  observedDurationMs?: number;
  source?: "acoustic" | "human" | "legacy";
  purpose?: string;
}

export interface TokenSpan {
  start: number;
  end: number;
}

export interface ProsodyEvent {
  id: string;
  sourceControlRef?: string;
  type: ProsodyType;
  activeSpan: TokenSpan;
  coreZone: TokenSpan;
  strength: 1 | 2 | 3;
  confidence?: number;
}

export interface MacroProsodyPoint {
  tokenIndex: number;
  /** Median pitch center inside this token's effective voiced interval. */
  macroPitchCenter?: number;
  normalizedLevel: number;
  rawNormalizedPitch?: number;
}

export interface MacroProsodySegment {
  startIndex: number;
  endIndex: number;
  type: "level" | "rising" | "falling";
  startLevel: number;
  endLevel: number;
  confidence?: number;
}

export interface MacroProsodyPath {
  points: MacroProsodyPoint[];
  segments: MacroProsodySegment[];
  source: "acoustic";
}

export interface RecitationSentence {
  id: string;
  order: number;
  text: string;
  function: string;
  rhythm: Rhythm;
  continuity: "connected" | "balanced" | "segmented";
  /** Hidden execution hints for TTS; intentionally not rendered in the graph UI. */
  performanceProfile?: HiddenPerformanceProfile;
  macroProsodyPath?: MacroProsodyPath;
  prosody: ProsodyEvent[];
  endingIntonation: {
    sourceControlRef?: string;
    type: EndingTone;
    strength: 1 | 2 | 3;
    confidence?: number;
    source?: "acoustic" | "human" | "legacy";
  };
  focus: FocusTarget[];
  voiceQuality: {
    start: VoiceQuality;
    transition?: VoiceQuality;
    end: VoiceQuality;
  };
  pauses: PauseMark[];
  prolongations: ProlongMark[];
  tokens: TimedToken[];
  teachingCue: string;
  avoid: string[];
  confidence: number;
  timeRange: { startMs: number; endMs: number };
}

export interface DocumentProfile {
  deliveryMode:
    | "natural_narration"
    | "lyrical_recitation"
    | "stage_recitation";
  recitationDegree: 1 | 2 | 3;
  baseRhythm: Rhythm;
  emotionalTone: string[];
  energy: "low" | "low_to_medium" | "medium" | "medium_to_high" | "high";
  control: "low" | "medium" | "high";
  interactionDistance: "intimate" | "conversational" | "public";
  voiceQuality: VoiceQuality;
  globalArc: string[];
}

export interface ControlSpec {
  schemaVersion: "1.0" | "1.1" | "2.0";
  id: string;
  workId: string;
  version: number;
  source: "ai" | "human" | "hybrid";
  /** Optional whole-piece TTS profile; intentionally hidden from the graph UI. */
  performanceProfile?: HiddenPerformanceProfile;
  /** Acoustic timing organization used only by the TTS execution layer. */
  timingProfile?: TimingProfile;
  documentProfile: DocumentProfile;
  tokens: TimedToken[];
  sentences: RecitationSentence[];
  analysisProvenance: {
    referenceAudioAssetId?: string;
    referenceAudioOriginalAssetId?: string;
    standardAiAudioAssetId?: string;
    analyzedAudioRole?: "reference_audio" | "standard_ai_audio";
    knowledgeAssetIds: string[];
    knowledgeBase?: {
      id: string;
      version: string;
      scope: "system";
    };
    pipelineVersion: string;
    alignmentModel?: string;
    acousticModel?: string;
    languageModel?: string;
    generatedAt: string;
  };
  validation: {
    state: "valid" | "warning" | "invalid";
    issues: Array<{
      code: string;
      severity: "info" | "warning" | "error";
      path: string;
      message: string;
    }>;
  };
  createdAt: string;
}

export interface TokenTimestamp {
  tokenId: string;
  tokenIndex: number;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface SentenceTimestamp {
  sentenceId: string;
  startMs: number;
  endMs: number;
}

export interface AudioTimeline {
  granularity: "character" | "word";
  tokens: TokenTimestamp[];
  sentences: SentenceTimestamp[];
}

export interface AudioTrack {
  id: string;
  kind: "reference" | "reference_original" | "ai_demo" | "standard_ai";
  url: string;
  filename: string;
  mimeType?: string;
  durationMs: number;
  provider: "demo" | "eleven" | "fish" | "qwen" | "upload";
  label: string;
  timeline?: AudioTimeline;
}

export interface RecitationWork {
  id: string;
  slug: string;
  title: string;
  author?: string;
  genre:
    | "modern_poetry"
    | "classical_poetry"
    | "prose"
    | "speech"
    | "other";
  language: "zh-CN";
  sourceText: string;
  status: WorkStatus;
  audioSyncStatus: AudioSyncStatus;
  currentSpecVersionId?: string;
  publishedRevisionId?: string;
  referenceAudio?: AudioTrack;
  referenceAudioOriginal?: AudioTrack;
  aiDemoAudio?: AudioTrack;
  standardAiAudio?: AudioTrack;
  analysisJobId?: string;
  analysisJobStatus?: "queued" | "processing" | "succeeded" | "failed";
  analysisPackage?: RecitationAnalysisPackage;
  controlSpec?: ControlSpec;
  /** Optional literary visual layer; it never changes control_spec or audio timing. */
  visuals?: import("./visual-assets").WorkVisualBundle;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisPause {
  after_index: number;
  gap_ms: number;
  relative_level: "short" | "long";
}

export interface AnalysisElongation {
  token_index: number;
  duration_ms: number;
  local_duration_ratio: number;
}

export interface AnalysisToken {
  index: number;
  char: string;
  machine_pinyin?: string;
  display_pinyin?: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  local_duration_ratio?: number | null;
  f0_hz?: number | null;
  normalized_pitch?: number | null;
  intensity_db?: number | null;
  normalized_energy?: number | null;
  silence_gap_before_ms?: number;
  silence_gap_after_ms?: number;
  voiced_ratio?: number | null;
  confidence?: number;
}

export interface AnalysisSentenceSummary {
  id: string;
  order: number;
  text: string;
  start_index: number;
  end_index: number;
  start_ms: number;
  end_ms: number;
  speaking_rate: number;
  pause_summary: unknown;
  duration_summary: unknown;
  pitch_summary: unknown;
  energy_summary: unknown;
  macro_pitch_contour: unknown;
  macro_prosody_path?: unknown;
  ending_intonation?: unknown;
}

export interface RecitationAnalysisPackage {
  schema_version: "1.0" | "recitation-analysis-1.0" | "recitation-analysis-2.0-standard-audio";
  generated_at: string;
  work: {
    title: string;
    author?: string;
    full_text: string;
  };
  reference_audio_asset_id?: string;
  reference_audio_original_asset_id?: string;
  standard_ai_audio_asset_id?: string;
  analyzed_audio_role?: "reference_audio" | "standard_ai_audio";
  standard_ai_timestamps?: {
    characters: AnalysisToken[];
    words: Array<Record<string, unknown>>;
  } | null;
  alignment_quality: Record<string, unknown>;
  tokens: AnalysisToken[];
  words: Array<Record<string, unknown>>;
  pauses: AnalysisPause[];
  elongations: AnalysisElongation[];
  pitch: Array<Record<string, unknown>>;
  energy: Array<Record<string, unknown>>;
  sentences: AnalysisSentenceSummary[];
  /** Deterministic timing organization derived from this reference performance. */
  timing_profile?: Record<string, unknown>;
  audio: {
    asset_id?: string;
    role?: "reference_audio" | "standard_ai_audio";
    filename?: string;
    mime_type?: string;
    duration_ms: number;
    sample_rate?: number;
  };
}

export const PROSODY_LABELS: Record<ProsodyType, string> = {
  peak: "波峰",
  valley: "波谷",
  rising: "起潮",
  falling: "落潮",
};

export const ENDING_LABELS: Record<EndingTone, string> = {
  rising: "上扬 ↗",
  falling: "下抑 ↘",
  level: "平收 →",
};

export const RHYTHM_LABELS: Record<Rhythm, string> = {
  light: "轻快",
  solemn: "凝重",
  relaxed: "舒缓",
  tense: "紧张",
  soaring: "高亢",
  low: "低沉",
};

export const VOICE_LABELS: Record<VoiceQuality, string> = {
  solid: "偏实声",
  slightly_breathy: "轻微气声",
  breathy: "略带气声",
  mixed: "虚实结合",
  neutral: "自然中性",
  breathy_to_supported: "气声到更有支撑",
  breathy_to_mixed: "气声到虚实结合",
  mixed_to_solid: "虚实结合到更有支撑",
  solid_to_soft: "实声到柔和",
};

export const FOCUS_LABELS: Record<FocusRealization, string> = {
  free: "自由实现",
  stronger: "力度增强",
  soft_emphasis: "轻读强调",
  slower: "放慢延长",
  lower_weighted: "压低加重",
  breathy: "气声强调",
  voice_shift: "虚实变化",
  combined: "综合实现",
};
