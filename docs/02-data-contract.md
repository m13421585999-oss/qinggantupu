# 朗诵控制谱 v1.0 · 数据契约

## 1. 核心对象

### Work（作品）

保存作品身份、原文、当前流程状态和发布指针，不直接保存大文件。

```ts
type WorkStatus =
  | "draft"
  | "analyzing"
  | "review"
  | "audio_ready"
  | "published";

interface Work {
  id: string;
  slug: string;
  title: string;
  author?: string;
  genre: "modern_poetry" | "classical_poetry" | "prose" | "speech" | "other";
  language: "zh-CN";
  sourceText: string;
  status: WorkStatus;
  currentSpecVersionId?: string;
  publishedRevisionId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Asset（素材）

正文附件、参考朗诵、知识库、AI 示范音频都作为资产；字节存 R2，元数据存 D1。

```ts
type AssetKind =
  | "manuscript"
  | "reference_audio"
  | "knowledge_source"
  | "tts_audio";

interface Asset {
  id: string;
  workId: string;
  kind: AssetKind;
  storageKey: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  durationMs?: number;
  checksum: string;
  provider?: "upload" | "eleven" | "fish" | "qwen" | "demo";
  createdAt: string;
}
```

### ControlSpec（统一控制谱）

```ts
interface ControlSpec {
  schemaVersion: "1.0";
  id: string;
  workId: string;
  version: number;
  source: "ai" | "human" | "hybrid";
  documentProfile: DocumentProfile;
  sentences: RecitationSentence[];
  analysisProvenance: AnalysisProvenance;
  validation: ValidationResult;
  createdAt: string;
}

interface DocumentProfile {
  deliveryMode: "natural_narration" | "lyrical_recitation" | "stage_recitation";
  recitationDegree: 1 | 2 | 3;
  baseRhythm: "natural" | "relaxed" | "light" | "solemn" | "soaring";
  emotionalTone: string[];
  energy: "low" | "low_to_medium" | "medium" | "medium_to_high" | "high";
  control: "low" | "medium" | "high";
  interactionDistance: "intimate" | "conversational" | "public";
  voiceQuality: VoiceQuality;
  globalArc: string[];
}
```

## 2. 图谱句

```ts
type ProsodyType = "crest" | "trough" | "rising" | "falling";
type EndingTone = "rise" | "fall" | "level";
type Rhythm = "natural" | "relaxed" | "light" | "solemn" | "soaring";
type VoiceQuality =
  | "solid"
  | "breathy"
  | "mixed"
  | "neutral"
  | "breathy_to_mixed"
  | "mixed_to_solid";

interface RecitationSentence {
  id: string;
  order: number;
  text: string;
  function: string;
  rhythm: Rhythm;
  continuity: "connected" | "balanced" | "segmented";
  prosody: {
    type: ProsodyType;
    strength: 1 | 2 | 3;
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
```

## 3. 字符、拼音与时间轴

```ts
interface TimedToken {
  id: string;
  char: string;
  pinyin?: string;
  tone?: 0 | 1 | 2 | 3 | 4;
  pronunciationSource?: "default" | "dictionary" | "human";
  startMs: number;
  endMs: number;
  confidence: number;
}

interface PauseMark {
  id: string;
  afterTokenId: string;
  type: "short" | "long";
  observedDurationMs?: number;
  source: "observed" | "inferred" | "human";
}

interface ProlongMark {
  id: string;
  tokenId: string;
  degree: 1 | 2 | 3;
  purpose?: string;
}
```

时间轴必须满足：同一句内 token 按顺序排列、不重叠、落在句级时间范围内；标点可以有零时长或与前字共享尾部时间，但不能制造倒序。

## 4. 表达焦点与实现方式

```ts
type FocusRealization =
  | "free"
  | "stronger"
  | "soft_emphasis"
  | "slower"
  | "lower_weighted"
  | "breathy"
  | "voice_shift"
  | "combined";

interface FocusTarget {
  id: string;
  tokenIds: string[];
  level: "primary" | "secondary";
  preferredRealization: FocusRealization;
  allowedRealizations: FocusRealization[];
  avoid: string[];
}
```

“目标位置”和“实现方式”必须分离。观看端只把目标文字标红；教师展开层和 TTS 编译器才读取实现方式。

## 5. 分析证据与版本

```ts
interface AnalysisProvenance {
  referenceAudioAssetId?: string;
  knowledgeAssetIds: string[];
  pipelineVersion: string;
  alignmentModel?: string;
  acousticModel?: string;
  languageModel?: string;
  generatedAt: string;
}

interface ValidationResult {
  state: "valid" | "warning" | "invalid";
  issues: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    path: string;
    message: string;
  }>;
}
```

所有 AI 结果必须能追溯到参考音频、知识库、模型和流水线版本；人工修改生成新控制谱版本，不覆盖历史版本。

## 6. D1 最小表结构

- `works`：作品身份、正文、状态、当前草稿与发布版本指针。
- `assets`：R2 对象的元数据、校验和、时长与来源。
- `control_spec_versions`：版本号、完整 JSON、来源、校验状态。
- `audio_versions`：供应商、Voice、Prompt、音频资产、时间轴 JSON、候选状态。
- `publications`：稳定 slug、冻结的控制谱版本和音频版本。
- `processing_jobs`：分析/TTS 任务状态、进度、错误与幂等键。

实际查询需要的索引：`works(status, updated_at)`、`assets(work_id, kind)`、`control_spec_versions(work_id, version)`、`publications(slug)`、`processing_jobs(work_id, status)`。
