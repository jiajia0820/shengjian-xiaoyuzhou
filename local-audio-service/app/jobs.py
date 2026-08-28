from __future__ import annotations

import secrets
import shutil
import threading
import time
import math
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

from .audio import AudioValidationError, download_remote_audio
from .engine import DiarizationEngine, ModelSetupError, VoiceprintEngine
from .engine import CHUNK_DURATION_MS
from .models import DiarizationTurn, Job, JobMode, JobSnapshot, VoiceprintReference
from .voiceprint import VoiceprintInputError, validate_voiceprint_reference_bounds


class JobManager:
    def __init__(
        self,
        root: Path,
        engine: DiarizationEngine,
        retention_seconds: int = 15 * 60,
        voiceprint_engine: VoiceprintEngine | None = None,
    ):
        self._root = root
        self._engine = engine
        self._voiceprint_engine = voiceprint_engine or VoiceprintEngine()
        self._retention_seconds = retention_seconds
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speaker-diarization")
        self._futures = {}
        self._root.mkdir(parents=True, exist_ok=True)

    def create_job(
        self,
        expected_speakers: int | None,
        *,
        mode: JobMode = "diarization",
        references: tuple[VoiceprintReference, VoiceprintReference] | None = None,
        source_urls: tuple[str, ...] | None = None,
        allowed_origins: frozenset[str] = frozenset(),
    ) -> JobSnapshot:
        if mode not in {"diarization", "voiceprint"}:
            raise ValueError("JOB_MODE_INVALID")
        if mode == "voiceprint" and references is None:
            raise ValueError("VOICEPRINT_REFERENCES_INVALID")
        if mode == "diarization":
            references = None
        normalized_sources = tuple(url.strip() for url in (source_urls or ()) if isinstance(url, str) and url.strip())
        if len(normalized_sources) > 2:
            raise ValueError("AUDIO_SOURCE_INVALID")
        job_id = secrets.token_urlsafe(18)
        with self._lock:
            while job_id in self._jobs:
                job_id = secrets.token_urlsafe(18)
            (self._root / job_id).mkdir(mode=0o700)
            self._jobs[job_id] = Job(
                id=job_id,
                expected_speakers=expected_speakers,
                source_urls=normalized_sources or None,
                mode=mode,
                references=references,
                allowed_origins=allowed_origins,
            )
            return self.snapshot(job_id)

    def upload_path(self, job_id: str, suffix: str) -> Path:
        if not suffix.startswith(".") or len(suffix) > 10:
            raise KeyError(job_id)
        with self._lock:
            self._job(job_id)
            return self._root / job_id / f"audio{suffix.lower()}"

    def queue(self, job_id: str, source_path: Path, duration_ms: int) -> None:
        with self._lock:
            job = self._job(job_id)
            if job.status != "queued" or not source_path.resolve().is_relative_to((self._root / job_id).resolve()):
                raise ValueError("JOB_NOT_QUEUEABLE")
            job.source_path = str(source_path)
            job.duration_ms = duration_ms

    def run(self, job_id: str) -> None:
        with self._lock:
            job = self._job(job_id)
            if job.cancel_event.is_set() or job.status == "cancelled":
                job.finished_at = time.monotonic()
                return
            if job.status != "queued" or (not job.source_path and not job.source_urls):
                raise ValueError("JOB_NOT_QUEUEABLE")
            job.status = "decoding"
            job.progress = 20
            job.chunk_count = max(1, math.ceil((job.duration_ms or CHUNK_DURATION_MS) / CHUNK_DURATION_MS))
            job.chunk_index = 0
            source_path = Path(job.source_path) if job.source_path else None

        def on_progress(progress: int) -> None:
            with self._lock:
                current = self._jobs.get(job_id)
                if current and current.status == "diarizing":
                    current.progress = max(current.progress, min(90, max(30, progress)))
                    if current.chunk_count:
                        current.chunk_index = min(
                            current.chunk_count,
                            max(0, math.ceil(max(0, current.progress - 35) * current.chunk_count / 55)),
                        )

        try:
            if job.source_urls:
                last_error: AudioValidationError | None = None
                for source_url in job.source_urls:
                    try:
                        source_path, duration_ms = download_remote_audio(
                            source_url,
                            self._root / job_id,
                            allowed_origins=job.allowed_origins,
                            cancel_event=job.cancel_event,
                        )
                        with self._lock:
                            current = self._jobs.get(job_id)
                            if current is None or current.cancel_event.is_set() or current.status == "cancelled":
                                source_path.unlink(missing_ok=True)
                                if current:
                                    current.finished_at = time.monotonic()
                                return
                            current.source_path = str(source_path)
                            current.duration_ms = duration_ms
                            current.chunk_count = max(1, math.ceil(duration_ms / CHUNK_DURATION_MS))
                        break
                    except AudioValidationError as error:
                        last_error = error
                        if error.code in {"AUDIO_TOO_LARGE", "AUDIO_TOO_LONG", "JOB_CANCELLED"}:
                            break
                if source_path is None:
                    raise last_error or AudioValidationError("AUDIO_DOWNLOAD_FAILED")

            with self._lock:
                if self._jobs[job_id].cancel_event.is_set() or self._jobs[job_id].status == "cancelled":
                    self._jobs[job_id].finished_at = time.monotonic()
                    return
                self._jobs[job_id].status = "diarizing"
                self._jobs[job_id].progress = 30
            if source_path is None:
                raise AudioValidationError("AUDIO_FILE_MISSING")
            if job.mode == "voiceprint" and job.references is not None:
                try:
                    validate_voiceprint_reference_bounds(job.references, job.duration_ms or 0)
                except VoiceprintInputError as error:
                    raise ModelSetupError(error.code) from error
            if job.mode == "voiceprint":
                if job.references is None:
                    raise ModelSetupError("VOICEPRINT_REFERENCES_INVALID")
                segments = self._voiceprint_engine.identify(source_path, job.references, on_progress)
            else:
                segments = self._engine.diarize(source_path, job.expected_speakers, on_progress)
            if any(segment.end_ms <= segment.start_ms for segment in segments):
                raise ValueError("DIARIZATION_INVALID")
            with self._lock:
                current = self._jobs[job_id]
                if current.cancel_event.is_set() or current.status == "cancelled":
                    current.finished_at = time.monotonic()
                    return
                current.segments = list(segments)
                current.status = "ready"
                current.progress = 100
                current.finished_at = time.monotonic()
        except AudioValidationError as error:
            with self._lock:
                current = self._jobs.get(job_id)
                if current and current.status != "cancelled":
                    if error.code == "JOB_CANCELLED":
                        current.status = "cancelled"
                    else:
                        current.status = "failed"
                        current.error_code = error.code
                    current.finished_at = time.monotonic()
        except ModelSetupError as error:
            with self._lock:
                current = self._jobs.get(job_id)
                if current and current.status != "cancelled":
                    current.status = "failed"
                    current.error_code = error.code
                    current.finished_at = time.monotonic()
        except Exception:
            with self._lock:
                current = self._jobs.get(job_id)
                if current and current.status != "cancelled":
                    current.status = "failed"
                    current.error_code = "VOICEPRINT_FAILED" if current.mode == "voiceprint" else "DIARIZATION_FAILED"
                    current.finished_at = time.monotonic()

    def start(self, job_id: str) -> None:
        with self._lock:
            job = self._job(job_id)
            if job.status != "queued" or (not job.source_path and not job.source_urls):
                raise ValueError("JOB_NOT_QUEUEABLE")
            if job_id not in self._futures:
                self._futures[job_id] = self._executor.submit(self.run, job_id)

    def wait_for_idle(self, timeout: float | None = None) -> None:
        with self._lock:
            pending = list(self._futures.values())
        if pending:
            wait(pending, timeout=timeout)

    def cancel(self, job_id: str) -> JobSnapshot:
        with self._lock:
            job = self._job(job_id)
            if job.status in {"queued", "decoding", "diarizing"}:
                job.status = "cancelled"
                job.cancel_event.set()
                job.finished_at = time.monotonic()
            return self.snapshot(job_id)

    def snapshot(self, job_id: str) -> JobSnapshot:
        with self._lock:
            job = self._job(job_id)
            return JobSnapshot(
                id=job.id,
                status=job.status,
                progress=job.progress,
                expected_speakers=job.expected_speakers,
                duration_ms=job.duration_ms,
                segments=list(job.segments),
                error_code=job.error_code,
                chunk_index=job.chunk_index,
                chunk_count=job.chunk_count,
                mode=job.mode,
                references=job.references,
            )

    def cleanup_expired(self) -> None:
        now = time.monotonic()
        with self._lock:
            expired = [
                job_id for job_id, job in self._jobs.items()
                if job.finished_at is not None
                and now - job.finished_at >= self._retention_seconds
                and (job_id not in self._futures or self._futures[job_id].done())
            ]
            for job_id in expired:
                self._jobs.pop(job_id, None)
                self._futures.pop(job_id, None)
                shutil.rmtree(self._root / job_id, ignore_errors=True)

    def discard(self, job_id: str) -> None:
        with self._lock:
            future = self._futures.get(job_id)
            if future and not future.done():
                raise ValueError("JOB_RUNNING")
            self._job(job_id)
            self._jobs.pop(job_id, None)
            self._futures.pop(job_id, None)
            shutil.rmtree(self._root / job_id, ignore_errors=True)

    def clear_orphaned_directories(self) -> None:
        with self._lock:
            if self._jobs:
                raise ValueError("JOBS_ACTIVE")
            for child in self._root.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)

    def _job(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if not job:
            raise KeyError(job_id)
        return job
