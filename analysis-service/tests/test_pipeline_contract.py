from __future__ import annotations

from app.acoustics.contour import macro_contour
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
            "pauses": [{"after_index": 0, "gap_ms": 320, "relative_level": "short"}],
        },
    }
    interpretation = LlmInterpretation.model_validate(
        {
            "sentences": [
                {
                    "text": "我。",
                    "start_index": 0,
                    "end_index": 1,
                    "focus": [{"token_indexes": [0], "level": "primary"}],
                    "pauses": [{"after_index": 0, "type": "short", "observed_gap_ms": None}],
                    "prolongations": [],
                    "prosody": [
                        {
                            "type": "falling",
                            "active_span": {"start": 0, "end": 0},
                            "core_zone": {"start": 0, "end": 0},
                            "strength": 1,
                            "confidence": 0.7,
                        }
                    ],
                    "ending_intonation": {"type": "falling", "strength": 1},
                    "rhythm": {"type": "relaxed"},
                    "confidence": 0.8,
                }
            ]
        }
    )
    spec = assemble_control_spec(interpretation, package)
    assert spec["tokens"][0]["char"] == "我"
    assert spec["tokens"][0]["display_pinyin"] == "wǒ"
    assert spec["sentences"][0]["pauses"][0]["observed_gap_ms"] == 320
