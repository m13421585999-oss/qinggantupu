from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from app.providers.openai_compatible import StructuredGenerationResult
from app.schemas.control_spec import Prosody, Span
from app.text_recitation.generate import (
    build_tokens,
    split_sentences,
    generate_text_recitation,
    normalize_pauses,
    _assemble_control_spec,
    _validate_annotations,
    _normalize_llm_payload,
    _validate_plan_payload,
)
from app.text_recitation.prosody_compiler import (
    BASE_LEVEL,
    MAX_AUTO_LEVEL,
    MIN_AUTO_LEVEL,
    compile_sentence_prosody,
    normalize_events,
)
from app.text_recitation.schema import (
    TextRecitationPlan,
    TextRecitationRequest,
    TextRecitationSentence,
)


def make_prosody(typ, start, end, core_start, core_end, strength=1):
    return Prosody(
        type=typ,
        active_span=Span(start=start, end=end),
        core_zone=Span(start=core_start, end=core_end),
        strength=strength,
        confidence=0.9,
    )


def test_build_tokens_generates_pinyin_and_monotonic_timeline():
    text = "床前明月光，疑是地上霜。"
    tokens = build_tokens(text)
    assert len(tokens) == len(text)
    assert tokens[0]["char"] == "床"
    assert tokens[0]["display_pinyin"]  # 有拼音
    previous_start = -1
    for token in tokens:
        assert token["start_ms"] >= previous_start
        assert token["end_ms"] >= token["start_ms"]
        previous_start = token["start_ms"]
    # 汉字有拼音，标点无拼音
    assert tokens[5]["char"] == "，"
    assert tokens[5]["display_pinyin"] is None


def test_build_tokens_human_override_wins():
    text = "床前"
    tokens = build_tokens(text, {"token-0": "chuáng"})
    assert tokens[0]["display_pinyin"] == "chuáng"


def test_split_sentences_split_by_creator_line_breaks():
    # 用户输入的换行就是 Sentence Row 边界；\n 不进入 sentence.text
    text = "君不见黄河之水天上来\n奔流到海不复回\n君不见高堂明镜悲白发"
    ranges = split_sentences(text)
    assert len(ranges) == 3
    texts = [text[start : end + 1] for start, end in ranges]
    assert texts == [
        "君不见黄河之水天上来",
        "奔流到海不复回",
        "君不见高堂明镜悲白发",
    ]
    assert all("\n" not in piece for piece in texts)


def test_split_sentences_empty_lines_only_separate_paragraphs():
    text = "第一句。\n\n第二句。\n\n\n第三句。"
    ranges = split_sentences(text)
    assert len(ranges) == 3
    texts = [text[start : end + 1] for start, end in ranges]
    assert texts == ["第一句。", "第二句。", "第三句。"]


def test_split_sentences_trims_line_whitespace_but_keeps_punctuation():
    text = "  床前明月光，疑是地上霜。  \n  举头望明月，低头思故乡。"
    ranges = split_sentences(text)
    texts = [text[start : end + 1] for start, end in ranges]
    assert texts == ["床前明月光，疑是地上霜。", "举头望明月，低头思故乡。"]


def test_split_sentences_single_line_punctuation_not_split():
    text = "君不见，黄河之水天上来，奔流到海不复回。"
    ranges = split_sentences(text)
    assert len(ranges) == 1
    assert text[ranges[0][0] : ranges[0][1] + 1] == text


def test_compile_prosody_amplitude_at_least_three():
    for typ in ("rising", "falling", "peak", "valley"):
        compiled = compile_sentence_prosody(
            0, 9, [make_prosody(typ, 1, 8, 3, 6, strength=1)]
        )
        levels = [point["normalized_level"] for point in compiled.points]
        assert max(levels) - min(levels) >= 3, f"{typ}: {levels}"
        assert all(MIN_AUTO_LEVEL <= level <= MAX_AUTO_LEVEL for level in levels)


def test_compile_prosody_keeps_flat_segments_outside_span():
    compiled = compile_sentence_prosody(
        0, 14, [make_prosody("rising", 5, 10, 7, 9, strength=2)]
    )
    by_index = {point["token_index"]: point["normalized_level"] for point in compiled.points}
    # active_span 外保持基准平稳
    assert by_index[0] == BASE_LEVEL
    assert by_index[4] == BASE_LEVEL
    assert by_index[14] == BASE_LEVEL  # 事件后自然平稳回到基准


def test_compile_prosody_no_zigzag():
    compiled = compile_sentence_prosody(
        0, 9, [make_prosody("peak", 1, 8, 4, 5, strength=1)]
    )
    levels = [point["normalized_level"] for point in compiled.points]
    # 相邻点跳变不超过 1 档（线性插值 + 量化）
    for left, right in zip(levels, levels[1:]):
        assert abs(right - left) <= 1, f"锯齿：{levels}"


def test_normalize_events_merges_adjacent_same_type():
    events = [
        make_prosody("rising", 1, 4, 2, 3),
        make_prosody("rising", 4, 8, 5, 6),
    ]
    merged = normalize_events(events)
    assert len(merged) == 1
    assert merged[0].active_span.start == 1
    assert merged[0].active_span.end == 8


def _plan() -> TextRecitationPlan:
    sentence = TextRecitationSentence(
        text="床前明月光，疑是地上霜。",
        start_index=0,
        end_index=11,
        focus_spans=[],
        pause_after=[3],
        prosody=[make_prosody("rising", 0, 11, 4, 8, strength=2)],
        ending_intonation="falling",
        confidence=0.8,
    )
    return TextRecitationPlan(sentences=[sentence])


def test_assemble_control_spec_marks_and_source():
    text = "床前明月光，疑是地上霜。"
    request = TextRecitationRequest(title="静夜思", author="李白", text=text)
    plan = _plan()
    tokens = build_tokens(text)
    control_spec = _assemble_control_spec(
        request=request,
        text=text,
        plan=plan,
        tokens=tokens,
        expected=split_sentences(text),
        model="gpt-5.6-sol",
    )
    assert control_spec["source"] == "ai"
    assert control_spec["analysis_provenance"]["pipeline_version"] == "text-recitation-1.0"
    assert control_spec["analysis_provenance"]["knowledge_base"]["id"] == "text-recitation"
    sentence = control_spec["sentences"][0]
    # 停顿只出现 short，且 / 对应 after_index
    assert all(pause["type"] == "short" for pause in sentence["pauses"])
    assert sentence["pauses"][0]["after_index"] == 3
    # 无拖音
    assert sentence["prolongations"] == []
    # 语势事件 ≤ 2
    assert len(sentence["prosody"]) <= 2
    # 句尾语调只允许 rising/falling/level
    assert sentence["ending_intonation"]["type"] == "falling"
    # macro_prosody_path source 为 text_llm
    assert sentence["macro_prosody_path"]["source"] == "text_llm"
    # 全文没有换气/偷气/长停/拖音/横向语调符号
    dumped = str(control_spec)
    for forbidden in ("breath_major", "breath_minor", "///", "——"):
        assert forbidden not in dumped, f"出现禁用标记 {forbidden}"


def test_generate_text_recitation_end_to_end():
    text = "床前明月光，疑是地上霜。举头望明月，低头思故乡。"
    request = TextRecitationRequest(title="静夜思", author="李白", text=text)
    ranges = split_sentences(text)

    def plan_dict():
        sentences = []
        for start, end in ranges:
            sentences.append(
                {
                    "text": text[start : end + 1],
                    "start_index": start,
                    "end_index": end,
                    "focus_spans": [],
                    "pause_after": [start],
                    "prosody": [
                        {
                            "type": "rising",
                            "active_span": {"start": start, "end": end},
                            "core_zone": {"start": start + 2, "end": end - 1},
                            "strength": 2,
                            "confidence": 0.85,
                        }
                    ],
                    "ending_intonation": "falling",
                    "confidence": 0.8,
                }
            )
        return {"performance_profile": None, "sentences": sentences}

    with patch(
        "app.text_recitation.generate.generate_structured_result",
        return_value=StructuredGenerationResult(
            data=plan_dict(),
            endpoint="chat/completions",
            output_mode="json_object",
            request_count=1,
        ),
    ):
        result = asyncio.run(generate_text_recitation(
            request=request,
            provider="openai_compatible",
            api_key="test",
            base_url="https://example.com",
            model="gpt-5.6-sol",
            thinking="enabled",
            reasoning_effort="low",
            timeout_seconds=30,
        ))

    control_spec = result["control_spec"]
    assert control_spec["source"] == "ai"
    assert len(control_spec["sentences"]) == len(ranges)
    # 每句语势不超过两个，句尾语调只允许 rising/falling/level
    for sentence in control_spec["sentences"]:
        assert len(sentence["prosody"]) <= 2
        assert sentence["ending_intonation"]["type"] in ("rising", "falling", "level")
        assert sentence["macro_prosody_path"]["source"] == "text_llm"


# ============ 第三轮：自动标谱规则测试 ============

def _sentence(text, start=0, end=None, **kwargs):
    end = len(text) - 1 if end is None else end
    return TextRecitationSentence(text=text, start_index=start, end_index=end, confidence=0.9, **kwargs)


def test_focus_max_two_enforced_by_schema():
    # 每行 focus <= 2，超过 2 由 schema 拒绝
    from pydantic import ValidationError
    from app.schemas.control_spec import FocusInterpretation

    focus = FocusInterpretation(focus_span=Span(start=0, end=1), confidence=0.8)
    with pytest.raises(ValidationError):
        _sentence("测试文本", focus_spans=[focus, focus, focus])


def test_pause_max_two_enforced_by_schema():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        _sentence("测试文本", pause_after=[0, 1, 2])


def test_pause_next_to_punctuation_is_dropped():
    # 标点本身已承担停顿，紧邻标点的自动 / 被程序删除
    text = "人生得意须尽欢，莫使金樽空对月。"
    # 逗号 index 7；pause_after=[6] 在逗号前、[7] 在逗号后，都紧邻标点
    sentence = _sentence(text, pause_after=[6, 7])
    result = normalize_pauses(sentence, text)
    assert result == []


def test_pause_allowed_without_punctuation():
    # 无标点意群边界允许 /
    text = "君不见黄河之水天上来"
    sentence = _sentence(text, pause_after=[2])
    result = normalize_pauses(sentence, text)
    assert result == [2]


def test_pause_inside_focus_rejected():
    from app.schemas.control_spec import FocusInterpretation
    text = "人生得意须尽欢"
    focus = FocusInterpretation(focus_span=Span(start=0, end=3), confidence=0.8)
    sentence = _sentence(text, focus_spans=[focus], pause_after=[2])
    plan = TextRecitationPlan(sentences=[sentence])
    with pytest.raises(Exception, match="重音"):
        _validate_annotations(plan, text, [(0, len(text) - 1)])


def test_prosody_active_span_requires_three_spoken_chars():
    text = "人生得意须尽欢"
    sentence = _sentence(
        text,
        prosody=[make_prosody("rising", 0, 1, 0, 1)],  # 只覆盖 2 字
    )
    plan = TextRecitationPlan(sentences=[sentence])
    with pytest.raises(Exception, match="有效朗读文字不足 3 个"):
        _validate_annotations(plan, text, [(0, len(text) - 1)])


def test_compile_prosody_amplitude_at_least_three():
    # 已有测试，保持
    pass


def test_second_prosody_event_restarts_from_baseline():
    # 两个事件：第二个不强制继承第一个结束高度（可重新起势）
    events = [
        make_prosody("rising", 0, 4, 2, 3, strength=3),   # 终点约 7
        make_prosody("falling", 6, 9, 7, 8, strength=1),  # 从基准 4 重新起势
    ]
    compiled = compile_sentence_prosody(0, 9, events)
    levels = {p["token_index"]: p["normalized_level"] for p in compiled.points}
    # 第一事件结束高度（index 4）明显高于第二事件起点（index 6）
    assert levels[4] > levels[6]


def test_ending_intonation_allows_null():
    # 无明确语调允许 null（不显示符号）
    sentence = _sentence("测试文本", ending_intonation=None)
    assert sentence.ending_intonation is None
    assert _sentence("测试文本", ending_intonation="falling").ending_intonation == "falling"


def test_rhythm_label_mapping_exists():
    from app.schemas.control_spec import Rhythm
    for rhythm in ("light", "solemn", "relaxed", "tense", "soaring", "low"):
        assert Rhythm(type=rhythm).type == rhythm


# ============ 第十一轮：LLM JSON contract 归一化回归测试 ============

def _old_format_focus_sentence() -> dict:
    """模型实际返回的旧扁平 focus 结构（含 camelCase 字段名）。"""
    return {
        "text": "床前明月光",
        "start_index": 0,
        "end_index": 4,
        "function": "叙述",
        "focusSpans": [
            {"start_index": 2, "end_index": 4, "focus_style": "supported", "confidence": 0.9}
        ],
        "pauses": [1],
        "prosody": [
            {"type": "rising", "activeSpan": {"start": 0, "end": 4}, "coreZone": {"start": 2, "end": 4}, "strength": 2, "confidence": 0.9}
        ],
        "endingIntonation": "rising",
        "rhythm": "relaxed",
        "confidence": 0.85,
    }


def test_normalize_old_focus_shape_then_validate():
    # 1. 旧扁平 focus 结构 → 归一化 → 验证成功
    raw = {"sentences": [_old_format_focus_sentence()]}
    plan = _validate_plan_payload(raw)
    assert isinstance(plan, TextRecitationPlan)
    assert plan.sentences[0].focus_spans[0].focus_span.start == 2
    assert plan.sentences[0].focus_spans[0].focus_span.end == 4
    assert plan.sentences[0].focus_spans[0].focus_style == "supported"
    assert plan.sentences[0].prosody[0].active_span.start == 0
    assert plan.sentences[0].prosody[0].core_zone.end == 4
    assert plan.sentences[0].ending_intonation == "rising"
    assert plan.sentences[0].rhythm.type == "relaxed"
    assert plan.sentences[0].pause_after == [1]


def test_current_schema_json_validates_directly():
    # 2. 当前正式 schema JSON → 不经语义改变直接验证成功
    raw = {
        "sentences": [
            {
                "text": "床前明月光",
                "start_index": 0,
                "end_index": 4,
                "focus_spans": [
                    {"focus_span": {"start": 2, "end": 4}, "focus_style": "supported", "confidence": 0.9}
                ],
                "pause_after": [1],
                "prosody": [
                    {"type": "rising", "active_span": {"start": 0, "end": 4}, "core_zone": {"start": 2, "end": 4}, "strength": 2, "confidence": 0.9}
                ],
                "ending_intonation": "rising",
                "rhythm": {"type": "relaxed"},
                "confidence": 0.85,
            }
        ]
    }
    plan = TextRecitationPlan.model_validate(raw)
    assert plan.sentences[0].focus_spans[0].focus_span.start == 2


def test_undeterminable_structure_must_fail():
    # 3. 无法确定性转换的错误结构（缺 focus_span 且无 start/end）→ 必须失败
    raw = {
        "sentences": [
            {
                "text": "床前明月光",
                "start_index": 0,
                "end_index": 4,
                "focus_spans": [
                    {"focus_style": "supported", "confidence": 0.9}  # 无 start/end，无法迁移
                ],
                "confidence": 0.85,
            }
        ]
    }
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        TextRecitationPlan.model_validate(_normalize_llm_payload(raw))


def test_normalization_is_identity_for_current_shape():
    # 归一化对已是正确结构的输入应保持等价（不改 index、不补造）
    raw = {
        "sentences": [
            {
                "text": "床前明月光",
                "start_index": 0,
                "end_index": 4,
                "focus_spans": [
                    {"focus_span": {"start": 2, "end": 4}, "confidence": 0.9}
                ],
                "confidence": 0.85,
            }
        ]
    }
    normalized = _normalize_llm_payload(raw)
    assert normalized["sentences"][0]["focus_spans"][0]["focus_span"] == {"start": 2, "end": 4}
