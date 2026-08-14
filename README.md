# 声图 · 朗诵情感图谱

“声图”把当前作品的准确正文与真实参考朗诵音频转换为可理解、可编辑的情感图谱。参考音频既可以来自优秀真人朗诵，也可以由文稿自动生成。

正式创作流程：

1. 创作者可从云端作品库新建、搜索、继续编辑或永久删除作品；删除前会二次确认，并同步清理该作品的正文、音频、分析结果、控制谱与发布版。
2. 创作者在“准备作品”中选择参考朗诵来源：
   - 真人路径：上传优秀真人朗诵，由 Eleven Voice Changer 统一为标准声音；
   - AI 路径：GPT-5.6 Sol 先生成独立的 `performancePlan` 和 Eleven v3 `ttsText`，程序确认正文未被改写后，再由固定标准 Voice 生成 AI 参考朗诵。
3. 网站把正文、任务状态和朗诵导演方案保存在 D1，把真人与 AI 音频保存在 R2。AI 路径按“方案、声音、分析、图谱”分阶段保存，刷新或后续分析失败都不会丢失已生成音频。
4. 真人路径经过 Voice Changer、AI 路径直接使用 Eleven v3 TTS；两条路径从 `analysisAudio` 开始完全复用同一套分析代码。
5. 独立 Python 服务下载最终的真实 `analysisAudio`，执行 ElevenLabs Forced Alignment、FFmpeg/Praat-Parselmouth 声学分析，并使用内置《朗诵表达分析规则 v1.0》和 DeepSeek 生成当前作品控制谱。GPT-5.6 Sol 不直接生成图谱。
6. 分析完成后直接进入图谱编辑器，创作者可一边播放同源标准声音，一边修改重音、停顿、拖音、语势、句尾语调和节奏；修改后 `audio_sync_status` 变为 `modified`。
7. 创作端的“作品视觉”可先由独立 Visual Director 生成统一视觉方案，再生成或上传 Hero 与逐场景意境图；图片存入 R2，版本、审核和显示状态存入 D1，视觉失败不会阻断朗诵谱。
8. 编辑后直接进入发布预览；观看端播放被分析的同一条 `standard_ai_audio`，提供整篇/单句播放、跳转、倍速与逐字高亮，并只读取已经审核启用的视觉资产。

创作端会明确显示“未保存、保存中、已保存、保存失败”等状态。切换作品或新建作品前，如果当前内容尚未保存，会要求选择保存、放弃或取消；多个窗口编辑同一作品时，旧窗口不会静默覆盖云端新版本。作品库支持二次确认后永久删除，并清理对应 D1 记录与 R2 文件。

生产流程没有固定作品、固定控制谱或失败后的 Demo 回退。任一步骤失败都会显示真实错误状态。

## 项目结构

- `app/`、`components/`：现有创作端、编辑器与观看端。
- `worker/`：D1/R2、Voice Changer、分析任务、安全交接和发布接口。
- `analysis-service/`：云端 FastAPI 分析服务。
- `analysis-service/app/tts_director/`：独立的“文字 → Eleven v3 朗诵脚本”知识、Schema、正文校验与生成逻辑。
- `db/`、`drizzle/`：D1 结构与迁移。

## 本地启动

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

运行分析服务测试：

```text
PYTHONPATH=analysis-service analysis-service/.venv/bin/python -m pytest analysis-service/tests
```

数据结构变更后运行 `npm run db:generate` 并提交生成的迁移。

## 密钥安全

`.dev.vars`、`analysis-service/.env`、API Key、访问令牌和其他 Secret 不得提交到 Git。仓库只保留 `.dev.vars.example` 与 `analysis-service/.env.example` 占位模板；真实值应保存在本地环境或部署平台的 Secret 配置中。

## 产品文档

- [执行清单](docs/01-mvp-plan.md)
- [控制谱数据契约](docs/02-data-contract.md)
- [技术架构](docs/03-architecture.md)
- [部署与输入](docs/04-required-inputs.md)
