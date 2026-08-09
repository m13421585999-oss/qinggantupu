# 声图音频分析服务

这个 FastAPI 服务只完成声音事实提取，不调用任何 LLM：

1. ElevenLabs Forced Alignment；
2. FFmpeg 转单声道 16 kHz PCM WAV；
3. Parselmouth 提取局部时值、F0、能量、静音间隔和句段宏观轮廓；
4. 回调网站并保存精简的“朗诵分析包”。

## 本地运行

要求 Python 3.11/3.12 与 FFmpeg。复制 `.env.example` 为 `.env` 并填写值，然后：

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

健康检查：`GET /healthz`。

## Docker 部署

```bash
docker build -t shengtu-analysis .
docker run --rm -p 8080:8080 \
  -e ELEVENLABS_API_KEY=... \
  -e ANALYSIS_SERVICE_TOKEN=... \
  shengtu-analysis
```

可以部署到 Cloud Run、Railway、Render 或任何支持常驻 Docker 容器的平台。当前版本没有外部队列，因此请使用单个进程（Dockerfile 已固定 `--workers 1`），并避免平台在任务处理中强制休眠。网站通过 `ANALYSIS_SERVICE_URL` 调用它。

## Secret 对应关系

- 分析服务：`ELEVENLABS_API_KEY`、`ANALYSIS_SERVICE_TOKEN`。
- 网站 Worker：`ANALYSIS_SERVICE_URL`、同一个 `ANALYSIS_SERVICE_TOKEN`、独立的 `ANALYSIS_CALLBACK_TOKEN`、`ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`。
- `ANALYSIS_CALLBACK_TOKEN` 会随单次任务由网站安全传给分析服务，用于服务回调网站；不会进入浏览器。
