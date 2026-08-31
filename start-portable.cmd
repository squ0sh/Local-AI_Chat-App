@echo off
rem Portable Local AI Chat launcher for Windows.
setlocal
set "APP_DIR=%~dp0"
set "PORTABLE_DIR=%APP_DIR%.portable"
set "NODE_BIN=%APP_DIR%runtime\node\node.exe"
set "OLLAMA_BIN=%APP_DIR%runtime\ollama\ollama.exe"

if not exist "%NODE_BIN%" set "NODE_BIN=node"
if not exist "%OLLAMA_BIN%" set "OLLAMA_BIN=ollama"

where "%NODE_BIN%" >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ was not found. Bundle it in runtime\node or install Node.js.
  pause
  exit /b 1
)
where "%OLLAMA_BIN%" >nul 2>nul
if errorlevel 1 (
  echo Ollama was not found. Bundle it in runtime\ollama or install Ollama.
  pause
  exit /b 1
)

if not exist "%PORTABLE_DIR%\ollama\models" mkdir "%PORTABLE_DIR%\ollama\models"
if not exist "%PORTABLE_DIR%\logs" mkdir "%PORTABLE_DIR%\logs"
set "LOCAL_AI_DATA_DIR=%PORTABLE_DIR%\data"
set "OLLAMA_MODELS=%PORTABLE_DIR%\ollama\models"
set "OLLAMA_HOST=127.0.0.1:11434"

start "Portable Ollama" /b "%OLLAMA_BIN%" serve ^> "%PORTABLE_DIR%\logs\ollama.log" 2^>^&1
echo Starting Local AI Chat at http://127.0.0.1:5173
"%NODE_BIN%" "%APP_DIR%server.mjs" --mode local --host 127.0.0.1 --port 5173
