# 声图 · 朗诵情感图谱

“声图”把准确正文、朗诵控制谱和逐行场景视觉整理为可编辑、可打印的情感图谱。当前现役产品以最近 12 篇成品流程为准：作品库 → 准备正文 → 编辑完整版或紧凑版 → 导出多页 PDF。

当前创作主线只有一条：

1. **文稿直出图谱（本地优先）**：保存正文后创建持久化文稿分析任务，前端轮询状态；长文按 8～10 个 Sentence 分块，已完成分块会缓存并在中断后复用。任务完成后保存 `control_spec`，并以“整篇全部 Scene”任务生成场景图。
2. **人工精修**：在完整版或紧凑版直接调整拼音、标识、分行、节奏、语调、语势曲线和场景小图。
3. **成品输出**：两版分别按真实 DOM 分页并导出多页 PDF；紧凑版每个最终视觉行对应一张小图。

正文、任务状态、控制谱版本与视觉元数据保存在 D1；正式视觉资产保存在 R2。文稿分析和视觉生成彼此独立，任一路径失败都保留真实状态与已经完成的结果，不使用固定作品或 Demo 控制谱回退。

历史真人参考音频、AI 参考朗诵、观看端、发布快照和 Hero 数据仍由底层 Schema/API 兼容读取，但已经从现役创作界面移出。第一轮精简不删除这些历史数据，也不改变旧 D1/R2 记录。

编辑器提供两个并列版本：

- **完整版**：多场景图片、拼音、朗诵标识、语势曲线、A4 分页与 PDF，主要页面和交互保持稳定。
- **紧凑版 Compact**：A4 纵向直接编辑，左侧逐行小图，右侧拼音、正文、Marker 与语势曲线；支持人工拼音、人工换行、可选图例、语调再次点击取消，以及按住鼠标连续绘制五档语势。节点始终按正文文字的真实 DOM 位置对齐，分页时一张小图与对应文稿卡保持为一个整体。

创作端会明确显示“未保存、保存中、已保存、保存失败”等状态。切换作品或新建作品前，如果当前内容尚未保存，会要求选择保存、放弃或取消；多个窗口编辑同一作品时，旧窗口不会静默覆盖云端新版本。作品库支持二次确认后永久删除，并清理对应 D1 记录与 R2 文件。

## 项目结构

- `app/`、`components/`：现役创作端与完整版/紧凑版编辑器；历史观看组件只作兼容隔离，不再暴露入口。
- `worker/`：D1/R2、Voice Changer、分析任务、安全交接和发布接口。
- `analysis-service/`：本地优先、也可独立部署的 FastAPI 分析服务。
- `analysis-service/app/tts_director/`：独立的“文字 → Eleven v3 朗诵脚本”知识、Schema、正文校验与生成逻辑。
- `db/`、`drizzle/`：D1 结构与迁移。

## 本地启动

### 一键启动（推荐）

首次先完成下面「环境要求」以及「1. 启动网站」「2. 启动分析服务」中的安装步骤（`npm ci`、创建 `analysis-service/.venv`、安装 Python 依赖、配置 `.dev.vars` 与 `analysis-service/.env`），之后在项目根目录只需：

```text
npm run local
```

启动器会自动：检查运行环境 → 检查本地服务配置 → 初始化本地 D1 → 启动分析服务 → 启动前端 → 打开浏览器。按 `Ctrl+C` 关闭全部服务。

也可以直接双击项目根目录的入口文件（无需打开终端）：

- Windows：`start-local.bat`
- macOS：`start-local.command`

真正启动逻辑统一在 `scripts/start-local.mjs`，双击入口只负责切到项目根目录并调用 `npm run local`。

#### 配置本地服务（两个文件，token 两边必须一致）

一键启动前需要两份本地配置：

- 根目录 `.dev.vars`（复制 `.dev.vars.example`）：`ANALYSIS_SERVICE_URL`、`ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN`
- `analysis-service/.env`（复制 `.env.example`）：`AI_API_KEY`、`LLM_MODEL`、`ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN`

**注意**：`.dev.vars` 与 `analysis-service/.env` 里的 `ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN` 必须完全一致，否则前端与分析服务无法互相认证。启动器会在打开浏览器前校验这些字段（只显示 ✓/✗ 状态，不打印密钥），缺配或两端不一致会直接停止并提示。

#### 初始化本地数据库

首次启动（或清理 `.wrangler` 后），本地 D1 是空库，页面会报 `no such table: works`。运行一次初始化即可：

```text
npm run db:init
```

该命令把 `drizzle/` 下的迁移应用到本地 D1（幂等，可重复执行）。启动器也会在前端启动后自动检测并补做初始化。

### 环境要求

- Node.js 22.13 或更高版本；
- Python 3.12；
- FFmpeg（建议安装；服务找不到系统 FFmpeg 时会使用随包版本）。

### 1. 启动网站

在项目根目录安装依赖并创建本地环境文件：

```text
npm ci
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填写本机使用的服务端配置。其中：

- `ANALYSIS_SERVICE_URL` 本地默认可设为 `http://127.0.0.1:8000`；
- `ANALYSIS_SERVICE_TOKEN` 和 `ANALYSIS_CALLBACK_TOKEN` 必须与分析服务中的值完全一致；
- `ELEVENLABS_API_KEY` 和 `ELEVENLABS_VOICE_ID` 只用于服务端。
- `ELEVENLABS_TTS_MODEL` 可覆盖 AI 参考朗诵模型，默认 `eleven_v3`。
- `IMAGE_PROVIDER`、`IMAGE_MODEL`、`IMAGE_API_KEY` 和 `IMAGE_BASE_URL` 用于外接生图服务；未配置时仍可生成视觉方案和人工上传图片。
- `IMAGE_OCR_MODEL` 用于 Hero 标题/作者自动校验；未配置时，模型生成的 Hero 必须在创作端人工确认后才能展示。

然后启动网站：

```text
npm run dev
```

终端会显示本地访问地址。

### 2. 启动分析服务

另开一个终端：

```text
cd analysis-service
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
cp .env.example .env
```

编辑 `analysis-service/.env`，至少配置 ElevenLabs、通用 GPT、DeepSeek 朗诵解析以及两项服务通信 token。TTS Director 和 Visual Director 复用通用 `LLM_*` 配置；`TTS_DIRECTOR_REASONING_EFFORT` 默认 `medium`。声学证据后的图谱 Interpretation 继续使用独立 `RECITATION_LLM_*` 配置。加载环境变量并启动 FastAPI：

```text
set -a
source .env
set +a
PYTHONPATH=. .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

可访问 `http://127.0.0.1:8000/health` 检查服务配置是否齐全；该接口不会返回 Secret 内容。

## 验证

在项目根目录运行网站检查：

```text
npm run build
npm run lint
npx tsc --noEmit
npm test
```

截至 2026-08-21，全仓库 `npm run lint` 仍会报告 `batch/index.mjs`、`batch/recover.mjs`、`batch/run.mjs`、`batch/scan.mjs` 中的 14 个既有错误；与这些脚本无关的修改应对触及文件单独运行 ESLint，并保留全仓库告警，不能通过降低规则或顺手重构掩盖。

运行分析服务测试：

```text
PYTHONPATH=analysis-service analysis-service/.venv/bin/python -m pytest analysis-service/tests
```

数据结构变更后运行 `npm run db:generate` 并提交生成的迁移。

## 密钥安全

`.dev.vars`、`analysis-service/.env`、API Key、访问令牌和其他 Secret 不得提交到 Git。仓库只保留 `.dev.vars.example` 与 `analysis-service/.env.example` 占位模板；真实值应保存在本地环境或部署平台的 Secret 配置中。

## 产品文档

- [控制谱数据契约](docs/02-data-contract.md)
- [技术架构](docs/03-architecture.md)
- [部署与输入](docs/04-required-inputs.md)
