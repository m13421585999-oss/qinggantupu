from __future__ import annotations

import asyncio
import logging
import os
import secrets
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from app.config import (
    DEEPSEEK_THINKING,
    LLM_REASONING_EFFORTS,
    ConfigurationError,
    Settings,
    configured_base_url,
    configured_image_model,
    configured_image_ocr_model,
    configured_image_provider,
    configured_model,
    configured_provider,
)
from app.interpretation.visual_director import VisualDirectorError, direct_work_visuals
from app.pipeline import PIPELINE_VERSION, analyze_job
from app.providers.image_generation import ImageGenerationError, generate_image
from app.providers.hero_text_validation import (
    HeroTextValidationError,
    validate_hero_text,
)
from app.schemas.control_spec import JobRequest
from app.schemas.visual import VisualDirectorRequest


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("recitation-analysis")

app = FastAPI(
    title="声图朗诵分析服务",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)


class ImageGenerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["hero", "scene"]
    prompt: str = Field(min_length=1, max_length=50_000)
    negative_prompt: str | None = Field(default=None, max_length=20_000)
    width: int = Field(ge=64, le=4096)
    height: int = Field(ge=64, le=4096)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    title: str | None = Field(default=None, max_length=500)
    author: str | None = Field(default=None, max_length=500)
    scene_id: str | None = Field(default=None, max_length=500)


class HeroTextValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_base64: str = Field(min_length=1, max_length=25_000_000)
    mime_type: Literal["image/png", "image/jpeg", "image/webp", "image/avif"]
    title: str = Field(min_length=1, max_length=500)
    author: str = Field(default="", max_length=500)
    model: str | None = Field(default=None, min_length=1, max_length=200)


def _settings() -> Settings:
    try:
        return Settings.from_environment()
    except ConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _authorize(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(_settings),
) -> Settings:
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not secrets.compare_digest(supplied, settings.analysis_service_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service token")
    return settings


async def _callback(
    *,
    url: str,
    token: str,
    sites_bypass_token: str,
    body: dict[str, Any],
    timeout_seconds: float,
) -> None:
    last_error = ""
    for attempt, delay in enumerate((0, 2, 8), 1):
        if delay:
            await asyncio.sleep(delay)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds, connect=30),
                follow_redirects=True,
            ) as client:
                response = await client.post(
                    url,
                    headers={
                        "authorization": f"Bearer {token}",
                        "content-type": "application/json",
                        "OAI-Sites-Authorization": f"Bearer {sites_bypass_token}",
                    },
                    json=body,
                )
            if 200 <= response.status_code < 300:
                try:
                    acknowledgement = response.json()
                except ValueError:
                    acknowledgement = None
                if isinstance(acknowledgement, dict) and acknowledgement.get("ok") is True:
                    return
                last_error = "Callback endpoint returned no JSON acknowledgement"
            else:
                last_error = f"HTTP {response.status_code}: {response.text[:500]}"
        except httpx.HTTPError as exc:
            last_error = str(exc)
        logger.warning("callback attempt %s failed for job %s: %s", attempt, body.get("job_id"), last_error)
    raise RuntimeError(f"Analysis callback failed after retries: {last_error}")


async def _run_job(job: JobRequest, settings: Settings) -> str:
    logger.info("starting analysis job %s", job.job_id)
    try:
        await _callback(
            url=job.callback_url,
            token=settings.analysis_callback_token,
            sites_bypass_token=settings.sites_bypass_token,
            body={"job_id": job.job_id, "status": "processing", "progress": 5},
            timeout_seconds=settings.request_timeout_seconds,
        )
        analysis_package, control_spec = await analyze_job(
            input_url=job.input_url,
            audio_url=job.audio_url,
            settings=settings,
        )
        await _callback(
            url=job.callback_url,
            token=settings.analysis_callback_token,
            sites_bypass_token=settings.sites_bypass_token,
            body={
                "job_id": job.job_id,
                "status": "succeeded",
                "progress": 100,
                "analysis_package": analysis_package,
                "control_spec": control_spec,
                "pipeline": {
                    "version": PIPELINE_VERSION,
                    "alignment": "elevenlabs-forced-alignment",
                    "acoustics": "parselmouth",
                    "analyzed_audio_role": analysis_package.get("analyzed_audio_role"),
                    "standard_ai_audio_asset_id": analysis_package.get(
                        "standard_ai_audio_asset_id"
                    ),
                    "language_model_provider": settings.llm_provider,
                    "language_model": settings.llm_model,
                    "thinking": settings.llm_thinking,
                    "reasoning_effort": settings.llm_reasoning_effort,
                    "knowledge_base": "recitation-expression-v1.0",
                },
            },
            timeout_seconds=settings.request_timeout_seconds,
        )
        logger.info("completed analysis job %s", job.job_id)
        return "succeeded"
    except Exception as exc:  # Every production failure becomes an explicit failed job.
        logger.exception("analysis job %s failed", job.job_id)
        try:
            await _callback(
                url=job.callback_url,
                token=settings.analysis_callback_token,
                sites_bypass_token=settings.sites_bypass_token,
                body={
                    "job_id": job.job_id,
                    "status": "failed",
                    "progress": 100,
                    "error_code": exc.__class__.__name__.upper(),
                    "error_message": str(exc)[:1200] or "Analysis failed",
                },
                timeout_seconds=settings.request_timeout_seconds,
            )
        except Exception as callback_error:
            logger.exception("failed to report terminal state for job %s", job.job_id)
            raise RuntimeError(
                f"Analysis failed and its terminal callback could not be delivered: {callback_error}"
            ) from callback_error
        return "failed"


@app.get("/health")
async def health() -> dict[str, Any]:
    required = (
        "ELEVENLABS_API_KEY",
        "ANALYSIS_SERVICE_TOKEN",
        "ANALYSIS_CALLBACK_TOKEN",
        "SITES_BYPASS_TOKEN",
    )
    configured = {name: bool(os.getenv(name, "").strip()) for name in required}
    configured["LLM_AUTH"] = bool(
        os.getenv("AI_API_KEY", "").strip()
        or os.getenv("LLM_API_KEY", "").strip()
    )
    reasoning_effort = os.getenv("LLM_REASONING_EFFORT", "high").strip().lower()
    configured["LLM_REASONING_EFFORT"] = reasoning_effort in LLM_REASONING_EFFORTS
    try:
        provider = configured_provider()
        base_url = configured_base_url(provider)
        model = configured_model(provider)
        image_provider = configured_image_provider()
        image_model = configured_image_model()
        image_ocr_model = configured_image_ocr_model(provider)
        configured["LLM_PROVIDER"] = True
        configured["AI_BASE_URL"] = bool(base_url)
        configured["LLM_MODEL"] = bool(model)
        configured["IMAGE_PROVIDER"] = True
        configured["IMAGE_MODEL"] = bool(image_model)
        configured["IMAGE_OCR_MODEL"] = bool(image_ocr_model)
    except ConfigurationError:
        provider = os.getenv("LLM_PROVIDER", "").strip().lower() or "invalid"
        base_url = os.getenv("AI_BASE_URL", "").strip()
        model = os.getenv("LLM_MODEL", "").strip()
        image_provider = os.getenv("IMAGE_PROVIDER", "").strip() or "invalid"
        image_model = os.getenv("IMAGE_MODEL", "").strip()
        image_ocr_model = os.getenv("IMAGE_OCR_MODEL", "").strip()
        configured["LLM_PROVIDER"] = False
        configured["AI_BASE_URL"] = False
        configured["LLM_MODEL"] = False
        configured["IMAGE_PROVIDER"] = False
        configured["IMAGE_MODEL"] = False
        configured["IMAGE_OCR_MODEL"] = False
    llm = {
        "provider": provider,
        "base_url": base_url,
        "model": model,
        "thinking": DEEPSEEK_THINKING,
        "reasoning_effort": reasoning_effort,
        "endpoint_preference": (
            ["responses", "chat/completions"]
            if provider == "openai_compatible"
            else ["chat/completions"]
        ),
    }
    return {
        "ok": all(configured.values()),
        "configured": configured,
        "llm": llm,
        "visual_director": {
            "provider": provider,
            "model": model,
            "thinking": DEEPSEEK_THINKING,
            "reasoning_effort": reasoning_effort,
            "endpoint_preference": (
                ["responses", "chat/completions"]
                if provider == "openai_compatible"
                else ["chat/completions"]
            ),
        },
        "image_generation": {
            "provider": image_provider,
            "model": image_model,
            "endpoint_preference": ["images/generations", "responses"],
        },
        "hero_text_validation": {
            "provider": provider,
            "model": image_ocr_model,
            "endpoint_preference": ["responses", "chat/completions"],
        },
    }


@app.post("/v1/visual-director", status_code=status.HTTP_200_OK)
async def create_visual_plan(
    request: VisualDirectorRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    # Deliberately independent from analyze_job/control_spec. A failure here
    # only fails the caller's visual operation and cannot mutate analysis data.
    try:
        result = await direct_work_visuals(
            request=request,
            provider=settings.llm_provider,
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
            model=settings.llm_model,
            thinking=settings.llm_thinking,
            reasoning_effort=settings.llm_reasoning_effort,
            timeout_seconds=settings.request_timeout_seconds,
        )
    except VisualDirectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    generation_meta = result.pop("_meta", {})
    generation_meta = generation_meta if isinstance(generation_meta, dict) else {}
    return {
        **result,
        "_meta": {
            "provider": settings.llm_provider,
            "model": settings.llm_model,
            "thinking": settings.llm_thinking,
            "reasoning_effort": settings.llm_reasoning_effort,
            **generation_meta,
        },
    }


@app.post("/v1/image-generation", status_code=status.HTTP_200_OK)
async def create_image_generation(
    request: ImageGenerationRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    requested_model = (request.model or "").strip()
    model = (
        settings.image_model
        if not requested_model or requested_model == "service-configured"
        else requested_model
    )
    try:
        result = await generate_image(
            provider=settings.image_provider,
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
            model=model,
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            width=request.width,
            height=request.height,
            timeout_seconds=settings.request_timeout_seconds,
        )
    except ImageGenerationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "data": [result.image],
        "provider": result.provider,
        "model": result.model,
        "endpoint": result.endpoint,
        "kind": request.kind,
        **({"width": result.width} if result.width is not None else {}),
        **({"height": result.height} if result.height is not None else {}),
        **({"scene_id": request.scene_id} if request.scene_id else {}),
    }


@app.post("/v1/hero-text-validation", status_code=status.HTTP_200_OK)
async def create_hero_text_validation(
    request: HeroTextValidationRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    requested_model = (request.model or "").strip()
    model = requested_model or settings.image_ocr_model or settings.llm_model
    metadata = {
        "provider": settings.llm_provider,
        "model": model,
    }
    try:
        result = await validate_hero_text(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
            model=model,
            image_base64=request.image_base64,
            mime_type=request.mime_type,
            expected_title=request.title,
            expected_author=request.author,
            reasoning_effort=settings.llm_reasoning_effort,
            timeout_seconds=settings.request_timeout_seconds,
        )
    except HeroTextValidationError:
        return {"status": "failed", "endpoint": "unavailable", **metadata}
    return {
        "status": result.status,
        "extracted_title": result.extracted_title,
        "extracted_author": result.extracted_author,
        "endpoint": result.endpoint,
        **metadata,
    }


@app.post("/v1/jobs", status_code=status.HTTP_200_OK)
@app.post("/jobs", status_code=status.HTTP_200_OK, include_in_schema=False)
async def create_job(
    job: JobRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, str]:
    # Vercel may freeze or terminate a Python Function as soon as its response
    # is sent, so FastAPI BackgroundTasks cannot own this production job. The
    # Worker keeps the dispatch request open too; both sides wait until the
    # pipeline and terminal callback have finished.
    final_status = await _run_job(job, settings)
    return {"job_id": job.job_id, "status": final_status}
