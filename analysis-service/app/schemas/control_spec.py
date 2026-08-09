from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class AnalysisToken(BaseModel):
    index: int
    char: str
    machine_pinyin: str | None = None
    display_pinyin: str | None = None
    start_ms: int
    end_ms: int
    duration_ms: int
    confidence: float = 1.0


class PauseEvidence(BaseModel):
    after_index: int
    gap_ms: int
    relative_level: Literal["short", "long"]


class ElongationEvidence(BaseModel):
    token_index: int
    duration_ms: int
    local_duration_ratio: float


class SentenceSummary(BaseModel):
    id: str
    order: int
    text: str
    start_index: int
    end_index: int
    start_ms: int
    end_ms: int
    speaking_rate: float
    pause_summary: dict[str, Any]
    duration_summary: dict[str, Any]
    pitch_summary: dict[str, Any]
    energy_summary: dict[str, Any]
    macro_pitch_contour: list[dict[str, Any]]


class RecitationAnalysisPackage(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    generated_at: str
    work: dict[str, str]
    audio: dict[str, int | float]
    alignment_quality: dict[str, Any]
    tokens: list[AnalysisToken]
    words: list[dict[str, Any]]
    pauses: list[PauseEvidence]
    elongations: list[ElongationEvidence]
    pitch: list[dict[str, Any]]
    energy: list[dict[str, Any]]
    sentences: list[SentenceSummary]
    analysis_rules_version: str = Field(default="recitation-expression-v1.0")
