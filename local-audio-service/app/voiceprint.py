from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Sequence

from .models import DiarizationTurn, VoiceprintReference

MIN_REFERENCE_MS = 5_000
MAX_REFERENCE_MS = 30_000
VOICEPRINT_SPEAKERS = ("speaker_0", "speaker_1")


class VoiceprintInputError(ValueError):
    def __init__(self, code: str = "VOICEPRINT_REFERENCES_INVALID"):
        super().__init__(code)
        self.code = code


def _invalid() -> VoiceprintInputError:
    return VoiceprintInputError()


def _is_non_negative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def parse_voiceprint_references(value: str | None) -> tuple[VoiceprintReference, VoiceprintReference]:
    if not isinstance(value, str) or not value.strip():
        raise _invalid()
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise _invalid() from error
    if not isinstance(parsed, dict) or set(parsed) != set(VOICEPRINT_SPEAKERS):
        raise _invalid()

    references: list[VoiceprintReference] = []
    for speaker_id in VOICEPRINT_SPEAKERS:
        entry = parsed.get(speaker_id)
        if not isinstance(entry, Mapping) or set(entry) != {"startMs", "endMs"}:
            raise _invalid()
        start_ms = entry.get("startMs")
        end_ms = entry.get("endMs")
        if not _is_non_negative_integer(start_ms) or not _is_non_negative_integer(end_ms):
            raise _invalid()
        if end_ms <= start_ms or not MIN_REFERENCE_MS <= end_ms - start_ms <= MAX_REFERENCE_MS:
            raise _invalid()
        references.append(VoiceprintReference(speaker_id, start_ms, end_ms))

    first, second = references
    if first.start_ms < second.end_ms and second.start_ms < first.end_ms:
        raise _invalid()
    return first, second


def validate_voiceprint_reference_bounds(
    references: tuple[VoiceprintReference, VoiceprintReference],
    duration_ms: int,
) -> None:
    if not _is_non_negative_integer(duration_ms) or duration_ms <= 0:
        raise _invalid()
    if any(reference.end_ms > duration_ms for reference in references):
        raise _invalid()


def _normalized(values: Sequence[float]) -> list[float] | None:
    try:
        numbers = [float(value) for value in values]
    except (TypeError, ValueError):
        return None
    norm = math.sqrt(sum(value * value for value in numbers))
    if not math.isfinite(norm) or norm <= 0:
        return None
    return [value / norm for value in numbers]


def _cosine(left: Sequence[float], right: Sequence[float]) -> float | None:
    normalized_left = _normalized(left)
    normalized_right = _normalized(right)
    if normalized_left is None or normalized_right is None or len(normalized_left) != len(normalized_right):
        return None
    return sum(a * b for a, b in zip(normalized_left, normalized_right))


def classify_embedding(
    embedding: Sequence[float],
    centers: Mapping[str, Sequence[float]],
    *,
    min_similarity: float,
    min_margin: float,
) -> str | None:
    if set(centers) != set(VOICEPRINT_SPEAKERS):
        return None
    scores: list[tuple[float, str]] = []
    for speaker_id in VOICEPRINT_SPEAKERS:
        score = _cosine(embedding, centers[speaker_id])
        if score is None:
            return None
        scores.append((score, speaker_id))
    scores.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best_score, best_speaker = scores[0]
    second_score = scores[1][0]
    if best_score < min_similarity or best_score - second_score < min_margin:
        return None
    return best_speaker


def _merge_same_label(
    windows: Sequence[tuple[int, int, str | None]],
    join_gap_ms: int,
) -> list[DiarizationTurn]:
    labeled = sorted(
        (
            int(start_ms),
            int(end_ms),
            speaker_id,
        )
        for start_ms, end_ms, speaker_id in windows
        if speaker_id in VOICEPRINT_SPEAKERS and int(end_ms) > int(start_ms)
    )
    merged: list[DiarizationTurn] = []
    for start_ms, end_ms, speaker_id in labeled:
        current = DiarizationTurn(start_ms, end_ms, speaker_id)
        previous = merged[-1] if merged else None
        if previous and previous.speaker_id == speaker_id and start_ms <= previous.end_ms + join_gap_ms:
            merged[-1] = DiarizationTurn(previous.start_ms, max(previous.end_ms, end_ms), speaker_id)
        else:
            merged.append(current)
    return merged


def merge_labeled_windows(
    windows: Sequence[tuple[int, int, str | None]],
    *,
    hop_ms: int,
    min_turn_ms: int,
) -> list[DiarizationTurn]:
    if hop_ms <= 0 or min_turn_ms <= 0:
        return []
    merged = _merge_same_label(windows, hop_ms)
    if not merged:
        return []

    resolved: list[DiarizationTurn] = []
    for current in merged:
        if resolved and current.start_ms < resolved[-1].end_ms:
            boundary = (resolved[-1].end_ms + current.start_ms) // 2
            if boundary <= resolved[-1].start_ms:
                resolved.pop()
            else:
                resolved[-1] = DiarizationTurn(resolved[-1].start_ms, boundary, resolved[-1].speaker_id)
            if resolved and boundary >= current.end_ms:
                continue
            current = DiarizationTurn(boundary, current.end_ms, current.speaker_id)
        resolved.append(current)

    stable: list[DiarizationTurn] = []
    for index, current in enumerate(resolved):
        if current.end_ms - current.start_ms >= min_turn_ms:
            stable.append(current)
            continue
        previous = stable[-1] if stable else None
        following = resolved[index + 1] if index + 1 < len(resolved) else None
        if previous and following and previous.speaker_id == following.speaker_id:
            stable[-1] = DiarizationTurn(previous.start_ms, following.end_ms, previous.speaker_id)
        elif previous and not following:
            stable[-1] = DiarizationTurn(previous.start_ms, current.end_ms, previous.speaker_id)
        elif following and not previous:
            resolved[index + 1] = DiarizationTurn(current.start_ms, following.end_ms, following.speaker_id)

    return [turn for turn in stable if turn.end_ms > turn.start_ms]
