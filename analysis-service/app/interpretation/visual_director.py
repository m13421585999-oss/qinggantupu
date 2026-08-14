from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError

from app.providers.openai_compatible import (
    StructuredLlmError,
    generate_structured_result,
)
from app.schemas.visual import VisualDirectorRequest, VisualDirectorResult


class VisualDirectorError(RuntimeError):
    """A visual-only planning failure. It must never affect recitation analysis."""


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
    provider: str,
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
    system_prompt = (
        "你是文学作品视觉导演。你只负责把当前作品规划为统一的作品视觉档案、Hero 和逐场景意境图。"
        "这是独立的视觉请求，不得生成或修改朗诵 control_spec，不得改变作品正文、scene_id 或句子映射。"
        "全篇所有图片必须共享风格、色彩、材质和光线逻辑；避免俗套人物肖像、廉价卡通、随机文字、"
        "水印和与具体文稿无关的通用山水装饰。Scene 图片不得包含任何文字。"
    )
    user_prompt = (
        "阅读标题、作者、准确全文、上下文、场景单元以及只读朗诵节奏摘要，生成结构化视觉方案。"
        "Hero 固定为 1500x280，需要在画面内准确呈现 required_text，并为真实 DOM 播放按钮预留区域。"
        "每个 Scene 使用 4:3 构图，适合约 280x220 的小尺寸展示，主体明确、细节克制、不生成文字。"
        "如果 locked_profile 非空，必须原样使用它作为 work_visual_profile，不得重新设计作品风格。"
        "scene_visual_specs 必须与输入 scene_units 数量、顺序、scene_id、source_sentence_ids 和 source_text 完全一致。"
        "仅返回一个合法 JSON 对象，不要添加 Markdown 或解释。输出必须符合下面的 JSON Schema：\n"
        + schema_text
        + "\n\n当前作品视觉输入：\n"
        + json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))
    )
    try:
        generation = await generate_structured_result(
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema_name="work_visual_director_result",
            schema=schema,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            temperature=0.2,
            timeout_seconds=timeout_seconds,
            validator=VisualDirectorResult.model_validate,
        )
    except StructuredLlmError as exc:
        raise VisualDirectorError(f"Visual director failed: {exc}") from exc
    try:
        result = VisualDirectorResult.model_validate(generation.data)
    except (ValueError, ValidationError) as exc:
        raise VisualDirectorError(f"Visual director returned invalid JSON: {exc}") from exc
    _validate_source_contract(result, request)
    if request.locked_profile is not None:
        locked = json.loads(json.dumps(request.locked_profile, ensure_ascii=False))
        actual = result.work_visual_profile.model_dump(mode="json")
        if actual != locked:
            raise VisualDirectorError("Visual director changed a locked work visual profile")
    return {
        **result.model_dump(mode="json"),
        "_meta": {
            "endpoint": generation.endpoint,
            "output_mode": generation.output_mode,
            "request_count": generation.request_count,
        },
    }
