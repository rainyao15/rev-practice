@echo off
rem Keeps the bridge alive: node is restarted whenever it exits for any reason.
rem Everything printed here goes to the log the caller already redirects to, so
rem this script must not open that file a second time.
rem Exit code 42 means "another bridge already owns the ports", the one case
rem where restarting would just fight the instance that is doing fine.
setlocal
cd /d "%~dp0.."

set "NODE=node.exe"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

:again
rem A watchdog fires this script every few minutes; if a bridge is already
rem serving, starting node just to watch it exit 42 is wasted work.
netstat -ano | findstr /C:":2000 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  echo supervisor: port 2000 is already served, stopping
  exit /b 0
)
echo ===== supervisor: starting node =====
"%NODE%" "src\main.mjs"
if errorlevel 42 (
  echo supervisor: another bridge is already running, stopping
  exit /b 0
)
echo ===== supervisor: node exited, restarting in 5s =====
timeout /t 5 /nobreak >nul
goto again
