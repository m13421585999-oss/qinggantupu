from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictVisualModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SceneUnit(StrictVisualModel):
    scene_id: str = Field(min_length=1)
    source_sentence_ids: list[str] = Field(default_factory=list)
    source_text: str = Field(min_length=1)
    previous_text: str | None = None
    next_text: str | None = None
    position: int = Field(ge=0)


class VisualDirectorRequest(StrictVisualModel):
    title: str = Field(min_length=1)
    author: str = ""
    full_text: str = Field(min_length=1)
    genre: str = "other"
    control_spec_summary: dict[str, Any] = Field(default_factory=dict)
    scene_units: list[SceneUnit] = Field(min_length=1)
    locked_profile: dict[str, Any] | None = None


class WorkVisualProfile(StrictVisualModel):
    visual_style: str
    palette: list[str] = Field(min_length=1, max_length=10)
    texture: str
    lighting: str
    atmosphere: str
    composition_language: str
    human_presence: str
    symbolic_language: list[str] = Field(default_factory=list, max_length=16)
    avoid: list[str] = Field(default_factory=list, max_length=20)


class HeroSize(StrictVisualModel):
    width: Literal[1500]
    height: Literal[280]


class HeroVisualSpec(StrictVisualModel):
    type: Literal["hero"]
    size: HeroSize
    required_text: list[str] = Field(min_length=2, max_length=3)
    text_layout: str
    visual_subject: str
    composition: str
    lighting: str
    palette: list[str] = Field(min_length=1, max_length=10)
    image_prompt: str
    negative_prompt: str


class SceneVisualSpec(StrictVisualModel):
    scene_id: str = Field(min_length=1)
    source_sentence_ids: list[str] = Field(default_factory=list)
    source_text: str = Field(min_length=1)
    narrative_function: str
    visual_type: Literal[
        "literal_scene",
        "symbolic_scene",
        "abstract_scene",
        "environment",
        "minimal",
    ]
    scene_meaning: str
    main_subject: str
    environment: str
    emotion: list[str] = Field(default_factory=list, max_length=10)
    symbolism: list[str] = Field(default_factory=list, max_length=12)
    composition: str
    camera_distance: str
    lighting: str
    palette: list[str] = Field(min_length=1, max_length=10)
    image_prompt: str
    negative_prompt: str


class VisualDirectorResult(StrictVisualModel):
    work_visual_profile: WorkVisualProfile
    hero_visual_spec: HeroVisualSpec
    scene_visual_specs: list[SceneVisualSpec] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_scene_ids(self) -> "VisualDirectorResult":
        scene_ids = [scene.scene_id for scene in self.scene_visual_specs]
        if len(scene_ids) != len(set(scene_ids)):
            raise ValueError("scene_visual_specs contains duplicate scene_id values")
        return self
