@echo off
rem One-shot setup:
rem   1. make sure Node.js is reachable
rem   2. build the native helpers (needs .NET Framework 4, ships with Windows)
rem   3. write the "NetEase background" section into every wallpaper under the workshop root
rem   4. drop a desktop shortcut to the control panel
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

echo [1/3] building native helpers ...
call "%~dp0native\build.cmd"
if errorlevel 1 (
  echo [!] build failed. Scene wallpapers will not work, video wallpapers still will.
  timeout /t 2 >nul
)

echo.
echo [2/3] adding the property section to every wallpaper ...
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
echo [3/3] creating the desktop shortcut ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\shortcut.ps1" -Action create -Root "%~dp0." >nul 2>&1

echo.
echo Done.
echo   Double-click the "网易云背景" shortcut on your desktop, or run panel.cmd here.
echo   That puts an icon in the tray and opens the control panel.
echo   Undo everything later with uninstall.cmd
pause
