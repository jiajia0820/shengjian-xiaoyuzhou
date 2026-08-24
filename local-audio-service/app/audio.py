from __future__ import annotations

import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

MAX_BYTES = 1 * 1024 * 1024 * 1024
MAX_DURATION_MS = 2 * 60 * 60 * 1000
SUPPORTED_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".mp4", ".webm"}


@dataclass
class AudioValidationError(Exception):
    code: str

    def __str__(self) -> str:
        return self.code


def probe_duration_ms(path: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        check=False, capture_output=True, text=True, timeout=20,
    )
    try:
        seconds = float(result.stdout.strip())
    except ValueError as error:
        raise AudioValidationError("AUDIO_PROBE_FAILED") from error
    if result.returncode != 0 or not math.isfinite(seconds) or seconds <= 0:
        raise AudioValidationError("AUDIO_PROBE_FAILED")
    return round(seconds * 1000)


def validate_audio_file(path: Path) -> int:
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise AudioValidationError("AUDIO_TYPE_UNSUPPORTED")
    try:
        if path.stat().st_size > MAX_BYTES:
            raise AudioValidationError("AUDIO_TOO_LARGE")
    except FileNotFoundError as error:
        raise AudioValidationError("AUDIO_FILE_MISSING") from error
    duration_ms = probe_duration_ms(path)
    if duration_ms > MAX_DURATION_MS:
        raise AudioValidationError("AUDIO_TOO_LONG")
    return duration_ms
