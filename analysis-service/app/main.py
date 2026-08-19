from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from app.config import (
    DEEPSEEK_THINKING,
    LLM_REASONING_EFFORTS,
    ConfigurationError,
    Settings,
    configured_base_url,
    configured_image_base_url,
    configured_image_model,
    configured_image_ocr_model,
    configured_image_provider,
    configured_model,
    configured_provider,
    configured_recitation_base_url,
    configured_recitation_model,
    configured_recitation_provider,
    configured_recitation_reasoning_effort,
    configured_tts_reasoning_effort,
    configured_visual_reasoning_effort,
)
from app.interpretation.visual_director import VisualDirectorError, direct_work_visuals
from app.interpretation.llm_interpreter import InterpretationError, interpret_control_spec
from app.pipeline import PIPELINE_VERSION, PipelineStageError, analyze_job
from app.providers.image_generation import ImageGenerationError, generate_image
from app.providers.hero_text_validation import (
    HeroTextValidationError,
    validate_hero_text,
)
from app.schemas.control_spec import JobRequest
from app.schemas.visual import VisualDirectorRequest
from app.text_recitation import (
    TextRecitationError,
    TextRecitationRequest,
    generate_text_recitation,
)
from app.tts_director import (
    TtsDirectorError,
    TtsDirectorRequest,
    TtsDirectorTextMismatch,
    generate_tts_performance_plan,
)


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("recitation-analysis")

from app.image_task_worker import ImageTaskExecutor
from app.image_tasks import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_RUNNING,
    STATUS_UNCERTAIN,
    get_image_task_store,
)

_image_task_executor: ImageTaskExecutor | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _image_task_executor
    store = get_image_task_store()
    _image_task_executor = ImageTaskExecutor(store)
    _image_task_executor.recover_stale_running()
    _image_task_executor.start()
    try:
        yield
    finally:
        if _image_task_executor is not None:
            await _image_task_executor.stop()


app = FastAPI(
    title="声图朗诵分析服务",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
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


class InterpretationJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1, max_length=500)
    callback_url: str = Field(min_length=1, max_length=4_000)
    analysis_package: dict[str, Any]


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
        async def report_progress(stage_name: str, progress: int) -> None:
            await _callback(
                url=job.callback_url,
                token=settings.analysis_callback_token,
                sites_bypass_token=settings.sites_bypass_token,
                body={
                    "job_id": job.job_id,
                    "status": "processing",
                    "stage": stage_name,
                    "progress": progress,
                },
                timeout_seconds=settings.request_timeout_seconds,
            )

        analysis_package, control_spec = await analyze_job(
            input_url=job.input_url,
            audio_url=job.audio_url,
            settings=settings,
            progress_callback=report_progress,
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
                    "language_model_provider": settings.recitation_llm_provider,
                    "language_model": settings.recitation_llm_model,
                    "thinking": settings.llm_thinking,
                    "reasoning_effort": settings.recitation_reasoning_effort,
                    "knowledge_base": "recitation-expression-v1.0",
                },
            },
            timeout_seconds=settings.request_timeout_seconds,
        )
        logger.info("completed analysis job %s", job.job_id)
        return "succeeded"
    except Exception as exc:  # Every production failure becomes an explicit failed job.
        logger.exception("analysis job %s failed", job.job_id)
        failure_body: dict[str, Any] = {
            "job_id": job.job_id,
            "status": "failed",
            "error_code": (
                "LLM_INTERPRETATION_FAILED"
                if isinstance(exc, PipelineStageError)
                and exc.stage == "llm_interpreting"
                else exc.__class__.__name__.upper()
            ),
            "error_message": str(exc)[:1200] or "Analysis failed",
        }
        if isinstance(exc, PipelineStageError):
            failure_body["stage"] = exc.stage
            if exc.analysis_package is not None:
                failure_body["analysis_package"] = exc.analysis_package
        try:
            await _callback(
                url=job.callback_url,
                token=settings.analysis_callback_token,
                sites_bypass_token=settings.sites_bypass_token,
                body={**failure_body, "progress": 100},
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
    configured["RECITATION_LLM_AUTH"] = bool(
        os.getenv("RECITATION_LLM_API_KEY", "").strip()
        or os.getenv("LLM_API_KEY", "").strip()
        or os.getenv("AI_API_KEY", "").strip()
    )
    configured["IMAGE_AUTH"] = bool(
        os.getenv("IMAGE_API_KEY", "").strip()
        or os.getenv("AI_API_KEY", "").strip()
        or os.getenv("LLM_API_KEY", "").strip()
    )
    reasoning_effort = os.getenv("LLM_REASONING_EFFORT", "high").strip().lower()
    configured["LLM_REASONING_EFFORT"] = reasoning_effort in LLM_REASONING_EFFORTS
    visual_reasoning_effort = os.getenv(
        "VISUAL_REASONING_EFFORT", "low"
    ).strip().lower()
    configured["VISUAL_REASONING_EFFORT"] = (
        visual_reasoning_effort in LLM_REASONING_EFFORTS
    )
    tts_reasoning_effort = os.getenv(
        "TTS_DIRECTOR_REASONING_EFFORT", "medium"
    ).strip().lower()
    configured["TTS_DIRECTOR_REASONING_EFFORT"] = (
        tts_reasoning_effort in LLM_REASONING_EFFORTS
    )
    recitation_reasoning_effort = os.getenv(
        "RECITATION_REASONING_EFFORT", "high"
    ).strip().lower()
    configured["RECITATION_REASONING_EFFORT"] = (
        recitation_reasoning_effort in LLM_REASONING_EFFORTS
    )
    try:
        provider = configured_provider()
        base_url = configured_base_url(provider)
        model = configured_model(provider)
        image_provider = configured_image_provider()
        image_base_url = configured_image_base_url()
        image_model = configured_image_model()
        image_ocr_model = configured_image_ocr_model(provider)
        recitation_provider = configured_recitation_provider()
        recitation_base_url = configured_recitation_base_url(
            recitation_provider
        )
        recitation_model = configured_recitation_model(recitation_provider)
        recitation_reasoning_effort = configured_recitation_reasoning_effort()
        visual_reasoning_effort = configured_visual_reasoning_effort()
        tts_reasoning_effort = configured_tts_reasoning_effort()
        configured["LLM_PROVIDER"] = True
        configured["AI_BASE_URL"] = bool(base_url)
        configured["LLM_MODEL"] = bool(model)
        configured["RECITATION_LLM_PROVIDER"] = True
        configured["RECITATION_LLM_BASE_URL"] = bool(recitation_base_url)
        configured["RECITATION_LLM_MODEL"] = bool(recitation_model)
        configured["IMAGE_PROVIDER"] = True
        configured["IMAGE_BASE_URL"] = bool(image_base_url)
        configured["IMAGE_MODEL"] = bool(image_model)
        configured["IMAGE_OCR_MODEL"] = bool(image_ocr_model)
    except ConfigurationError:
        provider = os.getenv("LLM_PROVIDER", "").strip().lower() or "invalid"
        base_url = os.getenv("AI_BASE_URL", "").strip()
        model = os.getenv("LLM_MODEL", "").strip()
        image_provider = os.getenv("IMAGE_PROVIDER", "").strip() or "invalid"
        image_base_url = configured_image_base_url()
        image_model = os.getenv("IMAGE_MODEL", "").strip()
        image_ocr_model = os.getenv("IMAGE_OCR_MODEL", "").strip()
        recitation_provider = (
            os.getenv("RECITATION_LLM_PROVIDER", "").strip().lower()
            or "invalid"
        )
        recitation_base_url = os.getenv(
            "RECITATION_LLM_BASE_URL", ""
        ).strip()
        recitation_model = os.getenv("RECITATION_LLM_MODEL", "").strip()
        configured["LLM_PROVIDER"] = False
        configured["AI_BASE_URL"] = False
        configured["LLM_MODEL"] = False
        configured["RECITATION_LLM_PROVIDER"] = False
        configured["RECITATION_LLM_BASE_URL"] = False
        configured["RECITATION_LLM_MODEL"] = False
        configured["IMAGE_PROVIDER"] = False
        configured["IMAGE_BASE_URL"] = False
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
            "reasoning_effort": visual_reasoning_effort,
            "endpoint_preference": ["chat/completions"],
            "output_mode": "json_object",
            "scene_batch_size": 8,
            "fallback": "deterministic_visual_plan",
        },
        "tts_director": {
            "provider": provider,
            "model": model,
            "thinking": DEEPSEEK_THINKING,
            "reasoning_effort": tts_reasoning_effort,
            "endpoint_preference": ["chat/completions", "responses"],
            "output_mode": "structured_json",
            "text_validation": "programmatic_exact_semantic_sequence",
        },
        "recitation_interpreter": {
            "provider": recitation_provider,
            "base_url": recitation_base_url,
            "model": recitation_model,
            "thinking": DEEPSEEK_THINKING,
            "reasoning_effort": recitation_reasoning_effort,
            "timeout_fallback_reasoning_effort": recitation_reasoning_effort,
            "endpoint_preference": ["chat/completions"],
            "output_mode": "json_object",
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


@app.post("/v1/tts-director", status_code=status.HTTP_200_OK)
async def create_tts_performance_plan(
    request: TtsDirectorRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    try:
        result = await generate_tts_performance_plan(
            request=request,
            provider=settings.llm_provider,
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
            model=settings.llm_model,
            thinking=settings.llm_thinking,
            reasoning_effort=settings.tts_director_reasoning_effort,
            timeout_seconds=settings.request_timeout_seconds,
        )
    except TtsDirectorTextMismatch as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TtsDirectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    generation_meta = result.pop("_meta", {})
    generation_meta = generation_meta if isinstance(generation_meta, dict) else {}
    return {
        **result,
        "_meta": {
            "provider": settings.llm_provider,
            "model": settings.llm_model,
            "reasoning_effort": settings.tts_director_reasoning_effort,
            **generation_meta,
        },
    }


@app.post("/v1/interpretation-jobs", status_code=status.HTTP_200_OK)
async def retry_control_spec_interpretation(
    request: InterpretationJobRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, str]:
    await _callback(
        url=request.callback_url,
        token=settings.analysis_callback_token,
        sites_bypass_token=settings.sites_bypass_token,
        body={
            "job_id": request.job_id,
            "status": "processing",
            "stage": "llm_interpreting",
            "progress": 80,
        },
        timeout_seconds=settings.request_timeout_seconds,
    )
    try:
        control_spec = await interpret_control_spec(
            analysis_package=request.analysis_package,
            provider=settings.recitation_llm_provider,
            api_key=settings.recitation_llm_api_key,
            base_url=settings.recitation_llm_base_url,
            model=settings.recitation_llm_model,
            thinking=settings.llm_thinking,
            reasoning_effort=settings.recitation_reasoning_effort,
            timeout_seconds=settings.request_timeout_seconds,
        )
        await _callback(
            url=request.callback_url,
            token=settings.analysis_callback_token,
            sites_bypass_token=settings.sites_bypass_token,
            body={
                "job_id": request.job_id,
                "status": "succeeded",
                "progress": 100,
                "analysis_package": request.analysis_package,
                "control_spec": control_spec,
                "pipeline": {
                    "version": PIPELINE_VERSION,
                    "alignment": "elevenlabs-forced-alignment",
                    "acoustics": "parselmouth",
                    "analyzed_audio_role": request.analysis_package.get("analyzed_audio_role"),
                    "standard_ai_audio_asset_id": request.analysis_package.get(
                        "standard_ai_audio_asset_id"
                    ),
                    "language_model_provider": settings.recitation_llm_provider,
                    "language_model": settings.recitation_llm_model,
                    "thinking": settings.llm_thinking,
                    "reasoning_effort": settings.recitation_reasoning_effort,
                    "knowledge_base": "recitation-expression-v1.0",
                },
            },
            timeout_seconds=settings.request_timeout_seconds,
        )
        return {"job_id": request.job_id, "status": "succeeded"}
    except InterpretationError as exc:
        await _callback(
            url=request.callback_url,
            token=settings.analysis_callback_token,
            sites_bypass_token=settings.sites_bypass_token,
            body={
                "job_id": request.job_id,
                "status": "failed",
                "progress": 100,
                "stage": "llm_interpreting",
                "analysis_package": request.analysis_package,
                "error_code": "LLM_INTERPRETATION_FAILED",
                "error_message": str(exc)[:1200] or "图谱解析失败",
            },
            timeout_seconds=settings.request_timeout_seconds,
        )
        return {"job_id": request.job_id, "status": "failed"}


@app.post("/v1/text-recitation", status_code=status.HTTP_200_OK)
async def create_text_recitation(
    request: TextRecitationRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    try:
        result = await generate_text_recitation(
            request=request,
            provider=settings.llm_provider,
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
            model=settings.llm_model,
            thinking=settings.llm_thinking,
            reasoning_effort=settings.llm_reasoning_effort,
            timeout_seconds=settings.text_recitation_timeout_seconds,
        )
    except TextRecitationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    generation_meta = result.pop("_meta", {})
    generation_meta = generation_meta if isinstance(generation_meta, dict) else {}
    return {
        **result,
        "_meta": {
            "provider": settings.llm_provider,
            "model": settings.llm_model,
            "reasoning_effort": settings.llm_reasoning_effort,
            **generation_meta,
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
            reasoning_effort=settings.visual_reasoning_effort,
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


class ImageTaskSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    work_id: str = Field(min_length=1, max_length=500)
    scene_id: str | None = Field(default=None, max_length=500)
    kind: Literal["hero", "scene"]
    prompt: str = Field(min_length=1, max_length=50_000)
    negative_prompt: str | None = Field(default=None, max_length=20_000)
    width: int = Field(ge=64, le=4096)
    height: int = Field(ge=64, le=4096)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    title: str | None = Field(default=None, max_length=500)
    author: str | None = Field(default=None, max_length=500)


@app.post("/v1/image-tasks", status_code=status.HTTP_201_CREATED)
async def create_image_task(
    request: ImageTaskSubmitRequest,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    """Submit an image task and return its id immediately.

    Idempotent by scene_request_key (work_id+scene_id+model+size+prompt):
    a repeated submit for the same key returns the existing task instead of
    creating a second generation. completed / running / queued / uncertain /
    failed are all returned as-is — the caller decides what to do; nothing
    here ever auto-recreates a task.
    """
    requested_model = (request.model or "").strip()
    model = (
        settings.image_model
        if not requested_model or requested_model == "service-configured"
        else requested_model
    )
    store = get_image_task_store()
    key = store.scene_request_key(
        work_id=request.work_id,
        scene_id=request.scene_id,
        model=model,
        width=request.width,
        height=request.height,
        prompt=request.prompt,
        negative_prompt=request.negative_prompt,
    )
    existing = store.get_by_key(key)
    if existing is not None:
        return _image_task_response(existing, created=False)
    task = store.insert_queued(
        scene_request_key=key,
        work_id=request.work_id,
        scene_id=request.scene_id,
        kind=request.kind,
        model=model,
        width=request.width,
        height=request.height,
        prompt=request.prompt,
        negative_prompt=request.negative_prompt,
        title=request.title,
        author=request.author,
    )
    return _image_task_response(task, created=True)


@app.get("/v1/image-tasks/{task_id}")
async def get_image_task(
    task_id: str,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    store = get_image_task_store()
    task = store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Image task not found")
    return _image_task_response(task, created=False)


@app.get("/v1/image-tasks")
async def list_image_tasks(
    work_id: str = Query(min_length=1, max_length=500),
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    """Read-only list of every image task for one work (by scene id)."""
    store = get_image_task_store()
    tasks = store.list_by_work(work_id)
    # cheap global health signal for recovery drivers: any task completed in
    # the last 10 minutes proves the image upstream is accepting requests.
    recent_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 600))
    recent_completions = store.count_recent_completions(recent_iso)
    return {
        "work_id": work_id,
        "count": len(tasks),
        "recent_completions": recent_completions,
        "tasks": [_image_task_response(t, created=False) for t in tasks],
    }


@app.post("/v1/image-tasks/{task_id}/retry", status_code=status.HTTP_200_OK)
async def retry_image_task(
    task_id: str,
    settings: Settings = Depends(_authorize),
) -> dict[str, Any]:
    """Explicitly requeue a task the server knows failed upstream.

    Same task id, same scene_request_key — only the status flips
    failed -> queued and the existing worker claims it again. Safe only for
    status == 'failed'; completed / running / queued / uncertain are rejected.
    """
    store = get_image_task_store()
    result = store.retry_failed(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Image task not found")
    if not result["ok"]:
        if result["reason"] == "invalid_status":
            raise HTTPException(
                status_code=409,
                detail=f"Image task is {result['status']}; only failed tasks can be retried",
            )
        raise HTTPException(
            status_code=409,
            detail=f"Max retries reached ({result['retry_count']})",
        )
    return _image_task_response(result["task"], created=False)


def _image_task_response(task: dict[str, Any], *, created: bool) -> dict[str, Any]:
    return {
        "image_task_id": task["id"],
        "scene_request_key": task["scene_request_key"],
        "work_id": task["work_id"],
        "scene_id": task.get("scene_id"),
        "status": task["status"],
        "created": created,
        "attempt_count": task.get("attempt_count", 0),
        "retry_count": task.get("retry_count", 0),
        "asset": task.get("asset"),
        "error": task.get("error"),
        "last_error": task.get("last_error"),
        "last_failed_at": task.get("last_failed_at"),
        "created_at": task.get("created_at"),
        "started_at": task.get("started_at"),
        "finished_at": task.get("finished_at"),
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
            api_key=settings.image_api_key,
            base_url=settings.image_base_url,
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
