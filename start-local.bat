@echo off
rem 声图本地一键启动（Windows 双击入口）。
rem 真正逻辑在 scripts/start-local.mjs，这里只负责切到项目根目录。
cd /d "%~dp0"
call npm run local
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方提示。
  pause
)
