# 声图 · 朗诵情感图谱

“声图”把优秀朗诵加工成看得懂、听得到、可以反复学习的互动朗诵谱。

当前正式创作流程由两个彼此隔离的部分组成：

1. Windows 本地分析工具读取准确正文与参考朗诵，调用 ElevenLabs Forced Alignment，并用 Parselmouth 提取紧凑的声音事实，生成 `analysis-result.json`。
2. 创作者把分析结果交给 ChatGPT 生成 `control_spec`，在网站保存作品并导入 JSON，随后继续编辑图谱、生成 AI 示范和发布。

生产流程不包含固定作品或失败后回退的 Demo 控制谱。网站不会调用创作者电脑上的 Python，也不接任何 LLM API。

现有能力包括：

- D1 保存作品、控制谱版本、AI 音频版本与发布状态；R2 保存 AI 示范音频。
- 导入时严格校验 token 索引、字符、正文、时间戳、拼音与句段覆盖，绝不改写网站正文。
- 拼音、文稿、语势共享同一套 token index；曲线按文字真实 DOM 位置动态绘制。
- 单句编辑重音、停顿、拖音、语势区间与强度、句尾语调和节奏。
- Eleven v3 TTS with timestamps、整篇/单句播放、跳转、倍速与逐字高亮。
- 观看端只显示图谱、AI 示范与同步播放，不显示声学参数和编辑控件。

## 产品文档

- [MVP 执行清单](docs/01-mvp-plan.md)
- [控制谱数据契约](docs/02-data-contract.md)
- [技术架构](docs/03-architecture.md)
- [所需输入](docs/04-required-inputs.md)

## 本地开发

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

检查：

```bash
npm run build
npm run lint
npx tsc --noEmit
npm test
```

## Windows 本地朗诵分析

进入 `local-analyzer` 文件夹：

1. 第一次双击 `setup.bat`。
2. 按提示把 ElevenLabs API Key 写入仅保存在本机的 `.env`。
3. 以后双击 `启动朗诵分析.bat`。
4. 粘贴与音频逐字一致的正文、选择 MP3/WAV/M4A，点击“开始分析”。
5. 复制分析结果给 ChatGPT，或保存生成的 JSON。

完整说明见 `local-analyzer/README.md`。`.env` 与分析输出均被 Git 忽略，不会进入网站构建或部署。

数据结构变更后生成迁移：

```bash
npm run db:generate
```
