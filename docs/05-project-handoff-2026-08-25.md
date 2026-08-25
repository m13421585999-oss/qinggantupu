# 声图 / 朗诵情感图谱项目交接文档

> 交接快照：2026-08-25（Asia/Shanghai）
> 本文根据当前工作区代码、本地 D1、既有备份说明和最近 12 篇成品流程整理。
> 本文不包含任何 API Key、Token 或密码。

## 1. 一句话结论

“声图”目前是一个本地优先的朗诵图谱制作系统：浏览器编辑器负责人工创作和排版，Cloudflare Worker 负责作品、任务和资产业务，本地 D1/R2 保存正式工程数据与图片音频，本地 FastAPI 负责文稿、声音、视觉和图片相关的 AI 分析。

系统已经形成一套可用的“正文 → 控制谱 → 人工精修 → 完整版/紧凑版 → 多页 PDF”流程。2026-08-25 第一轮功能精简后，现役界面只保留最近 12 篇实际使用的主线：

1. 作品库、正文准备、完整版/紧凑版编辑与 PDF；
2. ControlSpec、人工拼音、独立分行、朗诵标识、语势曲线和逐行场景图；
3. 文稿分析完成后，以 `{ "type": "all" }` 创建整篇 Scene 任务。

旧真人/AI 参考音频面板、用户观看端、发布预览、分享、本页 PNG 和底部音频播放器已从现役界面移出；底层音频、发布和 Hero 数据/API 暂时保留，用于读取历史作品，不做数据删除。

## 2. 当前工作区状态

### 2.1 代码位置

```text
/Users/mcf/.codex/.chatgpt-projects/
  g-p-6a74ab96ae6c81918a24a4386356f328/site
```

当前分支：

```text
codex/sync-local-analysis-updates-20260821
```

该分支最初的同步提交为：

```text
9cc469e4c572df8b061c2d9b037b5d7f158600e6
```

但该提交之后，工作区又积累了约 3,470 行新增、498 行删除的未提交修改，主要集中在：

- 紧凑版与完整版编辑器；
- 版式分离与人工换行；
- 新增标识及图例；
- 语势曲线交互；
- 《春》《出师表》等作品特例；
- 完整版标识展示和拖音修复；
- 相关测试。

接手后不能直接把当前分支当成 9cc469e 的纯净状态，也不能清理或重置这些未提交修改。应先建立新的安全快照或提交，再继续开发。

### 2.2 当前本地数据快照

2026-08-25 只读统计：

```text
works                 116
control_spec_versions 187
visual_assets         1451
processing_jobs       522
```

其中包含：

- WorkBuddy 正式批量导入的 100 篇；
- 导入前已有的本地作品；
- 后续重点制作的 12 篇作品（该集合与旧作品存在一篇重合，因此总数不是简单相加）。

2026-08-21 的 105 作品完整备份位于：

```text
/Users/mcf/.codex/.chatgpt-projects/
  g-p-6a74ab96ae6c81918a24a4386356f328/
  project-backups/2026-08-21-merged-105-works
```

恢复时必须把 D1 与 R2 作为整体恢复，不能只恢复数据库或只恢复图片。

### 2.3 最近重点制作的 12 篇

1. 《面朝大海，春暖花开》
2. 《我微笑着走向生活》
3. 《你是人间的四月天》
4. 《我的南方和北方》
5. 《再别康桥》
6. 《将进酒》
7. 《春》
8. 《沁园春·雪》
9. 《致橡树》
10. 《永远的风华正茂》
11. 《出师表》
12. 《月光下的中国》

这 12 篇是当前标识、排版、分页和 PDF 行为的重要验收样本。

## 3. 产品结构

系统提供两个并列编辑版本。

### 3.1 完整版

主要能力：

- 场景图片；
- 拼音、正文和朗诵标识；
- 九档语势节点；
- 可选参考音频与同步播放；
- A4 分页与多页 PDF；
- 独立的完整版人工分行。

完整版整体设计已经稳定，后续修改应以修复和兼容为主，不应重新设计主要页面和操作路径。

### 3.2 紧凑版 Compact

主要能力：

- A4 纵向直接编辑；
- 每个视觉行左侧一张小图；
- 图片内纵排编号与节奏题签；
- 右侧拼音、正文、Marker 和语势曲线；
- 五档显示与按住左键连续绘制语势；
- 人工拼音；
- 人工换行、并入上一行、并入下一行；
- 自动分页与多页 PDF；
- 图例按作品实际使用标识自动筛选。

紧凑版是当前视觉与交互优化重点。

## 4. 总体技术架构

```text
浏览器 / React 创作端
  ├── RecitationStudio
  ├── FullA4Editor
  └── CompactRecitationEditor
             │
             │ /api/*
             ▼
Vinext + Cloudflare Worker
  ├── 作品与版本管理
  ├── ControlSpec 保存与导入校验
  ├── 分析任务状态
  ├── 视觉任务与资产版本
  ├── PDF 所需数据
  └── 对 FastAPI 的服务端代理
       │             │
       │             └──────────────┐
       ▼                            ▼
Cloudflare D1                  本地 FastAPI
正式结构化数据                 ├── 文稿朗诵分析
       │                       ├── TTS 朗诵导演
       ▼                       ├── 声音声学分析
Cloudflare R2                  ├── 视觉导演
图片与音频文件                 └── 图片生成代理
                                      │
                                      ▼
                              LLM / ElevenLabs / 生图服务
```

### 4.1 前端层

技术：React 19、TypeScript、Vinext/Vite。

主要职责：

- 作品选择与保存状态；
- 两个编辑版本切换；
- 字符级标识编辑；
- 人工拼音；
- 语势曲线交互；
- 页面测量、分页和 PDF 导出；
- 分析与图片任务轮询。

### 4.2 Worker 业务层

`worker/index.ts` 是当前主要服务端业务入口，负责：

- 作品 CRUD；
- D1/R2 读写；
- ControlSpec 版本；
- 文稿、音频、TTS 与视觉任务；
- 短时签名的分析输入和音频地址；
- 分析服务认证回调；
- 图片生成、失败记录和版本激活；
- 发布与资产读取。

该文件目前职责过多，是后续拆分的重点之一。

### 4.3 Python 分析层

`analysis-service/` 是本地优先的 FastAPI 服务。

它包含四条互相独立的能力：

1. 正文直接生成朗诵 ControlSpec；
2. GPT 生成 Eleven v3 朗诵方案和 TTS 脚本；
3. 对真实音频做对齐、声学分析和结构化解释；
4. 生成视觉方案并代理图片生成。

自动任务、文稿分块缓存和图片任务保存在：

```text
analysis-service/data/image_tasks.sqlite3
```

这个 SQLite 只属于本机任务执行层，不是作品正式数据源。

## 5. 数据边界

### 5.1 D1：正式结构化数据

核心表：

- `works`：作品正文、状态、当前控制谱版本、打印设置；
- `assets`：R2 文件元数据；
- `control_spec_versions`：每一版完整 ControlSpec；
- `audio_versions`：音频版本和角色；
- `processing_jobs`：文稿、音频、TTS、图片任务；
- `work_visual_profiles`：作品视觉风格；
- `visual_specs`：Hero/Scene 视觉方案；
- `visual_assets`：正式图片版本；
- `publications`：发布快照。

### 5.2 R2：正式二进制资产

保存：

- 真人参考音频；
- 标准 AI 朗诵；
- Hero 和 Scene 图片；
- 人工上传的替换图片。

D1 记录 R2 object key、版本、作品关系和启用状态。

### 5.3 ControlSpec：编辑器共同语言

ControlSpec 是两个编辑器、音频播放、图片关系和 PDF 的共同数据契约，主要包含：

- 全文 `tokens`；
- `sentences`；
- 拼音与人工拼音覆盖；
- 重音、停顿、拖音、换气及其他技巧标识；
- 节奏、语调和语势；
- 分析来源和校验状态；
- 完整版与紧凑版各自的分行布局。

每个正文字符拥有全文唯一 index。拼音、正文、Marker、语势节点、播放时间和人工换行都以这个 index 对齐。

## 6. 完整版与紧凑版的数据关系

两版共享：

- 正文 token；
- 人工拼音；
- 重音、停顿、拖音、换气等朗诵标识；
- 节奏与语调；
- 语势数据；
- 实景、虚景、远景、近景、虚声等技巧标识。

两版分离：

```text
editionLayouts.compact.rows
editionLayouts.full.rows
```

因此：

- 紧凑版调整分行不会再改动完整版；
- 完整版调整分行不会改动紧凑版；
- 字符级标识仍然在两版之间共享；
- 两版都能在本编辑器中执行换行和相邻行合并。

## 7. 默认自动化：正文直接生成图谱

### 7.1 任务流程

```text
用户点击分析
  → 前端先保存作品
  → Worker 在 D1 创建 text_recitation processing_job
  → FastAPI 持久化 text_recitation_task 并立即返回 202
  → 前端轮询 Worker
  → Worker 轮询 FastAPI
  → Python 后台执行器领取任务
  → LLM 分析正文
  → 程序校验、编译 ControlSpec
  → Worker 再次导入校验
  → 创建 control_spec_versions 新版本
  → 作品进入 review
  → 前端载入编辑器
```

这套设计的目的，是避免浏览器、Worker 或网络边缘保持一个很长的 HTTP 请求。

### 7.2 前端轮询策略

- 约每 1.6 秒查询一次任务；
- 遇到 502、503、524 时等待约 2.2 秒再查；
- 连续临时失败超过 8 次，停止当前页面等待，但不删除后台任务；
- 前端最长等待 20 分钟；
- Worker 查询 FastAPI 使用约 15 秒超时；
- 已完成的任务和分块仍会保留。

### 7.3 文稿切分

自动分析路径执行：

```text
一个非空输入行 = 一个 Sentence Row
```

- 不按逗号、句号重新拆句；
- 不允许 LLM 自己增删或合并行；
- 换行符不进入 sentence token 范围；
- 每个字符先由程序建立固定索引，再交给模型分析。

需要与“没有 ControlSpec 时直接建立紧凑版人工空谱”区分：人工空谱构建器还能按行尾终止标点建立初始行，这不是 AI 文稿分析流程。

### 7.4 拼音

程序使用 `pypinyin` 或前端 `pinyin-pro` 生成默认拼音，但多音字不能完全依赖自动库。

固定优先级：

```text
人工拼音覆盖 > 已保存 displayPinyin > 自动生成拼音
```

人工拼音以 token id 保存，并随作品、页面和 PDF 使用；重新分析时 Worker 会把已有人工拼音再次提交给分析服务，避免丢失。

### 7.5 LLM 分析顺序

提示词要求模型按固定层次分析：

1. 理解全文体裁、主题、叙述者和表达对象；
2. 判断全文情绪起点、发展、高潮、回落和最终落点；
3. 判断当前行在上下文中的功能；
4. 判断当前行节奏；
5. 判断重音；
6. 判断额外短停；
7. 判断语势；
8. 判断句尾语调；
9. 程序校验；
10. 程序编译成 ControlSpec 和曲线。

LLM 只负责表达判断，不负责生成正文、拼音、token、时间戳或固定像素坐标。

## 8. 自动标谱规则

### 8.1 重音

优先级：

```text
上下文逻辑与表达意图
> 当前句信息核心
> 情绪落点
> 语法候选
```

规则：

- 每行 `focus_spans` 为 0～1；
- 允许没有重音，并应大量出现；
- 短行默认倾向没有重音；
- 优先标完整的 2～4 字语义词组；
- 不因名词、形容词、疑问词或意象机械标红；
- 重音是信息焦点，不等于音量一定更大。

当前边界：程序能硬性限制“每个 Sentence 最多一个重音”，但“视觉上连续 2～4 行属于同一完整语义句时，整组最多一个重音”目前主要依赖提示词判断，尚未由程序重新分组并二次硬校验。

### 8.2 停顿

自动系统只生成短停 `/`：

- 每行 0～2 个，多数为 0～1；
- 已有明显标点时通常不再重复添加 `/`；
- 不允许放在重音词组、成语、人名、地名、数量结构或紧密修饰结构内部；
- 程序会删除紧贴明显标点的冗余自动短停。

### 8.3 节奏

六种节奏：

```text
light    轻快
solemn   凝重
relaxed  舒缓
tense    紧张
soaring  高亢
low      低沉
```

节奏需要结合全文基调、当前情感阶段、前后文、停连、轻重和表达张力，不能简单等同于语速。

### 8.4 语势

四种基础事件：

```text
peak     波峰
valley   波谷
rising   起潮
falling  落潮
```

每个事件包含：

- 生效文字范围；
- 核心区域；
- 强度 1～3；
- 置信度。

每行最多两个事件，多数为零或一个；每个自动事件至少覆盖 3 个有效朗读文字。

程序把事件编译为九档曲线：

- 基准为 4；
- 自动主要使用 1～7；
- 0、8 留给人工极端调整；
- 强度 1、2、3 对应约 3、4、5 档可见变化；
- 事件外保持平台；
- 禁止没有语义理由的逐字锯齿。

紧凑版把编辑体验映射为五个显示档位；完整版仍保留九档编辑能力。

### 8.5 语调

语调和语势分开：

- 语势描述当前行整体表达运动；
- 语调只描述句尾最后约 1～2 个词的走向。

自动新结果只生成：

- 上扬 `rising`；
- 下降 `falling`；
- 无明确方向。

问号不必然上扬，句号也不必然下降。

### 8.6 自动系统不会生成的标识

下列内容全部保留给人工编辑：

```text
V      换气
v      偷气
///    长停
—      拖音
虚声
一字一顿
实景 / 虚景
远景 / 近景
```

## 9. 程序硬校验

模型输出必须通过 Pydantic 和程序校验：

- 句子数量必须一致；
- 正文必须逐字一致；
- start/end token index 必须一致；
- 不得增加、删除、改写或调换正文；
- 标识不得越出当前句；
- 重音范围不能重叠；
- 停顿不能落在重音词组内部；
- 自动语势至少覆盖 3 个有效朗读字；
- 未定义字段被拒绝；
- 缓存结果再次使用前也必须重新校验。

短文第一次正文一致性校验失败时，会携带具体错误让模型定向修复一次；第二次仍失败则任务失败，不会使用 Demo ControlSpec。

## 10. 长文分块与断点恢复

不超过 12 行：整篇单次结构化分析。

超过 12 行：

1. 先生成一次全篇 `WorkContext`；
2. 按每块最多 10 行处理，最后一块可以更小；
3. 每块带前后各最多 2 行作为只读上下文；
4. 同时最多运行 2 个分块；
5. 严格按原文顺序合并；
6. 合并后重新执行整篇校验。

缓存键包含：

- 标题、作者、完整正文；
- pipeline version；
- 模型与 reasoning effort；
- 完整系统提示词；
- 人工拼音覆盖。

只有这些内容完全相同时才复用已完成分块。模型或规则改变后不会误用旧缓存。

Python 服务重启时，遗留的 `running` 文稿任务会重新排队；已完成分块不需要重做。

## 11. 真实音频分析路径

真人参考朗诵和 AI 参考朗诵最终会进入同一套标准声音分析：

```text
正文 + 标准分析音频
  → Eleven Forced Alignment
  → 字符/词时间戳
  → FFmpeg 转换
  → Praat-Parselmouth 声学分析
  → 音高、能量、时值、停连和语速摘要
  → LLM Interpretation
  → ControlSpec
```

声学路径会得到：

- 字符真实开始/结束时间；
- 局部时值比；
- F0 和归一化音高；
- 强度和归一化能量；
- 前后静音间隔；
- voiced ratio；
- 段落语速和宏观音高轮廓；
- 停顿与拖音候选。

逐帧声学数据不直接发送给 LLM，只发送压缩后的证据摘要。

拖音不能由 LLM 凭语义创造，必须先存在声学候选，再由保守分类器确认。

## 12. AI 参考朗诵路径

```text
作品正文
  → GPT 朗诵导演 performancePlan
  → Eleven v3 ttsText
  → 程序删除 Audio Tags 和控制符后与原文逐字核对
  → Eleven 生成固定标准 Voice
  → 进入真实音频分析路径
```

朗诵导演和图谱分析是两个独立 Schema。朗诵导演负责“如何演”，不直接生成图谱标识。

## 13. 视觉与图片自动化

### 13.1 视觉方案

Visual Director 读取作品和 ControlSpec，生成：

- 全篇视觉风格；
- 色板、光线、质感和氛围；
- 每个 Scene 的来源句子；
- 场景摘要、主体、环境、象征和构图；
- 图片 prompt 与 negative prompt。

长作品按最多 8 个 Scene 分批规划；视觉规划超时可以使用安全的本地确定性方案，但不会伪造朗诵 ControlSpec。

### 13.2 场景图片

当前只自动生产 Scene Cards，不再把 Hero 纳入常规生成任务。

- Scene 默认尺寸：768 × 1031，接近 3:4；
- 同时生成 3 张；
- 单张失败后再重试 1 次；
- 图片写入 R2；
- D1 保存版本、sceneId、prompt、状态和是否启用；
- 支持 `completed`、`partial_failed`、`failed`；
- 部分失败不会删除已经成功的图片。

### 13.3 已闭环：整篇场景图请求

文稿分析成功后，前端调用：

```json
{"type":"all"}
```

Worker 会在缺少现役视觉方案时自动包含规划，然后生成整篇全部 Scene。Hero 已从任务执行器的生成目标中移除，因此 `all` 不再产生 Hero 图片。单张重生成仍使用带具体 `sceneId` 的 `scene` 请求。

## 14. 紧凑版图片关系

产品规则是：每一个最终视觉行都要有一张对应小图。

为了不破坏完整版：

- ControlSpec Sentence 仍是共享的语义和标识数据；
- 紧凑版人工换行可产生多个视觉行；
- 每个紧凑视觉行使用稳定的 line id 作为 sceneId；
- 完整版继续按自己的 row/scene 关系取图；
- 图片与对应文字卡必须作为分页整体，不能跨页拆开。

这部分需要特别防止“语义 Scene”和“紧凑视觉行”两个概念混用。后续建议把资产关系明确命名为：

```text
semanticSceneId
compactLineSceneId
```

## 15. 当前编辑器特例

### 15.1 《春》

- 紧凑版隐藏语势曲线；
- 上方显示实景眼睛和虚景爱心；
- 文稿、拼音和技巧标识使用专门居中布局；
- 完整版仍显示语势曲线；
- 字体和标识尺寸有作品级放大。

### 15.2 《出师表》

- 原重音被转换为虚声；
- 连续虚声字符使用一个较大的虚线组合框；
- 只有被虚声框影响的位置增加局部留白；
- 不再对整篇统一扩大字间距。

### 15.3 远景与近景

- 作为字符左侧 Marker；
- 使用专门绘制的 emoji 风格望远镜/放大镜图标；
- 图例只在作品实际使用时出现。

当前这些规则有一部分仍依赖固定 workId 或组件内判断。下一阶段应迁移到可声明的作品级 `renderProfile`，避免继续扩散硬编码。

## 16. 图例逻辑

当前目标规则：

```text
正文实际出现的标识 → 页面底部显示对应图例
正文未使用的标识 → 自动隐藏
```

用户仍可在图例设置中手动选择，但自动推导应作为默认值。图例不是标谱数据本身，只是打印展示设置，不应反向删除正文标识。

## 17. PDF 导出

两个编辑器都以浏览器真实 DOM 为最终打印来源：

- 等待字体加载；
- 等待所有图片完成或失败；
- 检查页面溢出；
- 强制 A4 portrait、0 margin；
- 保持卡片整体分页；
- 输出多页 PDF；
- 批量导出后再压缩和打包 ZIP。

最近 12 篇的验收页数：

```text
紧凑版：24 页
完整版：73 页
```

## 18. 本地启动与配置

推荐命令：

```text
npm run local
```

它会检查环境、配置、D1、分析服务和网站，然后打开浏览器。

需要两份本地配置：

```text
site/.dev.vars
site/analysis-service/.env
```

两边的 `ANALYSIS_SERVICE_TOKEN` 和 `ANALYSIS_CALLBACK_TOKEN` 必须一致。

当前 2026-08-25 这两个文件都缺失，因此：

- `npm run local` 会停止；
- 可以单独用 `npm run dev` 启动编辑器；
- 作品库、人工编辑和本地 PDF 可以使用；
- 自动文稿分析、图片生成和音频分析不可用，直到安全恢复本地配置。

不要把真实配置、Key 或 Token 写入代码、Git、日志或交接文档。

## 19. 关键文件索引

| 领域 | 文件 |
|---|---|
| 总工作台 | `components/RecitationStudio.tsx` |
| 紧凑版编辑器 | `components/CompactRecitationEditor.tsx` |
| 完整版编辑器 | `components/FullA4Editor.tsx` |
| 语势交互 | `components/TeachingProsodyTrack.tsx` |
| 新技巧图标 | `components/RecitationTechniqueGlyphs.tsx` |
| 虚声组合框 | `components/VirtualVoiceGroupOverlay.tsx` |
| 两版分行隔离 | `lib/edition-layout.ts` |
| 紧凑版人工空谱 | `lib/compact-control-spec.ts` |
| 语势视觉转换 | `lib/prosody-visual.ts` |
| ControlSpec 类型 | `lib/recitation-schema.ts` |
| 语义场景/视觉行 | `lib/semantic-scene-lines.ts` |
| 场景资产匹配 | `lib/visual-assets.ts` |
| 图例推导 | `lib/compact-legend.ts` |
| 技巧数据 | `lib/delivery-technique.ts` |
| Worker API | `worker/index.ts` |
| FastAPI 入口 | `analysis-service/app/main.py` |
| 文稿任务持久化 | `analysis-service/app/text_recitation_tasks.py` |
| 文稿后台执行器 | `analysis-service/app/text_recitation_task_worker.py` |
| 文稿生成与分块 | `analysis-service/app/text_recitation/generate.py` |
| 自动标谱规则 | `analysis-service/app/text_recitation/text_recitation_rules_v2.md` |
| 语势编译器 | `analysis-service/app/text_recitation/prosody_compiler.py` |
| 音频分析管线 | `analysis-service/app/pipeline.py` |
| 声学解释 | `analysis-service/app/interpretation/llm_interpreter.py` |
| 视觉导演 | `analysis-service/app/interpretation/visual_director.py` |
| D1 Schema | `db/schema.ts` |

## 20. 已知风险

### P0：数据安全

- `.wrangler/state/v3` 同时包含本地 D1 与 R2；
- 不得只恢复其中一侧；
- 不得把约 1.8GB 原始状态提交到普通 Git；
- 删除重复或未完成作品必须先获得用户确认；
- main 上已有 PDF 不得覆盖或删除。

### 已完成：编辑器安全基线

最近 12 篇相关编辑器成果已经建立独立安全基线提交：

```text
28259b5 feat: finalize compact and full recitation editors
```

后续功能精简与该基线分开提交，可独立回退。

### 已完成：自动场景图契约

前端整篇生成已改用 `type = all`；`type = scene` 只用于带具体 `sceneId` 的单图重生成。

### P1：跨行语义句硬校验

把“一个完整语义句最多一个重音词组”从提示词规则升级为程序规则：

1. 先建立 semantic group；
2. 跨组校验 focus 数量；
3. 超出时按置信度和上下文优先级收敛；
4. 记录修正说明，而不是静默删除。

### P1：去除作品 ID 硬编码

把《春》《出师表》等特例迁移为作品级可配置 profile：

```text
renderProfile.hideCompactProsody
renderProfile.techniqueLane
renderProfile.fontScale
renderProfile.virtualVoiceSpacing
```

### P1：拆分巨型文件

优先拆分：

- `RecitationStudio.tsx`：作品状态、任务状态、编辑器容器、PDF；
- `worker/index.ts`：works、analysis、tts、visuals、assets、publish；
- `CompactRecitationEditor.tsx`：页面、卡片、字符菜单、图例、打印。

### P1：导出成为正式流水线

把目前的临时批量脚本整理为正式命令：

```text
npm run export:compact -- --works manifest.json
npm run export:full -- --works manifest.json
```

命令应自动执行：文件数、页数、溢出、缺图、页码、首尾页渲染、压缩、ZIP 校验。

### P2：测试基线

2026-08-21 的同步提交曾通过：

- 网站 build；
- 94 项前端单元测试；
- 2 项集成测试；
- 54 项 Python 测试；
- 修改文件 ESLint；
- `git diff --check`。

但这不是 2026-08-25 当前未提交工作区的完整验证结果。交接前应重新运行当前全套测试，并把结果写入新的验收记录。

## 21. 下一阶段建议顺序

### 第一阶段：完成现役界面精简

1. 恢复本地配置但不泄露 Secret；
2. 运行 build、前端测试、Python 测试和 12 篇 PDF 回归；
3. 固化 12 篇作品清单与预期页数；
4. 在确认历史音频/发布数据无需恢复入口后，再删除隔离的前端兼容组件与对应 CSS。

### 第二阶段：增强自动化质量

1. 增加文稿分析 → ControlSpec → 图片 → 编辑器的端到端测试；
2. 增加跨行语义重音硬校验；
3. 给任务增加可读的真实阶段进度，不再只显示 15/55/100。

### 第三阶段：减少特例和耦合

1. 把作品特例迁移到 render profile；
2. 拆分 Worker 和 Studio 巨型文件；
3. 明确 semantic scene 与 compact visual line；
4. 建立正式批量导出工具。

### 第四阶段：为下一个项目抽取通用内核

如果要基于本项目开发下一项目，建议抽取四个独立包：

1. `recitation-control-spec`：字符索引、标识、语势、布局契约；
2. `recitation-analysis`：文稿分块、Prompt、校验、曲线编译；
3. `visual-asset-pipeline`：Scene 方案、生成、版本、R2 关系；
4. `a4-editor-core`：DOM 测量、分页、打印与 PDF 验证。

业务作品、特殊标识和品牌 UI 留在应用层，不应继续写入通用内核。

## 22. 交接验收清单

- [ ] 当前未提交修改已经安全提交或打包；
- [ ] 当前 D1/R2 已成套备份；
- [ ] `.dev.vars` 和 `analysis-service/.env` 已安全恢复；
- [ ] `npm run local` 可以同时启动网站和分析服务；
- [ ] `/api/health` 和 FastAPI `/health` 正常；
- [ ] 作品库数量和关键 12 篇可读取；
- [ ] 图片和 D1 关系无缺失；
- [ ] build、前端测试、Python 测试完成；
- [ ] 12 篇紧凑版 PDF 回归完成；
- [ ] 12 篇完整版 PDF 回归完成；
- [ ] 自动整篇 Scene 生成契约已修复或明确记录为待办；
- [ ] GitHub main 现有 PDF 已确认不会被覆盖；
- [ ] 接手人理解 ControlSpec、token index 和两版 layout 分离原则。

## 23. 不可破坏的核心原则

1. 正文是权威输入，模型不能改写正文；
2. 每个字符使用稳定 token index；
3. 人工拼音优先于自动拼音；
4. 一个完整语义句最多一个重音词组，允许没有重音；
5. 自动系统不生成 V/v、长停和拖音；
6. 语势节点必须按正文真实 DOM 位置计算；
7. 完整版与紧凑版共享标识，但分行独立；
8. 紧凑版每个最终视觉行使用一张对应小图；
9. 图片与文稿卡分页时不能拆开；
10. D1 与 R2 必须成套备份和恢复；
11. API Key、Token 和密码不能进入代码、Git、日志或文档；
12. 失败必须保留真实状态，不能用 Demo 结果伪装成功。
