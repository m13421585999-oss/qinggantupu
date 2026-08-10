# 声图云端朗诵分析服务

这个 FastAPI 服务只处理一条真实链路：当前作品正文和 R2 参考音频 → ElevenLabs Forced Alignment → FFmpeg/Praat-Parselmouth 声学证据 → 内置《朗诵表达分析规则 v1.0》+ LLM → 当前作品 `control_spec`。

任何步骤失败都会通过回调把任务标为 `failed`，绝不返回 Demo 控制谱。

## 接口与执行方式

- `GET /health`：检查必需 Secret 是否齐全，不返回 Secret 内容。
- `POST /v1/jobs`：由网站 Worker 使用 `ANALYSIS_SERVICE_TOKEN` 调用。请求只包含 `job_id`、签名的 `input_url`、签名的 `audio_url` 和 `callback_url`，音频不会进入 Vercel 请求体。

Vercel Python Function 不能依赖发送响应后继续运行的 FastAPI `BackgroundTasks`。因此 `/v1/jobs` 会保持请求，直到分析完成并把 `succeeded` 或 `failed` 终态回调给网站；网站 Worker 也会在同一次创建任务请求中等待这一终态，不再依赖只有短暂续命窗口的 `waitUntil`。`vercel.json` 把函数最长执行时间设为 300 秒。

如果分析服务返回时网站仍未收到终态回调，任务会明确标为 `failed`；超过 7 分钟仍停留在 `queued` / `processing` 的中断任务，也会在下一次读取或重试时自动收敛为失败，避免永久卡住。

所有中间音频只写入系统临时目录，函数结束后自动删除。运行时优先使用系统 `ffmpeg`，找不到时自动使用 `imageio-ffmpeg` 随包二进制。

## Vercel 配置

将 Vercel 项目的 Root Directory 设为本目录 `analysis-service`。Vercel 会通过根目录的 `server.py` 自动识别 FastAPI，并原样保留 `/health` 和 `/v1/jobs` 请求路径。

在 Vercel 项目中配置：

- `ELEVENLABS_API_KEY`：ElevenLabs 服务端 Key；
- `ANALYSIS_SERVICE_TOKEN`：网站 Worker 调用本服务的 Bearer token；
- `ANALYSIS_CALLBACK_TOKEN`：本服务回调网站的 Bearer token，必须与网站端一致；
- `SITES_BYPASS_TOKEN`：仅所有者可见的 Sites 跨服务访问 token；
- `LLM_API_KEY`：DeepSeek 服务端 API Key；
- `LLM_REASONING_EFFORT`：可选，默认 `high`，复杂作品可临时改为 `max` 后重新分析。

正式版固定使用 DeepSeek 官方 OpenAI 兼容接口，不读取环境变量自动切换 Provider 或模型：

```text
provider=deepseek
base_url=https://api.deepseek.com
model=deepseek-v4-flash
thinking=enabled
reasoning_effort=high
```

服务端只从 `LLM_API_KEY` 读取 DeepSeek Key。不会使用 `deepseek-chat`、`deepseek-reasoner` 或 Vercel AI Gateway。`GET /health` 会返回上述非敏感的实际运行配置，便于部署后核对。

部署完成后，把服务 HTTPS 根地址配置到网站端 `ANALYSIS_SERVICE_URL`。网站端与分析服务端的 `ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN` 必须完全一致。

## 本地验证

使用 Python 3.12：

```text
python -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
PYTHONPATH=. .venv/bin/python -m pytest tests
PYTHONPATH=. .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

本地验证时只在本机环境文件中设置 `LLM_API_KEY`。不要提交 `.env`、`.env.local`、API Key 或 token，也不要把它们放进浏览器代码。

## 部署体积与限制

- Python 固定为 3.12；
- 运行依赖与开发依赖已分离，测试、缓存、Docker 文件和样本不会进入函数包；
- 标准 Python Function 未压缩包上限为 500 MB；
- Vercel 请求/响应体上限不适合传音频，本服务始终通过网站签名 URL 拉取 R2 音频；
- 单次任务需在 300 秒内完成，第一版适合约 1～3 分钟的朗诵样本。
