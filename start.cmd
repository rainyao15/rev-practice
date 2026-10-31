@echo off
rem NetEase Cloud Music <- Wallpaper Engine bridge
rem Double-click to start. Flags:
rem   --restart       force a client restart with the debug port
rem   --no-relaunch   never restart the client, only warn
rem   --no-panel-sync skip the "add ne_* properties to every wallpaper" pass
rem
rem Asking for administrator rights is deliberate: the bridge has to be able to
rem restart a client that somebody started as administrator, and the logon task it
rem installs runs with highest privileges.
setlocal
cd /d "%~dp0"

set "NODE=%~dp0node.exe"
if not exist "%NODE%" set "NODE="
if not defined NODE for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [!] Node.js 18+ not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem Ports come from config.json (via src\ports.mjs) so the launcher tests the ports
rem the bridge will really bind instead of assuming the defaults.
set "DGPORT=9333"
set "MDPORT=2000"
rem node writes the resolved ports to a temp file; a `for /f` over a quoted
rem command line is fragile when the node path contains spaces.
set "PORTFILE=%TEMP%\cloudmusic-wallpaper-bridge-ports.txt"
"%NODE%" "%~dp0src\ports.mjs" > "%PORTFILE%" 2>nul
for /f "tokens=1,2" %%A in ('type "%PORTFILE%" 2^>nul') do (
  set "DGPORT=%%A"
  set "MDPORT=%%B"
)
del "%PORTFILE%" >nul 2>&1

rem A second copy would only fight the first one over ports 2000/2001 and over
rem which process owns the debug port, so say who is already there and stop.
netstat -ano | findstr /C:":%MDPORT% " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  echo [i] The bridge is already running ^(port %MDPORT% is in use^).
  echo     Stop it first:  autostart.cmd stop
  echo     Or open the running window from the taskbar.
  ping -n 7 127.0.0.1 >nul
  exit /b 0
)

rem Starting the client without the debug port is the most common dead end; if it
rem is already running, offer the restart instead of failing silently later.
tasklist /FI "IMAGENAME eq cloudmusic.exe" /NH 2>nul | findstr /I "cloudmusic.exe" >nul
if not errorlevel 1 (
  netstat -ano | findstr /C:":%DGPORT% " | findstr /C:"LISTENING" >nul
  if errorlevel 1 (
    echo [i] Cloud Music is running without its debug port.
    echo     Restart it now so the wallpaper can attach? [Y/N]
    choice /c YN /n /t 15 /d Y >nul
    if not errorlevel 2 (
      taskkill /IM cloudmusic.exe /F >nul 2>&1
      ping -n 3 127.0.0.1 >nul
    )
  )
)

fltmc >nul 2>&1
if not errorlevel 1 goto :run

echo [i] Requesting administrator rights ^(UAC^) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\elevate.ps1" -Node "%~dp0src\main.mjs" -NodeArgs "%*" -WorkDir "%~dp0." >nul 2>&1
if not errorlevel 1 (
  echo [i] The bridge is starting in the elevated window.
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)
echo [x] Elevation was declined. Continuing without administrator rights;
echo     a client started as administrator cannot be restarted by the bridge.

:run
start "cloudmusic-wallpaper-bridge" /min "%NODE%" "%~dp0src\main.mjs" %*
