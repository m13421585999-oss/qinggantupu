# 本地运行、可选部署与作品输入

## 每篇作品的最低输入

- 作品名称。
- 作者/来源（可选）。
- 完整正文；使用音频分析时，正文必须与实际朗读准确对应。
- 使用音频分析时，另需与正文准确对应、单人普通话清晰的 MP3、WAV、M4A 等参考朗诵；尽量减少背景音乐、混响和削波。

正文与实际朗读明显不一致时，Forced Alignment 会失败，而不是生成近似或 Demo 图谱。

## 网站端本地配置

复制 `.dev.vars.example` 为 `.dev.vars`。核心变量：

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ANALYSIS_SERVICE_URL`
- `ANALYSIS_SERVICE_TOKEN`
- `ANALYSIS_CALLBACK_TOKEN`
- `ELEVENLABS_TTS_MODEL`（可选，默认 `eleven_v3`）
- `IMAGE_PROVIDER`、`IMAGE_MODEL`（默认经分析服务代理；Key 只在服务端）

## Python 分析服务本地配置

复制 `analysis-service/.env.example` 为 `analysis-service/.env`。现役变量：

- `ELEVENLABS_API_KEY`
- `LLM_PROVIDER`
- `AI_BASE_URL`（OpenAI-compatible 地址）
- `AI_API_KEY`
- `LLM_MODEL`
- `LLM_REASONING_EFFORT`
- `VISUAL_REASONING_EFFORT`
- `TTS_DIRECTOR_REASONING_EFFORT`
- `RECITATION_LLM_PROVIDER`
- `RECITATION_LLM_BASE_URL`
- `RECITATION_LLM_MODEL`
- `RECITATION_LLM_API_KEY`（可选；按代码定义回退）
- `RECITATION_REASONING_EFFORT`
- `IMAGE_PROVIDER`、`IMAGE_BASE_URL`、`IMAGE_API_KEY`、`IMAGE_MODEL`
- `IMAGE_OCR_MODEL`（可选）
- `ANALYSIS_SERVICE_TOKEN`
- `ANALYSIS_CALLBACK_TOKEN`
- `SITES_BYPASS_TOKEN`（用于访问所有者私有的 Sites 接口）
- `IMAGE_TASKS_DB_PATH`（可选，默认 `analysis-service/data/image_tasks.sqlite3`）

网站与 Python 服务的两个任务 token 必须分别一致。真实 Key 与 Token 只能保存在本机环境文件或部署平台 Secret 中，不得写入浏览器、Git、Docker 镜像、日志或说明文档。旧 `LLM_API_KEY` / `LLM_BASE_URL` 仅作代码兼容，不是新配置的首选名称。

## 运行条件

Node.js 需要 22.13 或更高版本，Python 服务使用 3.12，并在音频分析时执行 FFmpeg 与 `praat-parselmouth`。推荐从项目根目录运行 `npm run local`；网站默认监听 `127.0.0.1:3000`，分析服务默认监听 `127.0.0.1:8000`。

本地 D1/R2 位于 `.wrangler/state/v3`。恢复前必须停止两项服务、备份当时状态，并把 D1 与 R2 成套恢复；不能只恢复数据库或只恢复图片，也不能把原始 `.wrangler` 状态提交到普通 Git 仓库。
