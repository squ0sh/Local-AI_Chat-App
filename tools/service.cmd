@echo off
rem Run the Capsule as a per-user background service via Task Scheduler.
rem
rem   tools\service.cmd install | status | uninstall
rem
rem The task launches the same start-portable.cmd you double-click, so this
rem machine's service and the portable kit stay one artifact with one data dir.
rem Auth: set AUTH_TOKEN first, or run node lib\user-store.mjs create … first;
rem with neither, install refuses (mirrors service.sh's --allow-open rule —
rem append --allow-open to accept the loopback-only risk).
setlocal EnableDelayedExpansion
set "APP_DIR=%~dp0.."
set "TASK_NAME=LocalAICapsule"
set "PORT_SET=%PORT%"
if "%PORT_SET%"=="" set "PORT_SET=5173"
set "USERS_FILE=%CAPSULE_USERS_FILE%"
if "%USERS_FILE%"=="" set "USERS_FILE=%APP_DIR%\.portable\data\users.json"

if "%1"=="uninstall" goto Uninstall
if "%1"=="status" goto Status
if "%1"=="install" goto Install
if not "%1"=="" (
  echo service: unknown argument "%1" 1>&2
  exit /b 2
)
goto Install

:Install
if exist "%USERS_FILE%" (
  echo service: multi-user accounts found — the service will require sign-in
  goto ScheduleTask
)
if not "%AUTH_TOKEN%"=="" (
  echo service: single-operator bearer token will be used
  goto ScheduleTask
)
if /i "%2"=="--allow-open" goto ScheduleTask
echo service: refusing to install an open service. 1>&2
echo. 1>&2
echo   Set AUTH_TOKEN or create a user, then retry: 1>&2
echo     set AUTH_TOKEN=a-long-random-secret 1>&2
echo     node lib\user-store.mjs create alice "a long memorable password" 1>&2
echo   Or accept loopback-only risk:  tools\service.cmd install --allow-open 1>&2
exit /b 1

:ScheduleTask
schtasks /Create /TN "%TASK_NAME%" /SC ONLOGON /RL LIMITED /TR "\"%ComSpec%\" /c \"\"%APP_DIR%\start-portable.cmd\"\"" /F
if errorlevel 1 (
  echo service: schtasks refused the task. 1>&2
  exit /b 1
)
echo service: installed task "%TASK_NAME%" (starts at logon, restarts via the task itself)
echo service: logs live under "%APP_DIR%\.portable\logs"
echo service: remove it with tools\service.cmd uninstall
exit /b 0

:Status
schtasks /Query /TN "%TASK_NAME%" 2>NUL
if errorlevel 1 (
  echo service: task "%TASK_NAME%" is not installed.
  exit /b 1
)
set "CURLOPTS=--max-time 2 -s -o NUL -w %%{http_code}"
curl --max-time 2 -s -o NUL "http://127.0.0.1:%PORT_SET%/health" && (echo service: reachable at http://127.0.0.1:%PORT_SET%) || (echo service: not answering http://127.0.0.1:%PORT_SET%/health yet)
exit /b 0

:Uninstall
schtasks /Delete /TN "%TASK_NAME%" /F
if errorlevel 1 (
  echo service: task "%TASK_NAME%" is not installed.
  exit /b 1
)
echo service: removed task "%TASK_NAME%"
echo service: data and models were left alone in "%APP_DIR%\.portable"
exit /b 0
