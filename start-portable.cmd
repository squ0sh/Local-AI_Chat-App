@echo off
rem Portable Local AI Chat launcher for Windows.
setlocal
set "APP_DIR=%~dp0"
set "PORTABLE_DIR=%APP_DIR%.portable"
set "MACHINE=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "MACHINE=%PROCESSOR_ARCHITEW6432%"
if /i "%MACHINE%"=="AMD64" set "TARGET=win32-x64"
if /i "%MACHINE%"=="ARM64" set "TARGET=win32-arm64"
if not defined TARGET (
  echo No bundled runtime supports Windows %MACHINE%.
  pause
  exit /b 1
)
set "RUNTIME_DIR=%APP_DIR%runtime\platforms\%TARGET%"
set "NODE_BIN=%RUNTIME_DIR%\node\node.exe"
set "OLLAMA_BIN=%RUNTIME_DIR%\ollama\ollama.exe"
set "OLLAMA_LIB_DIR=%RUNTIME_DIR%\ollama\lib\ollama"

if not exist "%APP_DIR%runtime\downloads.txt" goto :legacy_check

rem Restore missing runtime binaries automatically from the pinned release table.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%tools\install-portable-runtime.ps1" -AppDir "%APP_DIR%" -Target "%TARGET%" -Kind node
if errorlevel 1 goto :runtime_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%tools\install-portable-runtime.ps1" -AppDir "%APP_DIR%" -Target "%TARGET%" -Kind ollama
if errorlevel 1 goto :runtime_failed
goto :runtime_ok

:legacy_check
if not exist "%NODE_BIN%" (
  echo The bundled Node runtime is missing for %TARGET%.
  pause
  exit /b 1
)
if not exist "%OLLAMA_BIN%" (
  echo The bundled Ollama runtime is missing for %TARGET%.
  pause
  exit /b 1
)
goto :runtime_ok

:runtime_failed
echo Could not restore the bundled runtime for %TARGET%. See README for manual setup.
pause
exit /b 1

:runtime_ok
if not exist "%NODE_BIN%" (
  echo The bundled Node runtime is missing for %TARGET%.
  pause
  exit /b 1
)
if not exist "%OLLAMA_BIN%" (
  echo The bundled Ollama runtime is missing for %TARGET%.
  pause
  exit /b 1
)

if not exist "%PORTABLE_DIR%\ollama\models" mkdir "%PORTABLE_DIR%\ollama\models"
if not exist "%PORTABLE_DIR%\logs" mkdir "%PORTABLE_DIR%\logs"
if not exist "%PORTABLE_DIR%\data" mkdir "%PORTABLE_DIR%\data"
set "LOCAL_AI_DATA_DIR=%PORTABLE_DIR%\data"
set "LOCAL_AI_NODE_BIN=%NODE_BIN%"
set "LOCAL_AI_OLLAMA_BIN=%OLLAMA_BIN%"
set "OLLAMA_MODELS=%PORTABLE_DIR%\ollama\models"
set "OLLAMA_HOST=127.0.0.1:11435"
set "OLLAMA_NOPRUNE=true"
rem Machines without the Capsule signing key accept the unsigned manifest that
rem `npm run integrity` generates. Maintainers with the key keep signed checks.
if not exist "%USERPROFILE%\.capsule-signing\key.pem" (
  set "CAPSULE_ALLOW_UNSIGNED=1"
  echo Capsule integrity: unsigned mode (no signing key). After code changes run: npm run integrity
)
set "PATH=%OLLAMA_LIB_DIR%;%PATH%"

set "OLLAMA_URL=http://127.0.0.1:11435"
"%NODE_BIN%" "%APP_DIR%tools\ollama-health.mjs" >nul 2>nul
if not errorlevel 1 goto :ollama_ready

for /f %%P in ('powershell -NoProfile -Command "$p=Start-Process -FilePath $env:LOCAL_AI_OLLAMA_BIN -ArgumentList 'serve' -WindowStyle Hidden -PassThru; $p.Id"') do set "OLLAMA_PID=%%P"
echo Starting portable Ollama...
for /L %%I in (1,1,60) do (
  "%NODE_BIN%" "%APP_DIR%tools\ollama-health.mjs" >nul 2>nul
  if not errorlevel 1 goto :ollama_ready
  ping 127.0.0.1 -n 2 >nul
)
echo Portable Ollama did not become ready.
if defined OLLAMA_PID taskkill /PID %OLLAMA_PID% /T /F >nul 2>nul
pause
exit /b 1

:ollama_ready
echo Starting Local AI Chat at http://127.0.0.1:5173
"%NODE_BIN%" "%APP_DIR%server.mjs" --mode local --host 127.0.0.1 --port 5173
if defined OLLAMA_PID taskkill /PID %OLLAMA_PID% /T /F >nul 2>nul
