$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
$runtimePython = Join-Path $projectRoot '.venv-runtime\Scripts\python.exe'
if (Test-Path -LiteralPath $runtimePython) { $pythonPath = $runtimePython }
$vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $pythonPath) -or -not (Test-Path -LiteralPath $vitePath)) {
    throw 'Install the Python and Node dependencies described in README.md first.'
}
& $pythonPath -c 'import sys, ssl; assert sys.version_info >= (3,10), "Python 3.10+ is required"'
if ($LASTEXITCODE -ne 0) { throw 'The Python environment is incompatible. Follow the clean environment setup in README.md.' }

function Find-FreePort([int]$firstPort) {
    $candidatePort = $firstPort
    while (Get-NetTCPConnection -LocalPort $candidatePort -State Listen -ErrorAction SilentlyContinue) {
        $candidatePort++
    }
    return $candidatePort
}

$backendPort = Find-FreePort 8001
$frontendPort = Find-FreePort 5173
$logDirectory = Join-Path $projectRoot '.rag-data'
New-Item -Path $logDirectory -ItemType Directory -Force | Out-Null
Start-Process -FilePath $pythonPath -ArgumentList '-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',$backendPort -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "backend-$backendPort.out.log") -RedirectStandardError (Join-Path $logDirectory "backend-$backendPort.err.log")
$previousProxyTarget = $env:API_PROXY_TARGET
try {
    $env:API_PROXY_TARGET = "http://127.0.0.1:$backendPort"
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    Start-Process -FilePath $nodePath -ArgumentList ('"' + $vitePath + '"'),'--host','127.0.0.1','--port',$frontendPort,'--strictPort' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "frontend-$frontendPort.out.log") -RedirectStandardError (Join-Path $logDirectory "frontend-$frontendPort.err.log")
} finally {
    $env:API_PROXY_TARGET = $previousProxyTarget
}
Write-Output "Atlas: http://127.0.0.1:$frontendPort/"
Write-Output "Backend: http://127.0.0.1:$backendPort/api/health"
