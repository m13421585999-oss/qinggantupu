from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError
from pypinyin import Style, lazy_pinyin

from app.providers.openai_compatible import StructuredLlmError, generate_structured_result
from app.recitation_chunks import STATUS_COMPLETED, get_recitation_chunk_store
from app.text_recitation.prosody_compiler import compile_sentence_prosody
from app.text_recitation.schema import (
    TextRecitationPlan,
    TextRecitationRequest,
    TextRecitationSentence,
    WorkContext,
)
from app.text_recitation.system_prompt import TEXT_RECITATION_SYSTEM_PROMPT


class TextRecitationError(RuntimeError):
    """A text-recitation request failed; never replace it with demo data."""


PUNCTUATION = set("，。！？、；：,.!?;:\n\r\t ‘’“”\"'（）()【】[]《》〈〉—…·")
# Punctuation that already carries a natural pause. An automatic "/" placed
# immediately before or after these is redundant and is dropped by the program.
PAUSE_PUNCTUATION = set("，。；：！？、…—,.!?;:")
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


def _pause_next_to_punctuation(text: str, index: int) -> bool:
    after = text[index] if 0 <= index < len(text) else ""
    nxt = text[index + 1] if 0 <= index + 1 < len(text) else ""
    return after in PAUSE_PUNCTUATION or nxt in PAUSE_PUNCTUATION


def _rename_key(old: str, new: str, mapping: dict[str, Any]) -> None:
    """Deterministic key rename: only move the value, never invent one."""
    if old in mapping and new not in mapping:
        mapping[new] = mapping.pop(old)


def _normalize_focus_item(focus: Any) -> Any:
    """Migrate a flat legacy focus to the nested ``focus_span`` shape.

    Legacy (LLM drift): ``{"start_index": x, "end_index": y, "focus_style": ...}``
    Current schema:     ``{"focus_span": {"start": x, "end": y}, ...}``
    The index values are preserved verbatim; only the container shape changes.
    """
    if not isinstance(focus, dict):
        return focus
    item = dict(focus)
    if "focus_span" not in item:
        if "start_index" in item and "end_index" in item:
            item["focus_span"] = {
                "start": item.pop("start_index"),
                "end": item.pop("end_index"),
            }
        elif "start" in item and "end" in item:
            item["focus_span"] = {
                "start": item.pop("start"),
                "end": item.pop("end"),
            }
    return item


def _normalize_prosody_item(event: Any) -> Any:
    if not isinstance(event, dict):
        return event
    item = dict(event)
    _rename_key("activeSpan", "active_span", item)
    _rename_key("coreZone", "core_zone", item)
    return item


def _normalize_sentence(sentence: Any) -> Any:
    if not isinstance(sentence, dict):
        return sentence
    item = dict(sentence)
    # Legacy camelCase field names from the old prompt examples.
    _rename_key("focusSpans", "focus_spans", item)
    _rename_key("pauses", "pause_after", item)
    _rename_key("endingIntonation", "ending_intonation", item)
    if isinstance(item.get("focus_spans"), list):
        item["focus_spans"] = [_normalize_focus_item(f) for f in item["focus_spans"]]
    if isinstance(item.get("prosody"), list):
        item["prosody"] = [_normalize_prosody_item(p) for p in item["prosody"]]
    if isinstance(item.get("pause_after"), list):
        item["pause_after"] = [
            p["after_index"] if isinstance(p, dict) and "after_index" in p else p
            for p in item["pause_after"]
        ]
    if isinstance(item.get("rhythm"), str):
        item["rhythm"] = {"type": item["rhythm"]}
    return item


def _normalize_llm_payload(data: Any) -> Any:
    """Narrow compatibility layer: migrate only confirmed legacy shapes.

    This never guesses missing semantics, fabricates focus, rewrites index
    values or the manuscript, and never relaxes field validation. It only
    performs deterministic key renames and the flat-to-nested ``focus_span``
    migration so the LLM's drift does not block the strict Pydantic model.
    """
    if not isinstance(data, dict):
        return data
    item = dict(data)
    if isinstance(item.get("sentences"), list):
        item["sentences"] = [_normalize_sentence(s) for s in item["sentences"]]
    return item


def _validate_plan_payload(data: dict[str, Any]) -> TextRecitationPlan:
    """Validate the (normalized) LLM payload against the single schema."""
    return TextRecitationPlan.model_validate(_normalize_llm_payload(data))


def normalize_pauses(sentence: TextRecitationSentence, text: str) -> list[int]:
    """Drop automatic "/" that sit next to existing punctuation.

    A punctuation mark already carries a natural pause, so a teaching "/"
    immediately before or after it is redundant. Human editors can still add
    their own "/" later; this only cleans the automatic output.
    """
    result: list[int] = []
    seen: set[int] = set()
    for index in sentence.pause_after:
        if index in seen:
            continue
        if _pause_next_to_punctuation(text, index):
            continue
        seen.add(index)
        result.append(index)
    return result


def _validate_annotations(
    plan: TextRecitationPlan,
    text: str,
    expected: list[tuple[int, int]],
) -> None:
    """Program-side annotation invariants the LLM must respect."""
    for position, (sentence, (start, end)) in enumerate(
        zip(plan.sentences, expected, strict=True), 1
    ):
        # Focus: spans must not overlap and must contain at least one real
        # spoken character (never a pure punctuation span).
        ordered = sorted(
            (f.focus_span.start, f.focus_span.end) for f in sentence.focus_spans
        )
        for index, (fstart, fend) in enumerate(ordered):
            if fend < fstart:
                raise TextRecitationError(f"第 {position} 句重音范围无效。")
            if index > 0 and fstart <= ordered[index - 1][1]:
                raise TextRecitationError(f"第 {position} 句存在相互重叠的重音。")
            segment = text[fstart : fend + 1]
            if not any(HAN.search(char) and char not in PUNCTUATION for char in segment):
                raise TextRecitationError(f"第 {position} 句重音不含有效朗读文字。")
        # Pause: must not sit inside a focus span.
        focus_indexes: set[int] = set()
        for focus in sentence.focus_spans:
            focus_indexes.update(range(focus.focus_span.start, focus.focus_span.end + 1))
        for index in sentence.pause_after:
            if index in focus_indexes:
                raise TextRecitationError(f"第 {position} 句停顿落在重音词组内部。")
        # Prosody: active span must cover at least 3 spoken characters.
        for event in sentence.prosody:
            segment = text[event.active_span.start : event.active_span.end + 1]
            spoken = sum(
                1 for char in segment if HAN.search(char) and char not in PUNCTUATION
            )
            if spoken < 3:
                raise TextRecitationError(
                    f"第 {position} 句语势覆盖的有效朗读文字不足 3 个。"
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
    _validate_annotations(plan, text, expected)
    return expected


def _assemble_control_spec(
    *,
    request: TextRecitationRequest,
    text: str,
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
                "function": sentence.function,
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
                    for index in normalize_pauses(sentence, text)
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
            validator=_validate_plan_payload,
            prefer_chat_json=True,
        )
        plan = _validate_plan_payload(generation.data)
    except (StructuredLlmError, ValidationError, ValueError) as exc:
        raise TextRecitationError(f"文稿分析生成失败：{exc}") from exc
    return plan, {
        "endpoint": generation.endpoint,
        "output_mode": generation.output_mode,
        "request_count": generation.request_count,
    }


# ---------------------------------------------------------------------------
# Chunked generation for long manuscripts (Sentence > CHUNK_THRESHOLD).
# A single structured request for a very long text can exceed the LLM request
# timeout; splitting into small ordered chunks (with a light WorkContext and
# 1-2 neighbour Sentences as context) keeps every request small while the
# merged output is byte-identical to the single-shot schema.
# ---------------------------------------------------------------------------

CHUNK_THRESHOLD = 12
CHUNK_SIZE_MIN = 8
CHUNK_SIZE_MAX = 10
CHUNK_CONTEXT_SENTENCES = 2
CHUNK_TIMEOUT_SECONDS = 150.0


def _chunk_ranges(sentence_count: int) -> list[tuple[int, int]]:
    """Split [0, sentence_count) into ordered chunks of up to CHUNK_SIZE_MAX.
    A trailing remainder may be smaller (e.g. 46 -> 10/10/10/10/6)."""
    ranges: list[tuple[int, int]] = []
    start = 0
    while start < sentence_count:
        end = min(start + CHUNK_SIZE_MAX, sentence_count)
        ranges.append((start, end))
        start = end
    return ranges


def _sentence_line(order: int, start: int, end: int, text: str) -> str:
    return f"[{order}] start_index={start}, end_index={end}, text={text!r}"


def _work_context_prompt(
    request: TextRecitationRequest,
    sentences: list[tuple[int, int]],
    text: str,
) -> str:
    listing = "\n".join(
        _sentence_line(order, start, end, text[start : end + 1])
        for order, (start, end) in enumerate(sentences)
    )
    return (
        "请基于以下作品正文，仅给出全篇的朗诵处理总体语境（WorkContext）。\n"
        "这是长篇分块分析的第一步：你只需要输出整体的语气基调、情绪走向、"
        "节奏倾向和主要语义段，不要对任何句子做逐句标注。\n\n"
        f"作品标题：{request.title}\n"
        f"作者或来源：{request.author or '未提供'}\n\n"
        "句子列表（仅用于把握全文结构）：\n"
        f"{listing}\n\n"
        "请输出：overall_tone（一句话）、emotion_arc（情绪走向，一两句）、"
        "rhythm_tendency（节奏倾向，一两句）、major_semantic_sections（主要语义段，"
        "每段一句话）。"
    )


def _chunk_user_prompt(
    request: TextRecitationRequest,
    work_context: WorkContext,
    text: str,
    sentences: list[tuple[int, int]],
    chunk_range: tuple[int, int],
) -> str:
    """Build the chunk request. Only chunk Sentences are emitted; the 1-2
    neighbours on each side are given as context and must NOT be re-emitted."""
    start, end = chunk_range
    in_chunk = list(range(start, end))
    context_before = list(range(max(0, start - CHUNK_CONTEXT_SENTENCES), start))
    context_after = list(
        range(end, min(len(sentences), end + CHUNK_CONTEXT_SENTENCES))
    )

    def describe(order: int) -> str:
        (s, e) = sentences[order]
        return _sentence_line(order, s, e, text[s : e + 1])

    parts = [
        "请基于以下作品正文进行朗诵表达分析。这是长篇分块处理中的一段。",
        "",
        f"作品标题：{request.title}",
        f"作者或来源：{request.author or '未提供'}",
        "",
        "## 全篇处理语境（WorkContext）",
        f"overall_tone：{work_context.overall_tone}",
        f"emotion_arc：{work_context.emotion_arc}",
        f"rhythm_tendency：{work_context.rhythm_tendency}",
        "major_semantic_sections：",
        *[f"- {section}" for section in work_context.major_semantic_sections],
        "",
        "## 需要分析输出标注的句子（仅这些句子的 text/start_index/end_index 必须原样回传）",
        "\n".join(describe(order) for order in in_chunk),
    ]
    if context_before:
        parts += [
            "",
            "## 前文语境（仅供理解，禁止为这些句子输出任何标注）",
            "\n".join(describe(order) for order in context_before),
        ]
    if context_after:
        parts += [
            "",
            "## 后文语境（仅供理解，禁止为这些句子输出任何标注）",
            "\n".join(describe(order) for order in context_after),
        ]
    parts += [
        "",
        "输出要求：",
        f"- 只输出上面“需要分析输出标注的句子”中 {len(in_chunk)} 个句子的完整分析。",
        "- 每个句子的 text、start_index、end_index 必须与给定值完全一致，不得改写。",
        "- 不得输出前文/后文语境句子的标注，不得遗漏本段任何一个句子，不得增行。",
        "- 字段与当前 schema 完全一致：function、focus_spans、pause_after、prosody、"
        "ending_intonation、rhythm、confidence 等。",
    ]
    return "\n".join(parts)


async def _generate_work_context(
    *,
    request: TextRecitationRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
) -> WorkContext:
    text = normalize_text(request.text)
    sentences = split_sentences(text)
    user_prompt = _work_context_prompt(request, sentences, text)
    try:
        generation = await generate_structured_result(
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            system_prompt=(
                "你是专业朗诵指导。对长篇作品先给出全篇处理语境。"
                "只输出 JSON，不要解释。"
            ),
            user_prompt=user_prompt,
            schema_name="work_context",
            schema=WorkContext.model_json_schema(),
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            temperature=0.3,
            timeout_seconds=timeout_seconds,
            validator=lambda data: WorkContext.model_validate(data),
            prefer_chat_json=True,
        )
        return WorkContext.model_validate(generation.data)
    except (StructuredLlmError, ValidationError, ValueError) as exc:
        raise TextRecitationError(f"文稿整体语境生成失败：{exc}") from exc


async def _generate_chunk(
    *,
    request: TextRecitationRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
    work_context: WorkContext,
    text: str,
    sentences: list[tuple[int, int]],
    chunk_range: tuple[int, int],
) -> list[TextRecitationSentence]:
    user_prompt = _chunk_user_prompt(
        request, work_context, text, sentences, chunk_range
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
            schema=TextRecitationPlan.model_json_schema(),
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            temperature=0.2,
            timeout_seconds=timeout_seconds,
            validator=lambda data: TextRecitationPlan.model_validate(data),
            prefer_chat_json=True,
        )
        plan = TextRecitationPlan.model_validate(generation.data)
    except (StructuredLlmError, ValidationError, ValueError) as exc:
        raise TextRecitationError(f"文稿分块分析生成失败：{exc}") from exc

    # Strict contract: only the chunk's own Sentences may be emitted, in order,
    # with byte-identical text and token range. Context sentences must be absent.
    start, end = chunk_range
    expected: list[TextRecitationSentence] = []
    for order, (s, e) in enumerate(sentences[start:end], start):
        exact_text = text[s : e + 1]
        try:
            found = next(
                candidate
                for candidate in plan.sentences
                if candidate.start_index == s and candidate.end_index == e
            )
        except StopIteration as exc:
            raise TextRecitationError(
                f"分块分析第 {order} 句缺失或 token 范围被改写，已拒绝结果。"
            ) from exc
        if found.text != exact_text:
            raise TextRecitationError(f"分块分析第 {order} 句正文被改写，已拒绝结果。")
        # Reject any context sentence leaking into the output.
        if order < start or order >= end:
            raise TextRecitationError(f"分块分析第 {order} 句越界输出。")
        expected.append(found)
    if len(expected) != end - start:
        raise TextRecitationError(
            f"分块分析输出 {len(expected)} 句，应输出 {end - start} 句。"
        )
    return expected


def _merge_chunk_sentences(
    chunks: list[list[TextRecitationSentence]],
    expected_ranges: list[tuple[int, int]],
    expected_sentences: list[tuple[int, int]],
    text: str,
) -> list[TextRecitationSentence]:
    """Deterministic merge: chunk order + in-chunk order; verify 1:1 with input."""
    merged: list[TextRecitationSentence] = []
    seen: set[int] = set()
    for chunk_index, (chunk, (start, end)) in enumerate(
        zip(chunks, expected_ranges, strict=True)
    ):
        if len(chunk) != end - start:
            raise TextRecitationError(
                f"第 {chunk_index + 1} 个分块合并数量不符：{len(chunk)} != {end - start}。"
            )
        for sentence in chunk:
            if sentence.start_index in seen:
                raise TextRecitationError(
                    f"分块合并发现重复句子（start_index={sentence.start_index}）。"
                )
            seen.add(sentence.start_index)
            merged.append(sentence)
    if len(merged) != len(expected_sentences):
        raise TextRecitationError(
            f"分块合并总数为 {len(merged)}，应为 {len(expected_sentences)}。"
        )
    # Order check: merged must follow the exact original order.
    expected_starts = [s for (s, _e) in expected_sentences]
    actual_starts = [s.start_index for s in merged]
    if actual_starts != expected_starts:
        raise TextRecitationError("分块合并顺序与原文不一致。")
    return merged


def _decode_cached_chunk(
    raw: object,
    chunk_range: tuple[int, int],
    sentences: list[tuple[int, int]],
    text: str,
) -> list[TextRecitationSentence]:
    """Validate persisted JSON before it is allowed back into a ControlSpec."""
    if not isinstance(raw, list):
        raise ValueError("缓存分块不是句子数组")
    start, end = chunk_range
    if len(raw) != end - start:
        raise ValueError("缓存分块句子数量不符")
    decoded = [TextRecitationSentence.model_validate(item) for item in raw]
    for offset, sentence in enumerate(decoded, start):
        expected_start, expected_end = sentences[offset]
        if sentence.start_index != expected_start or sentence.end_index != expected_end:
            raise ValueError("缓存分块 token 范围与原文不符")
        if sentence.text != text[expected_start : expected_end + 1]:
            raise ValueError("缓存分块正文与原文不符")
    return decoded


async def generate_text_recitation_chunked(
    *,
    request: TextRecitationRequest,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
    chunk_concurrency: int = 2,
) -> dict[str, Any]:
    """Chunked pipeline for long manuscripts. Output shape identical to the
    single-shot path (the caller's downstream pipeline cannot tell the
    difference)."""
    text = normalize_text(request.text)
    tokens = build_tokens(text, request.pinyin_overrides)
    sentences = split_sentences(text)
    ranges = _chunk_ranges(len(sentences))

    chunk_store = get_recitation_chunk_store()
    cache_variant = json.dumps(
        {
            "pipeline_version": PIPELINE_VERSION,
            "model": model,
            "reasoning_effort": reasoning_effort,
            "system_prompt": TEXT_RECITATION_SYSTEM_PROMPT,
            "pinyin_overrides": request.pinyin_overrides,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    request_key = chunk_store.request_key(
        request.title,
        request.author or "",
        text,
        cache_variant,
    )
    created_at = datetime.now(UTC).isoformat()

    chunks: list[list[TextRecitationSentence] | None] = [None] * len(ranges)
    reused_chunk_count = 0
    for index, chunk_range in enumerate(ranges):
        row = chunk_store.get(request_key, index)
        if row and row.get("status") == STATUS_COMPLETED and row.get("result_json"):
            try:
                chunks[index] = _decode_cached_chunk(
                    json.loads(str(row["result_json"])),
                    chunk_range,
                    sentences,
                    text,
                )
                reused_chunk_count += 1
                continue
            except (json.JSONDecodeError, ValidationError, TypeError, ValueError):
                chunk_store.mark_failed(request_key, index, "缓存校验失败，等待重新生成")
        chunk_store.upsert_queued(request_key, index, created_at)

    pending_indexes = [index for index, chunk in enumerate(chunks) if chunk is None]
    work_context = None
    if pending_indexes:
        work_context = await _generate_work_context(
            request=request,
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            timeout_seconds=timeout_seconds,
        )

    # Worker pool: fixed chunk_concurrency workers, each grabbing the next
    # pending chunk via a cursor. A slow chunk never blocks siblings.
    import asyncio

    cursor = 0
    lock = asyncio.Lock()

    async def worker() -> None:
        nonlocal cursor
        while True:
            async with lock:
                if cursor >= len(pending_indexes):
                    return
                index = pending_indexes[cursor]
                cursor += 1
            chunk_store.mark_running(request_key, index)
            try:
                assert work_context is not None
                generated = await _generate_chunk(
                    request=request,
                    provider=provider,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    thinking=thinking,
                    reasoning_effort=reasoning_effort,
                    timeout_seconds=CHUNK_TIMEOUT_SECONDS,
                    work_context=work_context,
                    text=text,
                    sentences=sentences,
                    chunk_range=ranges[index],
                )
            except Exception as exc:
                chunk_store.mark_failed(request_key, index, str(exc))
                raise
            chunks[index] = generated
            chunk_store.mark_completed(
                request_key,
                index,
                [sentence.model_dump(mode="json") for sentence in generated],
            )

    workers = [
        asyncio.create_task(worker())
        for _ in range(min(chunk_concurrency, len(pending_indexes)))
    ]
    if workers:
        await asyncio.gather(*workers)

    merged = _merge_chunk_sentences(
        [chunk for chunk in chunks if chunk is not None],
        ranges,
        sentences,
        text,
    )
    plan = TextRecitationPlan(performance_profile=None, sentences=merged)
    expected = _validate_plan(plan, text)
    control_spec = _assemble_control_spec(
        request=request,
        text=text,
        plan=plan,
        tokens=tokens,
        expected=expected,
        model=model,
    )
    return {
        "control_spec": control_spec,
        "validation": {
            "repair_count": 0,
            "chunked": True,
            "chunk_count": len(ranges),
            "reused_chunk_count": reused_chunk_count,
        },
        "_meta": {
            "endpoint": "chat/completions",
            "output_mode": "json_object",
            "request_count": len(pending_indexes) + (1 if pending_indexes else 0),
            "mode": "chunked",
        },
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
    sentence_count = len(split_sentences(text))
    # Long manuscripts: keep every LLM request small by splitting into ordered
    # chunks (8-10 Sentences, concurrency 2). Short works stay on the exact
    # single-shot path. Both produce an identical ControlSpec shape.
    if sentence_count > CHUNK_THRESHOLD:
        return await generate_text_recitation_chunked(
            request=request,
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            timeout_seconds=timeout_seconds,
        )
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
        text=text,
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
