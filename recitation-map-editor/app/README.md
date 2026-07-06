# 朗诵情感图谱编辑器 Stage 9.30

当前主线为 A4 竖版打印塑封核心版。展示版、水彩版、多模板方案已封存，不作为当前主线维护。

当前代码版本以 `package.json` 为准：

```text
0.9.30-a4-pinyin-vertical-center
```

## 本版重点

1. 文稿层字号放大，优先保证中老年学员打印后可读。
2. 语势线改为阶梯 / 梯形语势图。
3. 语势点仍锚定具体文字 token，新增、修改、删除逻辑保留。
4. 左侧层标签压缩为“拼 / 文 / 势”。
5. 行级提示压缩为“节奏｜语势｜语气”，去掉重复前缀。
6. 页眉图例压缩为一行短说明。
7. 文稿层与语势层增加安全间距，避免曲线影响正文。

## 清洁安装

本项目压缩包不应包含 `node_modules`、`dist`、`__MACOSX`、`.DS_Store` 等本地或构建产物。首次运行请在本机重新安装依赖：

```bash
cd recitation-map-editor/app
npm install
npm run dev
```

打开终端输出的本地地址，例如：

```text
http://localhost:5173/
```

## 验证

```bash
npm run validate:demo
npm run build
```

如果 `npm run build` 报原生依赖或平台绑定错误，先执行清洁安装：

```bash
rm -rf node_modules dist
npm install
npm run build
```

## 打包规则

重新打包交付时，只保留源码、文档与依赖声明文件。不要把以下内容放入 zip：

```text
node_modules/
dist/
__MACOSX/
.DS_Store
._*
```

## Stage 9.31 分包说明

当前运行包不再携带历史阶段文档和旧水彩课程素材。相关内容已单独封装为文档归档包。

本次分包不新增功能，不修改 A4 排版、分页、拼音、语势、点击编辑、视觉样式和数据结构。
