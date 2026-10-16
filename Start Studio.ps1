$ErrorActionPreference = 'Stop'
$studioConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$studioUrl = 'http://127.0.0.1:' + $studioConfig.port
$studioNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (!$studioNode) { $studioNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (!(Test-Path -LiteralPath $studioNode)) { throw 'Node.js not found.' }
$studioExisting = $null
try { $studioExisting = Invoke-RestMethod "$studioUrl/api/status" -TimeoutSec 5 } catch {}
if ($studioExisting) {
    if (!$studioExisting.gracefulStop) { throw 'An older Studio server is running. Use Restart Studio.cmd to apply the update.' }
    Start-Process $studioUrl
    exit
}
Start-Process -FilePath $studioNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
for ($studioAttempt = 0; $studioAttempt -lt 30; $studioAttempt++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod "$studioUrl/api/status" -TimeoutSec 2 | Out-Null; Start-Process $studioUrl; exit } catch {}
}
throw 'Studio did not start. Check server-error.log.'
