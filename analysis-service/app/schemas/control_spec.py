from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Span(StrictModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def ordered(self) -> "Span":
        if self.end < self.start:
            raise ValueError("span end must be greater than or equal to start")
        return self


class FocusInterpretation(StrictModel):
    focus_span: Span
    focus_style: Literal[
        "supported",
        "soft",
        "slower",
        "lower_weighted",
        "breathy",
        "breathy_to_supported",
    ] | None = None
    confidence: float = Field(ge=0, le=1)
    explanation: str | None = None


class Pause(StrictModel):
    after_index: int = Field(ge=0)
    type: Literal["short", "long"]
    observed_gap_ms: int | None = Field(ge=0)


class Prolongation(StrictModel):
    token_index: int = Field(ge=0)
    degree: Literal[1, 2, 3]


class Prosody(StrictModel):
    type: Literal["peak", "valley", "rising", "falling"]
    active_span: Span
    core_zone: Span
    strength: Literal[1, 2, 3]
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def core_inside_active_span(self) -> "Prosody":
        if self.core_zone.start < self.active_span.start or self.core_zone.end > self.active_span.end:
            raise ValueError("core_zone must be inside active_span")
        return self


class EndingIntonation(StrictModel):
    type: Literal["rising", "falling", "level"]
    strength: Literal[1, 2, 3]


class Rhythm(StrictModel):
    type: Literal["light", "solemn", "relaxed", "tense", "soaring", "low"]


class PerformanceProfile(StrictModel):
    delivery_mode: Literal[
        "natural_narration", "lyrical_recitation", "stage_recitation"
    ] | None = None
    emotion_tone: list[str] = Field(default_factory=list)
    continuity: Literal["connected", "balanced", "segmented"] | None = None
    voice_quality: Literal[
        "neutral",
        "solid",
        "slightly_breathy",
        "breathy",
        "mixed",
        "breathy_to_supported",
        "breathy_to_mixed",
        "mixed_to_solid",
        "solid_to_soft",
    ] | None = None
    focus_style: Literal[
        "supported",
        "soft",
        "slower",
        "lower_weighted",
        "breathy",
        "breathy_to_supported",
    ] | None = None
    expression_amplitude: Literal["low", "medium", "high"] | None = None
    avoid: list[str] = Field(default_factory=list)


class InterpretedSentence(StrictModel):
    text: str
    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)
    focus_spans: list[FocusInterpretation]
    prosody: list[Prosody]
    rhythm: Rhythm | None = None
    performance_profile: PerformanceProfile | None = None
    text_logic: str | None = None
    emotional_interpretation: str | None = None
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_indexes(self) -> "InterpretedSentence":
        if self.end_index < self.start_index:
            raise ValueError("sentence end_index must be greater than or equal to start_index")
        for focus in self.focus_spans:
            if focus.focus_span.start < self.start_index or focus.focus_span.end > self.end_index:
                raise ValueError("focus span is outside sentence")
        for event in self.prosody:
            if event.active_span.start < self.start_index or event.active_span.end > self.end_index:
                raise ValueError("prosody span is outside sentence")
        return self


class LlmInterpretation(StrictModel):
    performance_profile: PerformanceProfile | None = None
    sentences: list[InterpretedSentence] = Field(min_length=1)


class JobRequest(StrictModel):
    job_id: str = Field(min_length=1)
    input_url: str = Field(min_length=1)
    audio_url: str = Field(min_length=1)
    callback_url: str = Field(min_length=1)


class AnalysisToken(StrictModel):
    index: int
    char: str
    machine_pinyin: str | None = None
    display_pinyin: str | None = None
    start_ms: int
    end_ms: int
    confidence: float = 1.0
