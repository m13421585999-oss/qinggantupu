# 声图 · 朗诵情感图谱

“声图”把优秀朗诵加工成看得懂、听得到、可以反复学习的互动朗诵谱。

当前仓库是产品一的第一条可运行纵向切片，包含：

- 创作端四步工作流：准备素材、编辑图谱、生成示范、预览发布。
- 统一朗诵控制谱 v1.0。
- 拼音、文稿、语势三层图谱。
- 可编辑的表达焦点、四种语势、句尾语调、节奏与声音质感。
- 整篇播放、单句播放、字符高亮和读法提示。
- 作品、资产、控制谱版本、音频版本、发布版本和处理任务的数据表与迁移。

当前示范使用旧讨论中的四句“月光下的中国”片段和本机生成的占位声音。真实参考音频分析与 Eleven v3 接口将在首篇素材、知识库、Voice 和密钥到位后接通。

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

数据结构变更后生成迁移：

```bash
npm run db:generate
```
