# 声图云端朗诵分析服务

这个 FastAPI 服务只处理一条正式链路：当前作品正文和 R2 `standard_ai_audio` → ElevenLabs Forced Alignment → FFmpeg/Praat-Parselmouth 声学证据 → 内置《朗诵表达分析规则 v1.0》+ 结构化 LLM → 当前作品 `control_spec`。真人原始参考音频只作为来源证据保留，不进入新任务的对齐或声学分析。

任何步骤失败都会通过回调把任务标为 `failed`，绝不返回 Demo 控制谱。

## 接口与执行方式

- `GET /health`：检查必需 Secret 是否齐全，不返回 Secret 内容。
- `POST /v1/jobs`：由网站 Worker 使用 `ANALYSIS_SERVICE_TOKEN` 调用。请求只包含 `job_id`、签名的 `input_url`、签名的 `audio_url` 和 `callback_url`，音频不会进入 Vercel 请求体。
- `POST /v1/visual-director`：独立生成作品视觉方案，不修改朗诵 control_spec。
- `POST /v1/image-generation`：受同一 Bearer token 保护的图片生成代理，只转发生成请求并返回 `b64_json` 或临时 URL；不处理 R2/D1。
- `POST /v1/hero-text-validation`：受同一 Bearer token 保护的 Hero 标题/作者 OCR 核对，只返回 `matched`、`mismatch` 或 `failed` 安全结果。

Vercel Python Function 不能依赖发送响应后继续运行的 FastAPI `BackgroundTasks`。因此 `/v1/jobs` 会保持请求，直到分析完成并把 `succeeded` 或 `failed` 终态回调给网站；网站 Worker 也会在同一次创建任务请求中等待这一终态，不再依赖只有短暂续命窗口的 `waitUntil`。`vercel.json` 把函数最长执行时间设为 300 秒。

如果分析服务返回时网站仍未收到终态回调，任务会明确标为 `failed`；超过 12 分钟仍停留在 `queued` / `processing` 的中断任务，也会在下一次读取或重试时自动收敛为失败，避免永久卡住。

所有中间音频只写入系统临时目录，函数结束后自动删除。运行时优先使用系统 `ffmpeg`，找不到时自动使用 `imageio-ffmpeg` 随包二进制。

## Vercel 配置

将 Vercel 项目的 Root Directory 设为本目录 `analysis-service`。Vercel 会通过根目录的 `server.py` 自动识别 FastAPI，并原样保留 `/health` 和 `/v1/jobs` 请求路径。

在 Vercel 项目中配置：

- `ELEVENLABS_API_KEY`：ElevenLabs 服务端 Key；
- `ANALYSIS_SERVICE_TOKEN`：网站 Worker 调用本服务的 Bearer token；
- `ANALYSIS_CALLBACK_TOKEN`：本服务回调网站的 Bearer token，必须与网站端一致；
- `SITES_BYPASS_TOKEN`：仅所有者可见的 Sites 跨服务访问 token；
- `LLM_PROVIDER`：`openai_compatible` 或回滚用的 `deepseek`；
- `AI_BASE_URL`：OpenAI 兼容网关根地址；DeepSeek 回滚可使用 `https://api.deepseek.com`；
- `AI_API_KEY`：当前 LLM Provider 的服务端 Key；
- `LLM_MODEL`：朗诵解释和 Visual Director 共用的模型名；
- `LLM_REASONING_EFFORT`：可选，默认 `high`，复杂作品可临时改为 `max` 后重新分析。
- `IMAGE_PROVIDER`：当前固定为 `openai_compatible`；
- `IMAGE_MODEL`：图片生成模型，当前默认 `image2.0`；
- `IMAGE_OCR_MODEL`：可选的 Hero 文字核对模型；未设置时自动使用 `LLM_MODEL`。

`openai_compatible` 会优先调用 Responses API，并用各自独立的 JSON Schema 约束朗诵解释与 Visual Director；只有网关明确不提供 Responses endpoint 时，才回退到同一网关的 Chat Completions。两类请求共用 Provider 和模型，但 prompt 与 schema 完全独立。

当前非敏感默认值为：

```text
LLM_PROVIDER=openai_compatible
AI_BASE_URL=https://api2.65535.space
LLM_MODEL=gpt-5.6-sol
LLM_REASONING_EFFORT=high
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

`AI_API_KEY` 是正式变量；旧 `LLM_API_KEY` 仅作为迁移期兼容回滚读取。`GET /health` 只返回 Provider、Base URL、模型等非敏感配置，不返回 Key。

OpenAI 兼容结构化输出按 `Responses json_schema` → `Chat Completions json_schema` → `Chat Completions json_object` 顺序降级。只有上游明确不支持相应端点/Schema，或返回内容未通过本地 Pydantic 校验时才降级；JSON Object 模式解析或校验失败会进行一次定向修复重试。成功使用的真实 endpoint 和输出模式会写入视觉响应 `_meta`，并写入分析包的非业务 `_meta.llm`，不会改变 control_spec Schema 或组装规则。

图片生成和 Hero OCR 与结构化 LLM 共用服务端 `AI_BASE_URL` / `AI_API_KEY`，浏览器端不接触 Key。`/v1/image-generation` 只调用规范化后的 `/v1/images/generations`；Base URL 无论是否已经包含 `/v1` 都不会重复拼接版本路径。

部署完成后，把服务 HTTPS 根地址配置到网站端 `ANALYSIS_SERVICE_URL`。网站端与分析服务端的 `ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN` 必须完全一致。

## 本地验证

使用 Python 3.12：

```text
python -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
PYTHONPATH=. .venv/bin/python -m pytest tests
PYTHONPATH=. .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

本地验证时只在本机环境文件中设置 `AI_API_KEY`。不要提交 `.env`、`.env.local`、API Key 或 token，也不要把它们放进浏览器代码。

## 部署体积与限制

- Python 固定为 3.12；
- 运行依赖与开发依赖已分离，测试、缓存、Docker 文件和样本不会进入函数包；
- 标准 Python Function 未压缩包上限为 500 MB；
- Vercel 请求/响应体上限不适合传音频，本服务始终通过网站签名 URL 拉取 R2 音频；
- 单次任务需在 300 秒内完成，第一版适合约 1～3 分钟的朗诵样本。
