from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

import httpx

from app.providers.openai_compatible import (
    StructuredPayloadError,
    _openai_endpoint,
    _response_json,
    _responses_content,
    _responses_is_unavailable,
    _strict_output_schema,
    _strict_schema_is_unavailable,
)


class HeroTextValidationError(RuntimeError):
    """An intentionally non-sensitive OCR validation failure."""


@dataclass(frozen=True)
class HeroTextValidationResult:
    status: str
    extracted_title: str | None
    extracted_author: str | None
    endpoint: str


def _normalized(value: Any) -> str:
    return re.sub(r"[\s《》〈〉「」『』“”'\"·•]", "", str(value or "")).strip()


def _image_data_url(image_base64: str, mime_type: str) -> str:
    value = image_base64.strip()
    if value.startswith("data:"):
        return value
    return f"data:{mime_type};base64,{value}"


def _content(payload: dict[str, Any]) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HeroTextValidationError("OCR response did not contain content") from exc
    if isinstance(content, str) and content.strip():
        return content.strip()
    raise HeroTextValidationError("OCR response did not contain text")


def _json_object(content: str) -> dict[str, Any]:
    candidate = content.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate, flags=re.I)
    try:
        value = json.loads(candidate)
    except ValueError as exc:
        raise HeroTextValidationError("OCR response was not valid JSON") from exc
    if not isinstance(value, dict):
        raise HeroTextValidationError("OCR response was not a JSON object")
    return value


async def validate_hero_text(
    *,
    api_key: str,
    base_url: str,
    model: str,
    image_base64: str,
    mime_type: str,
    expected_title: str,
    expected_author: str,
    reasoning_effort: str,
    timeout_seconds: float,
) -> HeroTextValidationResult:
    instruction = (
        "读取图片中作为作品标题和作者的中文。只返回 JSON："
        '{"title":"","author":""}。不要把“朗诵情感图谱”'
        "识别成标题或作者；看不清时返回空字符串，不得猜测。"
    )
    image_url = _image_data_url(image_base64, mime_type)
    schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "author": {"type": "string"},
        },
        "required": ["title", "author"],
        "additionalProperties": False,
    }

    responses_body = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": instruction,
                    },
                    {
                        "type": "input_image",
                        "image_url": image_url,
                    },
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "hero_text_validation",
                "strict": True,
                "schema": _strict_output_schema(schema),
            }
        },
        "reasoning": {"effort": reasoning_effort},
    }
    chat_body = {
        "model": model,
        "temperature": 0,
        "reasoning_effort": reasoning_effort,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": instruction},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=30)
        ) as client:
            response = await client.post(
                _openai_endpoint(base_url, "responses"),
                headers={
                    "authorization": f"Bearer {api_key}",
                    "content-type": "application/json",
                },
                json=responses_body,
            )
            endpoint_name = "responses"
            extracted: dict[str, Any] | None = None
            if 200 <= response.status_code < 300:
                try:
                    extracted = _json_object(
                        _responses_content(_response_json(response))
                    )
                except (StructuredPayloadError, HeroTextValidationError):
                    extracted = None
            elif not (
                _responses_is_unavailable(response)
                or _strict_schema_is_unavailable(response)
            ):
                raise HeroTextValidationError(
                    f"OCR request failed (HTTP {response.status_code})"
                )

            if extracted is None and not _responses_is_unavailable(response):
                json_body = {
                    **responses_body,
                    "text": {"format": {"type": "json_object"}},
                }
                response = await client.post(
                    _openai_endpoint(base_url, "responses"),
                    headers={
                        "authorization": f"Bearer {api_key}",
                        "content-type": "application/json",
                    },
                    json=json_body,
                )
                if 200 <= response.status_code < 300:
                    try:
                        extracted = _json_object(
                            _responses_content(_response_json(response))
                        )
                    except (StructuredPayloadError, HeroTextValidationError):
                        extracted = None

            if extracted is None:
                response = await client.post(
                    _openai_endpoint(base_url, "chat/completions"),
                    headers={
                        "authorization": f"Bearer {api_key}",
                        "content-type": "application/json",
                    },
                    json=chat_body,
                )
                endpoint_name = "chat/completions"
    except httpx.TimeoutException as exc:
        raise HeroTextValidationError("OCR request timed out") from exc
    except httpx.HTTPError as exc:
        raise HeroTextValidationError("Unable to call OCR service") from exc
    if response.status_code >= 400:
        raise HeroTextValidationError(f"OCR request failed (HTTP {response.status_code})")
    try:
        payload = response.json()
    except ValueError as exc:
        raise HeroTextValidationError("OCR service returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise HeroTextValidationError("OCR service returned an invalid object")
    if extracted is None:
        extracted = _json_object(_content(payload))
    extracted_title = str(extracted.get("title") or "")
    extracted_author = str(extracted.get("author") or "")
    matched = _normalized(extracted_title) == _normalized(expected_title) and (
        not expected_author
        or _normalized(extracted_author) == _normalized(expected_author)
    )
    return HeroTextValidationResult(
        status="matched" if matched else "mismatch",
        extracted_title=extracted_title,
        extracted_author=extracted_author,
        endpoint=endpoint_name,
    )
