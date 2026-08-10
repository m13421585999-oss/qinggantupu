# 正式部署与作品输入

## 每篇作品

- 作品名称。
- 作者/来源（可选）。
- 与参考朗诵内容准确对应的完整正文。
- 单人、普通话清晰的 MP3、WAV、M4A 等参考朗诵；尽量减少背景音乐、混响和削波。

正文与实际朗读明显不一致时，Forced Alignment 会失败，而不是生成近似或 Demo 图谱。

## 网站端环境变量

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ANALYSIS_SERVICE_URL`
- `ANALYSIS_SERVICE_TOKEN`
- `ANALYSIS_CALLBACK_TOKEN`

## Python 分析服务环境变量

- `ELEVENLABS_API_KEY`
- `LLM_API_KEY`
- `LLM_BASE_URL`（默认 OpenAI-compatible `/v1` 地址）
- `LLM_MODEL`
- `ANALYSIS_SERVICE_TOKEN`
- `ANALYSIS_CALLBACK_TOKEN`
- `SITES_BYPASS_TOKEN`（用于访问所有者私有的 Sites 接口）

网站与 Python 服务的两个任务 token 必须分别一致。所有值都配置为服务端 Secret，不得写入浏览器、Git、Docker 镜像或说明文档。

## 运行条件

Python 服务使用 3.12，必须能够执行 FFmpeg，并安装 `praat-parselmouth`。`analysis-service/Dockerfile` 已包含这些运行条件。

Windows `local-analyzer` 仍可作为离线排查工具，但其 JSON 不会自动成为正式作品控制谱，也不会替代云端生产任务。
