$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root 'iapp\server'
$Desktop = Join-Path $Root 'desktop'

function Test-Server {
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 2
    return $res.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

if (-not (Test-Server)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "cd `"$Server`"; `$env:NODE_ENV='development'; `$env:PORT='3001'; npx.cmd tsx src/index.tsx *> server.log"
  )
  Start-Sleep -Seconds 5
}

Get-CimInstance Win32_Process -Filter "name = 'pythonw.exe'" |
  Where-Object { $_.CommandLine -like '*dynamic_island.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Get-CimInstance Win32_Process -Filter "name = 'pythonw.exe' or name = 'python.exe'" |
  Where-Object { $_.CommandLine -like '*codex_status_bridge.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath python.exe `
  -ArgumentList 'codex_status_bridge.py' `
  -WorkingDirectory $Desktop `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Desktop 'codex-status-bridge.log') `
  -RedirectStandardError (Join-Path $Desktop 'codex-status-bridge.err.log')
Start-Process -FilePath pythonw.exe -ArgumentList 'dynamic_island.py' -WorkingDirectory $Desktop
