[CmdletBinding()]
param(
  [switch]$Describe,
  [switch]$StartNow,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if (($Describe -and $StartNow) -or ($Describe -and $Uninstall) -or ($StartNow -and $Uninstall)) {
  throw 'Describe, StartNow, and Uninstall are mutually exclusive.'
}

$taskName = 'CodexStatusLightWatchdog'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watchdogPath = Join-Path $projectRoot 'scripts\codex-status-watchdog.ps1'
$powerShellCommand = Get-Command powershell.exe -ErrorAction Stop
$powerShellPath = $powerShellCommand.Source
if ([string]::IsNullOrWhiteSpace($powerShellPath)) {
  $powerShellPath = $powerShellCommand.Path
}
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogPath`""
$stateDirectory = Join-Path $env:LOCALAPPDATA 'CodexStatusLight'
$heartbeatPath = Join-Path $stateDirectory 'watchdog.heartbeat'

if ($Describe) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $descriptor = [ordered]@{
    taskName = $taskName
    trigger = 'AtLogOn'
    rescueIntervalMinutes = 1
    multipleInstances = 'IgnoreNew'
    restartIntervalMinutes = 1
    restartCount = 999
    arguments = $arguments
  }
  [Console]::Write(($descriptor | ConvertTo-Json -Compress))
}
elseif ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -eq $taskName } |
    Select-Object -First 1
  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
  }
}
else {
  $checkArguments = @(
    '-NoProfile'
    '-ExecutionPolicy'
    'Bypass'
    '-File'
    ('"{0}"' -f $watchdogPath)
    '-CheckConfiguration'
  )
  $checkProcess = Start-Process -FilePath $powerShellPath -ArgumentList $checkArguments -Wait -PassThru -WindowStyle Hidden
  if ($checkProcess.ExitCode -ne 0) {
    throw "Watchdog configuration check failed with exit code $($checkProcess.ExitCode). Verify gh auth status or set a non-empty GH_TOKEN, then retry."
  }

  if ($StartNow) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
      Where-Object { $_.TaskName -eq $taskName } |
      Select-Object -First 1
    if ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $taskName
      $stoppedSamples = 0
      for ($attempt = 0; $attempt -lt 20 -and $stoppedSamples -lt 4; $attempt++) {
        Start-Sleep -Milliseconds 250
        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
          Where-Object { $_.TaskName -eq $taskName } |
          Select-Object -First 1
        if ($null -eq $existingTask -or [string]$existingTask.State -ne 'Running') {
          $stoppedSamples++
        }
        else {
          $stoppedSamples = 0
        }
      }
      if ($stoppedSamples -lt 4) {
        throw "Scheduled task '$taskName' did not stop before replacement."
      }
    }
  }

  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $rescueTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
  $triggers = @($logonTrigger, $rescueTrigger)
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 999 `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  $principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

  if ($StartNow) {
    $startRequestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-ScheduledTask -TaskName $taskName
    $runningSamples = 0
    for ($attempt = 0; $attempt -lt 40 -and $runningSamples -lt 4; $attempt++) {
      Start-Sleep -Milliseconds 250
      $startedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -eq $taskName } |
        Select-Object -First 1
      $freshHeartbeat = $false
      if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
        try {
          [long]$heartbeatTimestamp = 0
          $heartbeatText = [System.IO.File]::ReadAllText($heartbeatPath).Trim()
          $freshHeartbeat = [long]::TryParse($heartbeatText, [ref]$heartbeatTimestamp) -and $heartbeatTimestamp -gt $startRequestedAt
        }
        catch {
          $freshHeartbeat = $false
        }
      }
      if ($null -ne $startedTask -and [string]$startedTask.State -eq 'Running' -and $freshHeartbeat) {
        $runningSamples++
      }
      else {
        $runningSamples = 0
      }
    }
    if ($runningSamples -lt 4) {
      throw "Scheduled task '$taskName' did not publish a fresh heartbeat while remaining Running after StartNow. The one-minute rescue trigger will retry automatically."
    }
  }
}
