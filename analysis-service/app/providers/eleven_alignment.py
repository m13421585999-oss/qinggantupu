from __future__ import annotations

import difflib
import mimetypes
from pathlib import Path
from typing import Any

import httpx


ELEVEN_ALIGNMENT_URL = "https://api.elevenlabs.io/v1/forced-alignment"
PUNCTUATION = set("，。！？、；：,.!?;:\n\r\t ‘’“”\"'（）()【】[]《》〈〉—…·")


class AlignmentError(RuntimeError):
    """An alignment failure that must stop the production job."""


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _optional_number(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _seconds(item: dict[str, Any], name: str) -> float:
    return _number(item.get(name, item.get(f"{name}_seconds")))


def _at(values: Any, index: int) -> float:
    return _number(values[index]) if isinstance(values, list) and index < len(values) else 0.0


def _provider_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            detail = payload.get("detail") or payload.get("message")
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("status")
            if detail:
                return str(detail)[:500]
    except ValueError:
        pass
    return response.text.strip()[:500] or "unknown provider error"


def normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    raw_characters = payload.get("characters")
    characters: list[dict[str, Any]] = []
    if isinstance(raw_characters, list) and raw_characters:
        if isinstance(raw_characters[0], dict):
            for item in raw_characters:
                if not isinstance(item, dict):
                    continue
                characters.append(
                    {
                        "text": str(item.get("text") or item.get("character") or item.get("char") or ""),
                        "start": _seconds(item, "start"),
                        "end": _seconds(item, "end"),
                        "confidence": _optional_number(item.get("confidence")),
                    }
                )
        else:
            starts = payload.get("character_start_times_seconds") or payload.get("character_start_times") or []
            ends = payload.get("character_end_times_seconds") or payload.get("character_end_times") or []
            for index, character in enumerate(raw_characters):
                characters.append(
                    {
                        "text": str(character),
                        "start": _at(starts, index),
                        "end": _at(ends, index),
                        "confidence": None,
                    }
                )

    words: list[dict[str, Any]] = []
    raw_words = payload.get("words")
    if isinstance(raw_words, list):
        for item in raw_words:
            if not isinstance(item, dict):
                continue
            words.append(
                {
                    "text": str(item.get("text") or item.get("word") or ""),
                    "start": _seconds(item, "start"),
                    "end": _seconds(item, "end"),
                    "confidence": _optional_number(item.get("confidence")),
                }
            )
    if not words:
        word_texts = payload.get("word_texts") or payload.get("word_characters") or []
        starts = payload.get("word_start_times_seconds") or payload.get("word_start_times") or []
        ends = payload.get("word_end_times_seconds") or payload.get("word_end_times") or []
        if isinstance(word_texts, list):
            words = [
                {
                    "text": str(word),
                    "start": _at(starts, index),
                    "end": _at(ends, index),
                    "confidence": None,
                }
                for index, word in enumerate(word_texts)
            ]
    return {**payload, "characters": characters, "words": words}


async def forced_align(
    *, api_key: str, audio_path: Path, full_text: str, timeout_seconds: float = 300
) -> dict[str, Any]:
    mime_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=30), follow_redirects=True
        ) as client:
            with audio_path.open("rb") as audio_file:
                response = await client.post(
                    ELEVEN_ALIGNMENT_URL,
                    headers={"xi-api-key": api_key},
                    data={"text": full_text},
                    files={"file": (audio_path.name, audio_file, mime_type)},
                )
    except httpx.TimeoutException as exc:
        raise AlignmentError("ElevenLabs forced alignment timed out") from exc
    except (httpx.HTTPError, OSError) as exc:
        raise AlignmentError(f"Unable to call ElevenLabs forced alignment: {exc}") from exc
    if response.status_code >= 400:
        raise AlignmentError(
            f"ElevenLabs forced alignment failed (HTTP {response.status_code}): {_provider_error(response)}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise AlignmentError("ElevenLabs returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise AlignmentError("ElevenLabs returned an invalid alignment payload")
    normalized = normalize_payload(payload)
    if not normalized["characters"]:
        raise AlignmentError("ElevenLabs returned no character alignment")
    return normalized


def map_to_source(full_text: str, payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    provider = payload.get("characters")
    if not isinstance(provider, list) or not provider:
        raise AlignmentError("Forced Alignment returned no character data")

    provider_text = "".join(str(item.get("text") or "") for item in provider if isinstance(item, dict))
    matcher = difflib.SequenceMatcher(a=provider_text, b=full_text, autojunk=False)
    source_to_provider: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            source_to_provider[block.b + offset] = block.a + offset

    spoken_indexes = [index for index, char in enumerate(full_text) if char not in PUNCTUATION]
    matched_spoken = [index for index in spoken_indexes if index in source_to_provider]
    coverage = len(matched_spoken) / max(len(spoken_indexes), 1)
    if coverage < 0.98:
        raise AlignmentError(
            f"Reference audio and source text character coverage is only {coverage:.1%}; exact text is required"
        )

    tokens: list[dict[str, Any]] = []
    last_spoken_end = 0
    for index, char in enumerate(full_text):
        provider_index = source_to_provider.get(index)
        if provider_index is not None:
            item = provider[provider_index]
            start_ms = round(_number(item.get("start")) * 1000)
            end_ms = max(start_ms, round(_number(item.get("end")) * 1000))
            confidence = _optional_number(item.get("confidence"))
            confidence = 1.0 if confidence is None else confidence
            if char not in PUNCTUATION and start_ms < last_spoken_end:
                start_ms = last_spoken_end
                end_ms = max(start_ms, end_ms)
            if char not in PUNCTUATION:
                last_spoken_end = max(last_spoken_end, end_ms)
        else:
            next_start = next(
                (
                    round(_number(provider[source_to_provider[cursor]].get("start")) * 1000)
                    for cursor in range(index + 1, len(full_text))
                    if cursor in source_to_provider
                ),
                last_spoken_end,
            )
            start_ms = min(last_spoken_end, next_start)
            end_ms = start_ms
            confidence = 1.0 if char in PUNCTUATION else 0.0
        tokens.append(
            {
                "index": index,
                "char": char,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "confidence": round(confidence, 4),
            }
        )
    if "".join(item["char"] for item in tokens) != full_text:
        raise AlignmentError("Alignment mapping unexpectedly changed source text")
    return tokens, {
        "character_coverage": round(coverage, 5),
        "matched_spoken_characters": len(matched_spoken),
        "spoken_characters": len(spoken_indexes),
        "provider_character_count": len(provider),
        "provider_loss": payload.get("loss"),
    }


def normalized_words(payload: dict[str, Any]) -> list[dict[str, Any]]:
    words = payload.get("words")
    if not isinstance(words, list):
        return []
    return [
        {
            "text": str(item.get("text") or ""),
            "start_ms": round(_number(item.get("start")) * 1000),
            "end_ms": round(_number(item.get("end")) * 1000),
            "confidence": item.get("confidence"),
        }
        for item in words
        if isinstance(item, dict)
    ]
