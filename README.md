# 声图 · 朗诵情感图谱

“声图”把当前作品的准确正文与优秀真人朗诵转换为可理解、可编辑、可继续驱动 AI 朗诵的情感图谱。

正式创作流程：

1. 创作者填写作品名称、作者/来源和完整正文，上传真实参考朗诵。
2. 网站把正文和任务保存在 D1，把音频保存在 R2。
3. 网站先调用 Eleven Voice Changer，把真人参考朗诵转换并保存为 `standard_ai_audio`。
4. 独立 Python 服务只下载这条 `standard_ai_audio`，执行 ElevenLabs Forced Alignment、FFmpeg/Praat-Parselmouth 声学分析，并使用内置《朗诵表达分析规则 v1.0》和 DeepSeek 生成当前作品控制谱。
5. 创作者在现有图谱编辑器中修改重音、停顿、拖音、语势、句尾语调和节奏；修改后 `audio_sync_status` 变为 `modified`。
6. 发布后，观看端播放被分析的同一条 `standard_ai_audio`，提供整篇/单句播放、跳转、倍速与逐字高亮。

生产流程没有固定作品、固定控制谱或失败后的 Demo 回退。任一步骤失败都会显示真实错误状态。

## 项目结构

- `app/`、`components/`：现有创作端、编辑器与观看端。
- `worker/`：D1/R2、Voice Changer、分析任务、安全交接和发布接口。
- `analysis-service/`：云端 FastAPI 分析服务。
- `db/`、`drizzle/`：D1 结构与迁移。

## 本地验证

需要 Node.js 22.13+ 与 Python 3.12：

```text
npm install
npm run build
npm run lint
npx tsc --noEmit
npm test

PYTHONPATH=analysis-service analysis-service/.venv/bin/python -m pytest analysis-service/tests
```

数据结构变更后运行 `npm run db:generate` 并提交生成的迁移。

## 产品文档

- [执行清单](docs/01-mvp-plan.md)
- [控制谱数据契约](docs/02-data-contract.md)
- [技术架构](docs/03-architecture.md)
- [部署与输入](docs/04-required-inputs.md)
