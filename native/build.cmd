@echo off
rem Builds the native helpers with the C# compiler that ships with Windows.
rem No Visual Studio / .NET SDK required — csc.exe from the .NET Framework 4 is enough.
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [!] csc.exe not found — .NET Framework 4 is required.
  exit /b 1
)

rem keep this file CRLF: cmd.exe mis-parses batch files with LF endings

"%CSC%" /nologo /optimize+ /target:exe /out:"%~dp0SceneCapture.exe" "%~dp0SceneCapture.cs" ^
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll
if errorlevel 1 exit /b 1
echo Built %~dp0SceneCapture.exe

"%CSC%" /nologo /optimize+ /target:exe /out:"%~dp0SceneAudio.exe" "%~dp0SceneAudio.cs" ^
  /r:System.dll
if errorlevel 1 exit /b 1
echo Built %~dp0SceneAudio.exe
