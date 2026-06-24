$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Root 'start-mini-watch-desktop.bat'
$WatcherLauncher = Join-Path $Root 'start-mini-watch-when-codex.bat'
$ShortcutName = 'Mini Watch Codex.lnk'

if (-not (Test-Path $Launcher)) {
  throw "Launcher not found: $Launcher"
}
if (-not (Test-Path $WatcherLauncher)) {
  throw "Watcher launcher not found: $WatcherLauncher"
}

$DesktopDir = [Environment]::GetFolderPath('DesktopDirectory')
$StartupDir = [Environment]::GetFolderPath('Startup')
$IconLocation = "$env:SystemRoot\System32\shell32.dll,167"

function New-MiniWatchShortcut {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Target
  )

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.WorkingDirectory = $Root
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = $IconLocation
  $shortcut.Description = 'Mini Watch Codex status island'
  $shortcut.Save()
}

$DesktopShortcut = Join-Path $DesktopDir $ShortcutName
$StartupShortcut = Join-Path $StartupDir $ShortcutName

New-MiniWatchShortcut -Path $DesktopShortcut -Target $Launcher
New-MiniWatchShortcut -Path $StartupShortcut -Target $WatcherLauncher

Write-Output "[OK] Desktop shortcut: $DesktopShortcut"
Write-Output "[OK] Startup watcher shortcut: $StartupShortcut"
