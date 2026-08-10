# 产品一 · 当前技术架构

## 1. 最小正式架构

```text
Windows 本地分析工具
  正文 + 参考朗诵
      ↓ ElevenLabs Forced Alignment
      ↓ FFmpeg + Parselmouth
  analysis-result.json（声音事实）
      ↓ 人工复制给 ChatGPT
  control_spec JSON
      ↓ 手工导入
在线创作端（React + Worker）
      ↓
  D1：作品 / 控制谱版本 / 发布状态
  R2：AI 示范音频
      ↓
  Eleven v3 TTS with timestamps
      ↓
在线观看端：图谱 + AI 示范 + 同步高亮
```

网站不会调用本地 Python。本地工具也不会连接 D1、R2 或网站接口。二者只通过创作者明确复制、导入的 JSON 衔接，因此第一版不需要 Railway、Docker、任务队列或 LLM API。

## 2. 本地分析工具

`local-analyzer` 使用 Python 与 Tkinter，提供正文输入、音频选择、开始分析、复制结果和下载 JSON。

处理顺序：

1. 把准确正文和真实音频提交给 ElevenLabs Forced Alignment。
2. 映射回原始全文的稳定字符 index；覆盖率低于阈值时明确失败。
3. 用系统 FFmpeg，或 `imageio-ffmpeg` 自带二进制，转成 mono 16 kHz PCM WAV。
4. Parselmouth 按 token 时间窗计算时长、局部时值比、F0、归一化音高、强度、归一化能量、前后停顿与 voiced 状态。
5. Python 聚合句段语速、明显时值变化、停顿、能量变化和经过平滑的宏观 pitch contour。
6. 输出紧凑 JSON；不输出逐帧 F0，也不判断重音、拖音、语势、句尾语调或节奏。

API Key 只从 `local-analyzer/.env` 读取。该文件、虚拟环境和输出 JSON 均不会进入 Git 或网站部署。

## 3. 在线创作端

当前步骤为：

1. 保存作品名称、作者/来源和唯一正文。
2. 粘贴并导入 ChatGPT 返回的 `control_spec`。
3. 在现有单句面板中调整重音、停顿、拖音、语势区间与强度、句尾语调和节奏。
4. 可选生成 Eleven v3 AI 示范。
5. 预览并发布到观看端。

导入层会拒绝以下数据：token 数量或字符与网站正文不一致、索引不连续、缺少字符时间戳、汉字缺少可展示拼音、句段未连续覆盖全文、编辑标记引用越界。导入失败不会修改正文或当前控制谱。

## 4. 图谱与播放对齐

每个字符拥有全文唯一 `index`。拼音层和正文层使用同一 token 网格；语势只保存 `active_span` 与 `core_zone` 的 token 范围。浏览器读取对应文字的实际 DOM 边界后生成 SVG 曲线，并在字体加载、缩放和容器尺寸变化时重新测量，因此不保存固定像素坐标。

参考朗诵时间戳仅用于生成控制谱的证据。AI 示范使用 Eleven TTS 返回的独立字符时间戳；观看端按这条最终时间轴执行整篇播放、听本句、句子跳转与逐字高亮。

## 5. 数据与失败原则

- D1 是作品正文、控制谱版本和发布状态的权威来源。
- R2 只保存音频二进制，D1 保存对应元数据。
- 正文变化时，旧控制谱和发布指针失效；历史记录不被伪装成新作品分析结果。
- 生产路径没有固定 Demo 控制谱，也没有失败 fallback。
- 第一版无多用户、权限、团队协作、云端 Python 或 LLM API。
