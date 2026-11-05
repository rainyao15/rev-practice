param(
  [ValidateSet('create', 'remove')]
  [string]$Action = 'create',
  [Parameter(Mandatory = $true)][string]$Root
)

# Desktop shortcut for panel.cmd. Kept in its own .ps1 because batch files cannot
# reliably carry non-ASCII text (cmd.exe reads them in the OEM code page).
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop '网易云背景.lnk'
$target = Join-Path $Root 'panel.cmd'
$icon = Join-Path $Root 'native\BridgePanel.exe'

if ($Action -eq 'remove') {
  if (Test-Path -LiteralPath $link) {
    Remove-Item -LiteralPath $link -Force
    Write-Output 'shortcut removed'
  } else {
    Write-Output 'no shortcut'
  }
  return
}

if (-not (Test-Path -LiteralPath $target)) {
  Write-Output "panel.cmd not found at $target"
  return
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $target
$sc.WorkingDirectory = $Root
if (Test-Path -LiteralPath $icon) { $sc.IconLocation = $icon }
$sc.Description = '网易云背景 — Wallpaper Engine 桥接'
$sc.Save()
Write-Output "shortcut created: $link"
