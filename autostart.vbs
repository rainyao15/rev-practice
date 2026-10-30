' Launches the bridge without a console window, logging to
' %LOCALAPPDATA%\cloudmusic-wallpaper-bridge\bridge.log
'
' Used by the logon entries and by the five-minute watchdog task. It must never
' show a dialog: the watchdog fires unattended while the machine is in use, and a
' modal "Windows Script Host" box every five minutes is worse than the problem it
' is meant to fix. Two consequences:
'
'   1. On Error Resume Next, and every failure path just quits quietly.
'   2. No direct writes to the log from here. cmd's ">>" redirect shares the file
'      with a running bridge; FileSystemObject does not. Opening a log that a live
'      bridge already holds is what raised "Permission denied" (800A0046) here.

Option Explicit
On Error Resume Next

Dim fso, sh, root, logDir, logFile, nodeExe, script, cmdline, q, sup

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
q = """"

root = fso.GetParentFolderName(WScript.ScriptFullName)
script = root & "\src\main.mjs"
If Err.Number <> 0 Then WScript.Quit 0

If Not fso.FileExists(script) Then WScript.Quit 0

logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\cloudmusic-wallpaper-bridge"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\bridge.log"

' prefer the standard install location, fall back to whatever is on PATH
If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe") Then
  nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
Else
  nodeExe = "node"
End If

' Always go through the supervisor: if node dies (standby, antivirus, crash) it
' comes back on its own instead of leaving the client without a background.
' cmd /c needs one extra pair of quotes when the path itself is quoted.
sup = root & "\native\run-forever.cmd"
If fso.FileExists(sup) Then
  cmdline = "cmd /c " & q & q & sup & q & " >> " & q & logFile & q & " 2>&1" & q
Else
  cmdline = "cmd /c " & q & q & nodeExe & q & " " & q & script & q & _
            " >> " & q & logFile & q & " 2>&1" & q
End If

' 0 = hidden window, False = do not wait
sh.Run cmdline, 0, False
WScript.Quit 0
