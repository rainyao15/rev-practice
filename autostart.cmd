@echo off
rem Make the bridge start with Windows (hidden), or undo that.
rem
rem   autostart.cmd            show what is currently installed
rem   autostart.cmd install    start with Windows from now on
rem   autostart.cmd uninstall  stop starting with Windows
rem   autostart.cmd start      start the bridge now, hidden
rem   autostart.cmd stop       stop a hidden bridge
rem
rem Everything except "status" asks for administrator rights (UAC): the logon
rem task has to run with highest privileges, and an elevated bridge can replace a
rem client that somebody started as administrator.
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

rem %~dp0 ends with a backslash, which would escape a closing quote
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

fltmc >nul 2>&1
if not errorlevel 1 goto :run
if /i "%ACTION%"=="status" goto :run

echo [i] Requesting administrator rights ^(UAC^) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\elevate.ps1" -Script "%~dp0native\autostart.ps1" -Action "%ACTION%" -Root "%ROOT%" -WorkDir "%ROOT%" -KeepOpen >nul 2>&1
if not errorlevel 1 (
  echo [i] Continued in the elevated window that just opened.
  exit /b 0
)
echo [x] Elevation was declined. Continuing without administrator rights;
echo     the logon task will then not be able to run elevated.

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\autostart.ps1" -Action "%ACTION%" -Root "%ROOT%"
if errorlevel 1 echo [!] something went wrong, see the message above.
echo.
pause
