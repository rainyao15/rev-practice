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

rem A second copy would only fight the first one over ports 2000/2001 and over
rem which process owns the debug port, so say who is already there and stop.
netstat -ano | findstr /C:":2000 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  echo [i] The bridge is already running ^(port 2000 is in use^).
  echo     Stop it first:  autostart.cmd stop
  echo     Or just open the running window from the taskbar.
  ping -n 7 127.0.0.1 >nul
  exit /b 0
)

rem Starting the client without the debug port is the most common dead end; if it
rem is already running, offer to do the restart instead of failing silently later.
tasklist /FI "IMAGENAME eq cloudmusic.exe" /NH 2>nul | findstr /I "cloudmusic.exe" >nul
if not errorlevel 1 (
  netstat -ano | findstr /C:":9222 " | findstr /C:"LISTENING" >nul
  if errorlevel 1 (
    echo [i] Cloud Music is running without its debug port.
    echo     Restart it now so the wallpaper can attach? [Y/N]
    choice /c YN /n /t 15 /d Y >nul
    if not errorlevel 2 (
      taskkill /IM cloudmusic.exe /F >nul 2>&1
      timeout /t 2 >nul
    )
  )
)

start "cloudmusic-wallpaper-bridge" /min "%NODE%" "%~dp0src\main.mjs" %*