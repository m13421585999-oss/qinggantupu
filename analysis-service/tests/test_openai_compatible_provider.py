from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import httpx
import pytest

from app.providers.openai_compatible import (
    StructuredLlmError,
    _openai_endpoint,
    generate_structured_result,
    generate_structured_json,
)


def _run(
    *,
    provider: str,
    base_url: str = "https://gateway.example/v1",
) -> dict[str, object]:
    return asyncio.run(
        generate_structured_json(
            provider=provider,
            api_key="provider-test-key",
            base_url=base_url,
            model="provider/model",
            system_prompt="system prompt",
            user_prompt="user prompt",
            schema_name="independent_schema",
            schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            thinking="enabled",
            reasoning_effort="high",
            temperature=0.1,
            timeout_seconds=30,
        )
    )


@pytest.mark.parametrize(
    ("base_url", "expected"),
    [
        ("https://api2.65535.space", "https://api2.65535.space/v1/responses"),
        ("https://api2.65535.space/", "https://api2.65535.space/v1/responses"),
        ("https://api2.65535.space/v1", "https://api2.65535.space/v1/responses"),
        ("https://api2.65535.space/v1/", "https://api2.65535.space/v1/responses"),
    ],
)
def test_openai_endpoint_contains_exactly_one_v1(base_url: str, expected: str) -> None:
    assert _openai_endpoint(base_url, "responses") == expected


def test_openai_compatible_prefers_responses_with_strict_schema() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": '{"ok":true}'}
                        ],
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        result = _run(provider="openai_compatible")

    assert result == {"ok": True}
    assert captured["path"] == "/v1/responses"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["instructions"] == "system prompt"
    assert body["input"][0]["content"][0]["text"] == "user prompt"
    assert body["text"]["format"]["name"] == "independent_schema"
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["required"] == ["ok"]
    assert body["text"]["format"]["schema"]["additionalProperties"] is False
    assert body["reasoning"] == {"effort": "high"}


def test_openai_compatible_falls_back_when_responses_endpoint_is_absent() -> None:
    requests: list[tuple[str, dict[str, object]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append((request.url.path, body))
        if request.url.path.endswith("/responses"):
            return httpx.Response(404, json={"error": "unknown endpoint"})
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"ok":true}'}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        result = _run(provider="openai_compatible")

    assert result == {"ok": True}
    assert [path for path, _ in requests] == [
        "/v1/responses",
        "/v1/chat/completions",
    ]
    fallback = requests[1][1]
    assert fallback["response_format"]["type"] == "json_schema"
    assert fallback["response_format"]["json_schema"]["name"] == "independent_schema"
    assert "thinking" not in fallback
    assert fallback["reasoning_effort"] == "high"


def test_responses_json_mode_repairs_one_invalid_json_object() -> None:
    requests: list[tuple[str, dict[str, object]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append((request.url.path, body))
        if request.url.path.endswith("/responses"):
            if body["text"]["format"]["type"] == "json_schema":
                return httpx.Response(400, text="json_schema is not supported")
            if "待修复输出" not in body["input"][0]["content"][0]["text"]:
                return httpx.Response(
                    200,
                    json={"output_text": '{"wrong":true}'},
                )
            return httpx.Response(200, json={"output_text": '{"ok":true}'})
        raise AssertionError("Responses JSON mode should satisfy this request")

    def validator(value: dict[str, object]) -> None:
        if value.get("ok") is not True:
            raise ValueError("ok must be true")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        result = asyncio.run(generate_structured_result(
            provider="openai_compatible",
            api_key="provider-test-key",
            base_url="https://gateway.example/v1",
            model="provider/model",
            system_prompt="system prompt",
            user_prompt="user prompt",
            schema_name="independent_schema",
            schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            thinking="enabled",
            reasoning_effort="high",
            temperature=0.1,
            timeout_seconds=30,
            validator=validator,
        ))

    assert result.data == {"ok": True}
    assert result.endpoint == "responses"
    assert result.output_mode == "json_object_repair"
    assert result.request_count == 3
    assert all(path == "/v1/responses" for path, _ in requests)
    assert requests[-1][1]["reasoning"] == {"effort": "high"}


def test_chat_json_mode_repairs_after_responses_is_absent() -> None:
    requests: list[tuple[str, dict[str, object]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append((request.url.path, body))
        if request.url.path.endswith("/responses"):
            return httpx.Response(404, text="unknown endpoint")
        if body["response_format"]["type"] == "json_schema":
            return httpx.Response(400, text="response_format json_schema unsupported")
        if len(body["messages"]) == 2:
            return httpx.Response(
                200, json={"choices": [{"message": {"content": '{"wrong":true}'}}]}
            )
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"ok":true}'}}]}
        )

    def validator(value: dict[str, object]) -> None:
        if value.get("ok") is not True:
            raise ValueError("ok must be true")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        result = asyncio.run(generate_structured_result(
            provider="openai_compatible",
            api_key="provider-test-key",
            base_url="https://gateway.example/v1",
            model="provider/model",
            system_prompt="system prompt",
            user_prompt="user prompt",
            schema_name="independent_schema",
            schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            thinking="enabled",
            reasoning_effort="high",
            temperature=0.1,
            timeout_seconds=30,
            validator=validator,
        ))

    assert result.data == {"ok": True}
    assert result.endpoint == "chat/completions"
    assert result.output_mode == "json_object_repair"
    assert result.request_count == 4
    assert requests[-1][1]["reasoning_effort"] == "high"
    assert len(requests[-1][1]["messages"]) == 4


def test_deepseek_rollback_keeps_existing_chat_request_fields() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"ok":true}'}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        result = _run(provider="deepseek", base_url="https://api.deepseek.com")

    assert result == {"ok": True}
    assert captured["path"] == "/chat/completions"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["response_format"] == {"type": "json_object"}
    assert body["thinking"] == {"type": "enabled"}
    assert body["reasoning_effort"] == "high"


def test_provider_error_never_echoes_api_key() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="provider-test-key must not be valid")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory), pytest.raises(
        StructuredLlmError,
    ) as captured:
        _run(provider="openai_compatible")

    assert "provider-test-key" not in str(captured.value)
