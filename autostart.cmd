@echo off
rem Make the bridge start with Windows (hidden), or undo that.
rem
rem   autostart.cmd            show what is currently installed
rem   autostart.cmd install    start with Windows from now on
rem   autostart.cmd uninstall  stop starting with Windows
rem   autostart.cmd start      start the bridge now, hidden
rem   autostart.cmd stop       stop a hidden bridge
rem
rem No administrator rights needed: the shortcut goes into the current user's
rem Startup folder and the client tweak goes into HKCU.
setlocal
cd /d "%~dp0"

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

where /q powershell.exe
if errorlevel 1 (
  echo [!] PowerShell not found, cannot manage the startup entry.
  pause
  exit /b 1
)

rem %~dp0 ends with a backslash, which would escape the closing quote
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\autostart.ps1" -Action "%ACTION%" -Root "%ROOT%"
if errorlevel 1 (
  echo [!] something went wrong, see the message above.
)
echo.
pause
