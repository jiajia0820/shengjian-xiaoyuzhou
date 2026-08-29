Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $projectRoot "local-audio-service"
$python = Join-Path $serviceRoot ".venv/Scripts/python.exe"

# pyannote.audio 4 uses torchcodec, which needs FFmpeg shared DLLs on Windows.
# Prefer the project-local shared build downloaded during setup when present.
$defaultFfmpegSharedBin = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $projectRoot))) "ffmpeg-shared/ffmpeg-master-latest-win64-gpl-shared/bin"
if (-not $env:FFMPEG_SHARED_BIN -and (Test-Path -Path (Join-Path $defaultFfmpegSharedBin "avcodec-*.dll"))) {
    $env:FFMPEG_SHARED_BIN = $defaultFfmpegSharedBin
}

# The dev server falls back from port 3000 to 3001 when 3000 is occupied.
# Trust both explicit local origins while keeping the service loopback-only.
if (-not $env:SPEAKER_ALLOWED_ORIGINS) {
    $env:SPEAKER_ALLOWED_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001"
}
$env:MPLCONFIGDIR = Join-Path $serviceRoot ".matplotlib"
New-Item -ItemType Directory -Force -Path $env:MPLCONFIGDIR | Out-Null
if (-not $env:SPEAKER_DEVICE) {
    $env:SPEAKER_DEVICE = "auto"
}

if (-not (Test-Path -LiteralPath $python)) {
    throw "Local speaker service is not installed. Run scripts/setup-local-speaker-service.ps1 first."
}

Push-Location $serviceRoot
try {
    & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
}
finally {
    Pop-Location
}
