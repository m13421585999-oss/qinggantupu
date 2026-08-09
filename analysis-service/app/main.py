from __future__ import annotations

import asyncio
import hmac
import logging
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from pydantic_settings import BaseSettings, SettingsConfigDict

from .pipeline import run_pipeline


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("recitation-analysis")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    elevenlabs_api_key: str = ""
    analysis_service_token: str = ""
    max_audio_bytes: int = 100 * 1024 * 1024
    callback_timeout_seconds: float = 30.0


settings = Settings()
app = FastAPI(title="声图真人朗诵分析服务", version="1.0.0")
analysis_lock = asyncio.Semaphore(1)


@dataclass(frozen=True)
class JobInput:
    job_id: str
    work_id: str
    title: str
    author: str
    full_text: str
    filename: str
    mime_type: str
    audio_bytes: bytes
    callback_url: str
    callback_token: str


@app.get("/healthz")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "recitation-analysis",
        "elevenlabs_configured": bool(settings.elevenlabs_api_key),
        "llm_enabled": False,
    }


@app.post("/v1/jobs", status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    background_tasks: BackgroundTasks,
    job_id: Annotated[str, Form()],
    work_id: Annotated[str, Form()],
    title: Annotated[str, Form()],
    author: Annotated[str, Form()],
    full_text: Annotated[str, Form()],
    callback_url: Annotated[str, Form()],
    callback_token: Annotated[str, Form()],
    audio_file: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    authorize(authorization)
    if not title.strip() or not full_text.strip():
        raise HTTPException(status_code=400, detail="title and full_text are required")
    audio_bytes = await audio_file.read(settings.max_audio_bytes + 1)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="audio_file is empty")
    if len(audio_bytes) > settings.max_audio_bytes:
        raise HTTPException(status_code=413, detail="audio_file exceeds 100 MB")
    job = JobInput(
        job_id=job_id,
        work_id=work_id,
        title=title,
        author=author,
        full_text=full_text,
        filename=audio_file.filename or "reference-audio",
        mime_type=audio_file.content_type or "application/octet-stream",
        audio_bytes=audio_bytes,
        callback_url=callback_url,
        callback_token=callback_token,
    )
    background_tasks.add_task(process_job, job)
    return {"job_id": job_id, "status": "accepted"}


def authorize(authorization: str | None) -> None:
    if not settings.analysis_service_token:
        return
    supplied = (authorization or "").removeprefix("Bearer ")
    if not hmac.compare_digest(supplied, settings.analysis_service_token):
        raise HTTPException(status_code=401, detail="invalid service token")


async def process_job(job: JobInput) -> None:
    async with analysis_lock:
        try:
            package, quality = await run_pipeline(
                title=job.title,
                author=job.author,
                full_text=job.full_text,
                filename=job.filename,
                mime_type=job.mime_type,
                audio_bytes=job.audio_bytes,
                elevenlabs_api_key=settings.elevenlabs_api_key,
            )
            payload: dict[str, Any] = {
                "status": "succeeded",
                "analysis_package": package.model_dump(mode="json"),
                "provider_quality": quality,
            }
        except Exception as error:  # The Worker must receive a terminal failed state.
            logger.exception("analysis job %s failed", job.job_id)
            payload = {
                "status": "failed",
                "error": {"code": error.__class__.__name__.upper(), "message": str(error)},
            }
        await post_callback(job, payload)


async def post_callback(job: JobInput, payload: dict[str, Any]) -> None:
    last_error: Exception | None = None
    for delay in (0, 1, 3):
        if delay:
            await asyncio.sleep(delay)
        try:
            async with httpx.AsyncClient(timeout=settings.callback_timeout_seconds) as client:
                response = await client.post(
                    job.callback_url,
                    headers={"authorization": f"Bearer {job.callback_token}"},
                    json=payload,
                )
            response.raise_for_status()
            return
        except Exception as error:
            last_error = error
            logger.warning("callback attempt failed for %s: %s", job.job_id, error)
    logger.error("analysis callback permanently failed for %s: %s", job.job_id, last_error)
