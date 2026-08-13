from __future__ import annotations

import json
from typing import Any

import httpx
from pydantic import ValidationError

from app.interpretation.llm_interpreter import _response_format_for_provider
from app.schemas.visual import VisualDirectorRequest, VisualDirectorResult


class VisualDirectorError(RuntimeError):
    """A visual-only planning failure. It must never affect recitation analysis."""


def _extract_content(payload: dict[str, Any]) -> str:
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise VisualDirectorError("Visual director response did not contain a message") from exc
    if message.get("refusal"):
        raise VisualDirectorError(f"Visual director refused the request: {message['refusal']}")
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [str(item.get("text") or "") for item in content if isinstance(item, dict)]
        if any(texts):
            return "".join(texts)
    raise VisualDirectorError("Visual director response did not contain JSON content")


def _validate_source_contract(
    result: VisualDirectorResult,
    request: VisualDirectorRequest,
) -> None:
    expected = request.scene_units
    actual = result.scene_visual_specs
    if len(actual) != len(expected):
        raise VisualDirectorError(
            f"Visual director returned {len(actual)} scenes; {len(expected)} were expected"
        )
    for position, (scene, source) in enumerate(zip(actual, expected, strict=True), 1):
        if (
            scene.scene_id != source.scene_id
            or scene.source_text != source.source_text
            or scene.source_sentence_ids != source.source_sentence_ids
        ):
            raise VisualDirectorError(
                f"Visual director changed the source identity or text of scene {position}"
            )
    expected_required_text = [request.title]
    if request.author:
        expected_required_text.append(request.author)
    expected_required_text.append("朗诵情感图谱")
    if result.hero_visual_spec.required_text != expected_required_text:
        raise VisualDirectorError("Visual director changed required Hero title or author text")


async def direct_work_visuals(
    *,
    request: VisualDirectorRequest,
    api_key: str,
    base_url: str,
    model: str,
    thinking: str,
    reasoning_effort: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    schema = VisualDirectorResult.model_json_schema()
    schema_text = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    evidence = request.model_dump(mode="json", exclude_none=True)
    request_body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是文学作品视觉导演。你只负责把当前作品规划为统一的作品视觉档案、Hero 和逐场景意境图。"
                    "这是独立的视觉请求，不得生成或修改朗诵 control_spec，不得改变作品正文、scene_id 或句子映射。"
                    "全篇所有图片必须共享风格、色彩、材质和光线逻辑；避免俗套人物肖像、廉价卡通、随机文字、"
                    "水印和与具体文稿无关的通用山水装饰。Scene 图片不得包含任何文字。"
                ),
            },
            {
                "role": "user",
                "content": (
                    "阅读标题、作者、准确全文、上下文、场景单元以及只读朗诵节奏摘要，生成结构化视觉方案。"
                    "Hero 固定为 1500x420，需要在画面内准确呈现 required_text，并为真实 DOM 播放按钮预留区域。"
                    "每个 Scene 使用 4:3 构图，适合约 280x220 的小尺寸展示，主体明确、细节克制、不生成文字。"
                    "如果 locked_profile 非空，必须原样使用它作为 work_visual_profile，不得重新设计作品风格。"
                    "scene_visual_specs 必须与输入 scene_units 数量、顺序、scene_id、source_sentence_ids 和 source_text 完全一致。"
                    "仅返回一个合法 JSON 对象，不要添加 Markdown 或解释。输出必须符合下面的 JSON Schema：\n"
                    + schema_text
                    + "\n\n当前作品视觉输入：\n"
                    + json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
        "response_format": _response_format_for_provider(
            base_url=base_url,
            model=model,
            schema=schema,
        ),
        "thinking": {"type": thinking},
        "reasoning_effort": reasoning_effort,
        "temperature": 0.2,
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=30)
        ) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "authorization": f"Bearer {api_key}",
                    "content-type": "application/json",
                },
                json=request_body,
            )
    except httpx.TimeoutException as exc:
        raise VisualDirectorError("Visual director request timed out") from exc
    except httpx.HTTPError as exc:
        raise VisualDirectorError(f"Unable to call the visual director: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text.strip()[:800]
        raise VisualDirectorError(
            f"Visual director failed (HTTP {response.status_code}): {detail}"
        )
    try:
        payload = response.json()
        raw = json.loads(_extract_content(payload))
        result = VisualDirectorResult.model_validate(raw)
    except (ValueError, ValidationError) as exc:
        raise VisualDirectorError(f"Visual director returned invalid JSON: {exc}") from exc
    _validate_source_contract(result, request)
    if request.locked_profile is not None:
        locked = json.loads(json.dumps(request.locked_profile, ensure_ascii=False))
        actual = result.work_visual_profile.model_dump(mode="json")
        if actual != locked:
            raise VisualDirectorError("Visual director changed a locked work visual profile")
    return result.model_dump(mode="json")
