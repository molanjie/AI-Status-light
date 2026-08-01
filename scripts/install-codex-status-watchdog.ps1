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
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`""

if ($Describe) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $descriptor = [ordered]@{
    taskName = $taskName
    trigger = 'AtLogOn'
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

  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 999 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  $principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

  if ($StartNow) {
    Start-ScheduledTask -TaskName $taskName
  }
}
