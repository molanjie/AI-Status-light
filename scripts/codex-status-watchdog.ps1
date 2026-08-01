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
$config = Resolve-WatchdogConfiguration `
  -ProjectRoot $projectRoot `
  -RequireGitHubAuthentication:$CheckConfiguration

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

$IntervalSeconds = Get-WatchdogIntervalSeconds -IntervalSeconds $IntervalSeconds
$publisherTimeoutMilliseconds = 35000
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
  $backoffState = [pscustomobject]@{
    ExternalFailures = 0
  }

  do {
    $externalSucceeded = $null
    $sleepSeconds = $IntervalSeconds
    try {
      $localHealthValid = Test-LocalHealthEndpoint -Url $config.localHealthUrl -TimeoutSeconds 3
      $ownedServer = Get-OwnedProcessFromPidFile -PidFile $serverPidFile -ExpectedCommandLineFragments $serverFragments
      $serverDecision = Get-LocalServerGateDecision -LocalHealthValid $localHealthValid -OwnedServer $ownedServer

      if ($serverDecision -eq 'RecoverServer') {
        $replacement = Invoke-OwnedProcessReplacement -StopOwned {
          Stop-OwnedProcessFromPidFile -PidFile $serverPidFile -ExpectedCommandLineFragments $serverFragments
        } -ClearPid {
          if (Test-Path -LiteralPath $serverPidFile -PathType Leaf) {
            Remove-Item -LiteralPath $serverPidFile -Force
          }
        } -StartReplacement {
          Start-OwnedProcess -FilePath $config.nodePath -Arguments @($config.serverPath) -WorkingDirectory $config.projectRoot -PidFile $serverPidFile -OutputLog $serverOutputLog -ErrorLog $serverErrorLog | Out-Null
        }
        if ($replacement.TerminationFailed) {
          Write-WatchdogLog ("owned server termination failed: $($replacement.StopResult.Error)")
        }
        else {
          if ($replacement.StopResult.Status -eq 'Terminated') {
            Write-WatchdogLog 'stopped owned unhealthy server'
          }
          Write-WatchdogLog 'started owned server'
        }
      }
      elseif ($serverDecision -eq 'OwnershipConflict') {
        $retirement = Invoke-OwnedProcessRetirement -StopOwned {
          Stop-OwnedProcessFromPidFile -PidFile $tunnelPidFile -ExpectedCommandLineFragments $tunnelFragments
        } -ClearPid {
          if (Test-Path -LiteralPath $tunnelPidFile -PathType Leaf) {
            Remove-Item -LiteralPath $tunnelPidFile -Force
          }
        }
        if ($retirement.TerminationFailed) {
          Write-WatchdogLog ("owned tunnel termination failed during server ownership conflict: $($retirement.StopResult.Error)")
        }
        elseif ($retirement.StopResult.Status -eq 'Terminated') {
          Write-WatchdogLog 'stopped owned tunnel during server ownership conflict'
        }
        Write-WatchdogLog 'local health ownership conflict; refusing to adopt, replace, expose, or publish listener'
      }
      else {
        $externalSucceeded = $false
        $tunnel = Get-OwnedProcessFromPidFile -PidFile $tunnelPidFile -ExpectedCommandLineFragments $tunnelFragments
        if ($null -eq $tunnel) {
          if (Test-Path -LiteralPath $tunnelPidFile -PathType Leaf) {
            Remove-Item -LiteralPath $tunnelPidFile -Force
          }
          Clear-OwnedTunnelLogs -StateDirectory $config.stateDirectory
          Start-OwnedProcess -FilePath $config.cloudflaredPath -Arguments @('tunnel', '--url', $config.localTunnelUrl, '--no-autoupdate') -WorkingDirectory $config.projectRoot -PidFile $tunnelPidFile -OutputLog $tunnelOutputLog -ErrorLog $tunnelErrorLog | Out-Null
          Write-WatchdogLog 'started owned tunnel'
        }

        $tunnelUrl = Get-NewestTunnelUrlFromLogFiles -OutputLog $tunnelOutputLog -ErrorLog $tunnelErrorLog
        $publicStatusHealthy = $false
        if ([string]::IsNullOrWhiteSpace($tunnelUrl)) {
          Write-WatchdogLog 'tunnel URL unavailable'
        }
        else {
          $publicStatusHealthy = Test-PublicStatusEndpoint -Url ($tunnelUrl + '/api/status') -TimeoutSeconds 5
          if (-not $publicStatusHealthy) {
            Write-WatchdogLog 'public status check failed'
          }
        }

        $transition = Invoke-PublicStatusTransition -State $publicState -TunnelUrl $tunnelUrl -PublicStatusHealthy $publicStatusHealthy -PublishTunnel {
          param($publishUrl)
          $publishResult = Invoke-EndpointPublisherProcess `
            -NodePath $config.nodePath `
            -PublisherPath $config.publisherPath `
            -TunnelUrl $publishUrl `
            -WorkingDirectory $config.projectRoot `
            -TimeoutMilliseconds $publisherTimeoutMilliseconds
          if (-not $publishResult.Succeeded) {
            Write-WatchdogLog ("endpoint publisher failed: $($publishResult.Status)")
            return $false
          }
          return $true
        } -RotateTunnel {
          $retirement = Invoke-OwnedProcessRetirement -StopOwned {
            Stop-OwnedProcessFromPidFile -PidFile $tunnelPidFile -ExpectedCommandLineFragments $tunnelFragments
          } -ClearPid {
            if (Test-Path -LiteralPath $tunnelPidFile -PathType Leaf) {
              Remove-Item -LiteralPath $tunnelPidFile -Force
            }
          }
          if ($retirement.TerminationFailed) {
            Write-WatchdogLog ("owned tunnel termination failed: $($retirement.StopResult.Error)")
            return $false
          }
          if ($retirement.StopResult.Status -eq 'Terminated') {
            Write-WatchdogLog 'stopped owned unhealthy tunnel'
          }
          return $true
        }
        $publicState = $transition.State
        $externalSucceeded = $publicStatusHealthy -and (
          -not $transition.PublicationAttempted -or $transition.PublicationSucceeded
        )

        if ($transition.RotationRequested) {
          Write-WatchdogLog 'rotated owned tunnel after three public failures'
          $externalSucceeded = $true
        }
        if ($transition.RotationFailed) {
          Write-WatchdogLog 'owned tunnel rotation failed; preserving PID and failure state'
        }
        if ($transition.PublicationSucceeded) {
          Write-WatchdogLog ("published tunnel URL $tunnelUrl")
        }
      }
    }
    catch {
      Write-WatchdogLog ("watchdog iteration failed: {0}" -f $_.Exception.Message)
    }

    if ($null -ne $externalSucceeded) {
      $sleepSeconds = Update-WatchdogBackoff `
        -State $backoffState `
        -Succeeded ([bool]$externalSucceeded) `
        -BaseDelaySeconds $IntervalSeconds
    }
    Invoke-WatchdogSleep -RunOnce:$RunOnce -DelaySeconds $sleepSeconds | Out-Null
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
