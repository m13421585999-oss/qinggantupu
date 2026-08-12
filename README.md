# 声图 · 朗诵情感图谱

“声图”把当前作品的准确正文与优秀真人朗诵转换为可理解、可编辑、可继续驱动 AI 朗诵的情感图谱。

正式创作流程：

1. 创作者填写作品名称、作者/来源和完整正文，上传真实参考朗诵。
2. 网站把正文和任务保存在 D1，把音频保存在 R2。
3. 网站先调用 Eleven Voice Changer，把真人参考朗诵转换并保存为 `standard_ai_audio`。
4. 独立 Python 服务只下载这条 `standard_ai_audio`，执行 ElevenLabs Forced Alignment、FFmpeg/Praat-Parselmouth 声学分析，并使用内置《朗诵表达分析规则 v1.0》和 DeepSeek 生成当前作品控制谱。
5. 分析完成后直接进入图谱编辑器，创作者可一边播放同源标准声音，一边修改重音、停顿、拖音、语势、句尾语调和节奏；修改后 `audio_sync_status` 变为 `modified`。
6. 编辑后直接进入发布预览；观看端播放被分析的同一条 `standard_ai_audio`，提供整篇/单句播放、跳转、倍速与逐字高亮。

生产流程没有固定作品、固定控制谱或失败后的 Demo 回退。任一步骤失败都会显示真实错误状态。

## 项目结构

- `app/`、`components/`：现有创作端、编辑器与观看端。
- `worker/`：D1/R2、Voice Changer、分析任务、安全交接和发布接口。
- `analysis-service/`：云端 FastAPI 分析服务。
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

编辑 `analysis-service/.env`，至少配置 ElevenLabs、DeepSeek 以及两项服务通信 token。加载环境变量并启动 FastAPI：

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
