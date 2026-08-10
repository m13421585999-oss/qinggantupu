from __future__ import annotations

from app.acoustics.contour import continuous_macro_prosody_path, macro_contour
from app.acoustics.parselmouth_analyzer import _ending_intonation
from app.interpretation.llm_interpreter import assemble_control_spec
from app.providers.eleven_alignment import map_to_source, normalize_payload
from app.schemas.control_spec import LlmInterpretation


def test_macro_contour_preserves_the_named_acoustic_metric() -> None:
    contour = macro_contour(
        [0, 1, 2],
        [0.4, -1.2, 0.2],
        zones=3,
        value_key="normalized_energy",
    )
    assert [item["normalized_energy"] for item in contour] == [0.4, -1.2, 0.2]
    assert all("normalized_pitch" not in item for item in contour)


def test_continuous_macro_path_keeps_valley_and_final_rise() -> None:
    indexes = list(range(44, 53))
    path = continuous_macro_prosody_path(
        indexes,
        [1.1, 0.7, 0.1, -0.8, -1.25, -1.0, -0.35, 0.45, 1.35],
    )
    levels = [point["normalized_level"] for point in path["points"]]
    assert levels[4] == min(levels)
    assert levels[-1] > levels[-2] > levels[4]
    assert "falling" in {segment["type"] for segment in path["segments"]}
    assert "rising" in {segment["type"] for segment in path["segments"]}
    for left, right in zip(path["segments"], path["segments"][1:], strict=False):
        assert left["end_index"] == right["start_index"]
        assert left["end_level"] == right["start_level"]


def test_ending_intonation_prefers_real_final_phrase_rise() -> None:
    evidence = [
        {
            "token_index": index,
            "pitch_start": level - 0.1,
            "pitch_end": level,
            "pitch_delta": 0.1,
            "voiced_ratio": 0.9,
        }
        for index, level in zip([6, 7, 8], [-0.7, 0.1, 1.2], strict=True)
    ]
    path = {
        "points": [
            {"token_index": 6, "normalized_level": -0.7},
            {"token_index": 7, "normalized_level": 0.1},
            {"token_index": 8, "normalized_level": 1.2},
        ]
    }
    ending = _ending_intonation(
        evidence,
        [0, 1, 2],
        path,
        [
            {"normalized_level": 0.1},
            {"normalized_level": 1.2},
        ],
    )
    assert ending["type"] == "rising"
    assert ending["source"] == "acoustic"


def test_alignment_preserves_exact_source_indexes() -> None:
    source = "我想你。"
    payload = normalize_payload(
        {
            "characters": list(source),
            "character_start_times_seconds": [0, 0.1, 0.2, 0.3],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.3],
        }
    )
    tokens, quality = map_to_source(source, payload)
    assert "".join(token["char"] for token in tokens) == source
    assert [token["index"] for token in tokens] == [0, 1, 2, 3]
    assert quality["character_coverage"] == 1


def test_control_spec_uses_analysis_tokens_without_rewriting() -> None:
    package = {
        "tokens": [
            {
                "index": 0,
                "char": "我",
                "machine_pinyin": "wo3",
                "display_pinyin": "wǒ",
                "start_ms": 0,
                "end_ms": 180,
                "confidence": 1,
            },
            {
                "index": 1,
                "char": "。",
                "machine_pinyin": None,
                "display_pinyin": None,
                "start_ms": 180,
                "end_ms": 180,
                "confidence": 1,
            },
        ],
        "segments": [{"text": "我。", "start_index": 0, "end_index": 1}],
        "acoustic_evidence": {
            "tokens": [
                {
                    "token_index": 0,
                    "local_duration_ratio": 1.8,
                    "normalized_pitch": 0.4,
                    "normalized_energy": 1.1,
                    "voiced_ratio": 1,
                }
            ],
            "pauses": [{"after_index": 0, "gap_ms": 320, "relative_level": "short"}],
            "duration_outliers": [
                {
                    "token_index": 0,
                    "duration_ms": 180,
                    "local_duration_ratio": 1.8,
                }
            ],
        },
    }
    package["segments"][0]["macro_prosody_path"] = {
        "points": [{"token_index": 0, "normalized_level": 0.4}],
        "segments": [
            {
                "start_index": 0,
                "end_index": 0,
                "type": "level",
                "start_level": 0.4,
                "end_level": 0.4,
                "confidence": 0.5,
            }
        ],
    }
    package["segments"][0]["ending_intonation"] = {
        "type": "rising",
        "strength": 1,
        "confidence": 0.8,
        "source": "acoustic",
    }
    interpretation = LlmInterpretation.model_validate(
        {
            "sentences": [
                {
                    "text": "我。",
                    "start_index": 0,
                    "end_index": 1,
                    "focus_spans": [
                        {
                            "focus_span": {"start": 0, "end": 0},
                            "confidence": 0.9,
                            "explanation": "主语焦点",
                        }
                    ],
                    "prosody": [
                        {
                            "type": "falling",
                            "active_span": {"start": 0, "end": 0},
                            "core_zone": {"start": 0, "end": 0},
                            "strength": 1,
                            "confidence": 0.7,
                        }
                    ],
                    "rhythm": {"type": "relaxed"},
                    "text_logic": "主语",
                    "emotional_interpretation": "克制",
                    "confidence": 0.8,
                }
            ]
        }
    )
    spec = assemble_control_spec(interpretation, package)
    assert spec["tokens"][0]["char"] == "我"
    assert spec["tokens"][0]["display_pinyin"] == "wǒ"
    assert spec["sentences"][0]["pauses"][0]["observed_gap_ms"] == 320
    assert spec["sentences"][0]["pauses"][0]["source"] == "acoustic"
    assert spec["sentences"][0]["prolongations"][0]["degree"] == 2
    assert spec["sentences"][0]["ending_intonation"]["type"] == "rising"
    assert spec["sentences"][0]["focus"][0]["focus_span"] == {"start": 0, "end": 0}
    assert spec["sentences"][0]["focus"][0]["focus_core"] == {"start": 0, "end": 0}


def test_control_spec_allows_no_focus_or_teaching_prosody_when_evidence_is_weak() -> None:
    package = {
        "tokens": [
            {
                "index": 0,
                "char": "嗯",
                "machine_pinyin": "en2",
                "display_pinyin": "én",
                "start_ms": 0,
                "end_ms": 120,
                "confidence": 1,
            },
            {
                "index": 1,
                "char": "。",
                "machine_pinyin": None,
                "display_pinyin": None,
                "start_ms": 120,
                "end_ms": 120,
                "confidence": 1,
            },
        ],
        "segments": [
            {
                "text": "嗯。",
                "start_index": 0,
                "end_index": 1,
                "macro_prosody_path": {
                    "points": [{"token_index": 0, "normalized_level": 0.0}],
                    "segments": [],
                },
                "ending_intonation": {
                    "type": "level",
                    "strength": 1,
                    "confidence": 0.25,
                    "source": "acoustic",
                },
            }
        ],
        "acoustic_evidence": {
            "tokens": [
                {
                    "token_index": 0,
                    "local_duration_ratio": 1.0,
                    "normalized_pitch": 0.0,
                    "normalized_energy": 0.0,
                    "voiced_ratio": 0.8,
                }
            ],
            "pauses": [],
            "duration_outliers": [],
        },
    }
    interpretation = LlmInterpretation.model_validate(
        {
            "sentences": [
                {
                    "text": "嗯。",
                    "start_index": 0,
                    "end_index": 1,
                    "focus_spans": [],
                    "prosody": [],
                    "rhythm": None,
                    "text_logic": None,
                    "emotional_interpretation": None,
                    "confidence": 0.25,
                }
            ]
        }
    )

    spec = assemble_control_spec(interpretation, package)

    assert spec["sentences"][0]["focus"] == []
    assert spec["sentences"][0]["prosody"] == []
    assert spec["sentences"][0]["macro_prosody_path"]["points"]
    assert spec["sentences"][0]["ending_intonation"]["source"] == "acoustic"
