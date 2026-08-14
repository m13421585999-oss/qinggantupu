from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException

from app.config import Settings
from app.interpretation.visual_director import VisualDirectorError, direct_work_visuals
from app.main import create_visual_plan
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
        "composition_language": "主体偏边缘并保留留白",
        "human_presence": "弱化人物",
        "symbolic_language": ["海面", "花枝"],
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
            "scene_meaning": "晨光中的开阔空间",
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
            "size": {"width": 1500, "height": 280},
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

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        actual = asyncio.run(direct_work_visuals(
            request=_request(),
            provider="deepseek",
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))

    metadata = actual.pop("_meta")
    assert actual == result
    assert metadata == {
        "endpoint": "chat/completions",
        "output_mode": "json_object",
        "request_count": 1,
    }
    assert captured["model"] == "deepseek-v4-pro"
    assert captured["thinking"] == {"type": "enabled"}
    assert captured["reasoning_effort"] == "high"
    messages = captured["messages"]
    assert isinstance(messages, list)
    prompt = json.dumps(messages, ensure_ascii=False)
    assert "不得生成或修改朗诵 control_spec" in prompt
    assert "scene_units" in prompt


def test_visual_director_restores_changed_source_scene() -> None:
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

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        actual = asyncio.run(direct_work_visuals(
            request=_request(),
            provider="deepseek",
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))

    scenes = actual["scene_visual_specs"]
    assert scenes[0]["source_text"] == _request().scene_units[0].source_text
    assert scenes[0]["scene_id"] == _request().scene_units[0].scene_id
    assert scenes[0]["source_sentence_ids"] == ["sentence-1"]


def test_visual_director_restores_changed_hero_required_text() -> None:
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

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        actual = asyncio.run(direct_work_visuals(
            request=_request(),
            provider="deepseek",
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))

    assert actual["hero_visual_spec"]["required_text"] == [
        "面朝大海，春暖花开",
        "海子",
        "朗诵情感图谱",
    ]


def test_visual_director_omits_empty_author_from_required_text() -> None:
    request = _request().model_copy(update={"author": ""})
    result = _result()

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result, ensure_ascii=False)}}]},
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return real_client(*args, transport=transport, **kwargs)

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        actual = asyncio.run(direct_work_visuals(
            request=request,
            provider="deepseek",
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))

    assert actual["hero_visual_spec"]["required_text"] == [
        "面朝大海，春暖花开",
        "朗诵情感图谱",
    ]


def test_visual_director_restores_changed_locked_profile() -> None:
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

    with patch("app.providers.openai_compatible.httpx.AsyncClient", side_effect=client_factory):
        actual = asyncio.run(direct_work_visuals(
            request=locked_request,
            provider="deepseek",
            api_key="test",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            thinking="enabled",
            reasoning_effort="high",
            timeout_seconds=30,
        ))

    assert actual["work_visual_profile"] == profile


def test_visual_director_route_maps_domain_failure_to_502() -> None:
    settings = Settings(
        elevenlabs_api_key="eleven",
        llm_api_key="gateway",
        llm_auth_source="ai_api_key",
        llm_provider="openai_compatible",
        analysis_service_token="service",
        analysis_callback_token="callback",
        sites_bypass_token="sites",
        llm_base_url="https://gateway.example",
        llm_model="gpt-5.6-sol",
        llm_thinking="enabled",
        llm_reasoning_effort="high",
        request_timeout_seconds=30,
    )
    with patch(
        "app.main.direct_work_visuals",
        side_effect=VisualDirectorError("invalid visual plan"),
    ), pytest.raises(HTTPException) as captured:
        asyncio.run(create_visual_plan(request=_request(), settings=settings))

    assert captured.value.status_code == 502
    assert captured.value.detail == "invalid visual plan"
