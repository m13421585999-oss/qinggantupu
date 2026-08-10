# 本地朗诵分析工具

这是一个只供创作者本人使用的 Windows 本地工具。它把参考朗诵转换为结构化的“声音事实分析包”，之后可以直接复制给 ChatGPT，请 ChatGPT 生成 `control_spec`。

工具会执行：

- ElevenLabs Forced Alignment：字符和词时间戳；
- FFmpeg：把音频临时转换为单声道 16 kHz PCM WAV；
- Parselmouth：时长、局部时值比例、F0、归一化音高、强度、停顿和宏观音高轮廓；
- 自动保存、复制和下载 `analysis-result.json`。

工具不会判断重音、拖音、语势、句尾语调或节奏，也不会生成任何固定 Demo 数据。

## Windows 首次安装

1. 安装 64 位 Python 3.11、3.12 或 3.13。推荐 Python 3.12，安装时勾选 `Add Python to PATH`。
2. 双击 `setup.bat`。
3. 按提示输入 ElevenLabs API Key。它只会写入本目录的 `.env`，不会写入源代码。
4. 安装完成后关闭窗口。

`setup.bat` 会建立隔离的 `.venv`、安装 Python 依赖，并准备随工具使用的 FFmpeg。电脑已经安装系统 FFmpeg 时也可以直接使用。

## 日常使用

1. 双击 `启动朗诵分析.bat`。
2. 粘贴和参考朗诵逐字一致的完整正文。
3. 选择 MP3 或 WAV 音频。
4. 点击“开始分析”。
5. 完成后点击“复制分析结果”，发给 ChatGPT 生成 `control_spec`。
6. 把 ChatGPT 返回的控制谱 JSON 导入在线网站。

每次成功分析还会自动在 `outputs` 文件夹生成一份带时间的 JSON 备份。

## 本地配置与隐私

- `.env` 和 `.venv` 已被 Git 忽略，不应上传或提交。
- Forced Alignment 必须把正文和参考音频发送给 ElevenLabs。
- Parselmouth 声学分析、JSON 生成和文件保存都在本机完成。
- `ELEVENLABS_VOICE_ID` 只为后续 AI 示范预留，Forced Alignment 当前不使用音色 ID。

## 常见问题

### 提示正文与音频覆盖率过低

请确保正文与实际朗诵逐字一致，包括增删的句子。标点和换行允许存在差异，但不应遗漏或增加朗读内容。

### 提示 ElevenLabs 鉴权失败

打开本目录的 `.env`，确认 `ELEVENLABS_API_KEY=` 后面是有效 Key。不要把 `.env` 发给别人。

### 安装中断

保持联网，重新双击 `setup.bat`。它会复用已经创建的本地环境，不会覆盖已有 `.env`。

