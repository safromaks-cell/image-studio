$ErrorActionPreference = 'Stop'
$studioConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$studioRuleName = 'Qwen-Image-Studio-LAN-' + $studioConfig.port
$studioNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (!$studioNode) { $studioNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$studioRule = Get-NetFirewallRule -Name $studioRuleName -ErrorAction SilentlyContinue
if (!$studioRule) {
    New-NetFirewallRule -Name $studioRuleName -DisplayName 'Qwen Image Studio - phone on local network' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $studioConfig.port -Program $studioNode -Profile Any -RemoteAddress LocalSubnet -ErrorAction Stop | Out-Null
}
else {
    Set-NetFirewallRule -Name $studioRuleName -Enabled True -Profile Any -Direction Inbound -Action Allow -RemoteAddress LocalSubnet -ErrorAction Stop | Out-Null
    $studioRule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $studioNode -ErrorAction Stop | Out-Null
}
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } | ForEach-Object { Write-Host ('Phone URL: http://' + $_.IPAddress + ':' + $studioConfig.port) }
