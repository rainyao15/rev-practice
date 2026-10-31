# Starts one of this project's entry points with administrator rights.
#
# The batch files call this instead of re-launching themselves: an elevated
# process gets its own %0, and a batch that re-ran itself ended up with %~dp0
# pointing at C:\Windows\System32. Passing absolute paths through PowerShell's
# argument array sidesteps cmd quoting entirely.
#
#   script mode (autostart): -Script <dir>\native\autostart.ps1 -Action install -Root <dir>
#   node mode   (start):     -Node <dir>\src\main.mjs [-NodeArgs "--restart"]
param(
    [string]$Script = '',
    [string]$Action = 'install',
    [string]$Root = '',
    [string]$WorkDir = '',

    [string]$Node = '',
    [string]$NodeArgs = '',

    # autostart prints a summary; without this the elevated window would close
    # before anybody could read it.
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

if ($Node) {
    if (-not (Test-Path $Node)) { exit 2 }
    $dir = Split-Path -Parent $Node
    $exe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $exe) { $exe = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path $exe)) { exit 3 }

    $list = @($Node)
    if ($NodeArgs) { $list += $NodeArgs.Split(' ') }
    try {
        Start-Process -FilePath $exe -ArgumentList $list -WorkingDirectory $dir -Verb RunAs -WindowStyle Minimized -ErrorAction Stop | Out-Null
        exit 0
    } catch { exit 1 }
}

if (-not $Script -or -not (Test-Path $Script)) { exit 2 }
if (-not $WorkDir) { $WorkDir = Split-Path -Parent (Split-Path -Parent $Script) }
if (-not $Root) { $Root = $WorkDir }

if ($KeepOpen) {
    $inner = "& '$Script' -Action '$Action' -Root '$Root'; Write-Host ''; Read-Host 'Press Enter to close' | Out-Null"
    $list = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner)
} else {
    $list = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, '-Action', $Action, '-Root', $Root)
}

try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $list -WorkingDirectory $WorkDir -Verb RunAs -ErrorAction Stop | Out-Null
    exit 0
} catch { exit 1 }
