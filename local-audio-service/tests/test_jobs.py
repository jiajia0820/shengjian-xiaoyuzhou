from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.jobs import JobManager
from app.models import DiarizationTurn


class FakeEngine:
    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        on_progress(70)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class BlockingEngine:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        self.started.set()
        self.release.wait(timeout=5)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class JobManagerTests(unittest.TestCase):
    def test_job_finishes_and_cleanup_removes_its_temp_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs = JobManager(root=root, engine=FakeEngine(), retention_seconds=0)
            job = jobs.create_job(expected_speakers=None)
            source = jobs.upload_path(job.id, ".wav")
            source.write_bytes(b"audio")
            jobs.queue(job.id, source, duration_ms=2_000)

            jobs.run(job.id)

            snapshot = jobs.snapshot(job.id)
            self.assertEqual(snapshot.status, "ready")
            self.assertEqual(snapshot.segments, [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")])
            jobs.cleanup_expired()
            self.assertFalse((root / job.id).exists())

    def test_cancelled_background_job_does_not_publish_engine_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = BlockingEngine()
            jobs = JobManager(root=root, engine=engine, retention_seconds=0)
            job = jobs.create_job(expected_speakers=None)
            source = jobs.upload_path(job.id, ".wav")
            source.write_bytes(b"audio")
            jobs.queue(job.id, source, duration_ms=2_000)

            jobs.start(job.id)
            self.assertTrue(engine.started.wait(timeout=1))
            self.assertEqual(jobs.cancel(job.id).status, "cancelled")
            jobs.cleanup_expired()
            self.assertTrue((root / job.id).exists())
            engine.release.set()
            jobs.wait_for_idle(timeout=1)

            snapshot = jobs.snapshot(job.id)
            self.assertEqual(snapshot.status, "cancelled")
            self.assertEqual(snapshot.segments, [])
            jobs.cleanup_expired()
            self.assertFalse((root / job.id).exists())


if __name__ == "__main__":
    unittest.main()
