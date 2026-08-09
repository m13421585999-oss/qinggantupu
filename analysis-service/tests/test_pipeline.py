import numpy as np
import parselmouth

from app.acoustics.parselmouth_analyzer import analyze_wav
from app.pipeline import map_alignment_to_source, split_sentence_ranges


def test_exact_alignment_keeps_source_text() -> None:
    text = "面朝大海，春暖花开。"
    payload = {
        "characters": [
            {"text": char, "start": index * 0.1, "end": (index + 1) * 0.1}
            for index, char in enumerate(text)
        ],
        "loss": 0.02,
    }
    tokens, quality = map_alignment_to_source(text, payload)
    assert "".join(token["char"] for token in tokens) == text
    assert quality["character_coverage"] == 1


def test_sentence_ranges_cover_every_character() -> None:
    text = "第一句。\n第二句！最后一句"
    ranges = split_sentence_ranges(text)
    reconstructed = "".join(text[start : end + 1] for start, end in ranges)
    assert reconstructed == text


def test_parselmouth_returns_compact_token_and_sentence_evidence(tmp_path) -> None:
    sample_rate = 16_000
    time = np.arange(sample_rate, dtype=float) / sample_rate
    samples = 0.2 * np.sin(2 * np.pi * 220 * time)
    wav_path = tmp_path / "tone.wav"
    parselmouth.Sound(samples, sampling_frequency=sample_rate).save(
        str(wav_path), parselmouth.SoundFileFormat.WAV
    )
    tokens = [
        {"index": 0, "char": "面", "start_ms": 0, "end_ms": 380},
        {"index": 1, "char": "朝", "start_ms": 450, "end_ms": 900},
        {"index": 2, "char": "。", "start_ms": 900, "end_ms": 900},
    ]
    result = analyze_wav(str(wav_path), tokens, [(0, 2)])
    assert result["duration_ms"] == 1000
    assert len(result["token_evidence"]) == 3
    assert result["token_evidence"][0]["voiced"] is True
    assert result["sentences"][0]["macro_pitch_contour"]
