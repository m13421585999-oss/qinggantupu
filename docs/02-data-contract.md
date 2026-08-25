# 朗诵控制谱 · 当前数据契约

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
  schemaVersion: "1.0" | "1.1" | "2.0";
  id: string;
  workId: string;
  version: number;
  source: "ai" | "human" | "hybrid";
  documentProfile: DocumentProfile;
  tokens: TimedToken[];
  sentences: RecitationSentence[];
  // 人工读音优先于自动拼音，并随工程、页面和 PDF 一起保存。
  pinyinOverrides?: Record<string, string>;
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
  | "slightly_breathy"
  | "breathy"
  | "mixed"
  | "neutral"
  | "breathy_to_supported"
  | "breathy_to_mixed"
  | "mixed_to_solid"
  | "solid_to_soft";

interface MacroProsodyPath {
  points: Array<{
    tokenIndex: number;
    macroPitchCenter?: number;
    normalizedLevel: number;
    rawNormalizedPitch?: number;
  }>;
  segments: Array<{
    startIndex: number;
    endIndex: number;
    type: "level" | "rising" | "falling";
    startLevel: number;
    endLevel: number;
    confidence?: number;
  }>;
  source: "acoustic" | "text_llm";
}

interface ProsodyEvent {
  id: string;
  type: ProsodyType;
  activeSpan: { start: number; end: number };
  coreZone: { start: number; end: number };
  strength: 1 | 2 | 3;
  confidence?: number;
}

interface ProsodyPointOverride {
  tokenIndex: number;
  visualLevel: number; // 保存 0～8 基础高度；Compact 映射为五个显示档位。
  source: "human";
}

interface SceneTechniqueMark {
  id: string;
  tokenId: string;
  tokenIndex: number;
  type: "real" | "virtual";
  source: "human";
}

interface BreathMark {
  id: string;
  afterTokenId: string;
  afterTokenIndex: number;
  type: "breath_major" | "breath_minor";
  source: "human";
}

interface RecitationSentence {
  id: string;
  order: number;
  text: string;
  function: string;
  rhythm: Rhythm;
  continuity: "connected" | "balanced" | "segmented";
  macroProsodyPath?: MacroProsodyPath; // 声学或文字分析得到的不可变基础路径。
  prosodyPointOverrides?: ProsodyPointOverride[]; // 人工教学曲线高度。
  lineBreakAfterTokenIndexes?: number[]; // Compact 人工换行；仍是同一编号卡片。
  sceneTechniqueMarks?: SceneTechniqueMark[]; // 仅《春》紧凑版特例渲染。
  prosody: ProsodyEvent[];
  endingIntonation: {
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
  breaths?: BreathMark[];
  prolongations: ProlongMark[];
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

拼音渲染顺序固定为 `ControlSpec.pinyinOverrides[token.id]` → `displayPinyin` → 自动生成拼音。人工覆盖不得写回或改写原文字符。

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

音频分析结果必须能追溯到原始参考音频、真正被分析的标准 AI 音频、系统知识库、模型和流水线版本；文稿直出图谱允许没有音频资产。人工修改生成新控制谱版本，不覆盖历史版本；存在同源音频时把 `audioSyncStatus` 从 `synced` 改为 `modified`。

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

`reference_audio_original` 只保留真人来源证据。`standard_ai_audio` 经 Forced Alignment 生成字符/词时间戳，Parselmouth、DeepSeek、图谱播放器和观看端全部使用这条音频及同一时间轴。旧 `ai_demo_audio` 只为已存在的作品兼容保留，不参与新作品主链；文稿直出图谱不伪造音频时间轴。

## 7. 渲染对齐约束

- 数据只保存 token index、语势区间与稀疏人工高度，不保存 `x = 430px` 一类坐标。
- 拼音、正文、Marker 与语势节点引用同一 token index；人工 Marker 不参与文字宽度估算。
- 页面渲染后读取每个正文文字的实际 DOM 边界，再换算为 SVG 曲线坐标。禁止按固定字宽、字符数量或包含 Marker 的整行宽度平均估算。
- `ResizeObserver`、窗口/视觉视口变化和字体加载完成都会触发重新测量。
- 页面缩放、字号变化和响应式换行不得改变“索引 → 文字 → 曲线锚点”的语义关系。
- 完整版保留九档基础曲线；紧凑版只显示 `[0, 2, 4, 6, 8]` 五档，旧奇数高度映射到最近档位，但保存结构仍向后兼容。
- Compact 的人工换行只改变同一卡片内部排版，不把一个编号段落拆成多个“正文 + 曲线”卡片；小图与对应卡片分页时不可分离。

## 8. D1 最小表结构

- `works`：作品身份、正文、状态、当前草稿与发布版本指针。
- `assets`：参考/示范音频等 R2 对象的元数据、校验和、时长与来源。
- `control_spec_versions`：版本号、完整 JSON、来源、校验状态。
- `audio_versions`：供应商、Voice、Prompt、音频资产、时间轴 JSON、候选状态。
- `publications`：稳定 slug、冻结的控制谱版本和音频版本。
- `processing_jobs`：文稿、音频、视觉等网站侧任务状态及分析服务任务编号。
- `work_visual_profiles`、`visual_specs`、`visual_assets`：视觉风格、场景计划和 R2 图片版本。
实际查询需要的索引：`works(status, updated_at)`、`assets(work_id, kind)`、`control_spec_versions(work_id, version)`、`publications(slug)`。

## 9. 紧凑版打印设置

`PrintSettings.compactLegendItems` 保存页脚图例选择。允许显式空数组；旧作品缺少该字段时使用既有六项默认图例。当前可选项包括换气、偷气、短停、长停、重音、语势曲线、上扬、下降、拖音、一字一顿、实景和虚景。
