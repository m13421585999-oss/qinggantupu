from __future__ import annotations

import asyncio

import pytest

from app.tts_director import generate as director
from app.tts_director.generate import TtsDirectorTextMismatch, validate_tts_text
from app.tts_director.schema import TtsDirectorRequest, TtsDirectorResult
from app.tts_director.system_prompt import TTS_DIRECTOR_SYSTEM_PROMPT


def _result(tts_text: str) -> TtsDirectorResult:
    return TtsDirectorResult.model_validate(
        {
            "performancePlan": {
                "genre": "现代诗",
                "theme": "希望",
                "overallTone": "自然、克制",
                "narratorState": "理解作品后的平静表达",
                "emotionalArc": [
                    {"stage": 1, "description": "平静进入", "delivery": "自然速度"}
                ],
                "climax": "末句",
                "ending": "温暖收束",
            },
            "ttsText": tts_text,
        }
    )


def test_programmatic_validation_allows_only_tags_layout_and_control_punctuation():
    original = "从明天起，做一个幸福的人。\n喂马、劈柴，周游世界。"
    scripted = "[calm]\n从明天起……做一个幸福的人。\n[warmly] 喂马、劈柴，周游世界！"

    validation = validate_tts_text(original, scripted)

    assert validation["matched"] is True
    assert validation["normalized_character_count"] > 0


@pytest.mark.parametrize(
    "scripted",
    [
        "[calm] 从今天起，做一个幸福的人。",
        "[calm] 从明天起，做一个真正幸福的人。",
        "[calm] 从明天起，做一个人。",
    ],
)
def test_programmatic_validation_rejects_rewrite_addition_and_deletion(scripted: str):
    with pytest.raises(TtsDirectorTextMismatch, match="TTS 脚本与原文不一致"):
        validate_tts_text("从明天起，做一个幸福的人。", scripted)


def test_director_repairs_a_semantic_mismatch_once(monkeypatch: pytest.MonkeyPatch):
    calls = 0

    async def fake_generate_once(**kwargs):
        nonlocal calls
        calls += 1
        text = "从今天起，做一个幸福的人。" if calls == 1 else "[calm] 从明天起，做一个幸福的人。"
        return _result(text), {"endpoint": "chat/completions", "output_mode": "json_object", "request_count": 1}

    monkeypatch.setattr(director, "_generate_once", fake_generate_once)
    result = asyncio.run(
        director.generate_tts_performance_plan(
            request=TtsDirectorRequest(
                title="面朝大海，春暖花开",
                author="海子",
                original_text="从明天起，做一个幸福的人。",
            ),
            provider="openai_compatible",
            api_key="test-only",
            base_url="https://example.invalid",
            model="gpt-5.6-sol",
            thinking="enabled",
            reasoning_effort="medium",
            timeout_seconds=30,
        )
    )

    assert calls == 2
    assert result["validation"]["matched"] is True
    assert result["validation"]["repair_count"] == 1
    assert result["ttsText"].startswith("[calm]")


def test_director_knowledge_is_separate_and_forbids_rewriting_and_sound_effects():
    assert "不得改写" in TTS_DIRECTOR_SYSTEM_PROMPT
    assert "不使用 SSML" in TTS_DIRECTOR_SYSTEM_PROMPT
    assert "BGM" in TTS_DIRECTOR_SYSTEM_PROMPT
    assert "声学" in TTS_DIRECTOR_SYSTEM_PROMPT
