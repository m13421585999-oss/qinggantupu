# 声图朗诵分析服务（本地优先）

这个 FastAPI 服务处理三项彼此独立的能力：

- `tts-director-knowledge`：作品正文 → GPT-5.6 Sol 朗诵导演方案与 Eleven v3 执行脚本；
- `text-recitation-knowledge`：作品正文 → 持久化后台任务 → 可编辑 `control_spec`；
- `acoustic-analysis-knowledge`：R2 中最终真实 `analysisAudio` → Forced Alignment → FFmpeg/Praat-Parselmouth 声学证据 → DeepSeek 结构化解释 → 当前作品 `control_spec`。

GPT-5.6 Sol 只设计朗诵，不直接生成图谱。真人原始参考音频只作为来源证据保留，不进入标准声音任务的对齐或声学分析。

任何步骤失败都会写入真实失败状态；音频路径同时通过回调收敛网站任务。服务绝不返回 Demo 控制谱。

## 接口与执行方式

- `GET /health`：检查必需 Secret 是否齐全，不返回 Secret 内容。
- `POST /v1/tts-director`：使用通用 GPT 配置生成结构化 `performancePlan` 与 `ttsText`；程序删除 Audio Tags 和控制标点后与原文逐字比对，不一致时只自动修复一次。
- `POST /v1/jobs`：由网站 Worker 使用 `ANALYSIS_SERVICE_TOKEN` 调用。请求只包含 `job_id`、签名的 `input_url`、签名的 `audio_url` 和 `callback_url`，音频不会进入 Vercel 请求体。
- `POST /v1/interpretation-jobs`：复用上次已经保存的 `analysis_package`，只重新执行图谱 Interpretation，不重新对齐、分析或生成 TTS。
- `POST /v1/text-recitation-tasks`：持久化文稿分析请求并立即返回 `202` 与任务编号。
- `GET /v1/text-recitation-tasks/{task_id}`：查询 `queued`、`running`、`completed` 或 `failed`，完成时返回控制谱。
- `POST /v1/text-recitation`：同步兼容接口；网站正式文稿流程不依赖它。
- `POST /v1/visual-director`：独立生成作品视觉方案，不修改朗诵 control_spec。
- `POST /v1/image-generation`：受同一 Bearer token 保护的图片生成代理，只转发生成请求并返回 `b64_json` 或临时 URL；不处理 R2/D1。
- `POST /v1/hero-text-validation`：受同一 Bearer token 保护的 Hero 标题/作者 OCR 核对，只返回 `matched`、`mismatch` 或 `failed` 安全结果。

文稿分析不让浏览器或网站 Worker 持有一个长 HTTP 请求。任务、长文分块结果和图片任务共用 `analysis-service/data/image_tasks.sqlite3`；FastAPI lifespan worker 领取队列，进程重启时把遗留的 `running` 文稿任务重新排队。超过 12 个 Sentence 的正文按每块最多 10 句处理，缓存键同时包含正文、模型、规则与人工拼音，因此只复用完全匹配且已校验的结果。

音频 `/v1/jobs` 与 `/v1/interpretation-jobs` 仍使用认证回调并在当前请求内收敛终态。若网络边缘返回 502、503 或 524，网站保留任务与已完成结果，并通过后续查询继续收口，而不是自动重建同一任务。

如果分析服务返回时网站仍未收到终态回调，任务会明确标为 `failed`；超过 12 分钟仍停留在 `queued` / `processing` 的中断任务，也会在下一次读取或重试时自动收敛为失败，避免永久卡住。

所有中间音频只写入系统临时目录，函数结束后自动删除。运行时优先使用系统 `ffmpeg`，找不到时自动使用 `imageio-ffmpeg` 随包二进制。

## 可选 Vercel 配置

将 Vercel 项目的 Root Directory 设为本目录 `analysis-service`。Vercel 会通过根目录的 `server.py` 自动识别 FastAPI。文稿任务依赖本地 SQLite 与持续运行的 worker；部署到无持久卷或会冻结后台进程的环境前，必须另外验证任务文件和 worker 生命周期。当前推荐在本机长期运行该服务。

在 Vercel 项目中配置：

- `ELEVENLABS_API_KEY`：ElevenLabs 服务端 Key；
- `ANALYSIS_SERVICE_TOKEN`：网站 Worker 调用本服务的 Bearer token；
- `ANALYSIS_CALLBACK_TOKEN`：本服务回调网站的 Bearer token，必须与网站端一致；
- `SITES_BYPASS_TOKEN`：仅所有者可见的 Sites 跨服务访问 token；
- `LLM_PROVIDER`：`openai_compatible` 或回滚用的 `deepseek`；
- `AI_BASE_URL`：OpenAI 兼容网关根地址；DeepSeek 回滚可使用 `https://api.deepseek.com`；
- `AI_API_KEY`：当前 LLM Provider 的服务端 Key；
- `LLM_MODEL`：TTS Director 和 Visual Director 共用的通用 GPT 模型名；
- `LLM_REASONING_EFFORT`：可选，默认 `high`，复杂作品可临时改为 `max` 后重新分析。
- `VISUAL_REASONING_EFFORT`：仅用于视觉导演，默认 `low`；长作品会按最多 8 个 Scene 分批规划，单批超时会使用安全的本地视觉方案，不再让整次生图因 524 失败。
- `TTS_DIRECTOR_REASONING_EFFORT`：仅用于 TTS 朗诵导演，默认 `medium`；
- `IMAGE_TASKS_DB_PATH`：可选；文稿任务、分块缓存和图片任务的 SQLite 路径，默认 `analysis-service/data/image_tasks.sqlite3`；
- `RECITATION_LLM_PROVIDER / BASE_URL / MODEL`：仅用于朗诵解释，默认恢复为 DeepSeek 官方 API、`deepseek-v4-pro`；Visual Director 继续使用通用 LLM 配置。
- `RECITATION_LLM_API_KEY`：可选；未设置时优先复用旧 `LLM_API_KEY`，用于保留原 DeepSeek Key。
- `RECITATION_REASONING_EFFORT`：仅用于完整朗诵解释请求，默认 `high`。
- `IMAGE_PROVIDER`：当前固定为 `openai_compatible`；
- `IMAGE_BASE_URL`：可选的图片生成专用网关根地址；未设置时依次回退到 `AI_BASE_URL`、旧 `LLM_BASE_URL`；
- `IMAGE_API_KEY`：可选的图片生成专用服务端 Key；未设置时依次回退到 `AI_API_KEY`、旧 `LLM_API_KEY`；
- `IMAGE_MODEL`：图片生成模型；以网关 `/v1/models` 返回的真实 ID 为准，当前生产配置为 `gpt-image-2`；
- `IMAGE_OCR_MODEL`：可选的 Hero 文字核对模型；未设置时自动使用 `LLM_MODEL`。

Visual Director 会按通用 OpenAI-compatible 降级策略调用；TTS Director 为降低长请求超时，优先使用 Chat Completions JSON mode，并始终由 Pydantic 严格校验结果。两者共用 Provider、Key 和模型，但 prompt 与 schema 完全独立。声学 Interpretation 使用单独的 `RECITATION_LLM_*` DeepSeek 配置。

当前非敏感默认值为：

```text
LLM_PROVIDER=openai_compatible
AI_BASE_URL=https://api2.65535.space
LLM_MODEL=gpt-5.6-sol
LLM_REASONING_EFFORT=high
VISUAL_REASONING_EFFORT=low
TTS_DIRECTOR_REASONING_EFFORT=medium
RECITATION_LLM_PROVIDER=deepseek
RECITATION_LLM_BASE_URL=https://api.deepseek.com
RECITATION_LLM_MODEL=deepseek-v4-pro
RECITATION_REASONING_EFFORT=high
```

保留的 DeepSeek 回滚配置为：

```text
LLM_PROVIDER=deepseek
provider=deepseek
base_url=https://api.deepseek.com
model=deepseek-v4-pro
thinking=enabled
reasoning_effort=high
```

`AI_API_KEY` 是正式 LLM 变量；旧 `LLM_API_KEY` 仅作为迁移期兼容回滚读取。`IMAGE_API_KEY` 可将图片生成权限与 LLM 权限分开。`GET /health` 的 `configured.LLM_AUTH` 与 `configured.IMAGE_AUTH` 只返回是否已配置的布尔值，不返回 Key。

OpenAI 兼容结构化输出按 `Responses json_schema` → `Chat Completions json_schema` → `Chat Completions json_object` 顺序降级。只有上游明确不支持相应端点/Schema，或返回内容未通过本地 Pydantic 校验时才降级；JSON Object 模式解析或校验失败会进行一次定向修复重试。成功使用的真实 endpoint 和输出模式会写入视觉响应 `_meta`，并写入分析包的非业务 `_meta.llm`，不会改变 control_spec Schema 或组装规则。

图片生成优先使用服务端 `IMAGE_BASE_URL` / `IMAGE_API_KEY`，未设置的单项才分别回退到 `AI_BASE_URL` / `AI_API_KEY`（再兼容旧 `LLM_*` 变量）；Hero OCR 继续使用结构化 LLM 的 `llm_base_url` / `llm_api_key`。浏览器端不会接触任何 Key。`/v1/image-generation` 只使用解析后的图片专用配置调用规范化的 `/v1/images/generations`；Base URL 无论是否已经包含 `/v1` 都不会重复拼接版本路径。

部署完成后，把服务 HTTPS 根地址配置到网站端 `ANALYSIS_SERVICE_URL`。网站端与分析服务端的 `ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN` 必须完全一致。

## 本地验证

使用 Python 3.12：

```text
python -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
PYTHONPATH=. .venv/bin/python -m pytest tests
PYTHONPATH=. .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

本地验证时只在本机环境文件中设置 `AI_API_KEY`，需要分离图片权限时再设置 `IMAGE_API_KEY`。不要提交 `.env`、`.env.local`、API Key 或 token，也不要把它们放进浏览器代码。

## 部署体积与限制

- Python 固定为 3.12；
- 运行依赖与开发依赖已分离，测试、缓存、Docker 文件和样本不会进入函数包；
- 标准 Python Function 未压缩包上限为 500 MB；
- Vercel 请求/响应体上限不适合传音频，本服务始终通过网站签名 URL 拉取 R2 音频；
- 单次任务需在 300 秒内完成，第一版适合约 1～3 分钟的朗诵样本。
