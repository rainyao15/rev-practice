@echo off
rem NetEase Cloud Music <- Wallpaper Engine bridge
rem Double-click to start. Flags:
rem   --restart       force a client restart with the debug port
rem   --no-relaunch   never restart the client, only warn
rem   --no-panel-sync skip the "add ne_* properties to every wallpaper" pass
setlocal
set "NODE=%~dp0node.exe"
if not exist "%NODE%" set "NODE="
if not defined NODE for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [!] Node.js 18+ not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
start "netease-wallpaper" /min "%NODE%" "%~dp0src\main.mjs" %*
