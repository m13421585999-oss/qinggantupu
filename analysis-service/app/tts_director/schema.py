from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class EmotionalArcStage(StrictModel):
    stage: int = Field(ge=1)
    description: str = Field(min_length=1, max_length=2_000)
    delivery: str = Field(min_length=1, max_length=2_000)


class PerformancePlan(StrictModel):
    genre: str = Field(min_length=1, max_length=500)
    theme: str = Field(min_length=1, max_length=2_000)
    overall_tone: str = Field(alias="overallTone", min_length=1, max_length=2_000)
    narrator_state: str = Field(alias="narratorState", min_length=1, max_length=2_000)
    emotional_arc: list[EmotionalArcStage] = Field(
        alias="emotionalArc", min_length=1, max_length=20
    )
    climax: str = Field(min_length=1, max_length=2_000)
    ending: str = Field(min_length=1, max_length=2_000)


class TtsDirectorResult(StrictModel):
    performance_plan: PerformancePlan = Field(alias="performancePlan")
    tts_text: str = Field(alias="ttsText", min_length=1, max_length=100_000)


class TtsDirectorRequest(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    author: str = Field(default="", max_length=500)
    original_text: str = Field(min_length=1, max_length=80_000)
