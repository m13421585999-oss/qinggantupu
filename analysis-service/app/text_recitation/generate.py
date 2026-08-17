from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError
from pypinyin import Style, lazy_pinyin

from app.providers.openai_compatible import StructuredLlmError, generate_structured_result
from app.text_recitation.prosody_compiler import compile_sentence_prosody
from app.text_recitation.schema import (
    TextRecitationPlan,
    TextRecitationRequest,
    TextRecitationSentence,
)
from app.text_recitation.system_prompt import TEXT_RECITATION_SYSTEM_PROMPT


class TextRecitationError(RuntimeError):
    """A text-recitation request failed; never replace it with demo data."""


PUNCTUATION = set("，。！？、；：,.!?;:\n\r\t ‘’“”\"'（）()【】[]《》〈〉—…·")
HAN = re.compile(r"[\u3400-\u9fff]")
PIPELINE_VERSION = "text-recitation-1.0"
# Synthetic pacing for a manuscript-only timeline. There is no audio, but the
# creator-facing viewer still requires a monotonic start_ms/end_ms per token.
SPOKEN_TOKEN_MS = 240


def normalize_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip("\ufeff")
    if not normalized.strip():
        raise TextRecitationError("正文为空。")
    if len(normalized) > 20_000:
        raise TextRecitationError("正文超过 20000 字上限。")
    return normalized


def pinyin_for_char(char: str) -> tuple[str | None, str | None]:
    if char in PUNCTUATION or not HAN.search(char):
        return None, None
    machine = lazy_pinyin(
        char, style=Style.TONE3, neutral_tone_with_five=True, errors="ignore"
    )
    display = lazy_pinyin(
        char, style=Style.TONE, neutral_tone_with_five=False, errors="ignore"
    )
    return (machine[0] if machine else None, display[0] if display else None)


def build_tokens(
    text: str, pinyin_overrides: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    """Establish a stable per-character token with program-generated pinyin.

    Human pinyin overrides always win over the automatic dictionary pinyin.
    """
    overrides = pinyin_overrides or {}
    tokens: list[dict[str, Any]] = []
    cursor_ms = 0
    for index, char in enumerate(text):
        machine, display = pinyin_for_char(char)
        token_id = f"token-{index}"
        override = overrides.get(token_id)
        if override:
            display = override
        is_spoken = char not in PUNCTUATION and bool(HAN.search(char))
        start_ms = cursor_ms
        end_ms = start_ms + (SPOKEN_TOKEN_MS if is_spoken else 0)
        if is_spoken:
            cursor_ms = end_ms
        tokens.append(
            {
                "index": index,
                "char": char,
                "machine_pinyin": machine,
                "display_pinyin": display,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "confidence": 1.0,
            }
        )
    return tokens


def split_sentences(text: str) -> list[tuple[int, int]]:
    """Split by the creator's own line breaks.

    Every non-empty line becomes one Sentence Row. The newline character never
    enters a sentence's token range; each line's leading/trailing whitespace is
    trimmed; punctuation inside a line is preserved verbatim; empty lines only
    separate paragraphs. The source text itself is never modified.
    """
    ranges: list[tuple[int, int]] = []
    start = 0
    length = len(text)
    for index, char in enumerate(text):
        if char == "\n":
            line = text[start:index]
            if line.strip():
                leading = len(line) - len(line.lstrip())
                ranges.append((start + leading, start + len(line.rstrip()) - 1))
            start = index + 1
    if start < length:
        line = text[start:]
        if line.strip():
            leading = len(line) - len(line.lstrip())
            ranges.append((start + leading, start + len(line.rstrip()) - 1))
    if not ranges:
        ranges = [(0, length - 1)]
    return ranges


def _user_prompt(request: TextRecitationRequest) -> str:
    sentences = split_sentences(request.text)
    sentence_lines: list[str] = []
    for order, (start, end) in enumerate(sentences):
        sentence_lines.append(
            f"[{order}] start_index={start}, end_index={end}, text={request.text[start:end + 1]!r}"
        )
    listing = "\n".join(sentence_lines)
    return (
        "请基于以下作品正文进行朗诵表达分析。正文已按句子切分，"
        "每个句子给出 token 范围（字符索引，从 0 开始）和原文。\n\n"
        f"作品标题：{request.title}\n"
        f"作者或来源：{request.author or '未提供'}\n\n"
        "句子列表（必须逐条对应、顺序一致）：\n"
        f"{listing}\n\n"
        "请对每个句子输出完整分析，text、start_index、end_index 必须与上面完全一致。"
    )


def _validate_plan(plan: TextRecitationPlan, text: str) -> list[tuple[int, int]]:
    expected = split_sentences(text)
    if len(plan.sentences) != len(expected):
        raise TextRecitationError(
            f"文稿分析返回 {len(plan.sentences)} 句，正文实际切分为 {len(expected)} 句。"
        )
    for position, (actual, (start, end)) in enumerate(
        zip(plan.sentences, expected, strict=True), 1
    ):
        exact_text = text[start : end + 1]
        if (
            actual.text != exact_text
            or actual.start_index != start
            or actual.end_index != end
        ):
            raise TextRecitationError(
                f"第 {position} 句正文或 token 范围被改写，已拒绝结果。"
            )
    return expected


def _assemble_control_spec(
    *,
    request: TextRecitationRequest,
    plan: TextRecitationPlan,
    tokens: list[dict[str, Any]],
    expected: list[tuple[int, int]],
    model: str,
) -> dict[str, Any]:
    sentences: list[dict[str, Any]] = []
    for sentence, (start, end) in zip(plan.sentences, expected, strict=True):
        compiled = compile_sentence_prosody(
            min_index=start,
            max_index=end,
            events=list(sentence.prosody),
        )
        sentences.append(
            {
                "text": sentence.text,
                "start_index": sentence.start_index,
                "end_index": sentence.end_index,
                "focus": [
                    {
                        "focus_span": {
                            "start": focus.focus_span.start,
                            "end": focus.focus_span.end,
                        },
                        "level": "primary",
                        "focus_style": focus.focus_style,
                        "confidence": focus.confidence,
                        "explanation": focus.explanation,
                    }
                    for focus in sentence.focus_spans
                ],
                "pauses": [
                    {"after_index": index, "type": "short", "observed_duration_ms": None}
                    for index in sorted(set(sentence.pause_after))
                ],
                "prolongations": [],
                "macro_prosody_path": {
                    "points": compiled.points,
                    "segments": compiled.segments,
                    "source": "text_llm",
                },
                "prosody": [event.model_dump(mode="json") for event in sentence.prosody],
                "ending_intonation": {
                    "type": sentence.ending_intonation or "level",
                    "strength": 1,
                    "confidence": 1.0,
                },
                "rhythm": sentence.rhythm.model_dump(mode="json")
                if sentence.rhythm
                else {"type": "relaxed"},
                **(
                    {
                        "performance_profile": sentence.performance_profile.model_dump(
                            mode="json", exclude_none=True
                        )
                    }
                    if sentence.performance_profile is not None
                    else {}
                ),
                "text_logic": sentence.text_logic,
                "emotional_interpretation": sentence.emotional_interpretation,
                "confidence": sentence.confidence,
            }
        )

    return {
        "source": "ai",
        "schema_version": "2.0",
        "performance_profile": (
            plan.performance_profile.model_dump(mode="json", exclude_none=True)
            if plan.performance_profile is not None
            else None
        ),
        "tokens": tokens,
        "sentences": sentences,
        "pinyin_overrides": request.pinyin_overrides,
        "analysis_provenance": {
            "pipeline_version": PIPELINE_VERSION,
            "language_model": model,
            "knowledge_base": {
                "id": "text-recitation",
                "version": "v1",
                "scope": "system",
            },
            "generated_at": datetime.now(UTC).isoformat(),
        },
        "validation": {"state": "valid", "issues": []},
    }


async def _generate_once(
    *,
    request: TextRecitationRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
    repair: str | None = None,
) -> tuple[TextRecitationPlan, dict[str, Any]]:
    schema = TextRecitationPlan.model_json_schema()
    user_prompt = _user_prompt(request)
    if repair:
        user_prompt += (
            f"\n\n上一份输出未通过正文一致性校验。请保持正文和 token 范围不变，重新输出。\n校验错误：{repair[:800]}"
        )
    try:
        generation = await generate_structured_result(
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            system_prompt=TEXT_RECITATION_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            schema_name="text_recitation_plan",
            schema=schema,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            temperature=0.2,
            timeout_seconds=timeout_seconds,
            validator=TextRecitationPlan.model_validate,
            prefer_chat_json=True,
        )
        plan = TextRecitationPlan.model_validate(generation.data)
    except (StructuredLlmError, ValidationError, ValueError) as exc:
        raise TextRecitationError(f"文稿分析生成失败：{exc}") from exc
    return plan, {
        "endpoint": generation.endpoint,
        "output_mode": generation.output_mode,
        "request_count": generation.request_count,
    }


async def generate_text_recitation(
    *,
    request: TextRecitationRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    text = normalize_text(request.text)
    tokens = build_tokens(text, request.pinyin_overrides)
    plan, metadata = await _generate_once(
        request=request,
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        timeout_seconds=timeout_seconds,
    )
    try:
        expected = _validate_plan(plan, text)
        repair_count = 0
    except TextRecitationError as first_error:
        plan, repair_metadata = await _generate_once(
            request=request,
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            timeout_seconds=timeout_seconds,
            repair=str(first_error),
        )
        try:
            expected = _validate_plan(plan, text)
        except TextRecitationError as second_error:
            raise TextRecitationError("文稿分析与正文不一致") from second_error
        metadata = {
            **repair_metadata,
            "request_count": metadata["request_count"] + repair_metadata["request_count"],
        }
        repair_count = 1

    control_spec = _assemble_control_spec(
        request=request,
        plan=plan,
        tokens=tokens,
        expected=expected,
        model=model,
    )
    return {
        "control_spec": control_spec,
        "validation": {"repair_count": repair_count},
        "_meta": metadata,
    }
