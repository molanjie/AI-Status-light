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

function Clear-ExactFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Stop-OwnedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PidFile,
    [Parameter(Mandatory = $true)]
    [string[]]$ExpectedFragments
  )

  $process = Get-OwnedProcessFromPidFile -PidFile $PidFile -ExpectedCommandLineFragments $ExpectedFragments
  if ($null -eq $process) {
    return $false
  }

  Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
  return $true
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

function Get-TunnelUrlFromLogs {
  param(
    [Parameter(Mandatory = $true)]
    [string]$OutputLog,
    [Parameter(Mandatory = $true)]
    [string]$ErrorLog
  )

  $logText = ''
  foreach ($logPath in @($OutputLog, $ErrorLog)) {
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
      $logText += [System.IO.File]::ReadAllText($logPath)
    }
  }
  return Get-TunnelUrlFromText -Text $logText
}

$IntervalSeconds = [Math]::Max(5, $IntervalSeconds)
$mutex = New-Object System.Threading.Mutex($false, 'Local\CodexStatusLightWatchdog')
$ownsMutex = $false

try {
  try {
    $ownsMutex = $mutex.WaitOne(0)
  }
  catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }

  if (-not $ownsMutex) {
    if (-not (Test-Path -LiteralPath $config.stateDirectory -PathType Container)) {
      New-Item -ItemType Directory -Path $config.stateDirectory -Force | Out-Null
    }
    Write-WatchdogLog 'watchdog already running'
    exit 0
  }

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
  $publicFailures = 0
  $lastPublishedUrl = $null

  do {
    try {
      if (-not (Test-HttpEndpoint -Url $config.localHealthUrl -TimeoutSeconds 3)) {
        if (Stop-OwnedProcess -PidFile $serverPidFile -ExpectedFragments $serverFragments) {
          Write-WatchdogLog 'stopped owned unhealthy server'
        }
        Clear-ExactFile -Path $serverPidFile
        Start-OwnedProcess -FilePath $config.nodePath -Arguments @($config.serverPath) -PidFile $serverPidFile -OutputLog $serverOutputLog -ErrorLog $serverErrorLog | Out-Null
        Write-WatchdogLog 'started owned server'
      }
      else {
        $tunnel = Get-OwnedProcessFromPidFile -PidFile $tunnelPidFile -ExpectedCommandLineFragments $tunnelFragments
        if ($null -eq $tunnel) {
          Clear-ExactFile -Path $tunnelPidFile
          Clear-ExactFile -Path $tunnelOutputLog
          Clear-ExactFile -Path $tunnelErrorLog
          Start-OwnedProcess -FilePath $config.cloudflaredPath -Arguments @('tunnel', '--url', $config.localTunnelUrl, '--no-autoupdate') -PidFile $tunnelPidFile -OutputLog $tunnelOutputLog -ErrorLog $tunnelErrorLog | Out-Null
          Write-WatchdogLog 'started owned tunnel'
        }

        $tunnelUrl = Get-TunnelUrlFromLogs -OutputLog $tunnelOutputLog -ErrorLog $tunnelErrorLog
        if ([string]::IsNullOrWhiteSpace($tunnelUrl)) {
          $publicFailures++
          Write-WatchdogLog ("tunnel URL unavailable ({0}/3)" -f $publicFailures)
        }
        elseif (Test-HttpEndpoint -Url ($tunnelUrl + '/api/status') -TimeoutSeconds 5) {
          $publicFailures = 0
          if ($tunnelUrl -ne $lastPublishedUrl) {
            & $config.nodePath $config.publisherPath publish $tunnelUrl
            if ($LASTEXITCODE -ne 0) {
              throw "Endpoint publisher failed with exit code $LASTEXITCODE."
            }
            $lastPublishedUrl = $tunnelUrl
            Write-WatchdogLog ("published tunnel URL $tunnelUrl")
          }
        }
        else {
          $publicFailures++
          Write-WatchdogLog ("public status check failed ({0}/3)" -f $publicFailures)
        }

        if ($publicFailures -ge 3) {
          if (Stop-OwnedProcess -PidFile $tunnelPidFile -ExpectedFragments $tunnelFragments) {
            Write-WatchdogLog 'stopped owned unhealthy tunnel'
          }
          Clear-ExactFile -Path $tunnelPidFile
          $publicFailures = 0
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
finally {
  if ($ownsMutex) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
