@echo off
rem Builds native\SceneCapture.exe with the C# compiler that ships with Windows.
rem No Visual Studio / .NET SDK required — csc.exe from the .NET Framework 4 is enough.
setlocal
set "OUT=%~dp0SceneCapture.exe"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [!] csc.exe not found — .NET Framework 4 is required.
  exit /b 1
)
"%CSC%" /nologo /optimize+ /target:exe /out:"%OUT%" "%~dp0SceneCapture.cs" ^
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll
if errorlevel 1 exit /b 1
echo Built %OUT%
