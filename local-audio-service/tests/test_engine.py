from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import ModelSetupError, PyannoteCommunityEngine


class FakeSegment:
    def __init__(self, start: float, end: float):
        self.start = start
        self.end = end


class FakeAnnotation:
    def itertracks(self, yield_label: bool = False):
        self.assert_yield_label = yield_label
        yield FakeSegment(4.0, 6.0), None, "SPEAKER_01"
        yield FakeSegment(1.25, 3.5), None, "SPEAKER_07"


class FakeOutput:
    exclusive_speaker_diarization = FakeAnnotation()


class FakePipeline:
    def __init__(self):
        self.kwargs = None

    def __call__(self, path, **kwargs):
        self.kwargs = kwargs
        return FakeOutput()


class PyannoteCommunityEngineTests(unittest.TestCase):
    def test_requires_a_hugging_face_token_without_loading_a_model(self):
        engine = PyannoteCommunityEngine()
        with patch("app.engine._get_huggingface_token", return_value=None), patch("app.engine._load_pipeline") as load_pipeline:
            with self.assertRaisesRegex(ModelSetupError, "HF_TOKEN_MISSING"):
                engine.diarize(Path("sample.wav"), None, lambda progress: None)
        load_pipeline.assert_not_called()

    def test_normalizes_exclusive_turns_by_first_seen_speaker(self):
        pipeline = FakePipeline()
        engine = PyannoteCommunityEngine()
        progress = []
        with patch("app.engine._get_huggingface_token", return_value="test-token"), patch("app.engine._load_pipeline", return_value=pipeline):
            turns = engine.diarize(Path("sample.wav"), 2, progress.append)

        self.assertEqual([(turn.start_ms, turn.end_ms, turn.speaker_id) for turn in turns], [
            (1_250, 3_500, "speaker_0"),
            (4_000, 6_000, "speaker_1"),
        ])
        self.assertEqual(pipeline.kwargs, {"num_speakers": 2})
        self.assertEqual(progress, [35, 90])


if __name__ == "__main__":
    unittest.main()
