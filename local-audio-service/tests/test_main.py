from __future__ import annotations

import sys
import tempfile
import time
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.audio import MAX_BYTES
from app.jobs import JobManager
from app.main import ServiceSettings, create_app
from app.models import DiarizationTurn, VoiceprintReference


class FakeEngine:
    def model_status(self):
        return "unloaded"

    def diarize(self, path: Path, expected_speakers: int | None, on_progress):
        on_progress(70)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class FakeVoiceprintEngine:
    def model_status(self):
        return "ready"

    def device_status(self):
        return "cuda"

    def identify(self, path: Path, references, on_progress):
        on_progress(70)
        return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]


class UnsafeStatusEngine(FakeEngine):
    def model_status(self):
        return "token=/secret"

    def device_status(self):
        return "C:\\private"


class UnsafeVoiceprintEngine(FakeVoiceprintEngine):
    def model_status(self):
        return "path=/secret"

    def device_status(self):
        return "cuda:0"


class LocalServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.manager = JobManager(root=self.root, engine=FakeEngine())
        settings = ServiceSettings(
            job_root=self.root,
            allowed_origins=frozenset({"http://localhost:3000"}),
        )
        self.client = TestClient(create_app(settings, self.manager), client=("127.0.0.1", 53000))

    def tearDown(self):
        self.temporary_directory.cleanup()

    @staticmethod
    def headers(origin="http://localhost:3000"):
        return {"Origin": origin, "X-Speaker-Client-Version": "1"}

    @staticmethod
    def audio_form():
        return {"audio": ("sample.wav", b"audio", "audio/wav")}

    def test_rejects_foreign_origin_and_missing_custom_header(self):
        foreign = self.client.post("/jobs", headers=self.headers("https://evil.example"), files=self.audio_form())
        missing_header = self.client.post("/jobs", headers={"Origin": "http://localhost:3000"}, files=self.audio_form())

        self.assertEqual(foreign.status_code, 403)
        self.assertEqual(missing_header.status_code, 403)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_health_exposes_no_tokens_paths_or_file_names(self):
        with patch("app.engine._get_huggingface_token", return_value=None):
            response = self.client.get("/health", headers=self.headers())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"service", "ffmpegAvailable", "model", "device", "voiceprintModel", "voiceprintDevice"})
        self.assertEqual(response.json()["device"], "cpu")
        self.assertEqual(response.json()["voiceprintModel"], "needs_setup")
        self.assertEqual(response.json()["voiceprintDevice"], "cpu")
        serialized = response.text.lower()
        self.assertNotIn("token", serialized)
        self.assertNotIn("path", serialized)
        self.assertNotIn("filename", serialized)

    def test_health_restricts_model_and_device_values_to_safe_enums(self):
        manager = JobManager(
            root=self.root,
            engine=UnsafeStatusEngine(),
            voiceprint_engine=UnsafeVoiceprintEngine(),
        )
        client = TestClient(create_app(
            ServiceSettings(job_root=self.root, allowed_origins=frozenset({"http://localhost:3000"})),
            manager,
        ), client=("127.0.0.1", 53000))
        response = client.get("/health", headers=self.headers())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["model"], "unloaded")
        self.assertEqual(response.json()["device"], "cpu")
        self.assertEqual(response.json()["voiceprintModel"], "unloaded")
        self.assertEqual(response.json()["voiceprintDevice"], "cpu")

    def test_rejects_declared_oversize_upload_without_creating_a_job(self):
        response = self.client.post(
            "/jobs",
            headers={**self.headers(), "Content-Length": str(MAX_BYTES + 1)},
            files=self.audio_form(),
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_allowed_upload_creates_only_its_own_job(self):
        with patch("app.main.validate_audio_file", return_value=2_000):
            response = self.client.post("/jobs", headers=self.headers(), files=self.audio_form(), data={"expectedSpeakers": "2"})

        self.assertEqual(response.status_code, 202)
        job_id = response.json()["jobId"]
        self.manager.wait_for_idle(timeout=1)
        self.assertEqual(self.client.get(f"/jobs/{job_id}", headers=self.headers()).status_code, 200)
        self.assertEqual(self.client.delete(f"/jobs/{job_id}", headers=self.headers()).status_code, 200)

    def test_voiceprint_upload_accepts_references_and_reports_mode(self):
        voiceprint_manager = JobManager(
            root=self.root,
            engine=FakeEngine(),
            voiceprint_engine=FakeVoiceprintEngine(),
        )
        client = TestClient(create_app(
            ServiceSettings(job_root=self.root, allowed_origins=frozenset({"http://localhost:3000"})),
            voiceprint_manager,
        ), client=("127.0.0.1", 53000))
        references = '{"speaker_0":{"startMs":0,"endMs":10000},"speaker_1":{"startMs":20000,"endMs":30000}}'
        with patch("app.main.validate_audio_file", return_value=60_000):
            response = client.post(
                "/jobs",
                headers=self.headers(),
                files=self.audio_form(),
                data={"mode": "voiceprint", "references": references},
            )

        self.assertEqual(response.status_code, 202)
        job_id = response.json()["jobId"]
        voiceprint_manager.wait_for_idle(timeout=1)
        job_response = client.get(f"/jobs/{job_id}", headers=self.headers())
        self.assertEqual(job_response.status_code, 200)
        self.assertEqual(job_response.json()["mode"], "voiceprint")
        self.assertEqual(job_response.json()["segments"][0]["speakerId"], "speaker_0")

    def test_voiceprint_upload_rejects_invalid_references_before_processing(self):
        invalid_references = [
            '{"speaker_0":{"startMs":0,"endMs":10000}}',
            '{"speaker_0":{"startMs":0,"endMs":10000},"speaker_1":{"startMs":5000,"endMs":20000}}',
        ]
        for references in invalid_references:
            with self.subTest(references=references), patch("app.main.validate_audio_file", return_value=60_000):
                response = self.client.post(
                    "/jobs",
                    headers=self.headers(),
                    files=self.audio_form(),
                    data={"mode": "voiceprint", "references": references},
                )

            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["detail"], "VOICEPRINT_REFERENCES_INVALID")
            self.assertEqual(list(self.root.iterdir()), [])

    def test_voiceprint_upload_rejects_references_outside_audio_after_probe(self):
        references = '{"speaker_0":{"startMs":0,"endMs":10000},"speaker_1":{"startMs":55000,"endMs":65000}}'
        with patch("app.main.validate_audio_file", return_value=60_000):
            response = self.client.post(
                "/jobs",
                headers=self.headers(),
                files=self.audio_form(),
                data={"mode": "voiceprint", "references": references},
            )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "VOICEPRINT_REFERENCES_INVALID")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_allows_private_network_preflight_only_for_allowed_origin(self):
        response = self.client.options("/jobs", headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-Speaker-Client-Version",
            "Access-Control-Request-Private-Network": "true",
        })

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["access-control-allow-private-network"], "true")
        self.assertEqual(response.headers["access-control-allow-origin"], "http://localhost:3000")

    def test_service_start_removes_orphaned_task_directory(self):
        stale = self.root / "stale-job"
        stale.mkdir()
        (stale / "audio.wav").write_bytes(b"audio")
        settings = ServiceSettings(job_root=self.root, allowed_origins=frozenset({"http://localhost:3000"}))

        create_app(settings)

        self.assertFalse(stale.exists())

    def test_lifespan_periodically_removes_finished_job_directories(self):
        manager = JobManager(root=self.root, engine=FakeEngine(), retention_seconds=0)
        job = manager.create_job(expected_speakers=None)
        source = manager.upload_path(job.id, ".wav")
        source.write_bytes(b"audio")
        manager.queue(job.id, source, duration_ms=2_000)
        manager.run(job.id)
        settings = ServiceSettings(
            job_root=self.root,
            allowed_origins=frozenset({"http://localhost:3000"}),
            cleanup_interval_seconds=0.01,
        )

        with TestClient(create_app(settings, manager), client=("127.0.0.1", 53000)):
            time.sleep(0.05)

        self.assertFalse((self.root / job.id).exists())


if __name__ == "__main__":
    unittest.main()
