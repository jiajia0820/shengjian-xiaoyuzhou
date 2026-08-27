from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import VoiceprintReference
from app.voiceprint import (
    VoiceprintInputError,
    parse_voiceprint_references,
    validate_voiceprint_reference_bounds,
)


class VoiceprintValidationTests(unittest.TestCase):
    def test_accepts_exactly_two_non_overlapping_10_to_30_second_references(self):
        refs = parse_voiceprint_references(json.dumps({
            "speaker_0": {"startMs": 0, "endMs": 10_000},
            "speaker_1": {"startMs": 20_000, "endMs": 50_000},
        }))
        self.assertEqual(refs, (
            VoiceprintReference("speaker_0", 0, 10_000),
            VoiceprintReference("speaker_1", 20_000, 50_000),
        ))
        validate_voiceprint_reference_bounds(refs, duration_ms=60_000)

    def test_rejects_missing_speaker_overlap_short_long_and_out_of_range_references(self):
        cases = [
            {"speaker_0": {"startMs": 0, "endMs": 10_000}},
            {"speaker_0": {"startMs": 0, "endMs": 10_000}, "speaker_1": {"startMs": 5_000, "endMs": 20_000}},
            {"speaker_0": {"startMs": 0, "endMs": 9_999}, "speaker_1": {"startMs": 20_000, "endMs": 30_000}},
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
if __name__ == "__main__":
    unittest.main()
