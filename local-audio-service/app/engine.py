from __future__ import annotations

import math
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Callable, Protocol

from .audio import probe_duration_ms
from .models import DiarizationTurn, VoiceprintReference
from .voiceprint import classify_embedding, merge_labeled_windows, validate_voiceprint_reference_bounds

CHUNK_DURATION_MS = 10 * 60 * 1000
CHUNK_OVERLAP_MS = 15 * 1000
VOICEPRINT_WINDOW_MS = 1_500
VOICEPRINT_HOP_MS = 750
VOICEPRINT_MIN_REFERENCE_SPEECH_MS = 3_000
VOICEPRINT_MIN_SIMILARITY = 0.35
VOICEPRINT_MIN_MARGIN = 0.05
VOICEPRINT_MIN_TURN_MS = 750


class DiarizationEngine(Protocol):
    def diarize(
        self,
        path: Path,
        expected_speakers: int | None,
        on_progress: Callable[[int], None],
    ) -> list[DiarizationTurn]: ...


class VoiceprintEncoder(Protocol):
    def embed(self, waveforms: Sequence[object], sample_rate: int) -> list[list[float]]: ...


class SpeechActivityDetector(Protocol):
    def detect(self, waveform: object, sample_rate: int) -> list[tuple[int, int]]: ...


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


def _requested_device():
    requested = os.environ.get("SPEAKER_DEVICE", "auto").strip().lower()
    if requested not in {"auto", "cpu", "cuda"}:
        requested = "auto"
    try:
        import torch
    except ImportError:
        return None, "cpu"
    if requested == "cpu" or (requested == "auto" and not torch.cuda.is_available()):
        return torch.device("cpu"), "cpu"
    if requested == "cuda" or torch.cuda.is_available():
        return torch.device("cuda"), "cuda"
    return torch.device("cpu"), "cpu"


def _move_model_to_requested_device(model) -> str:
    device, device_name = _requested_device()
    if device is None or device_name == "cpu":
        return "cpu"
    try:
        model.to(device)
        return "cuda"
    except Exception:
        try:
            model.to("cpu")
        except Exception:
            pass
        return "cpu"


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
        self._device = _move_model_to_requested_device(self._pipeline)

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


class EnergySpeechActivityDetector:
    """Small local VAD that filters silence before expensive embeddings."""

    def detect(self, waveform: object, sample_rate: int) -> list[tuple[int, int]]:
        try:
            import numpy as np
        except ImportError:
            return []
        values = waveform
        if hasattr(values, "detach"):
            values = values.detach().float().cpu().numpy()
        values = np.asarray(values, dtype=np.float32).reshape(-1)
        if sample_rate <= 0 or values.size == 0:
            return []
        frame_samples = max(1, round(sample_rate * 0.03))
        frame_count = math.ceil(values.size / frame_samples)
        rms: list[float] = []
        for index in range(frame_count):
            frame = values[index * frame_samples:(index + 1) * frame_samples]
            rms.append(float(np.sqrt(np.mean(np.square(frame), dtype=np.float64))))
        peak = max(rms, default=0.0)
        if peak <= 1e-5:
            return []
        noise_floor = float(np.percentile(np.asarray(rms), 20))
        threshold = max(1e-4, noise_floor * 2.5, peak * 0.08)
        active = [level >= threshold for level in rms]
        intervals: list[tuple[int, int]] = []
        start_frame: int | None = None
        max_gap_frames = max(1, round(0.3 / 0.03))
        gap_frames = 0
        for index, is_active in enumerate(active + [False]):
            if is_active:
                if start_frame is None:
                    start_frame = index
                gap_frames = 0
                continue
            if start_frame is None:
                continue
            gap_frames += 1
            if gap_frames <= max_gap_frames and index < len(active):
                continue
            start_ms = start_frame * 30
            end_ms = min(values.size * 1000 // sample_rate, index * 30)
            if end_ms - start_ms >= 300:
                intervals.append((start_ms, end_ms))
            start_frame = None
            gap_frames = 0
        return intervals


class _WespeakerEncoder:
    def __init__(self, token: str):
        try:
            import torch
            from pyannote.audio import Model
        except ImportError as error:
            raise ModelSetupError("VOICEPRINT_MODEL_UNAVAILABLE") from error
        try:
            self._torch = torch
            self._model = Model.from_pretrained(
                "pyannote/wespeaker-voxceleb-resnet34-LM",
                token=token,
            )
            self._device = _move_model_to_requested_device(self._model)
            self._torch_device = torch.device(self._device)
            self._model.eval()
        except ModelSetupError:
            raise
        except Exception as error:
            raise ModelSetupError("VOICEPRINT_MODEL_UNAVAILABLE") from error

    @property
    def device(self) -> str:
        return self._device

    def embed(self, waveforms: Sequence[object], sample_rate: int) -> list[list[float]]:
        if not waveforms:
            return []
        torch = self._torch
        tensors = []
        for waveform in waveforms:
            tensor = waveform if isinstance(waveform, torch.Tensor) else torch.as_tensor(waveform)
            tensor = tensor.detach().float().reshape(-1)
            tensors.append(tensor)
        batch = torch.nn.utils.rnn.pad_sequence(tensors, batch_first=True).unsqueeze(1)
        batch = batch.to(self._torch_device)
        with torch.inference_mode():
            output = self._model(batch)
        if isinstance(output, tuple):
            output = output[0]
        if output.ndim == 3:
            output = output.mean(dim=1)
        if output.ndim != 2:
            raise ModelSetupError("VOICEPRINT_MODEL_UNAVAILABLE")
        output = torch.nn.functional.normalize(output, p=2, dim=-1)
        return output.detach().cpu().tolist()


def _waveform_slice(waveform: object, sample_rate: int, start_ms: int, end_ms: int):
    start = max(0, round(start_ms * sample_rate / 1000))
    end = max(start + 1, round(end_ms * sample_rate / 1000))
    if hasattr(waveform, "ndim") and waveform.ndim > 1:
        return waveform[..., start:end]
    return waveform[start:end]


def _speech_windows(
    waveform: object,
    sample_rate: int,
    intervals: Sequence[tuple[int, int]],
    *,
    window_ms: int = VOICEPRINT_WINDOW_MS,
    hop_ms: int = VOICEPRINT_HOP_MS,
) -> list[tuple[int, int, object]]:
    windows: list[tuple[int, int, object]] = []
    for interval_start, interval_end in intervals:
        start = max(0, int(interval_start))
        end = max(start, int(interval_end))
        if end - start < window_ms:
            continue
        cursor = start
        while cursor + window_ms <= end:
            windows.append((cursor, cursor + window_ms, _waveform_slice(waveform, sample_rate, cursor, cursor + window_ms)))
            cursor += hop_ms
        if not windows or windows[-1][1] < end:
            final_start = max(start, end - window_ms)
            if not windows or windows[-1][0] != final_start:
                windows.append((final_start, end, _waveform_slice(waveform, sample_rate, final_start, end)))
    return windows


def _average_embeddings(embeddings: Sequence[Sequence[float]]) -> list[float] | None:
    if not embeddings:
        return None
    dimension = len(embeddings[0])
    if dimension == 0 or any(len(embedding) != dimension for embedding in embeddings):
        return None
    values = [sum(float(embedding[index]) for embedding in embeddings) / len(embeddings) for index in range(dimension)]
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm <= 0:
        return None
    return [value / norm for value in values]


class VoiceprintEngine:
    def __init__(
        self,
        *,
        vad: SpeechActivityDetector | None = None,
        encoder: VoiceprintEncoder | None = None,
    ):
        self._vad = vad or EnergySpeechActivityDetector()
        self._encoder = encoder
        self._device = getattr(encoder, "device", "cpu") if encoder is not None else "cpu"

    def model_status(self) -> str:
        if self._encoder is not None:
            return "ready"
        return "unloaded" if _get_huggingface_token() else "needs_setup"

    def device_status(self) -> str:
        return self._device

    def _ensure_encoder(self) -> VoiceprintEncoder:
        if self._encoder is not None:
            return self._encoder
        token = _get_huggingface_token()
        if not token:
            raise ModelSetupError("HF_TOKEN_MISSING")
        self._encoder = _WespeakerEncoder(token)
        self._device = getattr(self._encoder, "device", "cpu")
        return self._encoder

    def identify(
        self,
        path: Path,
        references: tuple[VoiceprintReference, VoiceprintReference],
        on_progress: Callable[[int], None],
    ) -> list[DiarizationTurn]:
        encoder = self._ensure_encoder()
        duration_ms = probe_duration_ms(path)
        validate_voiceprint_reference_bounds(references, duration_ms)
        on_progress(35)

        centers: dict[str, list[float]] = {}
        for reference in references:
            samples = _decode_audio_range(path, reference.start_ms, reference.end_ms)
            intervals = self._vad.detect(samples.data, samples.sample_rate)
            active_ms = sum(max(0, end - start) for start, end in intervals)
            if active_ms < VOICEPRINT_MIN_REFERENCE_SPEECH_MS:
                raise ModelSetupError("VOICEPRINT_REFERENCES_TOO_SHORT")
            windows = _speech_windows(samples.data, samples.sample_rate, intervals)
            embeddings = encoder.embed([window[2] for window in windows], samples.sample_rate)
            center = _average_embeddings(embeddings)
            if center is None:
                raise ModelSetupError("VOICEPRINT_REFERENCES_TOO_SHORT")
            centers[reference.speaker_id] = center

        chunk_count = max(1, (duration_ms + CHUNK_DURATION_MS - 1) // CHUNK_DURATION_MS)
        all_turns: list[DiarizationTurn] = []
        for chunk_index in range(chunk_count):
            core_start_ms = chunk_index * CHUNK_DURATION_MS
            core_end_ms = min(duration_ms, core_start_ms + CHUNK_DURATION_MS)
            input_start_ms = max(0, core_start_ms - CHUNK_OVERLAP_MS)
            input_end_ms = min(duration_ms, core_end_ms + CHUNK_OVERLAP_MS)
            samples = _decode_audio_range(path, input_start_ms, input_end_ms)
            intervals = self._vad.detect(samples.data, samples.sample_rate)
            windows = _speech_windows(samples.data, samples.sample_rate, intervals)
            embeddings = encoder.embed([window[2] for window in windows], samples.sample_rate)
            labeled_windows: list[tuple[int, int, str | None]] = []
            for window, embedding in zip(windows, embeddings):
                label = classify_embedding(
                    embedding,
                    centers,
                    min_similarity=VOICEPRINT_MIN_SIMILARITY,
                    min_margin=VOICEPRINT_MIN_MARGIN,
                )
                labeled_windows.append((
                    input_start_ms + window[0],
                    input_start_ms + window[1],
                    label,
                ))
            chunk_turns = merge_labeled_windows(
                labeled_windows,
                hop_ms=VOICEPRINT_HOP_MS,
                min_turn_ms=VOICEPRINT_MIN_TURN_MS,
            )
            for turn in chunk_turns:
                start_ms = max(core_start_ms, turn.start_ms)
                end_ms = min(core_end_ms, turn.end_ms)
                if end_ms > start_ms:
                    all_turns.append(DiarizationTurn(start_ms, end_ms, turn.speaker_id))
            on_progress(35 + ((chunk_index + 1) * 55 // chunk_count))

        if not all_turns:
            raise ModelSetupError("VOICEPRINT_LOW_CONFIDENCE")
        return all_turns
