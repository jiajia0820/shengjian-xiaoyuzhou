from __future__ import annotations

import json
from collections.abc import Mapping

from .models import VoiceprintReference

MIN_REFERENCE_MS = 10_000
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
