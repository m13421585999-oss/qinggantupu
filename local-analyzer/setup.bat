@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ========================================
echo   本地朗诵分析工具 - 首次安装
echo ========================================
echo.

set "PYTHON_CMD="
where py >nul 2>&1
if not errorlevel 1 (
  py -3.12 -c "import sys" >nul 2>&1
  if not errorlevel 1 set "PYTHON_CMD=py -3.12"
  if not defined PYTHON_CMD (
    py -3.11 -c "import sys" >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=py -3.11"
  )
  if not defined PYTHON_CMD (
    py -3.13 -c "import sys" >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=py -3.13"
  )
)
if not defined PYTHON_CMD (
  where python >nul 2>&1
  if not errorlevel 1 set "PYTHON_CMD=python"
)
if not defined PYTHON_CMD (
  echo [失败] 未找到 Python。
  echo 请先安装 Python 3.11 或 3.12，并勾选 Add Python to PATH。
  start "" "https://www.python.org/downloads/windows/"
  pause
  exit /b 1
)

%PYTHON_CMD% -c "import sys; assert (3, 11) ^<= sys.version_info ^< (3, 14), sys.version" >nul 2>&1
if errorlevel 1 (
  echo [失败] 需要 Python 3.11、3.12 或 3.13。
  echo 推荐安装 Python 3.12 后重新运行本文件。
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/4] 正在创建本地 Python 环境...
  %PYTHON_CMD% -m venv .venv
  if errorlevel 1 goto :install_failed
) else (
  echo [1/4] 已找到本地 Python 环境。
)

echo [2/4] 正在安装分析组件，首次安装可能需要几分钟...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :install_failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :install_failed

echo [3/4] 正在检查 FFmpeg 和图形界面...
".venv\Scripts\python.exe" -c "import tkinter; import imageio_ffmpeg; print('FFmpeg:', imageio_ffmpeg.get_ffmpeg_exe())"
if errorlevel 1 goto :install_failed

if not exist ".env" (
  echo.
  set /p "ELEVEN_KEY=请输入 ElevenLabs API Key（输入内容只写入本机 .env）: "
  if "!ELEVEN_KEY!"=="" (
    echo [失败] API Key 不能为空。
    pause
    exit /b 1
  )
  > ".env" echo ELEVENLABS_API_KEY=!ELEVEN_KEY!
  >> ".env" echo ELEVENLABS_VOICE_ID=DowyQ68vDpgFYdWVGjc3
  set "ELEVEN_KEY="
  echo [4/4] 本地 .env 已创建。
) else (
  echo [4/4] 已保留现有本地 .env，不会覆盖。
)

echo.
echo 安装完成。以后只需双击“启动朗诵分析.bat”。
echo.
pause
exit /b 0

:install_failed
echo.
echo [失败] 安装没有完成。请检查网络和上方错误信息后重试。
pause
exit /b 1
