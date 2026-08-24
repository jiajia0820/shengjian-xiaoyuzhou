from __future__ import annotations

import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

from .engine import DiarizationEngine, ModelSetupError
from .models import DiarizationTurn, Job, JobSnapshot


class JobManager:
    def __init__(self, root: Path, engine: DiarizationEngine, retention_seconds: int = 15 * 60):
        self._root = root
        self._engine = engine
        self._retention_seconds = retention_seconds
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speaker-diarization")
        self._futures = {}
        self._root.mkdir(parents=True, exist_ok=True)

    def create_job(self, expected_speakers: int | None) -> JobSnapshot:
        job_id = secrets.token_urlsafe(18)
        with self._lock:
            while job_id in self._jobs:
                job_id = secrets.token_urlsafe(18)
            (self._root / job_id).mkdir(mode=0o700)
            self._jobs[job_id] = Job(id=job_id, expected_speakers=expected_speakers)
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
            if job.status != "queued" or not job.source_path:
                raise ValueError("JOB_NOT_QUEUEABLE")
            job.status = "decoding"
            job.progress = 20
            source_path = Path(job.source_path)

        def on_progress(progress: int) -> None:
            with self._lock:
                current = self._jobs.get(job_id)
                if current and current.status == "diarizing":
                    current.progress = max(current.progress, min(90, max(30, progress)))

        try:
            with self._lock:
                if self._jobs[job_id].cancel_event.is_set() or self._jobs[job_id].status == "cancelled":
                    self._jobs[job_id].finished_at = time.monotonic()
                    return
                self._jobs[job_id].status = "diarizing"
                self._jobs[job_id].progress = 30
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
                    current.error_code = "DIARIZATION_FAILED"
                    current.finished_at = time.monotonic()

    def start(self, job_id: str) -> None:
        with self._lock:
            job = self._job(job_id)
            if job.status != "queued" or not job.source_path:
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
