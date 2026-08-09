export type WorkStatus =
  | "draft"
  | "analyzing"
  | "review"
  | "audio_ready"
  | "published";

export type ProsodyType = "crest" | "trough" | "rising" | "falling";
export type EndingTone = "rise" | "fall" | "level";
export type Rhythm =
  | "light"
  | "solemn"
  | "relaxed"
  | "tense"
  | "soaring"
  | "low";
export type VoiceQuality =
  | "solid"
  | "breathy"
  | "mixed"
  | "neutral"
  | "breathy_to_mixed"
  | "mixed_to_solid";

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
  tokenIds: string[];
  tokenIndexes: number[];
  level: "primary" | "secondary";
  preferredRealization: FocusRealization;
  allowedRealizations: FocusRealization[];
  avoid: string[];
}

export interface PauseMark {
  id: string;
  afterTokenId: string;
  afterTokenIndex: number;
  type: "short" | "long";
  observedDurationMs?: number;
  source: "observed" | "inferred" | "human";
}

export interface ProlongMark {
  id: string;
  tokenId: string;
  tokenIndex: number;
  degree: 1 | 2 | 3;
  purpose?: string;
}

export interface RecitationSentence {
  id: string;
  order: number;
  text: string;
  function: string;
  rhythm: Rhythm;
  continuity: "connected" | "balanced" | "segmented";
  prosody: {
    type: ProsodyType;
    strength: 1 | 2 | 3;
    anchorStart: number;
    anchorEnd: number;
    /** @deprecated v1.0 compatibility; renderers use anchorStart/anchorEnd. */
    anchorTokenIds: string[];
  };
  endingTone: {
    type: EndingTone;
    strength: 1 | 2 | 3;
  };
  focus: FocusTarget[];
  voiceQuality: {
    start: VoiceQuality;
    transition?: VoiceQuality;
    end: VoiceQuality;
  };
  pauses: PauseMark[];
  prolongs: ProlongMark[];
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
  schemaVersion: "1.0" | "1.1";
  id: string;
  workId: string;
  version: number;
  source: "ai" | "human" | "hybrid";
  documentProfile: DocumentProfile;
  sentences: RecitationSentence[];
  analysisProvenance: {
    referenceAudioAssetId?: string;
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
  kind: "reference" | "ai_demo";
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
  currentSpecVersionId?: string;
  publishedRevisionId?: string;
  referenceAudio?: AudioTrack;
  aiDemoAudio?: AudioTrack;
  controlSpec?: ControlSpec;
  createdAt: string;
  updatedAt: string;
}

export const PROSODY_LABELS: Record<ProsodyType, string> = {
  crest: "波峰",
  trough: "波谷",
  rising: "起潮",
  falling: "落潮",
};

export const ENDING_LABELS: Record<EndingTone, string> = {
  rise: "上扬 ↗",
  fall: "下抑 ↘",
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
  breathy: "略带气声",
  mixed: "虚实结合",
  neutral: "自然中性",
  breathy_to_mixed: "气声到虚实结合",
  mixed_to_solid: "虚实结合到更有支撑",
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
