@echo off
rem Undo what install.cmd did:
rem   - stop the bridge
rem   - strip every ne_* key from every wallpaper's project.json
rem   - delete the compiled helpers
rem Your Wallpaper Engine settings and the client itself are untouched.
setlocal
cd /d "%~dp0"
set "NODE=%~dp0node.exe"
if not exist "%NODE%" set "NODE="
if not defined NODE for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo Removing the logon autostart entry ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\autostart.ps1" -Action uninstall -Root "%ROOT%" >nul 2>&1

echo Stopping the bridge ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*main.mjs*') -or $_.Name -eq 'SceneCapture.exe' -or $_.Name -eq 'SceneAudio.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

if defined NODE (
  echo Removing the property section from every wallpaper ...
  "%NODE%" "%~dp0src\we-panel.mjs" --revert --all
)

echo Deleting compiled helpers ...
del /q "%~dp0native\SceneCapture.exe" 2>nul
del /q "%~dp0native\SceneAudio.exe" 2>nul

echo.
echo Done. Wallpaper Engine may need one restart before the section disappears from its panel.
pause
