$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3001
$TunnelOut = Join-Path $Root 'cloudflared-public.out.log'
$TunnelErr = Join-Path $Root 'cloudflared-public.err.log'
$PublicUrlFile = Join-Path $Root 'PUBLIC_URL.txt'

function Find-Cloudflared {
  $candidates = @(
    (Join-Path $Root 'tools\cloudflared.exe'),
    (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $Root))) 'tools\cloudflared.exe'),
    'C:\Users\Administrator\Documents\Codex\tools\cloudflared.exe'
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }

  $cmd = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  return $null
}

function Read-PublicUrl {
  $text = ''
  $codexTools = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $Root))) 'tools'
  $logs = @(
    (Join-Path $codexTools 'cloudflared.out.log'),
    (Join-Path $codexTools 'cloudflared.err.log'),
    $TunnelOut,
    $TunnelErr
  )

  foreach ($log in $logs) {
    if (Test-Path $log) {
      $text += "`n" + (Get-Content -Raw -Path $log -ErrorAction SilentlyContinue)
    }
  }

  $matches = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($matches.Count -gt 0) { return $matches[$matches.Count - 1].Value }
  return $null
}

Write-Host 'Starting Mini Watch desktop services...'
& (Join-Path $Root 'start-mini-watch-desktop.ps1')

$cloudflared = Find-Cloudflared
if (-not $cloudflared) {
  throw 'cloudflared.exe not found. Put it at C:\Users\Administrator\Documents\Codex\tools\cloudflared.exe first.'
}

$existing = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" |
  Where-Object { $_.CommandLine -like "*--url http://127.0.0.1:$Port*" }

if (-not $existing) {
  Remove-Item -Path $TunnelOut, $TunnelErr -ErrorAction SilentlyContinue
  Write-Host 'Starting public Cloudflare tunnel...'
  Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate') `
    -WindowStyle Hidden `
    -RedirectStandardOutput $TunnelOut `
    -RedirectStandardError $TunnelErr
}
else {
  Write-Host 'Public tunnel is already running.'
}

$publicUrl = $null
for ($i = 0; $i -lt 30; $i += 1) {
  $publicUrl = Read-PublicUrl
  if ($publicUrl) { break }
  Start-Sleep -Seconds 1
}

if (-not $publicUrl) {
  Write-Warning "Tunnel started, but the public URL was not found yet. Check $TunnelErr"
  exit 1
}

$phoneUrl = "$publicUrl/phone"
Set-Content -Path $PublicUrlFile -Value $phoneUrl -Encoding UTF8

Write-Host ''
Write-Host 'Public internet URL:'
Write-Host $phoneUrl
Write-Host ''
Write-Host "Saved to: $PublicUrlFile"
