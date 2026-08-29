Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $projectRoot "local-audio-service"
$venvRoot = Join-Path $serviceRoot ".venv"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"

& py -3.12 --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.12 is required and py -3.12 must be available."
}

foreach ($command in @("ffmpeg", "ffprobe")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "FFmpeg command '$command' must be installed and available on PATH."
    }
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    & py -3.12 -m venv $venvRoot
}

& $venvPython -m pip install --upgrade pip
$torchIndexUrl = $env:SPEAKER_TORCH_INDEX_URL
if (-not $torchIndexUrl) {
    $torchIndexUrl = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        "https://download.pytorch.org/whl/cu128"
    } else {
        "https://download.pytorch.org/whl/cpu"
    }
}
$wantsCuda = $torchIndexUrl -match "/cu[0-9]+"
$installedTorchCuda = ""
if (Test-Path -LiteralPath $venvPython) {
    $detectedTorchCuda = & $venvPython -c "import torch; print(torch.version.cuda or '')" 2>$null
    if ($LASTEXITCODE -eq 0 -and $detectedTorchCuda) {
        $installedTorchCuda = ($detectedTorchCuda | Select-Object -Last 1).Trim()
    }
}
if ($wantsCuda -and -not $installedTorchCuda) {
    & $venvPython -m pip uninstall -y torch torchaudio
}
& $venvPython -m pip install --upgrade torch torchaudio --index-url $torchIndexUrl
& $venvPython -m pip install -r (Join-Path $serviceRoot "requirements.txt")

Write-Host "Local speaker service installed with torch index $torchIndexUrl. Run '.\\local-audio-service\\.venv\\Scripts\\hf.exe auth login' and then scripts/start-local-speaker-service.ps1."
