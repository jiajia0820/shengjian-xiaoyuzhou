from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Protocol

from .models import DiarizationTurn


class DiarizationEngine(Protocol):
    def diarize(
        self,
        path: Path,
        expected_speakers: int | None,
        on_progress: Callable[[int], None],
    ) -> list[DiarizationTurn]: ...


class ModelSetupError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _get_huggingface_token() -> str | None:
    configured = os.environ.get("HF_TOKEN", "").strip()
    if configured:
        return configured
    try:
        from huggingface_hub import get_token
    except ImportError:
        return None
    return get_token() or None


def _load_pipeline(token: str):
    try:
        from pyannote.audio import Pipeline
    except ImportError as error:
        raise ModelSetupError("PYANNOTE_UNAVAILABLE") from error
    try:
        return Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=token)
    except Exception as error:
        raise ModelSetupError("PYANNOTE_MODEL_UNAVAILABLE") from error


class PyannoteCommunityEngine:
    def __init__(self):
        self._pipeline = None

    def model_status(self) -> str:
        if self._pipeline is not None:
            return "ready"
        return "unloaded" if _get_huggingface_token() else "needs_setup"

    def diarize(
        self,
        path: Path,
        expected_speakers: int | None,
        on_progress: Callable[[int], None],
    ) -> list[DiarizationTurn]:
        token = _get_huggingface_token()
        if not token:
            raise ModelSetupError("HF_TOKEN_MISSING")

        if self._pipeline is None:
            self._pipeline = _load_pipeline(token)
            self._move_to_requested_device()

        on_progress(35)
        kwargs = {"num_speakers": expected_speakers} if expected_speakers is not None else {}
        output = self._pipeline(str(path), **kwargs)
        on_progress(90)
        return self._normalize_turns(output.exclusive_speaker_diarization)

    def _move_to_requested_device(self) -> None:
        if os.environ.get("SPEAKER_DEVICE", "").strip().lower() != "cuda":
            return
        try:
            import torch
        except ImportError:
            return
        if torch.cuda.is_available():
            self._pipeline.to(torch.device("cuda"))

    @staticmethod
    def _normalize_turns(annotation) -> list[DiarizationTurn]:
        raw_turns: list[tuple[int, int, str]] = []
        for segment, _, label in annotation.itertracks(yield_label=True):
            start_ms = round(float(segment.start) * 1000)
            end_ms = round(float(segment.end) * 1000)
            if start_ms < 0 or end_ms <= start_ms:
                continue
            raw_turns.append((start_ms, end_ms, str(label)))

        raw_turns.sort(key=lambda turn: (turn[0], turn[1], turn[2]))
        speaker_ids: dict[str, str] = {}
        normalized: list[DiarizationTurn] = []
        for start_ms, end_ms, original_label in raw_turns:
            speaker_id = speaker_ids.setdefault(original_label, f"speaker_{len(speaker_ids)}")
            normalized.append(DiarizationTurn(start_ms=start_ms, end_ms=end_ms, speaker_id=speaker_id))
        return normalized
