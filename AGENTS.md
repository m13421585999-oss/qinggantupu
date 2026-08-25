# 声图项目规则

## 项目定位

- 本项目把中文文稿、可选参考朗诵和场景图整理为可编辑的朗诵情感图谱。
- 完整版是稳定主版本；紧凑版是当前视觉与编辑体验的主要迭代面。

## 启动与验证

- 推荐从项目根目录运行 `npm run local`，网站默认是 `http://localhost:3000`，分析服务默认是 `http://127.0.0.1:8000`。
- 常用门禁：`npm run build`、`npm run test:unit`、`npm run test:integration`，Python 使用 `PYTHONPATH=analysis-service analysis-service/.venv/bin/python -m pytest analysis-service/tests`。
- 全仓库 `npm run lint` 当前仍会命中 `batch/` 下的既有问题；处理无关任务时不要顺手重构这些批处理脚本。

## 产品边界

- 未经明确要求，不修改完整版主要页面、排版与交互；紧凑版改动保持在 Compact 相关组件和共享的无行为破坏基础设施内。
- 一个完整语义句最多一个重音词组，允许没有重音；批量标谱默认不自动添加 `V/v`。
- 紧凑版语势节点必须读取正文真实 DOM 位置，禁止按固定字宽、字符数或包含 Marker 的整行宽度平均估算。
- 人工拼音覆盖自动拼音，必须随工程保存并用于页面和 PDF。
- 《春》的实景/虚景展示是紧凑版特例，不得改变其他作品或完整版。

## 本地数据与安全

- `.wrangler/state/v3` 是配套的本地 D1/R2 状态；恢复前先停网站和分析服务、备份现场，并成套恢复 D1 与 R2。
- 不重新导入历史工程，不擅自删除重复、未完成作品或图片资产；任何作品删除都需要用户明确确认。
- `.wrangler`、`analysis-service/data/`、真实 `.env`、`.dev.vars`、API Key 和 Token 不得提交或写入日志、文档与回复。

## Git

- 先检查当前分支、dirty 文件和 `origin/main` 差异；已有改动均视为用户现场，不得重置或覆盖。
- 未经明确授权，不强推、重置、直接覆盖或合并 `main`；任何合并都必须保留远端已有资产（包括 PDF）。
