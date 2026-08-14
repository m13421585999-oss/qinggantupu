from __future__ import annotations

import asyncio
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
VISUAL_SCENE_BATCH_SIZE = 8
VISUAL_BATCH_TIMEOUT_SECONDS = 42.0


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


async def _generate_visual_batch(
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
            prefer_chat_json=True,
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


def _batch_request(
    request: VisualDirectorRequest,
    start: int,
    end: int,
    locked_profile: dict[str, Any] | None,
) -> VisualDirectorRequest:
    scene_units = request.scene_units[start:end]
    sentence_ids = {
        sentence_id
        for scene in scene_units
        for sentence_id in scene.source_sentence_ids
    }
    summary = deepcopy(request.control_spec_summary)
    sentences = summary.get("sentences")
    if isinstance(sentences, list) and sentence_ids:
        summary["sentences"] = [
            sentence
            for sentence in sentences
            if isinstance(sentence, dict)
            and str(sentence.get("id", "")) in sentence_ids
        ]
    return request.model_copy(update={
        "scene_units": scene_units,
        "control_spec_summary": summary,
        "locked_profile": locked_profile,
    })


def _fallback_visual_plan(request: VisualDirectorRequest) -> dict[str, Any]:
    """Create a safe plan when the upstream visual LLM misses its deadline."""

    profile = request.locked_profile or {
        "visual_style": "当代东方诗意编辑插画",
        "palette": ["暖白", "雾蓝", "墨灰", "淡金", "朱砂", "低饱和青绿"],
        "texture": "细腻棉纸与克制水粉颗粒",
        "lighting": "柔和自然光，随全文情绪由冷到暖变化",
        "atmosphere": "安静、文学性、留白充足",
        "composition_language": "主体偏向画面一侧，以大形体和留白保持小尺寸可读性",
        "human_presence": "弱化具体面孔，以背影、局部或环境意象为主",
        "symbolic_language": ["光影", "道路", "窗", "植物", "时间痕迹"],
        "avoid": ["随机文字", "水印", "廉价卡通", "正面人物特写", "通用旅游海报"],
    }
    excerpt = "".join(request.full_text.split())[:120]
    hero_prompt = _hero_production_prompt(
        (
            "1500×280当代东方诗意作品封面，细腻棉纸与克制水粉质感，严格左文右景。"
            f"围绕作品《{request.title}》及全文意象“{excerpt}”提炼一个清楚主视觉；"
            "左侧保持干净低对比，右侧集中文学意象，不生成按钮、界面或额外文字。"
        ),
        request,
    )
    hero = {
        "type": "hero",
        "size": {"width": 1500, "height": 280},
        "required_text": _hero_required_text(request),
        "text_layout": "左侧 x=6%–43% 为文字安全区，右侧 x=55%–96% 集中作品意象",
        "visual_subject": f"围绕《{request.title}》核心情绪提炼的代表性环境意象",
        "composition": "左文右景；左侧干净留白，右侧承载画面主体",
        "lighting": str(profile.get("lighting", "柔和自然光")),
        "palette": list(profile.get("palette", ["暖白", "雾蓝"])),
        "image_prompt": hero_prompt,
        "negative_prompt": "错字，漏字，随机文字，英文，水印，徽标，按钮，UI，正面人物特写，廉价卡通",
    }
    last_position = max((scene.position for scene in request.scene_units), default=0)
    scenes = []
    for scene in request.scene_units:
        source = "".join(scene.source_text.split())
        role = "开篇" if scene.position == 0 else "收束" if scene.position == last_position else "推进"
        context = "；".join(filter(None, [scene.previous_text, scene.source_text, scene.next_text]))
        scenes.append({
            "scene_id": scene.scene_id,
            "source_sentence_ids": list(scene.source_sentence_ids),
            "source_text": scene.source_text,
            "narrative_function": f"承担全文第{scene.position + 1}个场景的{role}作用",
            "visual_type": "symbolic_scene",
            "scene_meaning": source,
            "main_subject": f"围绕“{source[:64]}”提炼的单一清楚文学意象",
            "environment": "与当前句情绪相符的克制环境空间，保留足够呼吸感",
            "emotion": ["含蓄", "真实", "有层次"],
            "symbolism": ["光影", "空间", "时间痕迹"],
            "composition": "4:3构图，主体位于三分线，小尺寸下轮廓清楚，背景简洁",
            "camera_distance": "中景或中远景",
            "lighting": str(profile.get("lighting", "柔和自然光")),
            "palette": list(profile.get("palette", ["暖白", "雾蓝"])),
            "image_prompt": (
                "4:3当代东方诗意编辑插画，细腻棉纸与克制水粉质感。"
                f"根据当前原文“{scene.source_text}”及相邻语境“{context}”提炼一个具体、清楚、"
                "具有文学象征性的环境画面；主体适合约280×220小尺寸显示，色彩低饱和，"
                "不得出现正文、标题、编号、按钮、界面、随机汉字或水印。"
            ),
            "negative_prompt": "任何文字，汉字，数字，水印，徽标，UI，按钮，正面人物特写，廉价卡通，旅游海报，杂乱细节",
        })
    result = VisualDirectorResult.model_validate({
        "work_visual_profile": profile,
        "hero_visual_spec": hero,
        "scene_visual_specs": scenes,
    })
    _validate_source_contract(result, request)
    return {
        **result.model_dump(mode="json"),
        "_meta": {
            "endpoint": "local/fallback",
            "output_mode": "deterministic_fallback",
            "request_count": 0,
        },
    }


async def _generate_or_fallback(
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
    try:
        return await _generate_visual_batch(
            request=request,
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            timeout_seconds=min(timeout_seconds, VISUAL_BATCH_TIMEOUT_SECONDS),
        )
    except VisualDirectorError:
        return _fallback_visual_plan(request)


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
    """Plan long works in bounded batches so one large response cannot 524."""

    batch_ranges = [
        (start, min(start + VISUAL_SCENE_BATCH_SIZE, len(request.scene_units)))
        for start in range(0, len(request.scene_units), VISUAL_SCENE_BATCH_SIZE)
    ]
    first_start, first_end = batch_ranges[0]
    first_request = _batch_request(
        request,
        first_start,
        first_end,
        request.locked_profile,
    )
    first = await _generate_or_fallback(
        request=first_request,
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        timeout_seconds=timeout_seconds,
    )
    locked_profile = first["work_visual_profile"]

    async def generate_range(start: int, end: int) -> dict[str, Any]:
        return await _generate_or_fallback(
            request=_batch_request(request, start, end, locked_profile),
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
            timeout_seconds=timeout_seconds,
        )

    remaining = await asyncio.gather(*(
        generate_range(start, end)
        for start, end in batch_ranges[1:]
    ))
    parts = [first, *remaining]
    combined = {
        "work_visual_profile": first["work_visual_profile"],
        "hero_visual_spec": first["hero_visual_spec"],
        "scene_visual_specs": [
            scene
            for part in parts
            for scene in part["scene_visual_specs"]
        ],
    }
    canonical = _canonicalize_immutable_fields(combined, request)
    try:
        result = VisualDirectorResult.model_validate(canonical)
    except (ValueError, ValidationError) as exc:
        raise VisualDirectorError(f"Visual director returned invalid batched JSON: {exc}") from exc
    _validate_source_contract(result, request)
    metas = [part.get("_meta", {}) for part in parts]
    endpoints = {str(meta.get("endpoint", "")) for meta in metas}
    modes = {str(meta.get("output_mode", "")) for meta in metas}
    return {
        **result.model_dump(mode="json"),
        "_meta": {
            "endpoint": next(iter(endpoints)) if len(endpoints) == 1 else "batched/mixed",
            "output_mode": next(iter(modes)) if len(modes) == 1 else "batched_mixed",
            "request_count": sum(int(meta.get("request_count", 0)) for meta in metas),
            "batch_count": len(parts),
            "batch_size": VISUAL_SCENE_BATCH_SIZE,
            "reasoning_effort": reasoning_effort,
        },
    }
