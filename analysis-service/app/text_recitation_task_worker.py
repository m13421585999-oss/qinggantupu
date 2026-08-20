"""Background executor for persisted manuscript-recitation tasks."""

from __future__ import annotations

import asyncio
import logging

from app.config import Settings
from app.text_recitation import TextRecitationRequest, generate_text_recitation
from app.text_recitation_tasks import TextRecitationTaskStore

logger = logging.getLogger("recitation-analysis.text-recitation-tasks")


class TextRecitationTaskExecutor:
    def __init__(self, store: TextRecitationTaskStore) -> None:
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
            task = self._store.claim_next_queued()
            if task is None:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=1.5)
                except asyncio.TimeoutError:
                    pass
                continue
            await self._execute(task)

    async def _execute(self, task: dict[str, object]) -> None:
        task_id = str(task["id"])
        try:
            request = TextRecitationRequest.model_validate(task.get("request"))
            settings = Settings.from_environment()
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
            result.pop("_meta", None)
            self._store.mark_completed(task_id, result)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("text recitation task %s failed", task_id)
            self._store.mark_failed(task_id, str(exc))

    def recover_stale_running(self) -> int:
        return self._store.recover_stale_running()
