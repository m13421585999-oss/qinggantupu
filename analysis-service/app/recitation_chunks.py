"""SQLite persistence for chunked text-recitation jobs.

Long manuscripts (Sentence > 12) are analyzed in chunks of 8-10 Sentences so a
single LLM request stays small and never times out. Each chunk is persisted
here with its own status so a resume reuses completed chunks and only retries
failed ones. The key is a deterministic hash of the source text, so the same
manuscript re-submitted (batch resume / runner restart) maps to the same rows.

This reuses the same SQLite database file as image_tasks (single-machine
deployment; no Redis / Kafka / Celery).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from typing import Any

from app.image_tasks import get_image_task_store

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"


class RecitationChunkStore:
    """Chunk state for text-recitation. Shares the image_tasks DB file."""

    def __init__(self, db_path: str | None = None) -> None:
        store = get_image_task_store()
        self.db_path = db_path or store.db_path
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
                CREATE TABLE IF NOT EXISTS recitation_chunks (
                    request_key TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    finished_at TEXT,
                    result_json TEXT,
                    error TEXT,
                    PRIMARY KEY (request_key, chunk_index)
                );
                """
            )

    @staticmethod
    def request_key(title: str, author: str, text: str) -> str:
        material = f"{title}\u0000{author}\u0000{text}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    # -- reads --------------------------------------------------------------

    def get(self, request_key: str, chunk_index: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM recitation_chunks WHERE request_key = ? AND chunk_index = ?",
                (request_key, chunk_index),
            ).fetchone()
        return dict(row) if row else None

    def all_for_key(self, request_key: str) -> dict[int, dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM recitation_chunks WHERE request_key = ? ORDER BY chunk_index",
                (request_key,),
            ).fetchall()
        return {int(row["chunk_index"]): dict(row) for row in rows}

    # -- writes -------------------------------------------------------------

    def upsert_queued(
        self, request_key: str, chunk_index: int, created_at: str
    ) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO recitation_chunks (request_key, chunk_index, status, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(request_key, chunk_index) DO NOTHING
                """,
                (request_key, chunk_index, STATUS_QUEUED, created_at),
            )

    def mark_running(self, request_key: str, chunk_index: int) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE recitation_chunks SET status = ? WHERE request_key = ? AND chunk_index = ?
                """,
                (STATUS_RUNNING, request_key, chunk_index),
            )

    def mark_completed(
        self, request_key: str, chunk_index: int, result: list[dict[str, Any]]
    ) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE recitation_chunks SET status = ?, finished_at = ?,
                    result_json = ?, error = NULL
                WHERE request_key = ? AND chunk_index = ?
                """,
                (
                    STATUS_COMPLETED,
                    now,
                    json.dumps(result, ensure_ascii=False),
                    request_key,
                    chunk_index,
                ),
            )

    def mark_failed(self, request_key: str, chunk_index: int, error: str) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE recitation_chunks SET status = ?, finished_at = ?, error = ?
                WHERE request_key = ? AND chunk_index = ?
                """,
                (STATUS_FAILED, now, error[:2000], request_key, chunk_index),
            )


_store: RecitationChunkStore | None = None
_store_lock = threading.Lock()


def get_recitation_chunk_store() -> RecitationChunkStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = RecitationChunkStore()
    return _store
