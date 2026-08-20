from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.control_spec import (
    FocusInterpretation,
    PerformanceProfile,
    Prosody,
    Rhythm,
    Span,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextRecitationRequest(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    author: str = Field(default="", max_length=500)
    text: str = Field(min_length=1, max_length=20_000)
    # Human-authored readings keyed by stable token id; they override generated
    # pinyin in every compact rendering. Empty for a brand-new work.
    pinyin_overrides: dict[str, str] = Field(default_factory=dict)


class TextRecitationSentence(StrictModel):
    # The LLM must echo the exact sentence text and its token range so the
    # program can verify that nothing was rewritten, dropped, added or reordered.
    text: str = Field(min_length=1)
    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)
    # Internal line function (叙述/描写/铺陈/展开/说明/对比/转折/递进/强调/
    # 呼告/反问/设问/总结/高潮/回落/收束). Analysis-only, never rendered.
    function: str | None = None
    focus_spans: list[FocusInterpretation] = Field(default_factory=list, max_length=1)
    # ``/`` pause positions expressed as the token index they follow. The LLM
    # only selects teaching-meaningful boundaries; every pause is stored short.
    pause_after: list[int] = Field(default_factory=list, max_length=2)
    prosody: list[Prosody] = Field(default_factory=list, max_length=2)
    # New analysis only emits an explicit rise or fall; omission means level.
    ending_intonation: Literal["rising", "falling"] | None = None
    rhythm: Rhythm | None = None
    performance_profile: PerformanceProfile | None = None
    text_logic: str | None = None
    emotional_interpretation: str | None = None
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_indexes(self) -> "TextRecitationSentence":
        if self.end_index < self.start_index:
            raise ValueError("sentence end_index must be >= start_index")
        for focus in self.focus_spans:
            if focus.focus_span.start < self.start_index or focus.focus_span.end > self.end_index:
                raise ValueError("focus span is outside sentence")
        for index in self.pause_after:
            if index < self.start_index or index > self.end_index:
                raise ValueError("pause position is outside sentence")
        for event in self.prosody:
            if event.active_span.start < self.start_index or event.active_span.end > self.end_index:
                raise ValueError("prosody span is outside sentence")
        return self


class TextRecitationPlan(StrictModel):
    performance_profile: PerformanceProfile | None = None
    sentences: list[TextRecitationSentence] = Field(min_length=1)


class WorkContext(StrictModel):
    """Lightweight whole-work context for chunked long-text analysis.

    Only high-level reading guidance; never per-sentence annotations.
    """

    overall_tone: str = Field(min_length=1, max_length=200)
    emotion_arc: str = Field(min_length=1, max_length=400)
    rhythm_tendency: str = Field(min_length=1, max_length=300)
    major_semantic_sections: list[str] = Field(default_factory=list, max_length=10)
