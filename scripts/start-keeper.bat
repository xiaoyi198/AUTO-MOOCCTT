@echo off
rem ============================================================================
rem start-keeper.bat -- Windows entry point for the course-hours-autopilot keeper.
rem
rem WHAT IT IS
rem   Double-click entry that starts scripts\engine\keeper.js (the resident
rem   watchdog: keeps the managed browser alive and runs one patrol round every
rem   15 minutes). Example / reference implementation -- edit it as needed.
rem
rem WHY A DOUBLE-CLICK ENTRY IS NEEDED
rem   In some restricted environments two things happen:
rem     1) processes started from inside the sandbox are reaped when the call
rem        that started them ends, so the browser dies and the video stops;
rem     2) a browser started inside the sandbox can get its renderer frozen,
rem        because the sandbox forbids named pipes and Chromium uses them for its
rem        internal browser<->renderer IPC (symptom: window is blank, connect()
rem        works, browser-level CDP commands answer in milliseconds, page-level
rem        commands never answer).
rem   A process created by Explorer (i.e. by double-clicking this file) is outside
rem   that sandbox, which fixes both. Verify with: node scripts\engine\cdp-health.js
rem
rem USAGE
rem   Double-click this file once, then MINIMIZE the window and leave it open.
rem   Closing the window stops the keeper. Progress goes to the two log files
rem   named below; keeper-heartbeat.json tells you whether the keeper is alive.
rem
rem ASCII ONLY ON PURPOSE
rem   cmd.exe reads .bat files in the OEM code page, so any non-ASCII literal
rem   (e.g. Chinese comments or messages) would be garbled and can break parsing.
rem ============================================================================

setlocal
chcp 65001 >nul
title course-hours-autopilot keeper

rem --- Runtime directory: state, locks, logs and the managed browser profile
rem     all live here. Default matches config.js (%USERPROFILE%\.course-autopilot).
rem     If the host sandbox only allows writes inside its workspace, point this at
rem     a directory in there instead (an externally set AUTOPILOT_DIR wins).
if not defined AUTOPILOT_DIR set "AUTOPILOT_DIR=%USERPROFILE%\.course-autopilot"

rem --- Locate node: PATH first, then the default install location.
set "NODE_EXE="
for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Install Node.js 18+ or put it on PATH.
  echo         Looked in PATH and in "%ProgramFiles%\nodejs\node.exe".
  pause
  exit /b 1
)

set "KEEPER=%~dp0engine\keeper.js"
if not exist "%KEEPER%" (
  echo [ERROR] keeper.js not found at "%KEEPER%".
  echo         Run this file from the skill's scripts directory.
  pause
  exit /b 1
)

rem --- Drop proxy variables. If http_proxy/https_proxy are set, even 127.0.0.1
rem     (the CDP port) goes through the proxy and looks like "port not open".
set "http_proxy="
set "https_proxy="
set "all_proxy="
set "no_proxy="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "NO_PROXY="

set "CONSOLE_LOG=%~dp0keeper-console.log"
echo [start-keeper] node   = %NODE_EXE%
echo [start-keeper] keeper = %KEEPER%
echo [start-keeper] dir    = %AUTOPILOT_DIR%
echo [start-keeper] log    = %CONSOLE_LOG%
echo [start-keeper] keeper runs in the foreground: minimize this window, do not close it.
echo.

pushd "%~dp0"
echo [%date% %time%] keeper start >> "%CONSOLE_LOG%"
"%NODE_EXE%" "%KEEPER%" --dir "%AUTOPILOT_DIR%" %* >> "%CONSOLE_LOG%" 2>&1
set "EXITCODE=%errorlevel%"
popd

echo [%date% %time%] keeper exited (code %EXITCODE%) >> "%CONSOLE_LOG%"
echo.
echo Keeper stopped (exit code %EXITCODE%).
echo   console transcript : "%CONSOLE_LOG%"
echo   keeper log         : "%AUTOPILOT_DIR%\keeper.log"
echo   heartbeat          : "%AUTOPILOT_DIR%\keeper-heartbeat.json"
pause
exit /b %EXITCODE%
