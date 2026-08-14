from __future__ import annotations

import re
import unicodedata
from typing import Any

from pydantic import ValidationError

from app.providers.openai_compatible import StructuredLlmError, generate_structured_result
from app.tts_director.schema import TtsDirectorRequest, TtsDirectorResult
from app.tts_director.system_prompt import TTS_DIRECTOR_SYSTEM_PROMPT


class TtsDirectorError(RuntimeError):
    """A TTS-director request failed before any ElevenLabs call."""


class TtsDirectorTextMismatch(TtsDirectorError):
    """The generated execution script changed the source manuscript."""


_AUDIO_TAG = re.compile(r"\[[^\[\]\r\n]{1,160}\]")


def semantic_text(value: str, *, strip_audio_tags: bool) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    if strip_audio_tags:
        normalized = _AUDIO_TAG.sub("", normalized)
    return "".join(
        character
        for character in normalized
        if unicodedata.category(character)[:1] in {"L", "N"}
    )


def validate_tts_text(original_text: str, tts_text: str) -> dict[str, Any]:
    expected = semantic_text(original_text, strip_audio_tags=False)
    actual = semantic_text(tts_text, strip_audio_tags=True)
    if not expected:
        raise TtsDirectorTextMismatch("原文没有可校验的文字内容。")
    if expected == actual:
        return {
            "matched": True,
            "normalized_character_count": len(expected),
        }
    mismatch = next(
        (
            index
            for index, (left, right) in enumerate(zip(expected, actual))
            if left != right
        ),
        min(len(expected), len(actual)),
    )
    expected_excerpt = expected[max(0, mismatch - 8) : mismatch + 12]
    actual_excerpt = actual[max(0, mismatch - 8) : mismatch + 12]
    raise TtsDirectorTextMismatch(
        "TTS 脚本与原文不一致："
        f"第 {mismatch + 1} 个正文字符附近，原文为“{expected_excerpt}”，"
        f"脚本为“{actual_excerpt}”。"
    )


def _user_prompt(request: TtsDirectorRequest, repair: str | None = None) -> str:
    prompt = (
        "请先从全文设计朗诵，再输出 performancePlan 与可直接提交给 Eleven v3 的 ttsText。"
        "ttsText 只能在原文上增加 Audio Tags、朗读标点和换行，不能改变任何正文词语或顺序。"
        f"\n\n作品标题：{request.title}"
        f"\n作者或来源：{request.author or '未提供'}"
        f"\n\n原始正文（必须逐字保护）：\n{request.original_text}"
    )
    if repair:
        prompt += (
            "\n\n上一版 ttsText 未通过程序正文一致性校验。请保留朗诵导演意图，"
            "但重新生成 ttsText，确保去掉 Audio Tags 与控制性标点后，正文字符与原文完全一致。"
            f"\n校验错误：{repair[:1_000]}"
        )
    return prompt


async def _generate_once(
    *,
    request: TtsDirectorRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
    repair: str | None = None,
) -> tuple[TtsDirectorResult, dict[str, Any]]:
    schema = TtsDirectorResult.model_json_schema(by_alias=True)
    try:
        generation = await generate_structured_result(
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            system_prompt=TTS_DIRECTOR_SYSTEM_PROMPT,
            user_prompt=_user_prompt(request, repair),
            schema_name="tts_recitation_director",
            schema=schema,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            temperature=0.2,
            timeout_seconds=timeout_seconds,
            validator=TtsDirectorResult.model_validate,
            prefer_chat_json=True,
        )
        result = TtsDirectorResult.model_validate(generation.data)
    except (StructuredLlmError, ValidationError, ValueError) as exc:
        raise TtsDirectorError(f"朗诵方案生成失败：{exc}") from exc
    return result, {
        "endpoint": generation.endpoint,
        "output_mode": generation.output_mode,
        "request_count": generation.request_count,
    }


async def generate_tts_performance_plan(
    *,
    request: TtsDirectorRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    result, metadata = await _generate_once(
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
        validation = validate_tts_text(request.original_text, result.tts_text)
        repair_count = 0
    except TtsDirectorTextMismatch as first_error:
        result, repair_metadata = await _generate_once(
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
            validation = validate_tts_text(request.original_text, result.tts_text)
        except TtsDirectorTextMismatch as second_error:
            raise TtsDirectorTextMismatch("TTS 脚本与原文不一致") from second_error
        metadata = {
            **repair_metadata,
            "request_count": metadata["request_count"] + repair_metadata["request_count"],
        }
        repair_count = 1
    return {
        **result.model_dump(mode="json", by_alias=True),
        "validation": {
            **validation,
            "repair_count": repair_count,
        },
        "_meta": metadata,
    }
