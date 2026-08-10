from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from shutil import copyfile
from unittest.mock import patch

import numpy as np
import parselmouth

import analyzer
from analyzer import (
    analyze_recitation,
    analyze_wav,
    map_alignment_to_source,
    normalize_alignment_payload,
    pinyin_for_char,
    split_sentence_ranges,
)


class AnalyzerTests(unittest.TestCase):
    def test_parallel_array_alignment_is_normalized(self) -> None:
        payload = normalize_alignment_payload(
            {
                "characters": ["面", "朝", "大", "海"],
                "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3],
                "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4],
                "loss": 0.01,
            }
        )
        self.assertEqual(payload["characters"][2]["text"], "大")
        self.assertEqual(payload["characters"][2]["start"], 0.2)

    def test_alignment_keeps_exact_source_indexes(self) -> None:
        text = "面朝大海，春暖花开。"
        spoken = text.replace("，", "").replace("。", "")
        payload = {
            "characters": [
                {"text": char, "start": index * 0.1, "end": (index + 1) * 0.1}
                for index, char in enumerate(spoken)
            ]
        }
        tokens, quality = map_alignment_to_source(text, payload)
        self.assertEqual("".join(token["char"] for token in tokens), text)
        self.assertEqual([token["index"] for token in tokens], list(range(len(text))))
        self.assertEqual(quality["character_coverage"], 1.0)

    def test_sentence_ranges_cover_every_character(self) -> None:
        text = "第一句。\n第二句！最后一句"
        ranges = split_sentence_ranges(text)
        reconstructed = "".join(text[start : end + 1] for start, end in ranges)
        self.assertEqual(reconstructed, text)

    def test_display_pinyin_uses_tone_marks(self) -> None:
        machine, display = pinyin_for_char("想")
        self.assertEqual(machine, "xiang3")
        self.assertEqual(display, "xiǎng")

    def test_parselmouth_returns_compact_acoustic_facts(self) -> None:
        sample_rate = 16_000
        timeline = np.arange(sample_rate, dtype=float) / sample_rate
        samples = 0.2 * np.sin(2 * np.pi * 220 * timeline)
        with tempfile.TemporaryDirectory() as temp_dir:
            wav_path = Path(temp_dir) / "tone.wav"
            parselmouth.Sound(samples, sampling_frequency=sample_rate).save(
                str(wav_path), parselmouth.SoundFileFormat.WAV
            )
            tokens = [
                {"index": 0, "char": "面", "start_ms": 0, "end_ms": 380},
                {"index": 1, "char": "朝", "start_ms": 450, "end_ms": 900},
                {"index": 2, "char": "。", "start_ms": 900, "end_ms": 900},
            ]
            result = analyze_wav(wav_path, tokens, [(0, 2)])

        self.assertEqual(result["duration_ms"], 1000)
        self.assertTrue(result["token_acoustics"][0]["voiced"])
        self.assertIn("local_duration_ratio", result["token_acoustics"][0])
        self.assertTrue(result["sentences"][0]["macro_pitch_contour"])
        for forbidden in ("focus", "prosody", "rhythm", "ending_intonation"):
            self.assertNotIn(forbidden, result)

    def test_final_package_has_compact_per_token_facts_without_teaching_labels(self) -> None:
        sample_rate = 16_000
        timeline = np.arange(sample_rate, dtype=float) / sample_rate
        samples = 0.2 * np.sin(2 * np.pi * 220 * timeline)
        alignment = {
            "characters": [
                {"text": "面", "start": 0.0, "end": 0.4, "confidence": 0.99},
                {"text": "朝", "start": 0.5, "end": 0.9, "confidence": 0.98},
            ],
            "words": [{"text": "面朝", "start": 0.0, "end": 0.9}],
            "loss": 0.01,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "sample.wav"
            parselmouth.Sound(samples, sampling_frequency=sample_rate).save(
                str(source), parselmouth.SoundFileFormat.WAV
            )
            with patch.object(analyzer, "forced_align", return_value=alignment), patch.object(
                analyzer, "convert_to_mono_wav", side_effect=lambda src, dst: copyfile(src, dst)
            ):
                result = analyze_recitation(full_text="面朝。", audio_path=source, api_key="test-key")

        self.assertEqual("".join(item["char"] for item in result["tokens"]), "面朝。")
        self.assertEqual(len(result["token_acoustics"]), 2)
        expected_facts = {
            "duration_ms",
            "local_duration_ratio",
            "f0_hz",
            "normalized_pitch",
            "intensity_db",
            "normalized_energy",
            "silence_gap_before_ms",
            "silence_gap_after_ms",
        }
        self.assertTrue(expected_facts.issubset(result["token_acoustics"][0]))
        self.assertTrue(result["sentences"][0]["macro_pitch_contour"])
        for forbidden in ("focus", "prosody", "rhythm", "ending_intonation"):
            self.assertNotIn(forbidden, result)


if __name__ == "__main__":
    unittest.main()
