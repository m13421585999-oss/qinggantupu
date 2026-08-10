@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo 尚未完成首次安装，现在打开安装程序...
  call setup.bat
  if errorlevel 1 exit /b 1
)

if not exist ".env" (
  echo 未找到本地 .env，现在打开安装程序以配置 ElevenLabs API Key...
  call setup.bat
  if errorlevel 1 exit /b 1
)

".venv\Scripts\python.exe" app.py
if errorlevel 1 (
  echo.
  echo 工具意外退出，请将上方错误信息发给技术人员。
  pause
)

