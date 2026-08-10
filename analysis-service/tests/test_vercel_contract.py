from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from api.index import app as vercel_app
from app.acoustics.parselmouth_analyzer import resolve_ffmpeg
from app.config import ConfigurationError, Settings
from app.main import _callback, app, create_job
from app.pipeline import _sites_headers
from app.schemas.control_spec import JobRequest


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _base_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "AI_GATEWAY_API_KEY",
        "VERCEL_OIDC_TOKEN",
        "LLM_BASE_URL",
        "LLM_MODEL",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "eleven-test")
    monkeypatch.setenv("ANALYSIS_SERVICE_TOKEN", "service-test")
    monkeypatch.setenv("ANALYSIS_CALLBACK_TOKEN", "callback-test")
    monkeypatch.setenv("SITES_BYPASS_TOKEN", "sites-test")


def test_vercel_entrypoint_exports_the_fastapi_app() -> None:
    assert vercel_app is app


def test_vercel_configuration_targets_entrypoint_and_portable_duration() -> None:
    configuration = json.loads((SERVICE_ROOT / "vercel.json").read_text(encoding="utf-8"))
    function = configuration["functions"]["api/index.py"]
    assert function["maxDuration"] == 300
    assert "tests/**" in function["excludeFiles"]
    assert configuration["rewrites"] == [{"source": "/(.*)", "destination": "/api/index"}]


def test_settings_use_vercel_oidc_and_gateway_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("VERCEL_OIDC_TOKEN", "oidc-test")

    settings = Settings.from_environment()

    assert settings.llm_api_key == "oidc-test"
    assert settings.llm_auth_source == "vercel_oidc"
    assert settings.llm_base_url == "https://ai-gateway.vercel.sh/v1"
    assert settings.llm_model == "openai/gpt-5.6-sol"


def test_static_gateway_key_precedes_oidc(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "gateway-test")
    monkeypatch.setenv("VERCEL_OIDC_TOKEN", "oidc-test")

    settings = Settings.from_environment()

    assert settings.llm_api_key == "gateway-test"
    assert settings.llm_auth_source == "ai_gateway_api_key"


def test_missing_gateway_auth_is_a_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    with pytest.raises(ConfigurationError, match="VERCEL_OIDC_TOKEN"):
        Settings.from_environment()


def test_ffmpeg_falls_back_to_imageio_binary(tmp_path: Path) -> None:
    bundled = tmp_path / "ffmpeg"
    bundled.touch()
    with patch("app.acoustics.parselmouth_analyzer.shutil.which", return_value=None), patch(
        "imageio_ffmpeg.get_ffmpeg_exe", return_value=str(bundled)
    ):
        assert resolve_ffmpeg() == str(bundled)


def test_job_request_waits_for_pipeline_instead_of_background_task() -> None:
    job = JobRequest(
        job_id="job-test",
        input_url="https://example.test/input",
        audio_url="https://example.test/audio",
        callback_url="https://example.test/callback",
    )
    settings = Settings(
        elevenlabs_api_key="eleven",
        llm_api_key="oidc",
        llm_auth_source="vercel_oidc",
        analysis_service_token="service",
        analysis_callback_token="callback",
        sites_bypass_token="sites",
        llm_base_url="https://ai-gateway.vercel.sh/v1",
        llm_model="openai/gpt-5.6-sol",
        request_timeout_seconds=180,
    )
    runner = AsyncMock(return_value="succeeded")
    with patch("app.main._run_job", runner):
        response = asyncio.run(create_job(job=job, settings=settings))

    runner.assert_awaited_once_with(job, settings)
    assert response == {"job_id": "job-test", "status": "succeeded"}


def test_sites_handoff_header_uses_owner_bypass_token() -> None:
    assert _sites_headers("sites-owner-token") == {
        "OAI-Sites-Authorization": "Bearer sites-owner-token"
    }


def test_callback_sends_bearer_and_sites_bypass_headers() -> None:
    captured: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization", "")
        captured["sites"] = request.headers.get("OAI-Sites-Authorization", "")
        captured["content_type"] = request.headers.get("content-type", "")
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    client_options: dict[str, object] = {}

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        client_options.update(kwargs)
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.main.httpx.AsyncClient", side_effect=client_factory):
        asyncio.run(
            _callback(
                url="https://example.test/callback",
                token="callback-secret",
                sites_bypass_token="sites-owner-token",
                body={"job_id": "job-test", "status": "processing"},
                timeout_seconds=30,
            )
        )

    assert captured == {
        "authorization": "Bearer callback-secret",
        "sites": "Bearer sites-owner-token",
        "content_type": "application/json",
    }
    assert client_options["follow_redirects"] is True


def test_callback_rejects_success_status_without_worker_acknowledgement() -> None:
    attempts = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, text="<html>not the Worker callback</html>")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.main.httpx.AsyncClient", side_effect=client_factory), patch(
        "app.main.asyncio.sleep", new=AsyncMock()
    ), pytest.raises(RuntimeError, match="callback failed"):
        asyncio.run(
            _callback(
                url="https://example.test/callback",
                token="callback-secret",
                sites_bypass_token="sites-owner-token",
                body={"job_id": "job-test", "status": "processing"},
                timeout_seconds=30,
            )
        )

    assert attempts == 3
