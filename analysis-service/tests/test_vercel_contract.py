from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.acoustics.parselmouth_analyzer import resolve_ffmpeg
from app.config import ConfigurationError, Settings
from app.config import configured_visual_model
from app.interpretation.llm_interpreter import (
    InterpretationError,
    _response_format_for_provider,
    interpret_control_spec,
)
from app.main import _callback, _run_job, app, create_job, health
from app.pipeline import PipelineStageError, _sites_headers
from app.schemas.control_spec import JobRequest
from server import app as vercel_app


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _base_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "AI_API_KEY",
        "AI_BASE_URL",
        "LLM_API_KEY",
        "AI_GATEWAY_API_KEY",
        "VERCEL_OIDC_TOKEN",
        "LLM_PROVIDER",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "IMAGE_API_KEY",
        "IMAGE_BASE_URL",
        "IMAGE_PROVIDER",
        "IMAGE_MODEL",
        "IMAGE_OCR_MODEL",
        "VISUAL_LLM_MODEL",
        "LLM_REASONING_EFFORT",
        "VISUAL_REASONING_EFFORT",
        "RECITATION_LLM_PROVIDER",
        "RECITATION_LLM_BASE_URL",
        "RECITATION_LLM_MODEL",
        "RECITATION_LLM_API_KEY",
        "RECITATION_REASONING_EFFORT",
        "REQUEST_TIMEOUT_SECONDS",
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
    function = configuration["functions"]["server.py"]
    assert function["maxDuration"] == 300
    assert "tests/**" in function["excludeFiles"]
    assert "rewrites" not in configuration


def test_settings_read_canonical_openai_compatible_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_API_KEY", "gateway-test")
    monkeypatch.setenv("AI_BASE_URL", "https://gateway.example/v1/")
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "provider/model")

    settings = Settings.from_environment()

    assert settings.llm_api_key == "gateway-test"
    assert settings.llm_auth_source == "ai_api_key"
    assert settings.llm_provider == "openai_compatible"
    assert settings.llm_base_url == "https://gateway.example/v1"
    assert settings.llm_model == "provider/model"
    assert settings.llm_thinking == "enabled"
    assert settings.llm_reasoning_effort == "high"
    assert settings.visual_reasoning_effort == "low"
    assert settings.recitation_llm_provider == "deepseek"
    assert settings.recitation_llm_base_url == "https://api.deepseek.com"
    assert settings.recitation_llm_model == "deepseek-v4-pro"
    assert settings.recitation_reasoning_effort == "high"
    assert settings.image_api_key == "gateway-test"
    assert settings.image_base_url == "https://gateway.example/v1"


def test_settings_prefer_dedicated_image_credentials_without_changing_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_API_KEY", "llm-key")
    monkeypatch.setenv("AI_BASE_URL", "https://llm.example/v1/")
    monkeypatch.setenv("IMAGE_API_KEY", "image-key")
    monkeypatch.setenv("IMAGE_BASE_URL", "https://images.example/v1/")

    settings = Settings.from_environment()

    assert settings.llm_api_key == "llm-key"
    assert settings.llm_base_url == "https://llm.example/v1"
    assert settings.image_api_key == "image-key"
    assert settings.image_base_url == "https://images.example/v1"


def test_settings_image_credentials_fall_back_to_legacy_llm_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", "legacy-key")
    monkeypatch.setenv("LLM_BASE_URL", "https://legacy.example/v1/")

    settings = Settings.from_environment()

    assert settings.llm_api_key == "legacy-key"
    assert settings.llm_base_url == "https://legacy.example/v1"
    assert settings.image_api_key == "legacy-key"
    assert settings.image_base_url == "https://legacy.example/v1"


def test_settings_default_to_v4_pro_when_model_is_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", "deepseek-test")
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")

    settings = Settings.from_environment()

    assert settings.llm_model == "deepseek-v4-pro"


def test_settings_default_to_production_openai_compatible_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_API_KEY", "gateway-test")

    settings = Settings.from_environment()

    assert settings.llm_provider == "openai_compatible"
    assert settings.llm_base_url == "https://api2.65535.space"
    assert settings.llm_model == "gpt-5.6-sol"
    assert settings.request_timeout_seconds == 270


def test_stale_deepseek_model_is_normalized_after_provider_migration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-pro")
    monkeypatch.delenv("VISUAL_LLM_MODEL", raising=False)
    assert configured_visual_model() == "gpt-5.6-sol"
    monkeypatch.setenv("VISUAL_LLM_MODEL", "deepseek-visual-director")
    assert configured_visual_model() == "gpt-5.6-sol"


def test_deepseek_rollback_preserves_its_configured_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-pro")

    assert configured_visual_model() == "deepseek-v4-pro"


def test_reasoning_effort_can_be_raised_to_max(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", "deepseek-test")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "max")

    settings = Settings.from_environment()

    assert settings.llm_reasoning_effort == "max"


def test_recitation_reasoning_effort_is_independently_configurable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_API_KEY", "gateway-test")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "high")
    monkeypatch.setenv("RECITATION_REASONING_EFFORT", "low")

    settings = Settings.from_environment()

    assert settings.llm_reasoning_effort == "high"
    assert settings.recitation_reasoning_effort == "low"


def test_invalid_reasoning_effort_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", "deepseek-test")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "ultra")
    with pytest.raises(ConfigurationError, match="LLM_REASONING_EFFORT"):
        Settings.from_environment()


def test_deepseek_uses_json_object_mode() -> None:
    assert _response_format_for_provider(
        base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
        schema={"type": "object"},
    ) == {"type": "json_object"}


def test_gateway_keeps_strict_json_schema_mode() -> None:
    schema = {"type": "object"}
    response_format = _response_format_for_provider(
        base_url="https://ai-gateway.vercel.sh/v1",
        model="openai/gpt-5.6-sol",
        schema=schema,
    )
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"] == schema


def test_missing_llm_api_key_is_a_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    with pytest.raises(ConfigurationError, match="AI_API_KEY"):
        Settings.from_environment()


def test_health_reports_the_effective_deepseek_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", "deepseek-test")
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-pro")

    result = asyncio.run(health())

    assert result["ok"] is True
    assert result["llm"] == {
        "provider": "deepseek",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-pro",
        "thinking": "enabled",
        "reasoning_effort": "high",
        "endpoint_preference": ["chat/completions"],
    }


def test_health_reports_openai_compatible_gateway_and_shared_visual_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_API_KEY", "gateway-test")
    monkeypatch.setenv("AI_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "provider/model")

    result = asyncio.run(health())

    assert result["ok"] is True
    assert result["llm"]["provider"] == "openai_compatible"
    assert result["llm"]["base_url"] == "https://gateway.example/v1"
    assert result["llm"]["model"] == "provider/model"
    assert result["llm"]["endpoint_preference"] == [
        "responses",
        "chat/completions",
    ]
    assert result["visual_director"]["model"] == "provider/model"
    assert result["visual_director"]["reasoning_effort"] == "low"
    assert result["visual_director"]["endpoint_preference"] == [
        "chat/completions"
    ]
    assert result["visual_director"]["scene_batch_size"] == 8
    assert result["visual_director"]["fallback"] == "deterministic_visual_plan"
    assert result["recitation_interpreter"]["provider"] == "deepseek"
    assert result["recitation_interpreter"]["base_url"] == "https://api.deepseek.com"
    assert result["recitation_interpreter"]["model"] == "deepseek-v4-pro"
    assert result["recitation_interpreter"]["reasoning_effort"] == "high"
    assert result["recitation_interpreter"]["endpoint_preference"] == [
        "chat/completions"
    ]
    assert result["recitation_interpreter"]["output_mode"] == "json_object"


def test_health_reports_image_configuration_as_booleans_without_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("AI_API_KEY", "llm-secret")
    monkeypatch.setenv("IMAGE_API_KEY", "image-secret")
    monkeypatch.setenv("IMAGE_BASE_URL", "https://images.example/v1")

    result = asyncio.run(health())

    assert result["ok"] is True
    assert result["configured"]["IMAGE_AUTH"] is True
    assert result["configured"]["IMAGE_BASE_URL"] is True
    serialized = json.dumps(result)
    assert "llm-secret" not in serialized
    assert "image-secret" not in serialized


def test_deepseek_request_enables_thinking_with_configured_effort() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(500, text="intentional test response")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    analysis_package = {
        "work": {"title": "test", "author": "", "full_text": "测试"},
        "alignment_quality": {},
        "tokens": [],
        "segments": [],
        "acoustic_evidence": {
            "tokens": [],
            "pauses": [],
            "duration_outliers": [],
            "energy_changes": [],
        },
    }
    with patch(
        "app.providers.openai_compatible.httpx.AsyncClient",
        side_effect=client_factory,
    ), pytest.raises(InterpretationError, match="HTTP 500"):
        asyncio.run(
            interpret_control_spec(
                analysis_package=analysis_package,
                provider="deepseek",
                api_key="deepseek-test",
                base_url="https://api.deepseek.com",
                model="deepseek-v4-pro",
                thinking="enabled",
                reasoning_effort="high",
                timeout_seconds=30,
            )
        )

    assert captured["model"] == "deepseek-v4-pro"
    assert captured["thinking"] == {"type": "enabled"}
    assert captured["reasoning_effort"] == "high"


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
        llm_api_key="deepseek",
        llm_auth_source="llm_api_key_legacy",
        llm_provider="deepseek",
        analysis_service_token="service",
        analysis_callback_token="callback",
        sites_bypass_token="sites",
        llm_base_url="https://api.deepseek.com",
        llm_model="deepseek-v4-pro",
        llm_thinking="enabled",
        llm_reasoning_effort="high",
        request_timeout_seconds=180,
    )
    runner = AsyncMock(return_value="succeeded")
    with patch("app.main._run_job", runner):
        response = asyncio.run(create_job(job=job, settings=settings))

    runner.assert_awaited_once_with(job, settings)
    assert response == {"job_id": "job-test", "status": "succeeded"}


def test_run_job_reports_progress_without_reading_exception_state() -> None:
    job = JobRequest(
        job_id="job-progress",
        input_url="https://example.test/input",
        audio_url="https://example.test/audio",
        callback_url="https://example.test/callback",
    )
    settings = Settings(
        elevenlabs_api_key="eleven",
        llm_api_key="gateway",
        llm_auth_source="ai_api_key",
        llm_provider="openai_compatible",
        analysis_service_token="service",
        analysis_callback_token="callback",
        sites_bypass_token="sites",
        llm_base_url="https://gateway.example",
        llm_model="gpt-5.6-sol",
        llm_thinking="enabled",
        llm_reasoning_effort="high",
        request_timeout_seconds=180,
    )
    callback = AsyncMock()

    async def analyzer(**kwargs):
        await kwargs["progress_callback"]("audio_analyzing", 38)
        return ({"analyzed_audio_role": "standard_ai_audio"}, {"tokens": []})

    with patch("app.main._callback", callback), patch(
        "app.main.analyze_job", side_effect=analyzer
    ):
        result = asyncio.run(_run_job(job, settings))

    assert result == "succeeded"
    progress_bodies = [call.kwargs["body"] for call in callback.await_args_list]
    assert {"job_id": "job-progress", "status": "processing", "stage": "audio_analyzing", "progress": 38} in progress_bodies
    assert progress_bodies[-1]["status"] == "succeeded"


def test_run_job_preserves_acoustic_package_when_interpretation_fails() -> None:
    job = JobRequest(
        job_id="job-interpretation-failure",
        input_url="https://example.test/input",
        audio_url="https://example.test/audio",
        callback_url="https://example.test/callback",
    )
    settings = Settings(
        elevenlabs_api_key="eleven",
        llm_api_key="gateway",
        llm_auth_source="ai_api_key",
        llm_provider="openai_compatible",
        analysis_service_token="service",
        analysis_callback_token="callback",
        sites_bypass_token="sites",
        llm_base_url="https://gateway.example",
        llm_model="gpt-5.6-sol",
        llm_thinking="enabled",
        llm_reasoning_effort="high",
        request_timeout_seconds=180,
    )
    callback = AsyncMock()
    analysis_package = {"work": {"full_text": "测试"}, "tokens": []}

    with patch("app.main._callback", callback), patch(
        "app.main.analyze_job",
        new=AsyncMock(
            side_effect=PipelineStageError(
                "upstream timeout",
                stage="llm_interpreting",
                analysis_package=analysis_package,
            )
        ),
    ):
        result = asyncio.run(_run_job(job, settings))

    assert result == "failed"
    failure = callback.await_args_list[-1].kwargs["body"]
    assert failure["status"] == "failed"
    assert failure["error_code"] == "LLM_INTERPRETATION_FAILED"
    assert failure["stage"] == "llm_interpreting"
    assert failure["analysis_package"] == analysis_package


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
