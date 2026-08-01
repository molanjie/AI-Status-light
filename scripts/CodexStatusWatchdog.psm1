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

  foreach ($fragment in $ExpectedFragments) {
    if ([string]::IsNullOrWhiteSpace($fragment)) {
      continue
    }

    if ($CommandLine.IndexOf($fragment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return $false
    }
  }

  return $true
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
    return $false
  }

  try {
    $result = Invoke-CimMethod -InputObject $process -MethodName 'Terminate' -ErrorAction Stop
    return $result.ReturnValue -eq 0
  }
  catch {
    return $false
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

function Get-WatchdogIntervalSeconds {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [int]$IntervalSeconds
  )

  return [Math]::Max(5, $IntervalSeconds)
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

  if (-not $PublicStatusHealthy) {
    $State.PublicFailures = [int]$State.PublicFailures + 1
    if ($State.PublicFailures -ge 3) {
      & $RotateTunnel | Out-Null
      $State.PublicFailures = 0
      $rotationRequested = $true
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

function Test-HttpEndpoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch {
    return $false
  }
}

function Resolve-WatchdogConfiguration {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
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
  'Get-NewestTunnelUrlFromLogFiles',
  'Clear-OwnedTunnelLogs',
  'Get-WatchdogIntervalSeconds',
  'Invoke-PublicStatusTransition',
  'Invoke-WatchdogMutex',
  'Test-HttpEndpoint',
  'Resolve-WatchdogConfiguration'
)
