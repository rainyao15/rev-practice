@echo off
rem Restarts the bridge with whatever code is currently on disk.
rem Use after updating the project: the old process keeps running its loaded code
rem until it is stopped, and an elevated bridge cannot be killed from a normal shell.
setlocal
cd /d "%~dp0"

echo Stopping the bridge (a UAC prompt may appear)...
call "%~dp0autostart.cmd" stop

echo.
echo Starting it again...
call "%~dp0panel.cmd"

echo.
echo Done. The tray icon should be back.
timeout /t 3 >nul
