' Launches the bridge without a console window, logging to
' %LOCALAPPDATA%\cloudmusic-wallpaper-bridge\bridge.log
'
' Used by the logon shortcut that autostart.cmd installs; you can also run it
' by double-clicking, which is handy when you want it out of the way.

Option Explicit

Dim fso, sh, root, logDir, logFile, nodeExe, script, cmdline, q, f, stamp

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
q = """"

root = fso.GetParentFolderName(WScript.ScriptFullName)
script = root & "\src\main.mjs"

If Not fso.FileExists(script) Then
  MsgBox "src\main.mjs not found next to this script." & vbCrLf & root, 16, "cloudmusic-wallpaper-bridge"
  WScript.Quit 1
End If

logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\cloudmusic-wallpaper-bridge"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\bridge.log"

' prefer the standard install location, fall back to whatever is on PATH
If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe") Then
  nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
Else
  nodeExe = "node"
End If

' a locale-independent separator, so the log stays readable
stamp = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & " " & _
        Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)
Set f = fso.OpenTextFile(logFile, 8, True)
f.WriteLine ""
f.WriteLine "===== started " & stamp & " ====="
f.Close

' cmd /c needs the whole command wrapped in one extra pair of quotes when the
' executable path itself is quoted, otherwise "C:\Program Files\..." splits.
cmdline = "cmd /c " & q & q & nodeExe & q & " " & q & script & q & _
          " >> " & q & logFile & q & " 2>&1" & q

' 0 = hidden window, False = do not wait
sh.Run cmdline, 0, False
