[CmdletBinding()]
param(
  [switch]$CheckConfiguration,
  [switch]$RunOnce,
  [int]$IntervalSeconds = 10
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$modulePath = Join-Path $projectRoot 'scripts\CodexStatusWatchdog.psm1'
Import-Module $modulePath -Force
$config = Resolve-WatchdogConfiguration -ProjectRoot $projectRoot

if ($CheckConfiguration) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Write(($config | ConvertTo-Json -Compress))
  exit 0
}

function Write-WatchdogLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  Add-Content -LiteralPath (Join-Path $config.stateDirectory 'watchdog.log') -Value ("{0:u} {1}" -f (Get-Date), $Message)
}

function Start-OwnedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$PidFile,
    [Parameter(Mandatory = $true)]
    [string]$OutputLog,
    [Parameter(Mandatory = $true)]
    [string]$ErrorLog
  )

  $quotedArguments = @($Arguments | ForEach-Object { '"{0}"' -f $_.Replace('"', '\"') }) -join ' '
  $process = Start-Process -FilePath $FilePath -ArgumentList $quotedArguments -WorkingDirectory $config.projectRoot -WindowStyle Hidden -RedirectStandardOutput $OutputLog -RedirectStandardError $ErrorLog -PassThru
  [System.IO.File]::WriteAllText($PidFile, [string]$process.Id, [System.Text.Encoding]::ASCII)
  return $process
}

$IntervalSeconds = Get-WatchdogIntervalSeconds -IntervalSeconds $IntervalSeconds
$mutex = New-Object System.Threading.Mutex($false, 'Local\CodexStatusLightWatchdog')
$watchdogAction = {
  if (-not (Test-Path -LiteralPath $config.stateDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $config.stateDirectory -Force | Out-Null
  }

  $serverPidFile = Join-Path $config.stateDirectory 'server.pid'
  $tunnelPidFile = Join-Path $config.stateDirectory 'tunnel.pid'
  $serverOutputLog = Join-Path $config.stateDirectory 'server.out.log'
  $serverErrorLog = Join-Path $config.stateDirectory 'server.err.log'
  $tunnelOutputLog = Join-Path $config.stateDirectory 'tunnel.out.log'
  $tunnelErrorLog = Join-Path $config.stateDirectory 'tunnel.err.log'
  $serverFragments = @($config.nodePath, $config.serverPath)
  $tunnelFragments = @($config.cloudflaredPath, 'tunnel', '--url', $config.localTunnelUrl, '--no-autoupdate')
  $publicState = [pscustomobject]@{
    PublicFailures = 0
    LastPublishedUrl = $null
  }

  do {
    try {
      if (-not (Test-HttpEndpoint -Url $config.localHealthUrl -TimeoutSeconds 3)) {
        if (Stop-OwnedProcessFromPidFile -PidFile $serverPidFile -ExpectedCommandLineFragments $serverFragments) {
          Write-WatchdogLog 'stopped owned unhealthy server'
        }
        if (Test-Path -LiteralPath $serverPidFile -PathType Leaf) {
          Remove-Item -LiteralPath $serverPidFile -Force
        }
        Start-OwnedProcess -FilePath $config.nodePath -Arguments @($config.serverPath) -PidFile $serverPidFile -OutputLog $serverOutputLog -ErrorLog $serverErrorLog | Out-Null
        Write-WatchdogLog 'started owned server'
      }
      else {
        $tunnel = Get-OwnedProcessFromPidFile -PidFile $tunnelPidFile -ExpectedCommandLineFragments $tunnelFragments
        if ($null -eq $tunnel) {
          if (Test-Path -LiteralPath $tunnelPidFile -PathType Leaf) {
            Remove-Item -LiteralPath $tunnelPidFile -Force
          }
          Clear-OwnedTunnelLogs -StateDirectory $config.stateDirectory
          Start-OwnedProcess -FilePath $config.cloudflaredPath -Arguments @('tunnel', '--url', $config.localTunnelUrl, '--no-autoupdate') -PidFile $tunnelPidFile -OutputLog $tunnelOutputLog -ErrorLog $tunnelErrorLog | Out-Null
          Write-WatchdogLog 'started owned tunnel'
        }

        $tunnelUrl = Get-NewestTunnelUrlFromLogFiles -OutputLog $tunnelOutputLog -ErrorLog $tunnelErrorLog
        $publicStatusHealthy = $false
        if ([string]::IsNullOrWhiteSpace($tunnelUrl)) {
          Write-WatchdogLog 'tunnel URL unavailable'
        }
        else {
          $publicStatusHealthy = Test-HttpEndpoint -Url ($tunnelUrl + '/api/status') -TimeoutSeconds 5
          if (-not $publicStatusHealthy) {
            Write-WatchdogLog 'public status check failed'
          }
        }

        $transition = Invoke-PublicStatusTransition -State $publicState -TunnelUrl $tunnelUrl -PublicStatusHealthy $publicStatusHealthy -PublishTunnel {
          param($publishUrl)
          & $config.nodePath $config.publisherPath publish $publishUrl | Out-Null
          if ($LASTEXITCODE -ne 0) {
            Write-WatchdogLog ("endpoint publisher failed with exit code $LASTEXITCODE")
            return $false
          }
          return $true
        } -RotateTunnel {
          if (Stop-OwnedProcessFromPidFile -PidFile $tunnelPidFile -ExpectedCommandLineFragments $tunnelFragments) {
            Write-WatchdogLog 'stopped owned unhealthy tunnel'
          }
          if (Test-Path -LiteralPath $tunnelPidFile -PathType Leaf) {
            Remove-Item -LiteralPath $tunnelPidFile -Force
          }
        }
        $publicState = $transition.State

        if ($transition.RotationRequested) {
          Write-WatchdogLog 'rotated owned tunnel after three public failures'
        }
        if ($transition.PublicationSucceeded) {
          Write-WatchdogLog ("published tunnel URL $tunnelUrl")
        }
      }
    }
    catch {
      Write-WatchdogLog ("watchdog iteration failed: {0}" -f $_.Exception.Message)
    }

    if (-not $RunOnce) {
      Start-Sleep -Seconds $IntervalSeconds
    }
  } while (-not $RunOnce)
}

$didRun = Invoke-WatchdogMutex -Mutex $mutex -OnContention {
  if (-not (Test-Path -LiteralPath $config.stateDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $config.stateDirectory -Force | Out-Null
  }
  Write-WatchdogLog 'watchdog already running'
} -Action $watchdogAction

if (-not $didRun) {
  exit 0
}
