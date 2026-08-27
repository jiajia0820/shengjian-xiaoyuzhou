from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.jobs import JobManager
from app.engine import ModelSetupError
from app.models import DiarizationTurn, VoiceprintReference


class FakeEngine:
    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        on_progress(70)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class FakeVoiceprintEngine:
    def __init__(self):
        self.calls = []

    def identify(self, path: Path, references, on_progress):
        self.calls.append((path, references))
        on_progress(70)
        return [DiarizationTurn(start_ms=500, end_ms=1_500, speaker_id="speaker_0")]


class BlockingEngine:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        self.started.set()
        self.release.wait(timeout=5)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class MissingModelEngine:
    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        raise ModelSetupError("HF_TOKEN_MISSING")


class ChunkProgressEngine:
    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        for progress in (35, 53, 71, 90):
            on_progress(progress)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class JobManagerTests(unittest.TestCase):
    def test_voiceprint_job_dispatches_references_and_exposes_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            voiceprint_engine = FakeVoiceprintEngine()
            jobs = JobManager(root=root, engine=FakeEngine(), voiceprint_engine=voiceprint_engine)
            references = (
                VoiceprintReference("speaker_0", 0, 10_000),
                VoiceprintReference("speaker_1", 20_000, 30_000),
            )
            job = jobs.create_job(expected_speakers=None, mode="voiceprint", references=references)
            source = jobs.upload_path(job.id, ".wav")
            source.write_bytes(b"audio")
            jobs.queue(job.id, source, duration_ms=60_000)

            jobs.run(job.id)

            snapshot = jobs.snapshot(job.id)
            self.assertEqual(snapshot.mode, "voiceprint")
            self.assertEqual(snapshot.segments[0].speaker_id, "speaker_0")
            self.assertEqual(voiceprint_engine.calls, [(source, references)])

    def test_publishes_chunk_count_after_long_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs = JobManager(root=root, engine=ChunkProgressEngine())
            job = jobs.create_job(expected_speakers=None)
            source = jobs.upload_path(job.id, ".wav")
            source.write_bytes(b"audio")
            jobs.queue(job.id, source, duration_ms=25 * 60 * 1000)

            jobs.run(job.id)

            snapshot = jobs.snapshot(job.id)
            self.assertEqual(snapshot.chunk_count, 3)
            self.assertEqual(snapshot.chunk_index, 3)

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

    def test_exposes_safe_model_setup_error_without_source_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs = JobManager(root=root, engine=MissingModelEngine())
            job = jobs.create_job(expected_speakers=None)
            source = jobs.upload_path(job.id, ".wav")
            source.write_bytes(b"audio")
            jobs.queue(job.id, source, duration_ms=2_000)

            jobs.run(job.id)

            snapshot = jobs.snapshot(job.id)
            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(snapshot.error_code, "HF_TOKEN_MISSING")


if __name__ == "__main__":
    unittest.main()
