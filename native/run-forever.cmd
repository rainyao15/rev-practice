@echo off
rem Keeps the bridge alive: node is restarted whenever it exits for any reason.
rem Everything printed here goes to the log the caller already redirects to, so
rem this script must not open that file a second time.
rem
rem   run-forever.cmd             start only if nothing is serving yet
rem   run-forever.cmd --takeover  kill whatever bridge is running, then take over
rem
rem Exit code 42 means "another bridge already owns the ports", the one case
rem where restarting would just fight the instance that is doing fine.
rem
rem An elevated supervisor always takes over: the scheduled task runs with highest
rem privileges so it can replace a client that was started as administrator, and a
rem leftover non-elevated bridge from an earlier logon must not keep it out.
setlocal
cd /d "%~dp0.."

set "NODE=node.exe"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

if /i "%~1"=="--takeover" goto takeover
fltmc >nul 2>&1
if not errorlevel 1 goto takeover
goto again

:takeover
echo ===== supervisor: elevated, stopping any bridge left over from before =====
rem Whoever holds the ports is the bridge that must go. Reading the owner out of
rem netstat avoids a PowerShell one-liner whose quoting breaks inside cmd.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":2000 " ^| findstr /C:"LISTENING"') do taskkill /f /pid %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":2001 " ^| findstr /C:"LISTENING"') do taskkill /f /pid %%P >nul 2>&1
taskkill /f /im SceneCapture.exe >nul 2>&1
taskkill /f /im SceneAudio.exe >nul 2>&1
rem "timeout" refuses to run when stdin is redirected, which is the case under
rem the scheduled task; ping always works.
ping -n 3 127.0.0.1 >nul

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
ping -n 6 127.0.0.1 >nul
goto again
