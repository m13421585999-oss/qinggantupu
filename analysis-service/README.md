# 声图云端朗诵分析服务

这个 FastAPI 服务只处理一条真实链路：当前作品正文和 R2 参考音频 → ElevenLabs Forced Alignment → FFmpeg/Praat-Parselmouth 声学证据 → 内置《朗诵表达分析规则 v1.0》+ LLM → 当前作品 `control_spec`。

任何步骤失败都会通过回调把任务标为 `failed`，绝不返回 Demo 控制谱。

## 接口

- `GET /health`：检查必需 Secret 是否齐全，不返回 Secret 内容。
- `POST /v1/jobs`：由网站 Worker 使用 `ANALYSIS_SERVICE_TOKEN` 调用。请求包含 `job_id`、签名的 `input_url`、签名的 `audio_url`、`callback_url`。

服务接受任务后在后台处理，并使用 `ANALYSIS_CALLBACK_TOKEN` 回调网站。成功回调同时包含 `analysis_package` 与简化的 `control_spec`；网站负责将它转换为现有编辑器使用的完整结构并保存版本。

## 本地开发

Python 3.12 环境中安装 `requirements.txt`，复制 `.env.example` 为 `.env` 并通过运行环境加载这些变量，然后启动：

```text
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

系统必须能够执行 `ffmpeg`。

## 云端部署

使用本目录的 `Dockerfile` 部署为一个常驻 HTTPS 服务，并配置 `.env.example` 中列出的环境变量。部署完成后，把服务的 HTTPS 根地址保存为网站端 `ANALYSIS_SERVICE_URL`。网站端与分析服务端的 `ANALYSIS_SERVICE_TOKEN`、`ANALYSIS_CALLBACK_TOKEN` 必须完全一致。

当前网站采用仅所有者可访问的 Sites 策略。外部 Python 服务读取签名输入、音频和提交回调时还需要 `SITES_BYPASS_TOKEN`，并只将它放入 `OAI-Sites-Authorization` 请求头。该 token 仅用于跨服务穿过 Sites 登录门，不代替任务签名或回调 token。

不要把 `.env`、API Key 或 token 提交到 Git，也不要放到浏览器代码中。
