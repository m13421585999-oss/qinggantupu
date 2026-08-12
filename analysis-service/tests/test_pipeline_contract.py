from __future__ import annotations

import numpy as np

from app.acoustics.contour import continuous_macro_prosody_path, macro_contour
from app.acoustics.parselmouth_analyzer import (
    _effective_voice_measurement,
    _ending_intonation,
)
from app.acoustics.prolongation import assess_prolongation_candidate
from app.acoustics.timing_profile import derive_timing_profile
from app.interpretation.llm_interpreter import _compact_evidence, assemble_control_spec
from app.pipeline import PIPELINE_VERSION, _analysis_audio
from app.providers.eleven_alignment import map_to_source, normalize_payload
from app.schemas.control_spec import LlmInterpretation


def test_standard_ai_audio_is_the_primary_pipeline_input() -> None:
    payload = {
        "standard_ai_audio": {"asset_id": "standard", "filename": "standard.mp3"},
        "analysis_audio": {"asset_id": "generic"},
        "reference_audio": {"asset_id": "original"},
    }

    assert _analysis_audio(payload)["asset_id"] == "standard"
    assert PIPELINE_VERSION == "recitation-analysis-2.0-standard-audio"


def test_llm_evidence_keeps_standard_audio_provenance() -> None:
    package = {
        "work": {"title": "test", "author": "", "full_text": "测"},
        "analyzed_audio_role": "standard_ai_audio",
        "standard_ai_audio_asset_id": "standard",
        "reference_audio_original_asset_id": "original",
        "alignment_quality": {},
        "tokens": [{"index": 0, "char": "测", "start_ms": 0, "end_ms": 100}],
        "segments": [],
        "acoustic_evidence": {
            "tokens": [{"token_index": 0}],
            "pauses": [],
            "duration_outliers": [],
            "energy_changes": [],
        },
    }

    evidence = _compact_evidence(package)
    assert evidence["audio_provenance"] == {
        "analyzed_audio_role": "standard_ai_audio",
        "standard_ai_audio_asset_id": "standard",
        "reference_audio_original_asset_id": "original",
    }


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


def test_token_window_separates_sounding_duration_from_low_energy_tail() -> None:
    frame_times = np.arange(0.005, 1.0, 0.01)
    sounding = frame_times < 0.305
    measurement = _effective_voice_measurement(
        pitch_times=frame_times,
        pitch_values=np.where(sounding, 180.0, 0.0),
        intensity_times=frame_times,
        intensity_values=np.where(sounding, 68.0, 28.0),
        start_s=0.0,
        end_s=1.0,
        noise_floor_db=28.0,
        speech_reference_db=68.0,
    )

    assert 290 <= measurement["effective_voiced_duration_ms"] <= 320
    assert 680 <= measurement["low_energy_tail_ms"] <= 710
    assert measurement["voiced_continuity_ratio"] == 1.0


def test_dynamic_timing_profile_uses_current_acoustic_evidence() -> None:
    package = {
        "alignment_quality": {"character_coverage": 0.98},
        "tokens": [
            {"index": 0, "char": "甲", "start_ms": 0, "end_ms": 300},
            {"index": 1, "char": "乙", "start_ms": 300, "end_ms": 700},
            {"index": 2, "char": "，", "start_ms": 700, "end_ms": 700},
            {"index": 3, "char": "丙", "start_ms": 1200, "end_ms": 1500},
            {"index": 4, "char": "丁", "start_ms": 1500, "end_ms": 2000},
            {"index": 5, "char": "。", "start_ms": 2000, "end_ms": 2000},
        ],
        "segments": [{"id": "sentence-1", "start_index": 0, "end_index": 5}],
        "acoustic_evidence": {
            "tokens": [
                {"token_index": 0, "silence_gap_after_ms": 0},
                {"token_index": 1, "silence_gap_after_ms": 500},
                {"token_index": 3, "silence_gap_after_ms": 0},
                {"token_index": 4, "silence_gap_after_ms": 0},
            ],
            "pauses": [{"after_index": 1, "gap_ms": 500}],
            "duration_outliers": [{
                "token_index": 4,
                "local_duration_ratio": 2.5,
                "confidence": 0.95,
            }],
            "prolongations": [{
                "token_index": 4,
                "effective_voiced_duration_ratio": 2.9,
                "local_duration_ratio": 2.9,
                "confidence": 0.95,
                "source_control_ref": "analysis.acoustic_evidence.prolongations.token-4",
            }],
        },
    }

    timing = derive_timing_profile(package)

    assert timing is not None
    assert timing["global_pace"]["value"] == "slow"
    assert timing["pause_hierarchy"][0]["level"] == "marked"
    assert timing["prolongation_strength"][0]["strength"] == "strong"
    assert all(
        entry["source_control_ref"].startswith("analysis.")
        for entry in timing["phrase_duration_profile"]
    )


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
            "duration_outliers": [],
            "prolongations": [],
        },
        "internal_analysis": {
            "prolongation_candidates": [
                {
                    "token_index": 0,
                    "char": "我",
                    "duration_ms": 420,
                    "alignment_duration_ms": 420,
                    "local_duration_ratio": 2.4,
                    "effective_voiced_duration_ms": 390,
                    "effective_voiced_duration_ratio": 2.5,
                    "voiced_continuity_ratio": 0.95,
                    "low_energy_tail_ms": 30,
                    "low_energy_tail_ratio": 0.071,
                    "pause_after_ms": 30,
                    "boundary_type": "none",
                }
            ]
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
            "performance_profile": {
                "delivery_mode": "lyrical_recitation",
                "emotion_tone": ["温暖", "克制"],
                "continuity": "connected",
                "voice_quality": "slightly_breathy",
                "focus_style": "soft",
                "expression_amplitude": "medium",
                "avoid": ["避免喊叫"],
            },
            "sentences": [
                {
                    "text": "我。",
                    "start_index": 0,
                    "end_index": 1,
                    "focus_spans": [
                        {
                            "focus_span": {"start": 0, "end": 0},
                            "focus_style": "breathy_to_supported",
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
                    "performance_profile": {
                        "emotion_tone": ["思索"],
                        "continuity": "connected",
                        "voice_quality": "breathy_to_supported",
                        "focus_style": "breathy_to_supported",
                        "expression_amplitude": "low",
                    },
                    "text_logic": "主语",
                    "emotional_interpretation": "克制",
                    "confidence": 0.8,
                }
            ]
        }
    )
    spec = assemble_control_spec(interpretation, package)
    package["timing_profile"] = derive_timing_profile(package)
    spec["timing_profile"] = package["timing_profile"]
    assert spec["tokens"][0]["char"] == "我"
    assert spec["tokens"][0]["display_pinyin"] == "wǒ"
    assert spec["sentences"][0]["pauses"][0]["observed_gap_ms"] == 320
    assert spec["sentences"][0]["pauses"][0]["source"] == "acoustic"
    assert spec["sentences"][0]["prolongations"][0]["degree"] == 2
    assert spec["sentences"][0]["ending_intonation"]["type"] == "rising"
    assert spec["sentences"][0]["focus"][0]["focus_span"] == {"start": 0, "end": 0}
    assert spec["sentences"][0]["focus"][0]["focus_core"] == {"start": 0, "end": 0}
    assert spec["sentences"][0]["focus"][0]["focus_style"] == "breathy_to_supported"
    assert spec["performance_profile"]["voice_quality"] == "slightly_breathy"
    assert spec["sentences"][0]["performance_profile"]["focus_style"] == "breathy_to_supported"
    assert spec["timing_profile"] == package["timing_profile"]


def test_alignment_outlier_with_low_energy_tail_becomes_pause_not_prolongation() -> None:
    mark, audit = assess_prolongation_candidate({
        "token_index": 2,
        "char": "海",
        "alignment_duration_ms": 720,
        "local_duration_ratio": 2.7,
        "effective_voiced_duration_ms": 230,
        "effective_voiced_duration_ratio": 1.05,
        "voiced_continuity_ratio": 0.91,
        "low_energy_tail_ms": 490,
        "low_energy_tail_ratio": 0.681,
        "pause_after_ms": 640,
        "boundary_type": "phrase_end",
    })
    assert mark is None
    assert "alignment_window_is_mostly_low_energy_tail" in audit["decision_reasons"]
    assert audit["pause_after_ms"] == 640


def test_sustained_voiced_extension_is_a_teaching_prolongation() -> None:
    mark, audit = assess_prolongation_candidate({
        "token_index": 3,
        "char": "暖",
        "alignment_duration_ms": 610,
        "local_duration_ratio": 2.45,
        "effective_voiced_duration_ms": 560,
        "effective_voiced_duration_ratio": 2.55,
        "voiced_continuity_ratio": 0.96,
        "low_energy_tail_ms": 50,
        "low_energy_tail_ratio": 0.082,
        "pause_after_ms": 50,
        "boundary_type": "none",
    })
    assert mark is not None
    assert mark["degree"] == 2
    assert mark["local_duration_ratio"] == 2.55
    assert audit["decision"] == "confirmed"


def test_natural_sentence_final_lengthening_is_not_automatically_prolonged() -> None:
    mark, audit = assess_prolongation_candidate({
        "token_index": 4,
        "char": "开",
        "alignment_duration_ms": 500,
        "local_duration_ratio": 2.0,
        "effective_voiced_duration_ms": 440,
        "effective_voiced_duration_ratio": 2.05,
        "voiced_continuity_ratio": 0.94,
        "low_energy_tail_ms": 60,
        "pause_after_ms": 60,
        "boundary_type": "sentence_end",
    })
    assert mark is None
    assert "normal_boundary_lengthening" in audit["decision_reasons"]


def test_extreme_sustained_sentence_final_prolongation_is_still_allowed() -> None:
    mark, _ = assess_prolongation_candidate({
        "token_index": 4,
        "char": "开",
        "alignment_duration_ms": 760,
        "local_duration_ratio": 3.0,
        "effective_voiced_duration_ms": 700,
        "effective_voiced_duration_ratio": 3.05,
        "voiced_continuity_ratio": 0.97,
        "low_energy_tail_ms": 60,
        "pause_after_ms": 60,
        "boundary_type": "sentence_end",
    })
    assert mark is not None
    assert mark["degree"] == 3


def test_focus_slightly_slowed_does_not_create_prolongation() -> None:
    mark, audit = assess_prolongation_candidate({
        "token_index": 1,
        "char": "幸",
        "alignment_duration_ms": 390,
        "local_duration_ratio": 1.65,
        "effective_voiced_duration_ms": 350,
        "effective_voiced_duration_ratio": 1.62,
        "voiced_continuity_ratio": 0.95,
        "low_energy_tail_ms": 40,
        "pause_after_ms": 40,
        "boundary_type": "none",
    }, focus_indexes={1})
    assert mark is None
    assert audit["focus_context"] is True


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
