# 朗诵情感图谱编辑器 · Stage 9.31 当前运行包

当前主线：A4 竖版打印塑封版。

本包是“当前运行包”，只保留源码、依赖声明、当前 A4 打印版说明和必要静态资源。历史阶段文档、旧 schema、旧 demo 说明、旧水彩课程素材已单独封装到文档归档包，不放在当前运行包里，避免后续开发误判方向。

## 运行方式

```bash
cd recitation-map-editor/app
npm install
npm run dev
```

## 构建验证

```bash
cd recitation-map-editor/app
npm run validate:demo
npm run build
```

## 当前不包含

```text
node_modules/
dist/
__MACOSX/
.DS_Store
._*
历史阶段文档
旧水彩课程模板素材
```

## 当前不新增功能

本次只做文件分包和清理，不修改 A4 排版、分页、拼音、语势、点击编辑、视觉样式和数据结构。
