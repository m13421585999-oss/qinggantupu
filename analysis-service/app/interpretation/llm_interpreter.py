from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from pydantic import ValidationError

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
                "normalized_pitch": evidence.get("normalized_pitch"),
                "normalized_energy": evidence.get("normalized_energy"),
                "voiced_ratio": evidence.get("voiced_ratio"),
                "silence_gap_before_ms": evidence.get("silence_gap_before_ms"),
                "silence_gap_after_ms": evidence.get("silence_gap_after_ms"),
            }
        )
    return {
        "work": analysis_package["work"],
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


def assemble_control_spec(
    interpretation: LlmInterpretation,
    analysis_package: dict[str, Any],
) -> dict[str, Any]:
    _validate_against_analysis(interpretation, analysis_package)
    gap_by_index = {
        int(item["after_index"]): int(item["gap_ms"])
        for item in analysis_package["acoustic_evidence"]["pauses"]
    }
    sentences = []
    for sentence in interpretation.sentences:
        item = sentence.model_dump(mode="json")
        for pause in item["pauses"]:
            if pause.get("observed_gap_ms") is None:
                pause["observed_gap_ms"] = gap_by_index.get(int(pause["after_index"]))
        sentences.append(item)
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
    return {"tokens": tokens, "sentences": sentences}


async def interpret_control_spec(
    *,
    analysis_package: dict[str, Any],
    api_key: str,
    base_url: str,
    model: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    rules_path = Path(__file__).resolve().parents[1] / "rules" / "recitation_expression_v1.md"
    rules = rules_path.read_text(encoding="utf-8")
    evidence = _compact_evidence(analysis_package)
    schema = LlmInterpretation.model_json_schema()
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
                    "请解释以下当前作品的声音证据。每个 sentence 必须原样返回 text、start_index、end_index，"
                    "并给出 focus、pauses、prolongations、prosody、ending_intonation、rhythm、confidence。"
                    "只依据可见证据和文本语义；不确定时降低 confidence。\n\n"
                    + json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "recitation_control_spec_interpretation",
                "strict": True,
                "schema": schema,
            },
        },
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
