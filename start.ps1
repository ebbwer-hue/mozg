$ErrorActionPreference = 'Stop'
$taskNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) {
    $taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $taskNodeCommand) { throw 'Install Node.js 22 or newer: https://nodejs.org' }
    $taskNode = $taskNodeCommand.Source
}
Set-Location -LiteralPath $PSScriptRoot
$taskPort = if ($env:PORT) { [int]$env:PORT } else { 4318 }
$taskUrl = 'http://127.0.0.1:' + $taskPort
try {
    $taskResponse = Invoke-WebRequest -Uri $taskUrl -TimeoutSec 2 -UseBasicParsing
    if ($taskResponse.Content -match 'session-token') { Start-Process $taskUrl; exit }
    throw 'Port is used by another application. Set PORT to another value.'
} catch [System.Net.WebException] {
    # Start the application when the local server is not running.
}
$taskServerPath = Join-Path $PSScriptRoot 'server.mjs'
$taskEnvPath = Join-Path $PSScriptRoot '.env.local'
$taskNodeArguments = if (Test-Path -LiteralPath $taskEnvPath) { '--env-file="' + $taskEnvPath + '" "' + $taskServerPath + '"' } else { '"' + $taskServerPath + '"' }
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskNodeArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 200
    if ($taskProcess.HasExited) { throw 'Server failed to start. Run node server.mjs to see details.' }
    try {
        $taskReady = Invoke-WebRequest -Uri $taskUrl -TimeoutSec 1 -UseBasicParsing
        if ($taskReady.StatusCode -eq 200) { Start-Process $taskUrl; exit }
    } catch { }
}
throw 'Could not start the application.'
