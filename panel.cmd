@echo off
rem Opens the control panel. Starts the bridge first if it is not already up.
rem Everything is hidden: no console window stays around.
setlocal
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul || (
  echo Cannot find node in PATH.
  echo Install Node.js 18 or newer, then run this again.
  pause
  exit /b 1
)

rem bridge alive? /state answers only when the panel server is up
set "ALIVE="
for /f "tokens=*" %%A in ('curl -s -m 2 -o nul -w "%%{http_code}" http://127.0.0.1:2011/state 2^>nul') do set "ALIVE=%%A"

if not "%ALIVE%"=="200" (
  echo Starting the bridge...
  rem Start-Process fully detaches; "start /b" would keep this script (and the
  rem console it belongs to) alive for as long as the bridge runs
  powershell -NoProfile -WindowStyle Hidden -Command ^
    "Start-Process -FilePath '%NODE%' -ArgumentList 'src\main.mjs' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
  rem give the media + panel servers a moment to bind
  ping -n 6 127.0.0.1 >nul
)

rem Prefer the tray shell: it owns the icon, keeps a single instance and knows how
rem to start the bridge. It falls back to a bare Edge window if not built yet.
if exist "%~dp0native\BridgePanel.exe" (
  start "" "%~dp0native\BridgePanel.exe"
  exit /b 0
)

rem Edge app window with its own profile, so it never mixes with the user's browsing
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Microsoft Edge not found - the panel needs it.
  pause
  exit /b 1
)

start "" "%EDGE%" --app=http://127.0.0.1:2011/ ^
  --user-data-dir="%~dp0runtime\edge-profile" ^
  --window-size=420,600 --no-first-run --disable-features=msEdgeSidebarV2

exit /b 0
