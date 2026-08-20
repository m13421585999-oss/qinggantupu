"""Durable queue for manuscript-only recitation analysis.

The browser and Cloudflare Worker must not hold one HTTP request open while a
long manuscript is interpreted. Tasks live in the same single-machine SQLite
database as image tasks; the FastAPI lifespan worker resumes queued work after
a process restart.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Any

from app.image_tasks import get_image_task_store

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"


class TextRecitationTaskStore:
    def __init__(self, db_path: str | None = None) -> None:
        self.db_path = db_path or get_image_task_store().db_path
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
                CREATE TABLE IF NOT EXISTS text_recitation_tasks (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    error TEXT,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_text_recitation_tasks_status
                    ON text_recitation_tasks(status, created_at);
                """
            )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        for source, target in (("request_json", "request"), ("result_json", "result")):
            try:
                data[target] = json.loads(data[source]) if data.get(source) else None
            except (TypeError, ValueError):
                data[target] = None
        return data

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM text_recitation_tasks WHERE id = ?", (task_id,)
            ).fetchone()
        return self._row_to_dict(row)

    def insert_queued(self, request: dict[str, Any]) -> dict[str, Any]:
        task_id = f"text_task_{uuid.uuid4().hex}"
        created_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO text_recitation_tasks
                    (id, status, request_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    task_id,
                    STATUS_QUEUED,
                    json.dumps(request, ensure_ascii=False),
                    created_at,
                ),
            )
        return self.get(task_id)  # type: ignore[return-value]

    def claim_next_queued(self) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT id FROM text_recitation_tasks
                WHERE status = ? ORDER BY created_at ASC LIMIT 1
                """,
                (STATUS_QUEUED,),
            ).fetchone()
            if row is None:
                return None
            started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            connection.execute(
                """
                UPDATE text_recitation_tasks
                SET status = ?, started_at = ?, attempt_count = attempt_count + 1,
                    error = NULL, finished_at = NULL
                WHERE id = ?
                """,
                (STATUS_RUNNING, started_at, row["id"]),
            )
        return self.get(str(row["id"]))

    def mark_completed(self, task_id: str, result: dict[str, Any]) -> None:
        finished_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE text_recitation_tasks
                SET status = ?, result_json = ?, error = NULL, finished_at = ?
                WHERE id = ?
                """,
                (
                    STATUS_COMPLETED,
                    json.dumps(result, ensure_ascii=False),
                    finished_at,
                    task_id,
                ),
            )

    def mark_failed(self, task_id: str, error: str) -> None:
        finished_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE text_recitation_tasks
                SET status = ?, error = ?, finished_at = ? WHERE id = ?
                """,
                (STATUS_FAILED, error[:2000], finished_at, task_id),
            )

    def recover_stale_running(self) -> int:
        """A local LLM request has no external side effect, so it is safe to resume."""
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE text_recitation_tasks
                SET status = ?, started_at = NULL
                WHERE status = ?
                """,
                (STATUS_QUEUED, STATUS_RUNNING),
            )
        return cursor.rowcount


_store: TextRecitationTaskStore | None = None
_store_lock = threading.Lock()


def get_text_recitation_task_store() -> TextRecitationTaskStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = TextRecitationTaskStore()
    return _store
