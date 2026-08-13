from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import httpx
import pytest

from app.interpretation.visual_director import VisualDirectorError, direct_work_visuals
from app.schemas.visual import SceneUnit, VisualDirectorRequest


def _request() -> VisualDirectorRequest:
    return VisualDirectorRequest(
        title="面朝大海，春暖花开",
        author="海子",
        full_text="从明天起，做一个幸福的人。喂马、劈柴，周游世界。",
        scene_units=[
            SceneUnit(
                scene_id="scene-1",
                source_sentence_ids=["sentence-1"],
                source_text="从明天起，做一个幸福的人。",
                next_text="喂马、劈柴，周游世界。",
                position=0,
            ),
            SceneUnit(
                scene_id="scene-2",
                source_sentence_ids=["sentence-2"],
                source_text="喂马、劈柴，周游世界。",
                previous_text="从明天起，做一个幸福的人。",
                position=1,
            ),
        ],
    )


def _result() -> dict[str, object]:
    profile = {
        "visual_style": "东方当代写意插画",
        "palette": ["暖白", "雾蓝"],
        "texture": "宣纸",
        "lighting": "晨光",
        "atmosphere": "安静开阔",
        "composition_rule": "主体偏边缘并保留留白",
        "human_presence": "弱化人物",
        "symbolic_elements": ["海面", "花枝"],
        "avoid": ["随机文字", "水印"],
    }
    scenes = []
    for unit in _request().scene_units:
        scenes.append({
            "scene_id": unit.scene_id,
            "source_sentence_ids": unit.source_sentence_ids,
            "source_text": unit.source_text,
            "narrative_function": "展开",
            "visual_type": "environment",
            "scene_summary": "晨光中的开阔空间",
            "main_subject": "海与花",
            "environment": "海边",
            "emotion": ["温暖"],
            "symbolism": ["新生"],
            "composition": "大面积留白",
            "camera_distance": "远景",
            "lighting": "晨光",
            "palette": ["暖白", "雾蓝"],
            "image_prompt": "东方写意海边晨光",
            "negative_prompt": "文字，水印",
        })
    return {
        "work_visual_profile": profile,
        "hero_visual_spec": {
            "type": "hero",
            "size": {"width": 1500, "height": 420},
            "required_text": ["面朝大海，春暖花开", "海子", "朗诵情感图谱"],
            "text_layout": "左侧标题",
            "visual_subject": "海面与花枝",
            "composition": "右侧意象",
            "lighting": "晨光",
            "palette": ["暖白", "雾蓝"],
            "image_prompt": "东方写意诗歌 Hero",
            "negative_prompt": "随机文字，水印",
        },
        "scene_visual_specs": scenes,
    }


def test_visual_director_is_a_separate_structured_llm_request() -> None:
    captured: dict[str, object] = {}
    result = _result()

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result, ensure_ascii=False)}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.interpretation.visual_director.httpx.AsyncClient", side_effect=client_factory):
        actual = asyncio.run(direct_work_visuals(
            request=_request(),
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))

    assert actual == result
    assert captured["model"] == "deepseek-v4-pro"
    assert captured["thinking"] == {"type": "enabled"}
    assert captured["reasoning_effort"] == "high"
    messages = captured["messages"]
    assert isinstance(messages, list)
    prompt = json.dumps(messages, ensure_ascii=False)
    assert "不得生成或修改朗诵 control_spec" in prompt
    assert "scene_units" in prompt


def test_visual_director_rejects_changed_source_scene() -> None:
    result = _result()
    scenes = result["scene_visual_specs"]
    assert isinstance(scenes, list)
    scenes[0]["source_text"] = "被篡改的正文"

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result, ensure_ascii=False)}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.interpretation.visual_director.httpx.AsyncClient", side_effect=client_factory), pytest.raises(
        VisualDirectorError,
        match="changed the source identity or text",
    ):
        asyncio.run(direct_work_visuals(
            request=_request(),
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))


def test_visual_director_rejects_changed_hero_required_text() -> None:
    result = _result()
    hero = result["hero_visual_spec"]
    assert isinstance(hero, dict)
    hero["required_text"] = ["错别字标题", "海子", "朗诵情感图谱"]

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result, ensure_ascii=False)}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.interpretation.visual_director.httpx.AsyncClient", side_effect=client_factory), pytest.raises(
        VisualDirectorError,
        match="changed required Hero title or author text",
    ):
        asyncio.run(direct_work_visuals(
            request=_request(),
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))


def test_visual_director_rejects_changed_locked_profile() -> None:
    result = _result()
    profile = result["work_visual_profile"]
    assert isinstance(profile, dict)
    locked_request = _request().model_copy(update={"locked_profile": profile})
    result["work_visual_profile"] = {**profile, "visual_style": "被擅自改写的风格"}

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result, ensure_ascii=False)}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.interpretation.visual_director.httpx.AsyncClient", side_effect=client_factory), pytest.raises(
        VisualDirectorError,
        match="changed a locked work visual profile",
    ):
        asyncio.run(direct_work_visuals(
            request=locked_request,
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))
