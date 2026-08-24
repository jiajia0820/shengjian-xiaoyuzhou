Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $projectRoot "local-audio-service"
$python = Join-Path $serviceRoot ".venv/Scripts/python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "本地服务尚未安装。请先运行 scripts/setup-local-speaker-service.ps1。"
}

Push-Location $serviceRoot
try {
    & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
}
finally {
    Pop-Location
}
