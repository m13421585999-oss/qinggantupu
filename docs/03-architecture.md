# 声图 · 当前技术架构

## 现役图谱入口

```text
正文入口（默认、本地优先）
  浏览器保存作品 → Worker 创建 processing_job
  → FastAPI /v1/text-recitation-tasks 返回持久化任务编号
  → 浏览器轮询 Worker，Worker 轮询分析服务
  → 长文分块分析 / 缓存 / 断点恢复
  → Worker 校验并保存 control_spec
  → 创建整篇 all 视觉任务
  → 只生产全部 Scene 图片

共同出口
  → 完整版或紧凑版人工修正
  → A4 / 多页 PDF
```

历史真人参考音频、AI 参考朗诵、观看端、发布快照与 Hero 仍保留底层数据和 API 兼容，现役创作界面不再提供入口。精简阶段不会删除旧作品的相关记录。

## 数据边界

- D1 是作品正文、任务状态、素材元数据、控制谱版本、打印设置和视觉版本的现役权威来源；标准音频时间轴、同步状态与发布状态属于历史兼容字段。
- R2 保存真人原始参考朗诵、标准 AI 音频和正式视觉资产；D1 保存对象键、版本与作品关系。
- 本地 `.wrangler/state/v3` 中的 D1 与 R2 是一套状态，备份和恢复都必须成套进行。
- 分析服务的文稿任务、分块缓存与图片任务使用本机 `analysis-service/data/image_tasks.sqlite3`，该运行数据不进入 Git。
- Python 服务只通过短时签名 URL 读取当前任务的正文和音频，通过带服务端 token 的回调写回结果。
- Eleven、LLM 和回调 Secret 只存在于服务端环境变量。
- 正文改变后，旧控制谱和发布关联立即失效；不会伪装成新作品的分析结果。

## 历史兼容：声音事实与朗诵解释

Eleven 提供字符/词时间戳；Parselmouth 按时间窗提取时长、局部时值比、F0、归一化音高、强度、归一化能量、前后间隔、voiced ratio，以及句段语速和宏观音高轮廓。逐帧数据不发送给 LLM。

LLM 只解释当前正文、上下文、声音摘要与内置规则，输出 `focus`、`pauses`、`prolongations`、`prosody`、`ending_intonation`、`rhythm`。服务端重新注入真实 tokens 并校验正文和索引，模型不能改写正文。文稿直出路径同样执行严格正文和索引校验，并保证一个完整语义句最多一个重音词组。

## 图谱编辑与历史播放兼容

每个字符拥有全文唯一 index。拼音、正文、Marker 和语势共享这一 index。语势保存分析区间、基础路径和稀疏人工高度，浏览器根据每个正文文字的真实 DOM 边界生成 SVG，不保存固定像素。

完整版和紧凑版读取同一 ControlSpec，但属于并列渲染器：完整版维持稳定的九档节点编辑；紧凑版使用五个显示档位并支持按住左键连续绘制。紧凑版人工换行仍保留一个编号卡片；人工拼音覆盖自动拼音并进入页面和 PDF。

`standard_ai_audio` 历史路径使用 Forced Alignment 得到字符/词时间轴。该时间轴与旧播放器仍可由底层读取，但播放器已经从现役创作界面移出。人工改谱后仍保留原音频，并把 `audio_sync_status` 标为 `modified`，避免破坏旧数据语义。

## 失败原则

网站任务对外统一收敛为 `queued`、`processing`、`succeeded`、`failed`；分析服务文稿任务内部使用 `queued`、`running`、`completed`、`failed`。Voice Changer、对齐、声学分析、LLM、图片或回调失败时保留错误状态和已完成成果，允许显式重试；生产代码没有 Demo fallback。
