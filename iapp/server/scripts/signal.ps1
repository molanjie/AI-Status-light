param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('working', 'idle', 'attention', 'permission', 'interrupted', 'error')]
  [string]$State,

  [string]$SessionId = 'codex',
  [string]$BaseUrl = 'http://127.0.0.1:3001'
)

$signal = switch ($State) {
  'idle' { 'off' }
  default { $State }
}

$body = @{
  signal = $signal
  session_id = $SessionId
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/api/signal-light/state" `
  -ContentType 'application/json' `
  -Body $body
