from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from pydantic import ValidationError

from app.acoustics.prolongation import classify_prolongation_candidates
from app.schemas.control_spec import LlmInterpretation


class InterpretationError(RuntimeError):
    """A structured LLM interpretation failure; never replace it with demo data."""


def _compact_evidence(analysis_package: dict[str, Any]) -> dict[str, Any]:
    acoustics = {
        int(item["token_index"]): item
        for item in analysis_package.get("acoustic_evidence", {}).get("tokens", [])
    }
    tokens = []
    for token in analysis_package["tokens"]:
        evidence = acoustics.get(int(token["index"]), {})
        tokens.append(
            {
                "index": token["index"],
                "char": token["char"],
                "start_ms": token["start_ms"],
                "end_ms": token["end_ms"],
                "duration_ms": evidence.get("duration_ms"),
                "local_duration_ratio": evidence.get("local_duration_ratio"),
                "alignment_duration_ms": evidence.get("alignment_duration_ms"),
                "effective_voiced_duration_ms": evidence.get(
                    "effective_voiced_duration_ms"
                ),
                "effective_voiced_duration_ratio": evidence.get(
                    "effective_voiced_duration_ratio"
                ),
                "voiced_continuity_ratio": evidence.get("voiced_continuity_ratio"),
                "low_energy_tail_ms": evidence.get("low_energy_tail_ms"),
                "pause_after_ms": evidence.get("pause_after_ms"),
                "normalized_pitch": evidence.get("normalized_pitch"),
                "normalized_energy": evidence.get("normalized_energy"),
                "voiced_ratio": evidence.get("voiced_ratio"),
                "silence_gap_before_ms": evidence.get("silence_gap_before_ms"),
                "silence_gap_after_ms": evidence.get("silence_gap_after_ms"),
            }
        )
    return {
        "work": analysis_package["work"],
        "audio_provenance": {
            "analyzed_audio_role": analysis_package.get("analyzed_audio_role"),
            "standard_ai_audio_asset_id": analysis_package.get(
                "standard_ai_audio_asset_id"
            ),
            "reference_audio_original_asset_id": analysis_package.get(
                "reference_audio_original_asset_id"
            ),
        },
        "alignment_quality": analysis_package["alignment_quality"],
        "tokens": tokens,
        "observed_pauses": analysis_package["acoustic_evidence"]["pauses"],
        "duration_outliers": analysis_package["acoustic_evidence"]["duration_outliers"],
        "energy_changes": analysis_package["acoustic_evidence"]["energy_changes"],
        "sentence_summaries": analysis_package["segments"],
    }


def _extract_content(payload: dict[str, Any]) -> str:
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise InterpretationError("LLM response did not contain a message") from exc
    if message.get("refusal"):
        raise InterpretationError(f"LLM refused the interpretation: {message['refusal']}")
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [str(item.get("text") or "") for item in content if isinstance(item, dict)]
        if any(texts):
            return "".join(texts)
    raise InterpretationError("LLM response did not contain JSON content")


def _validate_against_analysis(
    interpretation: LlmInterpretation,
    analysis_package: dict[str, Any],
) -> None:
    expected = analysis_package["segments"]
    if len(interpretation.sentences) != len(expected):
        raise InterpretationError(
            f"LLM returned {len(interpretation.sentences)} sentences; {len(expected)} were expected"
        )
    for position, (actual, source) in enumerate(zip(interpretation.sentences, expected, strict=True), 1):
        if (
            actual.text != source["text"]
            or actual.start_index != source["start_index"]
            or actual.end_index != source["end_index"]
        ):
            raise InterpretationError(f"LLM changed the text or token range of sentence {position}")


def _focus_core(
    *,
    start: int,
    end: int,
    acoustics: dict[int, dict[str, Any]],
) -> dict[str, int]:
    scored: list[tuple[float, int]] = []
    for index in range(start, end + 1):
        evidence = acoustics.get(index, {})
        duration_ratio = float(evidence.get("local_duration_ratio") or 1)
        energy = abs(float(evidence.get("normalized_energy") or 0))
        pitch = abs(float(evidence.get("normalized_pitch") or 0))
        voiced = float(evidence.get("voiced_ratio") or 0)
        score = abs(duration_ratio - 1) * 0.42 + energy * 0.32 + pitch * 0.21 + voiced * 0.05
        scored.append((score, index))
    if not scored:
        return {"start": start, "end": start}
    scored.sort(reverse=True)
    best_score, best_index = scored[0]
    core_indexes = [best_index]
    for score, index in scored[1:]:
        if abs(index - best_index) == 1 and best_score > 0 and score >= best_score * 0.86:
            core_indexes.append(index)
    return {"start": min(core_indexes), "end": max(core_indexes)}


def _acoustic_pauses(
    analysis_package: dict[str, Any], start: int, end: int
) -> list[dict[str, Any]]:
    return [
        {
            "after_index": int(item["after_index"]),
            "type": "long" if item.get("relative_level") == "long" else "short",
            "observed_gap_ms": int(item["gap_ms"]),
            "source": "acoustic",
            "confidence": 0.95,
        }
        for item in analysis_package["acoustic_evidence"].get("pauses", [])
        if start <= int(item["after_index"]) <= end
    ]


def assemble_control_spec(
    interpretation: LlmInterpretation,
    analysis_package: dict[str, Any],
) -> dict[str, Any]:
    _validate_against_analysis(interpretation, analysis_package)
    acoustics = {
        int(item["token_index"]): item
        for item in analysis_package.get("acoustic_evidence", {}).get("tokens", [])
    }
    sentences = []
    confirmed_prolongations: list[dict[str, Any]] = []
    audited_candidates: list[dict[str, Any]] = []
    internal_analysis = analysis_package.get("internal_analysis")
    internal_analysis = internal_analysis if isinstance(internal_analysis, dict) else {}
    raw_candidates = internal_analysis.get(
        "prolongation_candidates",
        analysis_package.get("acoustic_evidence", {}).get(
            "prolongation_candidates", []
        ),
    )
    raw_candidates = raw_candidates if isinstance(raw_candidates, list) else []
    for sentence, segment in zip(
        interpretation.sentences,
        analysis_package["segments"],
        strict=True,
    ):
        focus = []
        for entry in sentence.focus_spans:
            span = entry.focus_span.model_dump(mode="json")
            focus.append(
                {
                    "focus_span": span,
                    "focus_core": _focus_core(
                        start=span["start"],
                        end=span["end"],
                        acoustics=acoustics,
                    ),
                    "level": "primary",
                    **(
                        {"focus_style": entry.focus_style}
                        if entry.focus_style is not None
                        else {}
                    ),
                    "confidence": entry.confidence,
                    "explanation": entry.explanation,
                }
            )
        rhythm = sentence.rhythm.model_dump(mode="json") if sentence.rhythm else {"type": "relaxed"}
        sentence_prolongations, sentence_audit = classify_prolongation_candidates(
            raw_candidates,
            focus=focus,
            start=sentence.start_index,
            end=sentence.end_index,
        )
        confirmed_prolongations.extend(sentence_prolongations)
        audited_candidates.extend(sentence_audit)
        sentences.append(
            {
                "text": sentence.text,
                "start_index": sentence.start_index,
                "end_index": sentence.end_index,
                "focus": focus,
                "pauses": _acoustic_pauses(
                    analysis_package, sentence.start_index, sentence.end_index
                ),
                "prolongations": sentence_prolongations,
                "macro_prosody_path": segment.get(
                    "macro_prosody_path", {"points": [], "segments": []}
                ),
                "prosody": [entry.model_dump(mode="json") for entry in sentence.prosody],
                "ending_intonation": segment.get(
                    "ending_intonation",
                    {
                        "type": "level",
                        "strength": 1,
                        "confidence": 0.2,
                        "source": "acoustic",
                    },
                ),
                "rhythm": {**rhythm, "confidence": sentence.confidence},
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
    analysis_package.setdefault("acoustic_evidence", {})[
        "prolongations"
    ] = confirmed_prolongations
    analysis_package["acoustic_evidence"][
        "prolongation_candidates"
    ] = audited_candidates
    analysis_package["internal_analysis"] = {
        **internal_analysis,
        "prolongation_candidates": audited_candidates,
    }
    tokens = [
        {
            "index": token["index"],
            "char": token["char"],
            "machine_pinyin": token.get("machine_pinyin"),
            "display_pinyin": token.get("display_pinyin"),
            "start_ms": token["start_ms"],
            "end_ms": token["end_ms"],
            "confidence": token.get("confidence", 1),
        }
        for token in analysis_package["tokens"]
    ]
    return {
        **(
            {
                "performance_profile": interpretation.performance_profile.model_dump(
                    mode="json", exclude_none=True
                )
            }
            if interpretation.performance_profile is not None
            else {}
        ),
        **(
            {"timing_profile": analysis_package["timing_profile"]}
            if isinstance(analysis_package.get("timing_profile"), dict)
            else {}
        ),
        "tokens": tokens,
        "sentences": sentences,
    }


def _response_format_for_provider(*, base_url: str, model: str, schema: dict[str, Any]) -> dict[str, Any]:
    if "deepseek.com" in base_url.lower() or model.lower().startswith("deepseek"):
        # DeepSeek supports JSON Object mode. Schema enforcement remains our
        # responsibility through the prompt and Pydantic validation below.
        return {"type": "json_object"}
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "recitation_control_spec_interpretation",
            "strict": True,
            "schema": schema,
        },
    }


async def interpret_control_spec(
    *,
    analysis_package: dict[str, Any],
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    rules_path = Path(__file__).resolve().parents[1] / "rules" / "recitation_expression_v1.md"
    rules = rules_path.read_text(encoding="utf-8")
    evidence = _compact_evidence(analysis_package)
    schema = LlmInterpretation.model_json_schema()
    schema_text = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    request_body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是专业朗诵指导，只负责依据当前作品的正文、上下文和声音事实生成朗诵标签。"
                    "不得修改正文或 token 范围，不得套用其他作品。严格遵守以下规则：\n\n" + rules
                ),
            },
            {
                "role": "user",
                "content": (
                    "请解释以下当前作品的声音证据。每个 sentence 必须原样返回 text、start_index、end_index。"
                    "你只负责 focus_spans、文本逻辑、情感解释、rhythm，以及把连续 macro_prosody_path 解释为教学语势事件。"
                    "停顿、拖音、句尾语调和基础声音路径由声学层直接生成，不要在输出中重复判断。"
                    "focus_spans 表示教学上整体标红的焦点词组；其内部声学核心由系统另算。"
                    "可选的 performance_profile 只描述生成示范需要的隐藏表演状态：全篇提供宏观基调，"
                    "句级只在确有变化时提供。允许 delivery_mode、emotion_tone、continuity、voice_quality、"
                    "focus_style、expression_amplitude、avoid；不要为了填满字段强行输出。"
                    "focus_style 也可写在单个 focus_span 中，用于说明焦点通过支撑、柔化、放慢、低位、"
                    "气声或气声转支撑实现，绝不能把重音一律理解为增大音量。"
                    "prosody 可以为空或包含多个连续事件，不得为了填字段强行标注。"
                    "判断 prosody 时必须尊重路径的真实连续高度，综合音高、能量、时值、停连和语义，"
                    "不能让普通话单字声调或单个 F0 极值决定类型。证据不足时返回空数组或降低 confidence。"
                    "仅返回一个合法 JSON 对象，不得添加 Markdown 或解释文字。输出必须符合下面的 JSON Schema：\n"
                    + schema_text
                    + "\n\n声音证据：\n"
                    + json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
        "response_format": _response_format_for_provider(
            base_url=base_url,
            model=model,
            schema=schema,
        ),
        "thinking": {"type": thinking},
        "reasoning_effort": reasoning_effort,
        "temperature": 0.1,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds, connect=30)) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
                json=request_body,
            )
    except httpx.TimeoutException as exc:
        raise InterpretationError("LLM interpretation timed out") from exc
    except httpx.HTTPError as exc:
        raise InterpretationError(f"Unable to call the LLM service: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text.strip()[:800]
        raise InterpretationError(f"LLM interpretation failed (HTTP {response.status_code}): {detail}")
    try:
        payload = response.json()
        raw = json.loads(_extract_content(payload))
        interpretation = LlmInterpretation.model_validate(raw)
    except (ValueError, ValidationError) as exc:
        raise InterpretationError(f"LLM returned an invalid control spec: {exc}") from exc
    return assemble_control_spec(interpretation, analysis_package)
