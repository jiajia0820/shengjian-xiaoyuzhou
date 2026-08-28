from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.audio import (
    AudioValidationError,
    MAX_BYTES,
    MAX_DURATION_MS,
    download_remote_audio,
    probe_duration_ms,
    validate_audio_file,
    validate_remote_audio_url,
)


class FakeRemoteResponse:
    def __init__(self, chunks, *, content_type="audio/mp4", content_length=None):
        self._chunks = list(chunks)
        self.read_sizes = []
        self.status = 200
        self.headers = {"Content-Type": content_type}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size):
        self.read_sizes.append(size)
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


class AudioValidationTests(unittest.TestCase):
    def test_long_audio_limits_are_two_hours_and_one_gigabyte(self):
        self.assertEqual(MAX_DURATION_MS, 2 * 60 * 60 * 1000)
        self.assertEqual(MAX_BYTES, 1 * 1024 * 1024 * 1024)

    @patch("app.audio.subprocess.run")
    def test_probe_uses_ffprobe_duration_only(self, run):
        run.return_value.stdout = "12.345\n"
        run.return_value.returncode = 0

        duration = probe_duration_ms(Path("sample.m4a"))

        self.assertEqual(duration, 12_345)
        run.assert_called_once_with(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", "sample.m4a",
            ],
            check=False, capture_output=True, text=True, timeout=20,
        )

    def test_probe_failure_raises_audio_validation_error(self):
        @patch("app.audio.subprocess.run")
        def probe_failure(run):
            run.return_value.stdout = ""
            run.return_value.returncode = 1
            return probe_duration_ms(Path("sample.m4a"))

        with self.assertRaisesRegex(AudioValidationError, "AUDIO_PROBE_FAILED"):
            probe_failure()

    def test_rejects_audio_longer_than_thirty_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.m4a"
            path.write_bytes(b"audio")
            with patch("app.audio.probe_duration_ms", return_value=MAX_DURATION_MS + 1):
                with self.assertRaisesRegex(AudioValidationError, "AUDIO_TOO_LONG"):
                    validate_audio_file(path)

    def test_accepts_audio_at_exactly_two_hours(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.m4a"
            path.write_bytes(b"audio")
            with patch("app.audio.probe_duration_ms", return_value=MAX_DURATION_MS):
                self.assertEqual(validate_audio_file(path), MAX_DURATION_MS)

    def test_download_remote_audio_streams_in_one_mib_chunks(self):
        response = FakeRemoteResponse([b"first", b"second"], content_length=11)
        with tempfile.TemporaryDirectory() as directory, patch("app.audio.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), patch("app.audio.build_remote_opener") as build_opener:
            build_opener.return_value.open.return_value = response
            with patch("app.audio.validate_audio_file", return_value=12_000):
                path, duration_ms = download_remote_audio(
                    "https://media.xyzcdn.net/audio.m4a", Path(directory), allowed_origins=frozenset()
                )
            self.assertEqual(path.suffix, ".m4a")
            self.assertEqual(path.read_bytes(), b"firstsecond")
            self.assertEqual(duration_ms, 12_000)
        self.assertEqual(response.read_sizes, [1024 * 1024, 1024 * 1024, 1024 * 1024])

    def test_remote_url_policy_rejects_http_private_and_unknown_hosts(self):
        with self.assertRaisesRegex(AudioValidationError, "AUDIO_HOST_NOT_ALLOWED"):
            validate_remote_audio_url("http://127.0.0.1:9999/api/episodes/e/audio-relay", frozenset())
        with self.assertRaisesRegex(AudioValidationError, "AUDIO_HOST_NOT_ALLOWED"):
            validate_remote_audio_url("https://127.0.0.1/audio.m4a", frozenset())
        with self.assertRaisesRegex(AudioValidationError, "AUDIO_HOST_NOT_ALLOWED"):
            validate_remote_audio_url("https://example.com/audio.m4a", frozenset())

    def test_remote_url_policy_allows_configured_relay_origin_and_official_cdn(self):
        self.assertEqual(
            validate_remote_audio_url("http://localhost:3000/api/episodes/e/audio-relay", frozenset({"http://localhost:3000"})),
            "http://localhost:3000/api/episodes/e/audio-relay",
        )
        self.assertEqual(
            validate_remote_audio_url("https://media.xyzcdn.net/audio.m4a", frozenset()),
            "https://media.xyzcdn.net/audio.m4a",
        )

    def test_remote_download_rejects_declared_oversize_before_writing(self):
        response = FakeRemoteResponse([], content_length=MAX_BYTES + 1)
        with tempfile.TemporaryDirectory() as directory, patch("app.audio.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), patch("app.audio.build_remote_opener") as build_opener:
            build_opener.return_value.open.return_value = response
            with self.assertRaisesRegex(AudioValidationError, "AUDIO_TOO_LARGE"):
                download_remote_audio("https://media.xyzcdn.net/audio.m4a", Path(directory), allowed_origins=frozenset())

    def test_remote_download_preserves_ffprobe_too_long_error(self):
        response = FakeRemoteResponse([b"audio"])
        with tempfile.TemporaryDirectory() as directory, patch("app.audio.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), patch("app.audio.build_remote_opener") as build_opener:
            build_opener.return_value.open.return_value = response
            with patch("app.audio.validate_audio_file", side_effect=AudioValidationError("AUDIO_TOO_LONG")):
                with self.assertRaisesRegex(AudioValidationError, "AUDIO_TOO_LONG"):
                    download_remote_audio("https://media.xyzcdn.net/audio.m4a", Path(directory), allowed_origins=frozenset())


if __name__ == "__main__":
    unittest.main()
