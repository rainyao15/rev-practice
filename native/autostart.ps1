param(
    [ValidateSet('install', 'uninstall', 'status', 'stop', 'start')]
    [string]$Action = 'status',
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path $Root).Path

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'cloudmusic-wallpaper-bridge.lnk'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbsPath = Join-Path $Root 'autostart.vbs'

$stateDir = Join-Path $env:LOCALAPPDATA 'cloudmusic-wallpaper-bridge'
$runBackup = Join-Path $stateDir 'run-entry-backup.txt'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'cloudmusic'
$debugFlag = '--remote-debugging-port=9333'

function Get-ClientRunValue {
    try {
        (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName
    } catch {
        $null
    }
}

function Set-ClientRunValue([string]$value) {
    New-ItemProperty -Path $runKey -Name $runName -Value $value -PropertyType String -Force | Out-Null
}

# "C:\...\cloudmusic.exe" --orpheus-startup=autorun
#   -> the exe token stays untouched, the debug flag goes right after it
function Add-DebugFlag([string]$cmdline) {
    if ($cmdline -match '--remote-debugging-port=') { return $cmdline }
    if ($cmdline -match '^\s*"([^"]+)"\s*(.*)$') {
        $exe = $Matches[1]
        $rest = $Matches[2].Trim()
    } elseif ($cmdline -match '^\s*(\S+)\s*(.*)$') {
        $exe = $Matches[1]
        $rest = $Matches[2].Trim()
    } else {
        return $cmdline
    }
    $tail = if ($rest) { " $rest" } else { '' }
    '"' + $exe + '" ' + $debugFlag + $tail
}

function Remove-DebugFlag([string]$cmdline) {
    ($cmdline -replace ('\s*' + [regex]::Escape($debugFlag)), '').Trim()
}

function Show-Status {
    $runHas = (Get-ItemProperty -Path $runKey -Name 'cloudmusic-wallpaper-bridge' -ErrorAction SilentlyContinue)
    "logon entry    : " + $(if ($runHas) { 'installed  (HKCU\Run, earliest)' } else { 'not installed' })
    $installed = Test-Path $lnkPath
    "logon shortcut : " + $(if ($installed) { "installed  ($lnkPath)" } else { 'not installed' })

    $taskLine = (& schtasks /query /tn 'cloudmusic-wallpaper-bridge' /fo LIST 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0) {
        $next = ($taskLine -split "`n" | Where-Object { $_ -match 'Next Run Time' }) -replace '.*Next Run Time:\s*', ''
        "watchdog task  : installed  (every 5 min, next $($next.Trim()))"
    } else {
        'watchdog task  : not installed  (run: autostart.cmd install)'
    }

    $client = Get-ClientRunValue
    if ($null -eq $client) {
        'client autorun : no entry (the client will start without a debug port)'
    } elseif ($client -match '--remote-debugging-port=') {
        "client autorun : port already in place`n                 $client"
    } else {
        "client autorun : NO debug port`n                 $client"
    }

    $listening = @(Get-NetTCPConnection -State Listen -LocalPort 2000 -ErrorAction SilentlyContinue)
    "bridge running : " + $(if ($listening.Count) { 'yes (port 2000 is listening)' } else { 'no' })

    $log = Join-Path $stateDir 'bridge.log'
    if (Test-Path $log) {
        $size = [math]::Round((Get-Item $log).Length / 1KB, 1)
        "log file       : $log ($size KB)"
    }
}

switch ($Action) {
    'start' {
        $listening = @(Get-NetTCPConnection -State Listen -LocalPort 2000 -ErrorAction SilentlyContinue)
        if ($listening.Count) {
            'already running (port 2000 is listening)'
        } else {
            Start-Process -FilePath $wscript -ArgumentList ('//B "' + $vbsPath + '"') -WindowStyle Hidden
            Start-Sleep -Seconds 4
            $listening = @(Get-NetTCPConnection -State Listen -LocalPort 2000 -ErrorAction SilentlyContinue)
            "started hidden : " + $(if ($listening.Count) { 'yes' } else { 'not yet - check the log' })
        }
    }
    'stop' {
        $killed = 0
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*main.mjs*') -or
            $_.Name -eq 'SceneCapture.exe' -or $_.Name -eq 'SceneAudio.exe'
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
        }
        "stopped $killed process(es). The client keeps running; just refresh it or restart the bridge."
    }
    'install' {
        if (-not (Test-Path $vbsPath)) { throw "autostart.vbs is missing next to autostart.cmd" }

        # Two entry points on purpose: HKCU\Run is picked up early in the logon
        # sequence, the Startup-folder shortcut is the safety net. Windows delays
        # both while the machine is busy booting, so whoever fires first wins and
        # the other one exits on its own (EADDRINUSE is handled quietly).
        $taskName = 'cloudmusic-wallpaper-bridge'
        # //B is batch mode: no Windows Script Host dialog, even on a fatal error.
        # A watchdog that pops a modal box every five minutes is worse than the
        # problem it is watching for, so every entry point carries the flag.
        $runValue = '"' + $wscript + '" //B "' + $vbsPath + '"'
        New-ItemProperty -Path $runKey -Name $taskName -Value $runValue -PropertyType String -Force | Out-Null
        "created  HKCU\Run '$taskName'"

        $sh = New-Object -ComObject WScript.Shell
        $lnk = $sh.CreateShortcut($lnkPath)
        $lnk.TargetPath = $wscript
        $lnk.Arguments = '//B "' + $vbsPath + '"'
        $lnk.WorkingDirectory = $Root
        $lnk.WindowStyle = 7
        $lnk.Description = 'Wallpaper Engine wallpapers behind the NetEase CloudMusic client'
        $lnk.Save()
        "created  $lnkPath"

        # Third entry point, and the only one that survives everything being
        # killed at once (standby, an aggressive antivirus, a crashed session):
        # a task that fires every five minutes. The supervisor exits straight
        # away when another bridge already owns the port, so this is a watchdog
        # rather than a second copy.
        & schtasks /create /f /tn $taskName /sc minute /mo 5 /tr ('"' + $wscript + '" //B "' + $vbsPath + '"') 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { "created  scheduled task '$taskName' (every 5 min, self-healing)" }
        else { "warning: could not create the scheduled task (exit $LASTEXITCODE); the two logon entries still work" }

        $client = Get-ClientRunValue
        if ($client -and $client -notmatch '--remote-debugging-port=') {
            if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
            if (-not (Test-Path $runBackup)) {
                Set-Content -Path $runBackup -Value $client -Encoding UTF8
                "backed up the old client autorun entry to $runBackup"
            }
            $new = Add-DebugFlag $client
            Set-ClientRunValue $new
            "patched  client autorun -> $new"
        } elseif ($client) {
            'client autorun already carries the debug port, left alone'
        } else {
            'no client autorun entry to patch (fine, the bridge adds the port itself)'
        }

        $listening = @(Get-NetTCPConnection -State Listen -LocalPort 2000 -ErrorAction SilentlyContinue)
        if (-not $listening.Count) {
            Start-Process -FilePath $wscript -ArgumentList ('//B "' + $vbsPath + '"') -WindowStyle Hidden
            Start-Sleep -Seconds 4
            $listening = @(Get-NetTCPConnection -State Listen -LocalPort 2000 -ErrorAction SilentlyContinue)
        }
        "bridge running : " + $(if ($listening.Count) { 'yes' } else { 'not yet - check the log' })
        ''
        'Done. It now starts with Windows, hidden, and logs to'
        "  $(Join-Path $stateDir 'bridge.log')"
    }
    'uninstall' {
        $taskName = 'cloudmusic-wallpaper-bridge'
        if ((Get-ItemProperty -Path $runKey -Name $taskName -ErrorAction SilentlyContinue)) {
            Remove-ItemProperty -Path $runKey -Name $taskName -Force
            "removed  HKCU\Run '$taskName'"
        }
        if (Test-Path $lnkPath) {
            Remove-Item $lnkPath -Force
            "removed  $lnkPath"
        } else {
            'logon shortcut was not installed'
        }

        & schtasks /delete /f /tn $taskName 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { "removed  scheduled task '$taskName'" }
        else { 'scheduled task was not installed' }

        if (Test-Path $runBackup) {
            $original = (Get-Content $runBackup -Raw).Trim()
            Set-ClientRunValue $original
            Remove-Item $runBackup -Force
            "restored client autorun -> $original"
        } else {
            $client = Get-ClientRunValue
            if ($client -and $client -match '--remote-debugging-port=') {
                $restored = Remove-DebugFlag $client
                Set-ClientRunValue $restored
                "removed the debug port from client autorun -> $restored"
            } else {
                'nothing to restore for the client autorun entry'
            }
        }
        ''
        'Autostart removed. A bridge that is already running keeps running until you close it.'
    }
    default { Show-Status }
}
