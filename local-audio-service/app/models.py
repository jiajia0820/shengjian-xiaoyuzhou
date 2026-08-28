from __future__ import annotations

from dataclasses import dataclass, field
from threading import Event
from typing import Literal

JobStatus = Literal["queued", "decoding", "diarizing", "ready", "failed", "cancelled"]
JobMode = Literal["diarization", "voiceprint"]


@dataclass(frozen=True)
class DiarizationTurn:
    start_ms: int
    end_ms: int
    speaker_id: str


@dataclass(frozen=True)
class VoiceprintReference:
    speaker_id: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class JobSnapshot:
    id: str
    status: JobStatus
    progress: int
    expected_speakers: int | None
    duration_ms: int | None
    segments: list[DiarizationTurn]
    error_code: str | None
    chunk_index: int = 0
    chunk_count: int = 0
    mode: JobMode = "diarization"
    references: tuple[VoiceprintReference, VoiceprintReference] | None = None


@dataclass
class Job:
    id: str
    expected_speakers: int | None
    source_urls: tuple[str, ...] | None = None
    allowed_origins: frozenset[str] = field(default_factory=frozenset)
    mode: JobMode = "diarization"
    references: tuple[VoiceprintReference, VoiceprintReference] | None = None
    status: JobStatus = "queued"
    progress: int = 0
    duration_ms: int | None = None
    source_path: str | None = None
    segments: list[DiarizationTurn] = field(default_factory=list)
    error_code: str | None = None
    chunk_index: int = 0
    chunk_count: int = 0
    finished_at: float | None = None
    cancel_event: Event = field(default_factory=Event, repr=False)
