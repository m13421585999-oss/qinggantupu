from __future__ import annotations

import asyncio
import logging
import os
import secrets
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, status

from app.config import (
    DEEPSEEK_BASE_URL,
    DEEPSEEK_PROVIDER,
    DEEPSEEK_REASONING_EFFORTS,
    DEEPSEEK_THINKING,
    ConfigurationError,
    Settings,
    configured_model,
)
from app.pipeline import PIPELINE_VERSION, analyze_job
from app.schemas.control_spec import JobRequest


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("recitation-analysis")

app = FastAPI(
    title="声图朗诵分析服务",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)


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
    configured["LLM_AUTH"] = bool(os.getenv("LLM_API_KEY", "").strip())
    reasoning_effort = os.getenv("LLM_REASONING_EFFORT", "high").strip().lower()
    configured["LLM_REASONING_EFFORT"] = reasoning_effort in DEEPSEEK_REASONING_EFFORTS
    llm = {
        "provider": DEEPSEEK_PROVIDER,
        "base_url": DEEPSEEK_BASE_URL,
        "model": configured_model(),
        "thinking": DEEPSEEK_THINKING,
        "reasoning_effort": reasoning_effort,
    }
    return {"ok": all(configured.values()), "configured": configured, "llm": llm}


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
