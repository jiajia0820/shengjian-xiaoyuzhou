from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
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
    def __init__(self, annotation):
        self.exclusive_speaker_diarization = annotation


class FakePipeline:
    def __init__(self):
        self.kwargs = None

    def __call__(self, path, **kwargs):
        self.kwargs = kwargs
        return FakeOutput(FakeAnnotation())

    def to(self, device):
        self.device = device
        return self


class RangeSamples:
    data = "waveform"
    sample_rate = 16_000


class ChunkAnnotation:
    def __init__(self, turns):
        self.turns = turns

    def itertracks(self, yield_label: bool = False):
        for start, end, label in self.turns:
            yield FakeSegment(start, end), None, label


class ChunkPipeline:
    def __init__(self):
        self.calls = []
        self._outputs = [
            [(0, 600, "local_a")],
            [(0, 15, "local_a"), (15, 30, "local_a"), (30, 615, "local_b")],
            [(0, 30, "local_b"), (30, 315, "local_c")],
        ]

    def __call__(self, file, **kwargs):
        self.calls.append((file, kwargs))
        return FakeOutput(ChunkAnnotation(self._outputs[len(self.calls) - 1]))


class PyannoteCommunityEngineTests(unittest.TestCase):
    def test_auto_device_uses_cuda_when_available(self):
        engine = PyannoteCommunityEngine()
        pipeline = FakePipeline()
        engine._pipeline = pipeline
        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True),
            device=lambda name: name,
        )
        with patch.dict(sys.modules, {"torch": fake_torch}), patch.dict("os.environ", {"SPEAKER_DEVICE": "auto"}):
            engine._move_to_requested_device()

        self.assertEqual(pipeline.device, "cuda")
        self.assertEqual(engine.device_status(), "cuda")

    def test_auto_device_falls_back_to_cpu_when_cuda_is_unavailable(self):
        engine = PyannoteCommunityEngine()
        pipeline = FakePipeline()
        engine._pipeline = pipeline
        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False),
            device=lambda name: name,
        )
        with patch.dict(sys.modules, {"torch": fake_torch}), patch.dict("os.environ", {"SPEAKER_DEVICE": "auto"}):
            engine._move_to_requested_device()

        self.assertFalse(hasattr(pipeline, "device"))
        self.assertEqual(engine.device_status(), "cpu")

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
        with patch("app.engine._get_huggingface_token", return_value="test-token"), patch("app.engine._load_pipeline", return_value=pipeline), patch("app.engine.probe_duration_ms", return_value=6_000, create=True), patch("app.engine._decode_audio_range", return_value=RangeSamples(), create=True):
            turns = engine.diarize(Path("sample.wav"), 2, progress.append)

        self.assertEqual([(turn.start_ms, turn.end_ms, turn.speaker_id) for turn in turns], [
            (1_250, 3_500, "speaker_0"),
            (4_000, 6_000, "speaker_1"),
        ])
        self.assertEqual(pipeline.kwargs, {"num_speakers": 2})
        self.assertEqual(progress, [35, 90])

    def test_processes_long_audio_in_overlapped_core_windows_and_maps_speakers(self):
        pipeline = ChunkPipeline()
        engine = PyannoteCommunityEngine()
        progress = []
        with patch("app.engine._get_huggingface_token", return_value="test-token"), patch("app.engine._load_pipeline", return_value=pipeline), patch("app.engine.probe_duration_ms", return_value=25 * 60 * 1000, create=True), patch("app.engine._decode_audio_range", return_value=RangeSamples(), create=True):
            turns = engine.diarize(Path("sample.wav"), None, progress.append)

        self.assertEqual([(turn.start_ms, turn.end_ms, turn.speaker_id) for turn in turns], [
            (0, 600_000, "speaker_0"),
            (600_000, 615_000, "speaker_0"),
            (615_000, 1_200_000, "speaker_1"),
            (1_200_000, 1_215_000, "speaker_1"),
            (1_215_000, 1_500_000, "speaker_2"),
        ])
        self.assertEqual(progress, [35, 53, 71, 90])
        self.assertEqual([call[0]["uri"] for call in pipeline.calls], [
            "sample-chunk-0", "sample-chunk-1", "sample-chunk-2",
        ])
        self.assertEqual([call[0]["waveform"] for call in pipeline.calls], [
            "waveform", "waveform", "waveform",
        ])


if __name__ == "__main__":
    unittest.main()
