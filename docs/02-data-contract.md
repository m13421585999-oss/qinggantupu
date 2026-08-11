# 朗诵控制谱 v2.0 · 数据契约

## 1. 核心对象

### Work（作品）

保存作品身份、原文、当前流程状态和发布指针，不直接保存大文件。

```ts
type WorkStatus =
  | "draft"
  | "analyzing"
  | "analysis_ready"
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
  audioSyncStatus: "pending" | "synced" | "modified";
  currentSpecVersionId?: string;
  publishedRevisionId?: string;
  referenceAudio?: AudioTrack;
  referenceAudioOriginal?: AudioTrack;
  standardAiAudio?: AudioTrack;
  // 只用于读取旧作品已经生成的历史示范声音。
  aiDemoAudio?: AudioTrack;
  controlSpec?: ControlSpec;
  createdAt: string;
  updatedAt: string;
}
```

### Asset（素材）

真人原始参考朗诵和 Voice Changer 生成的标准 AI 音频都保存到 R2；D1 保存素材元数据与来源关系。正文以 `Work.sourceText` 为唯一作品输入。

```ts
type AssetKind =
  | "reference_audio"
  | "standard_ai_audio"
  | "reference_audio_archived"
  | "standard_ai_audio_archived"
  | "ai_demo_audio"; // 旧作品兼容

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
  sourceAssetId?: string;
  metadataJson?: string;
  provider?: "upload" | "eleven" | "fish" | "qwen" | "demo";
  createdAt: string;
}
```

### ControlSpec（统一控制谱）

```ts
interface ControlSpec {
  schemaVersion: "2.0";
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
  baseRhythm: Rhythm;
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
type ProsodyType = "peak" | "valley" | "rising" | "falling";
type EndingTone = "rising" | "falling" | "level";
type Rhythm = "light" | "solemn" | "relaxed" | "tense" | "soaring" | "low";
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
    anchorStart: number;
    anchorEnd: number;
    // v1.0 兼容字段；新渲染器不依赖 token id 数组定位。
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
  index: number;
  char: string;
  machinePinyin?: string; // xiang3，供模型、词典和 TTS 使用
  displayPinyin?: string; // xiǎng，只用于用户展示
  pronunciationSource?: "default" | "dictionary" | "human";
  startMs: number;
  endMs: number;
  confidence: number;
}

interface PauseMark {
  id: string;
  afterTokenId: string;
  afterTokenIndex: number;
  type: "short" | "long";
  observedDurationMs?: number;
  source: "observed" | "inferred" | "human";
}

interface ProlongMark {
  id: string;
  tokenId: string;
  tokenIndex: number;
  degree: 1 | 2 | 3;
  purpose?: string;
}
```

`index` 是全文稳定索引，拼音层、正文层、语势锚点、焦点、停顿、拖音和播放时间轴都引用它。时间轴必须满足：同一句内 token 按顺序排列、不重叠、落在句级时间范围内；标点可以有零时长或与前字共享尾部时间，但不能制造倒序。

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
  tokenIndexes: number[];
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

所有 AI 结果必须能追溯到原始参考音频、真正被分析的标准 AI 音频、系统知识库、模型和流水线版本。人工修改生成新控制谱版本，不覆盖历史版本，并把 `audioSyncStatus` 从 `synced` 改为 `modified`。

## 6. 两条音轨与同源标准时间轴

```ts
interface AudioTrack {
  id: string;
  kind: "reference" | "reference_original" | "standard_ai" | "ai_demo";
  url: string;
  filename: string;
  durationMs: number;
  provider: "demo" | "eleven" | "fish" | "qwen" | "upload";
  label: string;
  timeline?: AudioTimeline;
}

interface AudioTimeline {
  granularity: "character" | "word";
  tokens: Array<{
    tokenId: string;
    tokenIndex: number;
    startMs: number;
    endMs: number;
    confidence?: number;
  }>;
  sentences: Array<{
    sentenceId: string;
    startMs: number;
    endMs: number;
  }>;
}
```

`reference_audio_original` 只保留真人来源证据。`standard_ai_audio` 经 Forced Alignment 生成字符/词时间戳，Parselmouth、DeepSeek、图谱播放器和观看端全部使用这条音频及同一时间轴。旧 `ai_demo_audio` 只为已存在的作品兼容保留，不参与新作品主链。

## 7. 渲染对齐约束

- 数据中只保存 `anchorStart` / `anchorEnd` 索引，不保存 `x = 430px` 一类坐标。
- 拼音行和正文行按同一 token 数组、同一 CSS Grid 列模板渲染。
- 页面渲染后读取锚点文字的实际 DOM 边界，再换算为 SVG 曲线坐标。
- `ResizeObserver`、窗口/视觉视口变化和字体加载完成都会触发重新测量。
- 页面缩放、字号变化和响应式换行不得改变“索引 → 文字 → 曲线锚点”的语义关系。

## 8. D1 最小表结构

- `works`：作品身份、正文、状态、当前草稿与发布版本指针。
- `assets`：参考/示范音频等 R2 对象的元数据、校验和、时长与来源。
- `control_spec_versions`：版本号、完整 JSON、来源、校验状态。
- `audio_versions`：供应商、Voice、Prompt、音频资产、时间轴 JSON、候选状态。
- `publications`：稳定 slug、冻结的控制谱版本和音频版本。
实际查询需要的索引：`works(status, updated_at)`、`assets(work_id, kind)`、`control_spec_versions(work_id, version)`、`publications(slug)`。
