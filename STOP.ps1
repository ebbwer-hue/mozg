$taskPort = if ($env:PORT) { [int]$env:PORT } else { 4318 }
$taskServerPath = Join-Path $PSScriptRoot 'server.mjs'
foreach ($taskConnection in (Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue)) {
    $taskServerProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskConnection.OwningProcess)
    if ($taskServerProcess.Name -eq 'node.exe' -and $taskServerProcess.CommandLine -like ('*' + $taskServerPath + '*')) {
        Stop-Process -Id $taskConnection.OwningProcess
    }
}
