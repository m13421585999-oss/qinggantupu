#!/bin/bash
# 声图本地一键启动（macOS 双击入口）。
# 真正逻辑在 scripts/start-local.mjs，这里只负责切到项目根目录。
cd "$(dirname "$0")"
npm run local
