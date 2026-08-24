Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $projectRoot "local-audio-service"
$venvRoot = Join-Path $serviceRoot ".venv"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"

& py -3.12 --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "需要安装 Python 3.12，并确保 py -3.12 可用。"
}

foreach ($command in @("ffmpeg", "ffprobe")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "需要先安装 FFmpeg，并确保 $command 位于 PATH 中。"
    }
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    & py -3.12 -m venv $venvRoot
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
& $venvPython -m pip install -r (Join-Path $serviceRoot "requirements.txt")

Write-Host "本地说话人识别服务已安装。下一步先运行：hf auth login，然后启动 scripts/start-local-speaker-service.ps1。"
