"""Background executor for persisted image tasks.

Submitting a task only writes a queued row and returns its id immediately;
the actual gpt-image-2 call happens here in a background asyncio task. On
startup any row left in `running` becomes `uncertain` (upstream state unknown
after a crash/restart) — the caller polls that status and never auto-recreates
the task, avoiding double-charge risk.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.config import Settings
from app.image_tasks import (
    STATUS_FAILED,
    STATUS_UNCERTAIN,
    ImageTaskStore,
)
from app.providers.image_generation import (
    ImageGenerationError,
    generate_image,
)

logger = logging.getLogger("recitation-analysis.image-tasks")

POLL_INTERVAL_SECONDS = 2.0


class ImageTaskExecutor:
    def __init__(self, store: ImageTaskStore) -> None:
        self._store = store
        self._stop = asyncio.Event()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if hasattr(self, "_task"):
            try:
                await asyncio.wait_for(self._task, timeout=3)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                task = self._store.claim_next_queued()
                if task is None:
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=POLL_INTERVAL_SECONDS)
                    except asyncio.TimeoutError:
                        pass  # poll interval elapsed; loop again
                    continue
                await self._execute(task)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("image task executor iteration failed")
                await asyncio.sleep(POLL_INTERVAL_SECONDS)

    async def _execute(self, task: dict[str, Any]) -> None:
        task_id = str(task["id"])
        settings = Settings.from_environment()
        started = time.monotonic()
        logger.info(
            "image task %s start work=%s scene=%s model=%s size=%s attempt=%s",
            task_id,
            task.get("work_id"),
            task.get("scene_id"),
            task.get("model"),
            task.get("size"),
            task.get("attempt_count"),
        )
        try:
            result = await generate_image(
                provider=settings.image_provider,
                api_key=settings.image_api_key,
                base_url=settings.image_base_url,
                model=str(task["model"]),
                prompt=str(task["prompt"]),
                negative_prompt=task.get("negative_prompt"),
                width=int(task["width"]),
                height=int(task["height"]),
                timeout_seconds=settings.request_timeout_seconds,
            )
        except ImageGenerationError as exc:
            # Deterministic upstream failure (HTTP error / invalid JSON).
            self._store.mark_failed(task_id, str(exc))
            logger.warning(
                "image task %s failed after %.0fs: %s",
                task_id, time.monotonic() - started, str(exc)[:300],
            )
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Network-level / unknown failure: the upstream may still be
            # generating. Mark uncertain, never auto-recreate.
            self._store.mark_uncertain(task_id, str(exc))
            logger.warning(
                "image task %s uncertain after %.0fs: %s",
                task_id, time.monotonic() - started, str(exc)[:300],
            )
            return
        self._store.mark_completed(task_id, result.image)
        logger.info(
            "image task %s completed in %.0fs (endpoint=%s)",
            task_id, time.monotonic() - started, result.endpoint,
        )

    def recover_stale_running(self) -> int:
        count = self._store.recover_stale_running()
        if count:
            logger.warning("image tasks recovered to uncertain on startup: %s", count)
        return count


executor: ImageTaskExecutor | None = None
