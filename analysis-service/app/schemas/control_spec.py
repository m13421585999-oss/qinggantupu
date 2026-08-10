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


class Focus(StrictModel):
    token_indexes: list[int] = Field(min_length=1)
    level: Literal["primary", "secondary"]


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


class InterpretedSentence(StrictModel):
    text: str
    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)
    focus: list[Focus]
    pauses: list[Pause]
    prolongations: list[Prolongation]
    prosody: list[Prosody]
    ending_intonation: EndingIntonation
    rhythm: Rhythm
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_indexes(self) -> "InterpretedSentence":
        if self.end_index < self.start_index:
            raise ValueError("sentence end_index must be greater than or equal to start_index")
        for focus in self.focus:
            if any(index < self.start_index or index > self.end_index for index in focus.token_indexes):
                raise ValueError("focus index is outside sentence")
        for pause in self.pauses:
            if pause.after_index < self.start_index or pause.after_index > self.end_index:
                raise ValueError("pause index is outside sentence")
        for prolongation in self.prolongations:
            if prolongation.token_index < self.start_index or prolongation.token_index > self.end_index:
                raise ValueError("prolongation index is outside sentence")
        for event in self.prosody:
            if event.active_span.start < self.start_index or event.active_span.end > self.end_index:
                raise ValueError("prosody span is outside sentence")
        return self


class LlmInterpretation(StrictModel):
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
