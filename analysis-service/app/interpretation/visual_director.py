from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from pydantic import ValidationError

from app.providers.openai_compatible import (
    StructuredLlmError,
    generate_structured_result,
)
from app.schemas.visual import VisualDirectorRequest, VisualDirectorResult


class VisualDirectorError(RuntimeError):
    """A visual-only planning failure. It must never affect recitation analysis."""


HERO_LAYOUT_CONTRACT_MARKER = "【Hero 成品排版硬约束 v2】"


def _author_display(author: str) -> str:
    name = author.strip()
    if name.startswith("作者："):
        name = name.removeprefix("作者：").strip()
    elif name.startswith("作者:"):
        name = name.removeprefix("作者:").strip()
    return f"作者：{name}" if name else ""


def _hero_required_text(request: VisualDirectorRequest) -> list[str]:
    required_text = [request.title]
    author_display = _author_display(request.author)
    if author_display:
        required_text.append(author_display)
    required_text.append("朗诵情感图谱")
    return required_text


def _hero_production_prompt(base_prompt: str, request: VisualDirectorRequest) -> str:
    """Attach the non-negotiable layout used by both planning and production.

    The generated asset is an ultra-wide publication Hero. Its fixed type area
    keeps all required text readable and leaves the right side for imagery.
    """

    if HERO_LAYOUT_CONTRACT_MARKER in base_prompt:
        return base_prompt
    author_display = _author_display(request.author)
    exact_lines = [
        "朗诵情感图谱",
        request.title,
        *([author_display] if author_display else []),
    ]
    lines = "；".join(f"“{line}”" for line in exact_lines)
    return (
        f"{base_prompt.strip()}\n\n"
        f"{HERO_LAYOUT_CONTRACT_MARKER}\n"
        "这是最终显示为 1500×280 的超宽作品封面。所有必需文字必须组成左侧文字组，完整落在 x=6%–43% 的安全区内；"
        "左侧至少留 70px，顶部和底部至少留 32px，任何笔画、书名号都不得贴边或越界。"
        "小题签“朗诵情感图谱”位于 y=18%–27%，主标题位于 y=34%–60%，作者行位于 y=70%–82%。"
        f"只允许逐字准确呈现这些文字：{lines}。"
        "主标题使用清楚、有艺术感但可辨认的中文标题字，整行最大宽度约 550px；"
        "字号必须自适应以保持标题单行完整，不得断行、截字或缺字。"
        + (
            f"作者行必须逐字写成“{author_display}”，必须包含“作者：”前缀。"
            if author_display
            else "不得虚构作者行。"
        )
        + "左侧保持干净、低对比和充分留白，不放房屋、人物、树枝等主体，也不要让纹理压住文字。"
        "作品意象和高对比视觉主体集中在 x=55%–96% 的右侧，左右形成清楚的‘左文右景’构图。"
        "禁止把标题放在画布顶部，禁止任何文字被裁切，禁止额外文字、随机汉字、按钮、徽标和水印。"
    )


def _canonicalize_immutable_fields(
    payload: dict[str, Any],
    request: VisualDirectorRequest,
) -> dict[str, Any]:
    """Restore source-owned fields before validating the model response.

    The model directs the visual treatment; it is not the source of truth for
    title text, author text, scene identity, or a locked visual profile. Some
    compatible gateways can return otherwise valid structured output while
    adding book-title marks or lightly rewriting those fields. Replacing them
    with the request values keeps the strict contract without turning a usable
    visual plan into a production 500.
    """

    canonical = deepcopy(payload)
    hero = canonical.get("hero_visual_spec")
    if isinstance(hero, dict):
        hero["type"] = "hero"
        hero["size"] = {"width": 1500, "height": 280}
        hero["required_text"] = _hero_required_text(request)
        hero["text_layout"] = (
            "左侧 x=6%–43% 为文字安全区：题签 y=18%–27%，标题 y=34%–60%，"
            "作者 y=70%–82%；右侧 x=55%–96% 集中作品意象"
        )
        hero["composition"] = (
            "左文右景；左侧干净留白，标题完整且不贴边，右侧承载画面主体"
        )
        hero["image_prompt"] = _hero_production_prompt(
            str(hero.get("image_prompt") or ""), request
        )

    scenes = canonical.get("scene_visual_specs")
    if isinstance(scenes, list):
        for scene, source in zip(scenes, request.scene_units):
            if not isinstance(scene, dict):
                continue
            scene["scene_id"] = source.scene_id
            scene["source_sentence_ids"] = list(source.source_sentence_ids)
            scene["source_text"] = source.source_text

    if request.locked_profile is not None:
        canonical["work_visual_profile"] = deepcopy(request.locked_profile)
    return canonical


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
    expected_required_text = _hero_required_text(request)
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
    author_display = _author_display(request.author)
    system_prompt = (
        "你是文学作品视觉导演。你只负责把当前作品规划为统一的作品视觉档案、Hero 和逐场景意境图。"
        "这是独立的视觉请求，不得生成或修改朗诵 control_spec，不得改变作品正文、scene_id 或句子映射。"
        "全篇所有图片必须共享风格、色彩、材质和光线逻辑；避免俗套人物肖像、廉价卡通、随机文字、"
        "水印和与具体文稿无关的通用山水装饰。Scene 图片不得包含任何文字。"
        "Hero 必须使用左文右景构图：左侧是完整文字安全区，作品意象集中在右侧。"
    )
    user_prompt = (
        "阅读标题、作者、准确全文、上下文、场景单元以及只读朗诵节奏摘要，生成结构化视觉方案。"
        "Hero 固定为 1500x280，需要在画面内准确呈现 required_text，并为真实 DOM 播放按钮预留区域。"
        "Hero 标题不得贴近上边缘；所有必需文字需落在明确的左侧安全排版区内。"
        + (
            f"作者必须逐字写成“{author_display}”，而不是只写作者姓名。"
            if author_display
            else "当前作品没有作者，不得虚构作者行。"
        )
        + "每个 Scene 使用 4:3 构图，适合约 280x220 的小尺寸展示，主体明确、细节克制、不生成文字。"
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
    canonical_data = _canonicalize_immutable_fields(generation.data, request)
    try:
        result = VisualDirectorResult.model_validate(canonical_data)
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
