from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.audio import AudioValidationError, MAX_BYTES, MAX_DURATION_MS, probe_duration_ms, validate_audio_file


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


if __name__ == "__main__":
    unittest.main()
