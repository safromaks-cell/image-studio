param([switch]$StopCurrent)
$ErrorActionPreference = 'Stop'
$studioConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$studioAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$studioExpectedApp = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app.js'))
$studioPorts = @($studioConfig.port,8795,8797,8799) | Select-Object -Unique
$studioToStop = @()
# Check all listeners, including a LAN helper sharing the main port.
# Identify this workspace by its served source and model configuration.
foreach ($studioPort in $studioPorts) {
    $studioConnections = Get-NetTCPConnection -LocalPort $studioPort -State Listen -ErrorAction SilentlyContinue
    foreach ($studioConnection in ($studioConnections | Sort-Object OwningProcess -Unique)) {
        $studioProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($studioConnection.OwningProcess)"
        if ($studioProcess.Name -ne 'node.exe') { throw "Port $studioPort belongs to a different application. Nothing stopped." }
        $studioAddress = if ($studioConnection.LocalAddress -in @('0.0.0.0','::')) { '127.0.0.1' } else { $studioConnection.LocalAddress }
        if ($studioAddress.Contains(':')) { $studioAddress = '[' + $studioAddress + ']' }
        $studioBase = "http://${studioAddress}:$studioPort"
        $studioState = Invoke-RestMethod "$studioBase/api/status" -TimeoutSec 10
        $studioApp = Invoke-WebRequest "$studioBase/app.js" -UseBasicParsing -TimeoutSec 10
        if ($studioState.defaultModel -ne $studioConfig.promptModel -or $studioApp.Content -ne $studioExpectedApp) { throw "Port $studioPort is not serving this Studio workspace. Nothing stopped." }
        if ($studioState.busy) {
            if (!$StopCurrent) { throw "Studio on port $studioPort is generating. Finish or stop the task first. Nothing stopped." }
            Invoke-RestMethod "$studioBase/api/jobs/$($studioState.busy)/cancel" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
            for ($studioWait=0; $studioWait -lt 60; $studioWait++) {
                Start-Sleep -Milliseconds 500
                $studioState=Invoke-RestMethod "$studioBase/api/status" -TimeoutSec 10
                if (!$studioState.busy) { break }
            }
            if ($studioState.busy) { throw 'The generation did not stop in time. Server restart skipped.' }
        }
        $studioToStop += $studioProcess.ProcessId
    }
}
if (!$studioAdministrator -and $studioToStop.Count) { throw 'Run Restart Studio.cmd as administrator to restart all Studio listeners, including the phone helper.' }
foreach ($studioPid in ($studioToStop | Select-Object -Unique)) { Stop-Process -Id $studioPid -ErrorAction Stop }
for ($studioAttempt=0; $studioAttempt -lt 25; $studioAttempt++) {
    if (!(Get-NetTCPConnection -LocalPort $studioConfig.port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 200
}
if ($studioAdministrator) {
    try { & (Join-Path $PSScriptRoot 'Enable Phone Access.ps1') } catch { Write-Warning ('Firewall: ' + $_.Exception.Message) }
}
& (Join-Path $PSScriptRoot 'Start Studio.ps1')