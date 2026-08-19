"""SQLite persistence for image generation tasks.

Each scene submission maps to one stable row keyed by a deterministic
scene_request_key (sha256 of work_id+scene_id+model+size+prompt). Repeated
submits for the same key return the same task id, so a batch runner that
timeouts / restarts / resumes never pays for a second generation of a scene
that was already submitted. Only a real prompt/model/size change (hash change)
may create a new task.

This is a single-machine deployment; SQLite is the intended persistence layer
(no Redis / Kafka / Celery).
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

DB_ENV = "IMAGE_TASKS_DB_PATH"

# status values
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_UNCERTAIN = "uncertain"

TERMINAL_STATUSES = frozenset({STATUS_COMPLETED, STATUS_FAILED})

# explicit retry is only allowed for a task the server KNOWS failed upstream;
# cap retries so a permanently-failing scene can never loop forever.
MAX_RETRIES = 3


def default_db_path() -> str:
    configured = os.getenv(DB_ENV, "").strip()
    if configured:
        return configured
    return str(Path(__file__).resolve().parent.parent / "data" / "image_tasks.sqlite3")


class ImageTaskStore:
    """Thread-safe SQLite store. One writer lock; reads open short connections."""

    def __init__(self, db_path: str | None = None) -> None:
        self.db_path = db_path or default_db_path()
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_schema(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS image_tasks (
                    id TEXT PRIMARY KEY,
                    scene_request_key TEXT NOT NULL UNIQUE,
                    work_id TEXT NOT NULL,
                    scene_id TEXT,
                    kind TEXT NOT NULL,
                    model TEXT NOT NULL,
                    size TEXT NOT NULL,
                    prompt_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    upstream_started_at TEXT,
                    asset_json TEXT,
                    error TEXT,
                    last_error TEXT,
                    last_failed_at TEXT,
                    title TEXT,
                    author TEXT,
                    negative_prompt TEXT,
                    prompt TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status);
                CREATE INDEX IF NOT EXISTS idx_image_tasks_work ON image_tasks(work_id, scene_id);
                """
            )
            # migrate existing databases: add history columns if missing.
            cols = {row[1] for row in connection.execute("PRAGMA table_info(image_tasks)")}
            for name, ddl in (
                ("retry_count", "ALTER TABLE image_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"),
                ("last_error", "ALTER TABLE image_tasks ADD COLUMN last_error TEXT"),
                ("last_failed_at", "ALTER TABLE image_tasks ADD COLUMN last_failed_at TEXT"),
            ):
                if name not in cols:
                    connection.execute(ddl)

    # -- key helpers ---------------------------------------------------------

    @staticmethod
    def scene_request_key(
        *,
        work_id: str,
        scene_id: str | None,
        model: str,
        width: int,
        height: int,
        prompt: str,
        negative_prompt: str | None,
    ) -> str:
        material = "|".join(
            [
                work_id,
                scene_id or "",
                model,
                f"{width}x{height}",
                negative_prompt or "",
                prompt,
            ]
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def new_task_id() -> str:
        return f"image_task_{uuid.uuid4().hex}"

    # -- row mapping ---------------------------------------------------------

    @staticmethod
    def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        if data.get("asset_json"):
            try:
                data["asset"] = json.loads(data["asset_json"])
            except (TypeError, ValueError):
                data["asset"] = None
        else:
            data["asset"] = None
        return data

    # -- queries -------------------------------------------------------------

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM image_tasks WHERE id = ?", (task_id,)
            ).fetchone()
        return self._row_to_dict(row)

    def get_by_key(self, scene_request_key: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM image_tasks WHERE scene_request_key = ?",
                (scene_request_key,),
            ).fetchone()
        return self._row_to_dict(row)

    def list_by_work(self, work_id: str) -> list[dict[str, Any]]:
        """All image tasks for one work, ordered by scene id (read-only)."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM image_tasks WHERE work_id = ? ORDER BY scene_id ASC",
                (work_id,),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def count_recent_completions(self, since_iso: str) -> int:
        """How many tasks completed anywhere at/after `since_iso` (UTC).

        A >0 value is the cheapest proof that the image upstream is currently
        accepting and producing requests — used by recovery drivers to decide
        whether a failed scene whose last_error is 'insufficient balance'
        should be retried now (balance may have been restored) or skipped.
        """
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS c FROM image_tasks WHERE status = 'completed' AND finished_at >= ?",
                (since_iso,),
            ).fetchone()
        return int(row["c"]) if row else 0

    def list_incomplete(self) -> list[dict[str, Any]]:
        """queued / running / uncertain tasks, oldest first."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM image_tasks WHERE status IN ('queued', 'running', 'uncertain') "
                "ORDER BY created_at ASC",
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    # -- writes --------------------------------------------------------------

    def insert_queued(
        self,
        *,
        scene_request_key: str,
        work_id: str,
        scene_id: str | None,
        kind: str,
        model: str,
        width: int,
        height: int,
        prompt: str,
        negative_prompt: str | None,
        title: str | None,
        author: str | None,
    ) -> dict[str, Any]:
        task_id = self.new_task_id()
        size = f"{width}x{height}"
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO image_tasks (
                    id, scene_request_key, work_id, scene_id, kind, model, size,
                    prompt_hash, status, attempt_count, created_at, prompt,
                    negative_prompt, width, height, title, author
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    scene_request_key,
                    work_id,
                    scene_id,
                    kind,
                    model,
                    size,
                    prompt_hash,
                    STATUS_QUEUED,
                    now,
                    prompt,
                    negative_prompt,
                    width,
                    height,
                    title,
                    author,
                ),
            )
        return self.get(task_id)  # type: ignore[return-value]

    def claim_next_queued(self) -> dict[str, Any] | None:
        """Atomically move one queued task to running (FIFO)."""
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT id FROM image_tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            connection.execute(
                """
                UPDATE image_tasks SET status = 'running', started_at = ?,
                    attempt_count = attempt_count + 1, upstream_started_at = ?
                WHERE id = ?
                """,
                (now, now, row["id"]),
            )
        return self.get(row["id"])  # type: ignore[return-value]

    def mark_completed(self, task_id: str, asset: dict[str, Any]) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE image_tasks SET status = 'completed', finished_at = ?,
                    asset_json = ?, error = NULL
                WHERE id = ?
                """,
                (now, json.dumps(asset, ensure_ascii=False), task_id),
            )

    def mark_failed(self, task_id: str, error: str) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE image_tasks SET status = 'failed', finished_at = ?, error = ?,
                    last_error = ?, last_failed_at = ?
                WHERE id = ?
                """,
                (now, error[:2000], error[:2000], now, task_id),
            )

    def retry_failed(self, task_id: str, max_retries: int = MAX_RETRIES) -> dict[str, Any] | None:
        """Explicitly requeue a task the server knows failed upstream.

        Atomic transition failed -> queued on the SAME row (same task id, same
        scene_request_key): the existing image task worker claims it again.
        History is preserved: retry_count is incremented and last_error /
        last_failed_at are left intact, only the current error is cleared.

        Allowed only when status == 'failed'. completed / running / queued /
        uncertain are rejected — no parallel duplicate generation, no
        double-charge on unknown upstream state, no regeneration of an asset
        that already exists.
        """
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT status, retry_count FROM image_tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if row is None:
                return None
            status = str(row["status"])
            if status != STATUS_FAILED:
                return {"ok": False, "reason": "invalid_status", "status": status}
            retries = int(row["retry_count"] or 0)
            if retries >= max_retries:
                return {"ok": False, "reason": "max_retries", "status": status, "retry_count": retries}
            now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            connection.execute(
                """
                UPDATE image_tasks SET status = 'queued', error = NULL,
                    finished_at = NULL, retry_count = ?
                WHERE id = ?
                """,
                (retries + 1, task_id),
            )
        task = self.get(task_id)
        return {"ok": True, "task": task, "retry_count": task["retry_count"] if task else retries + 1}

    def mark_uncertain(self, task_id: str, error: str) -> None:
        """Upstream may still be generating; never auto-recreate the task."""
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE image_tasks SET status = 'uncertain', error = ?
                WHERE id = ?
                """,
                (error[:2000], task_id),
            )

    def recover_stale_running(self) -> int:
        """Any running task older than the timeout becomes uncertain: the
        upstream state is unknown (it may still be generating)."""
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "UPDATE image_tasks SET status = 'uncertain' WHERE status = 'running'"
            )
        return cursor.rowcount


store: ImageTaskStore | None = None
_store_lock = threading.Lock()


def get_image_task_store() -> ImageTaskStore:
    global store
    if store is None:
        with _store_lock:
            if store is None:
                store = ImageTaskStore()
    return store
