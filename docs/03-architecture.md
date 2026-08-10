# 产品一 · 正式技术架构

## 完整链路

```text
浏览器创作端
  正文 + 参考朗诵
      ↓
Sites Worker
  D1：作品 / 素材元数据 / processing_job / control_spec / 发布
  R2：参考朗诵 / AI 示范
      ↓ 短时签名输入 URL
Python FastAPI 分析服务
  ElevenLabs Forced Alignment
  FFmpeg + Praat-Parselmouth
  声音事实摘要
  朗诵表达规则 v1.0 + LLM 结构化解释
      ↓ 认证回调
Worker 保存当前作品 control_spec
      ↓
现有图谱编辑器人工修正
      ↓
Eleven v3 TTS with timestamps
      ↓
发布与逐字同步播放
```

## 数据边界

- D1 是作品正文、任务状态、素材元数据、控制谱版本、AI 音频版本与发布状态的权威来源。
- R2 保存参考朗诵和 AI 示范二进制；D1 只保存可查询元数据。
- Python 服务只通过短时签名 URL 读取当前任务的正文和音频，通过带服务端 token 的回调写回结果。
- Eleven、LLM 和回调 Secret 只存在于服务端环境变量。
- 正文改变后，旧控制谱和发布关联立即失效；不会伪装成新作品的分析结果。

## 声音事实与朗诵解释

Eleven 提供字符/词时间戳；Parselmouth 按时间窗提取时长、局部时值比、F0、归一化音高、强度、归一化能量、前后间隔、voiced ratio，以及句段语速和宏观音高轮廓。逐帧数据不发送给 LLM。

LLM 只解释当前正文、上下文、声音摘要与内置规则，输出 `focus`、`pauses`、`prolongations`、`prosody`、`ending_intonation`、`rhythm`。服务端重新注入真实 tokens 并校验正文和索引，模型不能改写正文。

## 图谱与播放对齐

每个字符拥有全文唯一 index。拼音、正文和语势共享这一 index。语势只保存 `active_span` 与 `core_zone`，浏览器根据对应文字真实 DOM 边界生成 SVG，不保存固定像素。

参考朗诵使用 Forced Alignment 时间轴。AI 示范使用 Eleven TTS 返回的独立字符时间轴。播放器依据真实时间戳完成句子跳转与逐字高亮。

## 失败原则

任务状态只有 `queued`、`processing`、`succeeded`、`failed`。对齐、声学分析、LLM、TTS 或回调失败时保留错误状态并允许重新发起；生产代码没有 Demo fallback。
