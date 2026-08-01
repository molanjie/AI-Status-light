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
  'Test-HttpEndpoint',
  'Resolve-WatchdogConfiguration'
)
