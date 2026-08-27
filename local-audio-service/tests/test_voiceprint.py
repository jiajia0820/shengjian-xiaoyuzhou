from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import DiarizationTurn, VoiceprintReference
from app.voiceprint import (
    VoiceprintInputError,
    classify_embedding,
    merge_labeled_windows,
    parse_voiceprint_references,
    validate_voiceprint_reference_bounds,
)


class VoiceprintValidationTests(unittest.TestCase):
    def test_accepts_exactly_two_non_overlapping_5_to_30_second_references(self):
        refs = parse_voiceprint_references(json.dumps({
            "speaker_0": {"startMs": 0, "endMs": 5_000},
            "speaker_1": {"startMs": 20_000, "endMs": 50_000},
        }))
        self.assertEqual(refs, (
            VoiceprintReference("speaker_0", 0, 5_000),
            VoiceprintReference("speaker_1", 20_000, 50_000),
        ))
        validate_voiceprint_reference_bounds(refs, duration_ms=60_000)

    def test_rejects_missing_speaker_overlap_short_long_and_out_of_range_references(self):
        cases = [
            {"speaker_0": {"startMs": 0, "endMs": 10_000}},
            {"speaker_0": {"startMs": 0, "endMs": 10_000}, "speaker_1": {"startMs": 5_000, "endMs": 20_000}},
            {"speaker_0": {"startMs": 0, "endMs": 4_999}, "speaker_1": {"startMs": 20_000, "endMs": 30_000}},
            {"speaker_0": {"startMs": 0, "endMs": 30_001}, "speaker_1": {"startMs": 40_000, "endMs": 50_000}},
        ]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaisesRegex(VoiceprintInputError, "VOICEPRINT_REFERENCES_INVALID"):
                    parse_voiceprint_references(json.dumps(value))

        out_of_range = parse_voiceprint_references(json.dumps({
            "speaker_0": {"startMs": 0, "endMs": 10_000},
            "speaker_1": {"startMs": 55_000, "endMs": 65_000},
        }))
        with self.assertRaisesRegex(VoiceprintInputError, "VOICEPRINT_REFERENCES_INVALID"):
            validate_voiceprint_reference_bounds(out_of_range, duration_ms=60_000)


class VoiceprintMathTests(unittest.TestCase):
    def test_classifies_nearest_reference_and_leaves_low_margin_unknown(self):
        centers = {
            "speaker_0": [1.0, 0.0],
            "speaker_1": [0.0, 1.0],
        }
        self.assertEqual(classify_embedding([0.98, 0.02], centers, min_similarity=0.7, min_margin=0.1), "speaker_0")
        self.assertEqual(classify_embedding([0.5, 0.5], centers, min_similarity=0.7, min_margin=0.1), None)

    def test_merges_only_stable_adjacent_windows_and_drops_unknown_windows(self):
        windows = [
            (0, 1_500, "speaker_0"), (750, 2_250, "speaker_0"),
            (1_500, 3_000, None), (2_250, 3_750, "speaker_1"),
            (3_000, 4_500, "speaker_1"),
        ]
        self.assertEqual(merge_labeled_windows(windows, hop_ms=750, min_turn_ms=750), [
            DiarizationTurn(0, 2_250, "speaker_0"),
            DiarizationTurn(2_250, 4_500, "speaker_1"),
        ])
if __name__ == "__main__":
    unittest.main()
