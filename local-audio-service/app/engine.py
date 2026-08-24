from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Protocol

from .audio import probe_duration_ms
from .models import DiarizationTurn

CHUNK_DURATION_MS = 10 * 60 * 1000
CHUNK_OVERLAP_MS = 15 * 1000


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


def _decode_audio_range(path: Path, start_ms: int, end_ms: int):
    try:
        from torchcodec.decoders import AudioDecoder
    except ImportError as error:
        raise ModelSetupError("TORCHCODEC_UNAVAILABLE") from error
    decoder = AudioDecoder(str(path), sample_rate=16_000, num_channels=1)
    return decoder.get_samples_played_in_range(
        start_seconds=start_ms / 1000,
        stop_seconds=end_ms / 1000,
    )


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
    shared_bin = os.environ.get("FFMPEG_SHARED_BIN", "").strip()
    if shared_bin and os.path.isdir(shared_bin):
        # Windows does not reliably resolve FFmpeg DLLs from PATH for ctypes.
        # Register the directory explicitly before torchcodec is first used.
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(shared_bin)
        os.environ["PATH"] = shared_bin + os.pathsep + os.environ.get("PATH", "")
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
        self._device = "cpu"

    def model_status(self) -> str:
        if self._pipeline is not None:
            return "ready"
        return "unloaded" if _get_huggingface_token() else "needs_setup"

    def device_status(self) -> str:
        return self._device

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

        duration_ms = probe_duration_ms(path)
        chunk_count = max(1, (duration_ms + CHUNK_DURATION_MS - 1) // CHUNK_DURATION_MS)
        on_progress(35)
        kwargs = {"num_speakers": expected_speakers} if expected_speakers is not None else {}
        all_turns: list[DiarizationTurn] = []
        next_speaker_index = 0

        for chunk_index in range(chunk_count):
            core_start_ms = chunk_index * CHUNK_DURATION_MS
            core_end_ms = min(duration_ms, core_start_ms + CHUNK_DURATION_MS)
            input_start_ms = max(0, core_start_ms - CHUNK_OVERLAP_MS)
            input_end_ms = min(duration_ms, core_end_ms + CHUNK_OVERLAP_MS)
            samples = _decode_audio_range(path, input_start_ms, input_end_ms)
            file = {
                "waveform": samples.data,
                "sample_rate": samples.sample_rate,
                "uri": f"{path.stem}-chunk-{chunk_index}",
            }
            output = self._pipeline(file, **kwargs)
            local_turns = self._normalize_turns(output.exclusive_speaker_diarization)
            absolute_turns = [
                DiarizationTurn(
                    start_ms=turn.start_ms + input_start_ms,
                    end_ms=turn.end_ms + input_start_ms,
                    speaker_id=turn.speaker_id,
                )
                for turn in local_turns
            ]
            mapped_turns, next_speaker_index = self._map_chunk_speakers(
                absolute_turns, all_turns, next_speaker_index,
            )
            for turn in mapped_turns:
                start_ms = max(core_start_ms, turn.start_ms)
                end_ms = min(core_end_ms, turn.end_ms)
                if end_ms > start_ms:
                    all_turns.append(DiarizationTurn(start_ms, end_ms, turn.speaker_id))
            on_progress(35 + ((chunk_index + 1) * 55 // chunk_count))

        return all_turns

    @staticmethod
    def _map_chunk_speakers(
        chunk_turns: list[DiarizationTurn],
        previous_turns: list[DiarizationTurn],
        next_speaker_index: int,
    ) -> tuple[list[DiarizationTurn], int]:
        grouped: dict[str, list[DiarizationTurn]] = {}
        for turn in chunk_turns:
            grouped.setdefault(turn.speaker_id, []).append(turn)

        local_to_global: dict[str, str] = {}
        used_global: set[str] = set()
        known_global = {turn.speaker_id for turn in previous_turns}
        for local_id, local_turns in grouped.items():
            overlap_by_global: dict[str, int] = {}
            for local_turn in local_turns:
                for previous_turn in previous_turns:
                    overlap = min(local_turn.end_ms, previous_turn.end_ms) - max(local_turn.start_ms, previous_turn.start_ms)
                    if overlap > 0:
                        overlap_by_global[previous_turn.speaker_id] = overlap_by_global.get(previous_turn.speaker_id, 0) + overlap
            candidates = [
                (overlap, speaker_id)
                for speaker_id, overlap in overlap_by_global.items()
                if speaker_id not in used_global and overlap > 0
            ]
            if candidates:
                _, global_id = max(candidates, key=lambda candidate: (candidate[0], candidate[1]))
            else:
                while f"speaker_{next_speaker_index}" in known_global:
                    next_speaker_index += 1
                global_id = f"speaker_{next_speaker_index}"
                next_speaker_index += 1
                known_global.add(global_id)
            local_to_global[local_id] = global_id
            used_global.add(global_id)

        return [
            DiarizationTurn(turn.start_ms, turn.end_ms, local_to_global[turn.speaker_id])
            for turn in chunk_turns
        ], next_speaker_index

    def _move_to_requested_device(self) -> None:
        requested = os.environ.get("SPEAKER_DEVICE", "auto").strip().lower()
        if requested not in {"auto", "cpu", "cuda"}:
            requested = "auto"
        self._device = "cpu"
        if requested == "cpu":
            return
        try:
            import torch
        except ImportError:
            return
        if not torch.cuda.is_available():
            return
        try:
            self._pipeline.to(torch.device("cuda"))
            self._device = "cuda"
        except Exception:
            try:
                self._pipeline.to(torch.device("cpu"))
            except Exception:
                pass

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
