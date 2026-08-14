from __future__ import annotations

import base64
import json
import struct
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.image_generation import (
    ImageGenerationError,
    _image_endpoint,
    _responses_endpoint,
    generate_image,
)


def _environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ELEVENLABS_API_KEY", "eleven-test")
    monkeypatch.setenv("ANALYSIS_SERVICE_TOKEN", "service-test")
    monkeypatch.setenv("ANALYSIS_CALLBACK_TOKEN", "callback-test")
    monkeypatch.setenv("SITES_BYPASS_TOKEN", "sites-test")
    monkeypatch.setenv("AI_API_KEY", "provider-test-key")
    monkeypatch.setenv("AI_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "provider/vision")
    monkeypatch.setenv("IMAGE_PROVIDER", "openai_compatible")
    monkeypatch.setenv("IMAGE_MODEL", "image2.0")


@pytest.mark.parametrize(
    "path", ["/v1/image-generation", "/v1/hero-text-validation"]
)
def test_media_proxies_require_service_token(
    monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    _environment(monkeypatch)
    response = TestClient(app).post(path, headers={"authorization": "Bearer wrong"}, json={})
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("base_url", "expected"),
    [
        ("https://gateway.example", "https://gateway.example/v1/images/generations"),
        ("https://gateway.example/v1/", "https://gateway.example/v1/images/generations"),
    ],
)
def test_image_endpoint_contains_one_v1(base_url: str, expected: str) -> None:
    assert _image_endpoint(base_url) == expected


def test_image_responses_endpoint_contains_one_v1() -> None:
    assert _responses_endpoint("https://gateway.example/v1/") == (
        "https://gateway.example/v1/responses"
    )


def test_image_proxy_forwards_configured_model_size_and_b64(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _environment(monkeypatch)
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"data": [{"b64_json": "aGVsbG8=", "seed": 7}]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.image_generation.httpx.AsyncClient", side_effect=factory):
        response = TestClient(app).post(
            "/v1/image-generation",
            headers={"authorization": "Bearer service-test"},
            json={
                "kind": "scene",
                "scene_id": "scene-1",
                "prompt": "海面晨光",
                "negative_prompt": "文字，水印",
                "width": 768,
                "height": 576,
            },
        )

    assert response.status_code == 200
    assert response.json()["data"][0] == {"b64_json": "aGVsbG8=", "seed": 7}
    assert response.json()["model"] == "image2.0"
    assert response.json()["endpoint"] == "images/generations"
    assert captured["path"] == "/v1/images/generations"
    assert captured["body"] == {
        "model": "image2.0",
        "prompt": "海面晨光\n\n必须避免：文字，水印",
        "size": "768x576",
        "n": 1,
    }


def test_image_proxy_reports_dimensions_from_returned_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _environment(monkeypatch)
    png_header = b"\x89PNG\r\n\x1a\n" + (b"\x00" * 8) + struct.pack(">II", 1024, 768)
    encoded = base64.b64encode(png_header).decode("ascii")

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.image_generation.httpx.AsyncClient", side_effect=factory):
        response = TestClient(app).post(
            "/v1/image-generation",
            headers={"authorization": "Bearer service-test"},
            json={
                "kind": "scene",
                "prompt": "海面晨光",
                "width": 768,
                "height": 576,
            },
        )

    assert response.status_code == 200
    assert response.json()["width"] == 1024
    assert response.json()["height"] == 768
    assert response.json()["data"][0]["width"] == 1024
    assert response.json()["data"][0]["height"] == 768


def test_image_proxy_falls_back_to_responses_when_images_path_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _environment(monkeypatch)
    requests: list[tuple[str, dict[str, object]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append((request.url.path, body))
        if request.url.path.endswith("/images/generations"):
            return httpx.Response(404, text="unknown endpoint")
        return httpx.Response(
            200,
            json={
                "output": [
                    {"type": "image_generation_call", "result": "aGVsbG8="}
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.image_generation.httpx.AsyncClient", side_effect=factory):
        response = TestClient(app).post(
            "/v1/image-generation",
            headers={"authorization": "Bearer service-test"},
            json={
                "kind": "hero",
                "prompt": "海边诗歌封面",
                "width": 1500,
                "height": 280,
            },
        )

    assert response.status_code == 200
    assert response.json()["endpoint"] == "responses"
    assert [path for path, _ in requests] == [
        "/v1/images/generations",
        "/v1/responses",
    ]
    assert requests[1][1]["tools"] == [
        {"type": "image_generation", "size": "1536x1024"}
    ]


def test_image_provider_error_redacts_key() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="provider-test-key Bearer provider-test-key")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.image_generation.httpx.AsyncClient", side_effect=factory), pytest.raises(
        ImageGenerationError
    ) as captured:
        import asyncio

        asyncio.run(generate_image(
            provider="openai_compatible",
            api_key="provider-test-key",
            base_url="https://gateway.example",
            model="image2.0",
            prompt="test",
            negative_prompt=None,
            width=768,
            height=576,
            timeout_seconds=30,
        ))
    assert "provider-test-key" not in str(captured.value)


def test_hero_ocr_proxy_returns_only_safe_validation_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _environment(monkeypatch)
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "output_text": '{"title":"面朝大海，春暖花开","author":"海子"}'
            },
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.hero_text_validation.httpx.AsyncClient", side_effect=factory):
        response = TestClient(app).post(
            "/v1/hero-text-validation",
            headers={"authorization": "Bearer service-test"},
            json={
                "image_base64": "aGVsbG8=",
                "mime_type": "image/png",
                "title": "《面朝大海，春暖花开》",
                "author": "海子",
            },
        )

    assert response.status_code == 200
    assert response.json()["status"] == "matched"
    assert response.json()["endpoint"] == "responses"
    assert captured["path"] == "/v1/responses"
    assert captured["body"]["reasoning"] == {"effort": "high"}
    assert captured["body"]["text"]["format"]["strict"] is True


def test_hero_ocr_falls_back_to_chat_when_responses_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _environment(monkeypatch)
    paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/responses"):
            return httpx.Response(404, text="unknown endpoint")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"title":"面朝大海，春暖花开","author":"海子"}'
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.hero_text_validation.httpx.AsyncClient", side_effect=factory):
        response = TestClient(app).post(
            "/v1/hero-text-validation",
            headers={"authorization": "Bearer service-test"},
            json={
                "image_base64": "aGVsbG8=",
                "mime_type": "image/png",
                "title": "《面朝大海，春暖花开》",
                "author": "海子",
            },
        )

    assert response.status_code == 200
    assert response.json()["status"] == "matched"
    assert response.json()["endpoint"] == "chat/completions"
    assert paths == ["/v1/responses", "/v1/chat/completions"]
