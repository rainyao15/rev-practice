@echo off
rem One-shot setup:
rem   1. make sure Node.js is reachable
rem   2. build the two native helpers (needs .NET Framework 4, ships with Windows)
rem   3. write the "NetEase background" section into every wallpaper under the workshop root
setlocal
cd /d "%~dp0"
set "NODE=%~dp0node.exe"
if not exist "%NODE%" set "NODE="
if not defined NODE for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [!] Node.js 18+ not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

echo [1/2] building native helpers ...
call "%~dp0native\build.cmd"
if errorlevel 1 (
  echo [!] build failed. Scene wallpapers will not work, video wallpapers still will.
  timeout /t 2 >nul
)

echo.
echo [2/2] adding the property section to every wallpaper ...
echo.
echo   This writes a small "NetEase background" group into the project.json of every
echo   wallpaper you are subscribed to, so the controls show up in Wallpaper Engine's
echo   own property panel. Each file is backed up as project.json.bak-* before its
echo   first edit, and uninstall.cmd puts them all back.
echo.
pause
"%NODE%" "%~dp0src\we-panel.mjs" --all
if errorlevel 1 (
  echo [!] could not patch the wallpapers - see the message above.
  pause
  exit /b 1
)

echo.
echo Done. Start the bridge with start.cmd, then pick any wallpaper in Wallpaper Engine.
echo Undo everything later with uninstall.cmd
pause
