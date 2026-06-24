$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Root 'start-mini-watch-desktop.ps1'
$LogPath = Join-Path $Root 'mini-watch-codex-watcher.log'

function Write-WatcherLog {
  param([string]$Message)
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $LogPath -Value "[$stamp] $Message" -Encoding UTF8
}

function Test-CodexRunning {
  $codex = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue
  $cli = Get-Process -Name 'codex' -ErrorAction SilentlyContinue
  return [bool]($codex -or $cli)
}

function Test-MiniWatchRunning {
  $island = Get-CimInstance Win32_Process -Filter "name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dynamic_island.py*' }
  $bridge = Get-CimInstance Win32_Process -Filter "name = 'python.exe' or name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*codex_status_bridge.py*' }
  return [bool]($island -and $bridge)
}

Write-WatcherLog 'Watcher started.'

while ($true) {
  try {
    if ((Test-CodexRunning) -and -not (Test-MiniWatchRunning)) {
      Write-WatcherLog 'Codex detected; starting Mini Watch.'
      Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        "`"$Launcher`""
      )
      Start-Sleep -Seconds 8
    }
  }
  catch {
    Write-WatcherLog "Error: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 3
}
