Set-StrictMode -Version Latest

function Get-TunnelUrlFromText {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [string]$Text
  )

  if ([string]::IsNullOrEmpty($Text)) {
    return $null
  }

  $matches = [regex]::Matches($Text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($matches.Count -eq 0) {
    return $null
  }

  return $matches[$matches.Count - 1].Value
}

function Test-ExpectedCommandLine {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [string]$CommandLine,
    [string[]]$ExpectedFragments
  )

  if ($null -eq $CommandLine) {
    return $false
  }

  $remaining = $CommandLine.Trim()
  foreach ($fragment in $ExpectedFragments) {
    if ([string]::IsNullOrWhiteSpace($fragment)) {
      continue
    }

    $quotedFragment = '"' + $fragment + '"'
    if ($remaining.StartsWith($quotedFragment, [System.StringComparison]::OrdinalIgnoreCase)) {
      $remaining = $remaining.Substring($quotedFragment.Length)
    }
    elseif ($remaining.StartsWith($fragment, [System.StringComparison]::OrdinalIgnoreCase)) {
      if ($remaining.Length -gt $fragment.Length -and -not [char]::IsWhiteSpace($remaining[$fragment.Length])) {
        return $false
      }
      $remaining = $remaining.Substring($fragment.Length)
    }
    else {
      return $false
    }

    if ($remaining.Length -gt 0 -and -not [char]::IsWhiteSpace($remaining[0])) {
      return $false
    }
    $remaining = $remaining.TrimStart()
  }

  return $remaining.Length -eq 0
}

function Get-OwnedProcessFromPidFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$PidFile,
    [Parameter(Mandatory = $true)]
    [string[]]$ExpectedCommandLineFragments
  )

  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
    return $null
  }

  try {
    $pidText = [System.IO.File]::ReadAllText($PidFile).Trim()
    if ($pidText -notmatch '^[0-9]+$') {
      return $null
    }

    $processId = [uint32]$pidText
    if ($processId -eq 0) {
      return $null
    }

    $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $processId) -ErrorAction Stop
  }
  catch {
    return $null
  }

  if ($null -eq $process -or -not (Test-ExpectedCommandLine -CommandLine $process.CommandLine -ExpectedFragments $ExpectedCommandLineFragments)) {
    return $null
  }

  return $process
}

function Stop-OwnedProcessFromPidFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$PidFile,
    [Parameter(Mandatory = $true)]
    [string[]]$ExpectedCommandLineFragments
  )

  # This lookup validates the one recorded PID immediately before terminating its CIM object.
  $process = Get-OwnedProcessFromPidFile -PidFile $PidFile -ExpectedCommandLineFragments $ExpectedCommandLineFragments
  if ($null -eq $process) {
    return [pscustomobject]@{
      Status = 'NoOwnedProcess'
      Error = $null
    }
  }

  try {
    $result = Invoke-CimMethod -InputObject $process -MethodName 'Terminate' -ErrorAction Stop
    if ($result.ReturnValue -eq 0) {
      return [pscustomobject]@{
        Status = 'Terminated'
        Error = $null
      }
    }

    return [pscustomobject]@{
      Status = 'TerminationFailed'
      Error = "Win32_Process.Terminate returned $($result.ReturnValue)."
    }
  }
  catch {
    return [pscustomobject]@{
      Status = 'TerminationFailed'
      Error = $_.Exception.Message
    }
  }
}

function Invoke-OwnedProcessReplacement {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$StopOwned,
    [Parameter(Mandatory = $true)]
    [scriptblock]$ClearPid,
    [Parameter(Mandatory = $true)]
    [scriptblock]$StartReplacement
  )

  $stopResult = & $StopOwned
  if ($null -eq $stopResult -or $stopResult.Status -eq 'TerminationFailed') {
    return [pscustomobject]@{
      ReplacementStarted = $false
      TerminationFailed = $true
      StopResult = $stopResult
    }
  }

  if ($stopResult.Status -notin @('NoOwnedProcess', 'Terminated')) {
    throw "Unexpected owned-process stop status: $($stopResult.Status)"
  }

  & $ClearPid | Out-Null
  & $StartReplacement | Out-Null
  return [pscustomobject]@{
    ReplacementStarted = $true
    TerminationFailed = $false
    StopResult = $stopResult
  }
}

function Invoke-OwnedProcessRetirement {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$StopOwned,
    [Parameter(Mandatory = $true)]
    [scriptblock]$ClearPid
  )

  $stopResult = & $StopOwned
  if ($null -eq $stopResult -or $stopResult.Status -eq 'TerminationFailed') {
    return [pscustomobject]@{
      Succeeded = $false
      TerminationFailed = $true
      StopResult = $stopResult
    }
  }

  if ($stopResult.Status -notin @('NoOwnedProcess', 'Terminated')) {
    throw "Unexpected owned-process stop status: $($stopResult.Status)"
  }

  & $ClearPid | Out-Null
  return [pscustomobject]@{
    Succeeded = $true
    TerminationFailed = $false
    StopResult = $stopResult
  }
}

function Get-NewestTunnelUrlFromLogFiles {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$OutputLog,
    [Parameter(Mandatory = $true)]
    [string]$ErrorLog
  )

  $candidates = foreach ($logPath in @($OutputLog, $ErrorLog)) {
    if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
      continue
    }

    $url = Get-TunnelUrlFromText -Text ([System.IO.File]::ReadAllText($logPath))
    if (-not [string]::IsNullOrWhiteSpace($url)) {
      $item = Get-Item -LiteralPath $logPath -Force
      [pscustomobject]@{
        Url = $url
        LastWriteTimeUtc = $item.LastWriteTimeUtc
        Path = $item.FullName
      }
    }
  }

  if ($null -eq $candidates) {
    return $null
  }

  return ($candidates | Sort-Object -Property LastWriteTimeUtc, Path -Descending | Select-Object -First 1).Url
}

function Clear-OwnedTunnelLogs {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$StateDirectory
  )

  foreach ($fileName in @('tunnel.out.log', 'tunnel.err.log')) {
    $logPath = Join-Path $StateDirectory $fileName
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
      Remove-Item -LiteralPath $logPath -Force
    }
  }
}

function Start-OwnedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string]$PidFile,
    [Parameter(Mandatory = $true)]
    [string]$OutputLog,
    [Parameter(Mandatory = $true)]
    [string]$ErrorLog,
    [scriptblock]$StartProcessAction = {
      param($processPath, $processArguments, $processWorkingDirectory, $processOutputLog, $processErrorLog)
      $quotedArguments = @($processArguments | ForEach-Object { '"{0}"' -f $_.Replace('"', '\"') }) -join ' '
      Start-Process `
        -FilePath $processPath `
        -ArgumentList $quotedArguments `
        -WorkingDirectory $processWorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $processOutputLog `
        -RedirectStandardError $processErrorLog `
        -PassThru
    },
    [scriptblock]$WritePidAction = {
      param($tempPath, $processId)
      [System.IO.File]::WriteAllText($tempPath, [string]$processId, [System.Text.Encoding]::ASCII)
    },
    [scriptblock]$CommitPidAction = {
      param($tempPath, $targetPath)
      if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
        [System.IO.File]::Replace($tempPath, $targetPath, $null)
      }
      else {
        [System.IO.File]::Move($tempPath, $targetPath)
      }
    }
  )

  $pidDirectory = Split-Path -Parent $PidFile
  $pidFileName = [System.IO.Path]::GetFileName($PidFile)
  $tempPath = Join-Path $pidDirectory ("{0}.{1}.tmp" -f $pidFileName, [guid]::NewGuid().ToString('N'))
  $process = $null
  $pidCommitted = $false

  try {
    $process = & $StartProcessAction $FilePath $Arguments $WorkingDirectory $OutputLog $ErrorLog
    if ($null -eq $process -or ([string]$process.Id) -notmatch '^[1-9][0-9]*$') {
      throw 'Started process did not provide a valid positive integer PID.'
    }

    & $WritePidAction $tempPath ([string]$process.Id) | Out-Null
    & $CommitPidAction $tempPath $PidFile | Out-Null
    $pidCommitted = $true
    return $process
  }
  catch {
    $claimError = $_
    if ($null -ne $process) {
      try {
        $process.Kill()
      }
      catch {}
      try {
        [void]$process.WaitForExit()
      }
      catch {}
    }

    if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $process) {
      try {
        $process.Dispose()
      }
      catch {}
    }

    throw $claimError
  }
  finally {
    if (-not $pidCommitted -and (Test-Path -LiteralPath $tempPath -PathType Leaf)) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-WatchdogIntervalSeconds {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [int]$IntervalSeconds
  )

  return [Math]::Max(5, $IntervalSeconds)
}

function Invoke-EndpointPublisherProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodePath,
    [Parameter(Mandatory = $true)]
    [string]$PublisherPath,
    [Parameter(Mandatory = $true)]
    [string]$TunnelUrl,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 600000)]
    [int]$TimeoutMilliseconds
  )

  $process = $null
  try {
    $arguments = @($PublisherPath, 'publish', $TunnelUrl)
    $quotedArguments = @($arguments | ForEach-Object { '"{0}"' -f $_.Replace('"', '\"') }) -join ' '
    $process = Start-Process `
      -FilePath $NodePath `
      -ArgumentList $quotedArguments `
      -WorkingDirectory $WorkingDirectory `
      -WindowStyle Hidden `
      -PassThru

    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try {
        $process.Kill()
        [void]$process.WaitForExit(5000)
      }
      catch {}

      return [pscustomobject]@{
        Status = 'TimedOut'
        Succeeded = $false
        ExitCode = $null
      }
    }

    $exitCode = [int]$process.ExitCode
    return [pscustomobject]@{
      Status = if ($exitCode -eq 0) { 'Succeeded' } else { 'Failed' }
      Succeeded = $exitCode -eq 0
      ExitCode = $exitCode
    }
  }
  catch {
    if ($null -ne $process) {
      try {
        $process.Kill()
        [void]$process.WaitForExit(5000)
      }
      catch {}
    }

    return [pscustomobject]@{
      Status = 'StartFailed'
      Succeeded = $false
      ExitCode = $null
    }
  }
  finally {
    if ($null -ne $process) {
      $process.Dispose()
    }
  }
}

function Update-WatchdogBackoff {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$State,
    [Parameter(Mandatory = $true)]
    [bool]$Succeeded,
    [Parameter(Mandatory = $true)]
    [int]$BaseDelaySeconds
  )

  $baseDelay = [Math]::Min(60, [Math]::Max(5, $BaseDelaySeconds))
  if ($Succeeded) {
    $State.ExternalFailures = 0
    return $baseDelay
  }

  $State.ExternalFailures = [int]$State.ExternalFailures + 1
  $delay = $baseDelay
  for ($index = 1; $index -lt $State.ExternalFailures -and $delay -lt 60; $index += 1) {
    $delay = [Math]::Min(60, $delay * 2)
  }
  return [int]$delay
}

function Invoke-WatchdogSleep {
  [CmdletBinding()]
  param(
    [switch]$RunOnce,
    [Parameter(Mandatory = $true)]
    [int]$DelaySeconds,
    [scriptblock]$SleepAction = { param($seconds) Start-Sleep -Seconds $seconds }
  )

  if ($RunOnce) {
    return $false
  }

  & $SleepAction $DelaySeconds | Out-Null
  return $true
}

function Invoke-PublicStatusTransition {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$State,
    [AllowNull()]
    [string]$TunnelUrl,
    [Parameter(Mandatory = $true)]
    [bool]$PublicStatusHealthy,
    [Parameter(Mandatory = $true)]
    [scriptblock]$PublishTunnel,
    [Parameter(Mandatory = $true)]
    [scriptblock]$RotateTunnel
  )

  $publicationAttempted = $false
  $publicationSucceeded = $false
  $rotationRequested = $false
  $rotationFailed = $false

  if (-not $PublicStatusHealthy) {
    $State.PublicFailures = [int]$State.PublicFailures + 1
    if ($State.PublicFailures -ge 3) {
      try {
        $rotationSucceeded = [bool](& $RotateTunnel)
      }
      catch {
        $rotationSucceeded = $false
      }
      if ($rotationSucceeded) {
        $State.PublicFailures = 0
        $rotationRequested = $true
      }
      else {
        $rotationFailed = $true
      }
    }
  }
  else {
    $State.PublicFailures = 0
    if (-not [string]::IsNullOrWhiteSpace($TunnelUrl) -and $TunnelUrl -ne $State.LastPublishedUrl) {
      $publicationAttempted = $true
      $publicationSucceeded = [bool](& $PublishTunnel $TunnelUrl)
      if ($publicationSucceeded) {
        $State.LastPublishedUrl = $TunnelUrl
      }
    }
  }

  return [pscustomobject]@{
    State = $State
    PublicationAttempted = $publicationAttempted
    PublicationSucceeded = $publicationSucceeded
    RotationRequested = $rotationRequested
    RotationFailed = $rotationFailed
  }
}

function Invoke-WatchdogMutex {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [object]$Mutex,
    [Parameter(Mandatory = $true)]
    [scriptblock]$OnContention,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  $ownsMutex = $false
  try {
    try {
      $ownsMutex = $Mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
      $ownsMutex = $true
    }

    if (-not $ownsMutex) {
      & $OnContention | Out-Null
      return $false
    }

    & $Action | Out-Null
    return $true
  }
  finally {
    if ($ownsMutex) {
      $Mutex.ReleaseMutex()
    }
    $Mutex.Dispose()
  }
}

function Test-FiniteJsonNumber {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [object]$Value
  )

  if ($null -eq $Value) {
    return $false
  }

  $typeCode = [System.Type]::GetTypeCode($Value.GetType())
  if ($typeCode -notin @(
    [System.TypeCode]::Byte,
    [System.TypeCode]::SByte,
    [System.TypeCode]::UInt16,
    [System.TypeCode]::UInt32,
    [System.TypeCode]::UInt64,
    [System.TypeCode]::Int16,
    [System.TypeCode]::Int32,
    [System.TypeCode]::Int64,
    [System.TypeCode]::Decimal,
    [System.TypeCode]::Double,
    [System.TypeCode]::Single
  )) {
    return $false
  }

  $number = [double]$Value
  return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)
}

function Test-NonNegativeJsonInteger {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [object]$Value
  )

  if (-not (Test-FiniteJsonNumber -Value $Value)) {
    return $false
  }

  $number = [double]$Value
  return $number -ge 0 -and $number -eq [Math]::Truncate($number)
}

function Test-JsonObjectProperty {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [object]$Value,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  return $null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]
}

function Test-LocalHealthPayload {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [object]$Payload
  )

  if ($null -eq $Payload -or $Payload -is [System.Array]) {
    return $false
  }

  return (
    (Test-JsonObjectProperty -Value $Payload -Name 'ok') -and
    $Payload.ok -is [bool] -and
    $Payload.ok -eq $true -and
    (Test-JsonObjectProperty -Value $Payload -Name 'startedAt') -and
    (Test-FiniteJsonNumber -Value $Payload.startedAt) -and
    (Test-JsonObjectProperty -Value $Payload -Name 'now') -and
    (Test-FiniteJsonNumber -Value $Payload.now)
  )
}

function Test-PublicStatusPayload {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [object]$Payload
  )

  if ($null -eq $Payload -or $Payload -is [System.Array]) {
    return $false
  }

  $requiredProperties = @(
    'source',
    'state',
    'light',
    'label',
    'sessionCount',
    'sessions',
    'totalThreads',
    'hostname',
    'lastCompletedAt',
    'updatedAt',
    'error'
  )
  foreach ($propertyName in $requiredProperties) {
    if (-not (Test-JsonObjectProperty -Value $Payload -Name $propertyName)) {
      return $false
    }
  }

  if (
    $Payload.source -ne 'codex-local' -or
    $Payload.state -notin @('idle', 'processing', 'waiting', 'completed', 'offline', 'error') -or
    $Payload.light -notin @('red', 'yellow', 'green') -or
    $Payload.label -isnot [string] -or
    [string]::IsNullOrWhiteSpace($Payload.label) -or
    -not (Test-NonNegativeJsonInteger -Value $Payload.sessionCount) -or
    $Payload.sessions -isnot [System.Array] -or
    -not (Test-NonNegativeJsonInteger -Value $Payload.totalThreads) -or
    $Payload.hostname -isnot [string] -or
    -not (Test-FiniteJsonNumber -Value $Payload.updatedAt) -or
    $Payload.error -isnot [string]
  ) {
    return $false
  }

  if ($null -ne $Payload.lastCompletedAt -and -not (Test-FiniteJsonNumber -Value $Payload.lastCompletedAt)) {
    return $false
  }

  foreach ($session in $Payload.sessions) {
    if (
      $null -eq $session -or
      -not (Test-JsonObjectProperty -Value $session -Name 'title') -or
      $session.title -isnot [string] -or
      -not (Test-JsonObjectProperty -Value $session -Name 'state') -or
      $session.state -notin @('processing', 'waiting', 'completed')
    ) {
      return $false
    }
  }

  return $true
}

function Test-JsonEndpoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)]
    [scriptblock]$ValidatePayload
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace([string]$response.Content)) {
      return $false
    }

    $payload = $response.Content | ConvertFrom-Json -ErrorAction Stop
    return [bool](& $ValidatePayload $payload)
  }
  catch {
    return $false
  }
}

function Test-LocalHealthEndpoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds
  )

  return Test-JsonEndpoint -Url $Url -TimeoutSeconds $TimeoutSeconds -ValidatePayload {
    param($payload)
    Test-LocalHealthPayload -Payload $payload
  }
}

function Test-PublicStatusEndpoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds
  )

  return Test-JsonEndpoint -Url $Url -TimeoutSeconds $TimeoutSeconds -ValidatePayload {
    param($payload)
    Test-PublicStatusPayload -Payload $payload
  }
}

function Invoke-GitHubAuthStatusProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$GhPath,
    [ValidateRange(1, 600000)]
    [int]$TimeoutMilliseconds = 10000
  )

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $process.StartInfo.FileName = $GhPath
  $process.StartInfo.Arguments = 'auth status'
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true

  try {
    if (-not $process.Start()) {
      return $false
    }

    $outputRead = $process.StandardOutput.ReadToEndAsync()
    $errorRead = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try {
        $process.Kill()
        [void]$process.WaitForExit(5000)
      }
      catch {}
      return $false
    }

    [void]$outputRead.GetAwaiter().GetResult()
    [void]$errorRead.GetAwaiter().GetResult()
    return $process.ExitCode -eq 0
  }
  catch {
    return $false
  }
  finally {
    $process.Dispose()
  }
}

function Assert-GitHubAuthentication {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$GhPath,
    [AllowEmptyString()]
    [string]$EnvironmentToken = $env:GH_TOKEN,
    [scriptblock]$RunAuthStatus = {
      param($path)
      Invoke-GitHubAuthStatusProcess -GhPath $path
    }
  )

  if (-not [string]::IsNullOrWhiteSpace($EnvironmentToken)) {
    return $true
  }

  try {
    if ([bool](& $RunAuthStatus $GhPath)) {
      return $true
    }
  }
  catch {}

  throw 'GitHub authentication is unavailable. Run gh auth login or set a non-empty GH_TOKEN before installing the watchdog.'
}

function Get-LocalServerGateDecision {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [bool]$LocalHealthValid,
    [AllowNull()]
    [object]$OwnedServer
  )

  if (-not $LocalHealthValid) {
    return 'RecoverServer'
  }
  if ($null -eq $OwnedServer) {
    return 'OwnershipConflict'
  }
  return 'OwnedServerReady'
}

function Resolve-WatchdogConfiguration {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [switch]$RequireGitHubAuthentication
  )

  $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $missing = New-Object System.Collections.Generic.List[string]

  $nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace($nodeCommand.Source)) {
    $missing.Add('node.exe was not found on PATH.')
    $nodePath = $null
  }
  else {
    $nodePath = $nodeCommand.Source
  }

  $cloudflaredCandidates = @(
    (Join-Path $resolvedRoot 'tools\cloudflared.exe'),
    'C:\Users\Administrator\Documents\Codex\tools\cloudflared.exe'
  )
  $cloudflaredPath = $cloudflaredCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($null -eq $cloudflaredPath) {
    $cloudflaredCommand = Get-Command 'cloudflared.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cloudflaredCommand -and -not [string]::IsNullOrWhiteSpace($cloudflaredCommand.Source)) {
      $cloudflaredPath = $cloudflaredCommand.Source
    }
  }
  if ($null -eq $cloudflaredPath) {
    $missing.Add('cloudflared.exe was not found in tools, C:\Users\Administrator\Documents\Codex\tools, or PATH.')
  }

  $ghCommand = Get-Command 'gh.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $ghCommand -or [string]::IsNullOrWhiteSpace($ghCommand.Source)) {
    $missing.Add('gh.exe was not found on PATH.')
    $ghPath = $null
  }
  else {
    $ghPath = $ghCommand.Source
  }

  $publisherPath = Join-Path $resolvedRoot 'scripts\endpoint-registry.js'
  if (-not (Test-Path -LiteralPath $publisherPath -PathType Leaf)) {
    $missing.Add("Publisher script was not found: $publisherPath")
  }

  $serverPath = Join-Path $resolvedRoot 'server.js'
  if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    $missing.Add("Server script was not found: $serverPath")
  }

  if ($missing.Count -gt 0) {
    throw "Watchdog configuration is incomplete:`n - $($missing -join "`n - ")"
  }

  if ($RequireGitHubAuthentication) {
    Assert-GitHubAuthentication -GhPath $ghPath | Out-Null
  }

  return [pscustomobject]@{
    projectRoot = $resolvedRoot
    nodePath = $nodePath
    cloudflaredPath = $cloudflaredPath
    ghPath = $ghPath
    publisherPath = $publisherPath
    serverPath = $serverPath
    stateDirectory = (Join-Path $env:LOCALAPPDATA 'CodexStatusLight')
    localHealthUrl = 'http://127.0.0.1:3456/api/health'
    localTunnelUrl = 'http://127.0.0.1:3456'
  }
}

Export-ModuleMember -Function @(
  'Get-TunnelUrlFromText',
  'Test-ExpectedCommandLine',
  'Get-OwnedProcessFromPidFile',
  'Stop-OwnedProcessFromPidFile',
  'Invoke-OwnedProcessReplacement',
  'Invoke-OwnedProcessRetirement',
  'Get-NewestTunnelUrlFromLogFiles',
  'Clear-OwnedTunnelLogs',
  'Start-OwnedProcess',
  'Get-WatchdogIntervalSeconds',
  'Invoke-EndpointPublisherProcess',
  'Update-WatchdogBackoff',
  'Invoke-WatchdogSleep',
  'Invoke-PublicStatusTransition',
  'Invoke-WatchdogMutex',
  'Test-LocalHealthEndpoint',
  'Test-PublicStatusEndpoint',
  'Assert-GitHubAuthentication',
  'Get-LocalServerGateDecision',
  'Resolve-WatchdogConfiguration'
)
