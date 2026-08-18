from __future__ import annotations

import base64
import re
import struct
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import OPENAI_COMPATIBLE_PROVIDER


class ImageGenerationError(RuntimeError):
    """A sanitized upstream image-generation failure."""


@dataclass(frozen=True)
class ImageGenerationResult:
    image: dict[str, Any]
    provider: str
    model: str
    endpoint: str
    width: int | None
    height: int | None


def _image_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    versioned = base if base.lower().endswith("/v1") else f"{base}/v1"
    return f"{versioned}/images/generations"


def _responses_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    versioned = base if base.lower().endswith("/v1") else f"{base}/v1"
    return f"{versioned}/responses"


def _safe_detail(response: httpx.Response, api_key: str) -> str:
    detail = response.text.strip()[:800] or "empty provider response"
    if api_key:
        detail = detail.replace(api_key, "[redacted]")
    detail = re.sub(
        r"(?i)(bearer\s+)[^\s\"',}]+", r"\1[redacted]", detail
    )
    return re.sub(
        r"(?i)((?:api[_-]?key|authorization)\s*[=:]\s*)[^\s\"',}]+",
        r"\1[redacted]",
        detail,
    )


def _combined_prompt(prompt: str, negative_prompt: str | None) -> str:
    if not negative_prompt or not negative_prompt.strip():
        return prompt
    return f"{prompt}\n\n必须避免：{negative_prompt.strip()}"


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _reported_dimensions(image: dict[str, Any]) -> tuple[int | None, int | None]:
    width = _positive_int(image.get("width"))
    height = _positive_int(image.get("height"))
    size = image.get("size")
    if (width is None or height is None) and isinstance(size, str):
        match = re.fullmatch(r"\s*(\d+)\s*[xX]\s*(\d+)\s*", size)
        if match:
            width = width or _positive_int(match.group(1))
            height = height or _positive_int(match.group(2))
    return width, height


def _decoded_base64(value: Any) -> bytes | None:
    if not isinstance(value, str) or not value.strip():
        return None
    encoded = value.split(",", 1)[1] if value.lstrip().startswith("data:") and "," in value else value
    try:
        return base64.b64decode(encoded, validate=False)
    except (ValueError, TypeError):
        return None


def _binary_image_dimensions(data: bytes | None) -> tuple[int, int] | None:
    if not data:
        return None
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack(">II", data[16:24])
    if len(data) >= 10 and data[:6] in {b"GIF87a", b"GIF89a"}:
        return struct.unpack("<HH", data[6:10])
    if len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            return (
                1 + int.from_bytes(data[24:27], "little"),
                1 + int.from_bytes(data[27:30], "little"),
            )
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            return (
                int.from_bytes(data[26:28], "little") & 0x3FFF,
                int.from_bytes(data[28:30], "little") & 0x3FFF,
            )
        if chunk == b"VP8L" and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return (1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF))
    if len(data) >= 4 and data[:2] == b"\xff\xd8":
        offset = 2
        start_of_frame = {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }
        while offset + 8 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in {0xD8, 0xD9}:
                continue
            if offset + 2 > len(data):
                break
            segment_length = int.from_bytes(data[offset : offset + 2], "big")
            if marker in start_of_frame and offset + 7 <= len(data):
                return (
                    int.from_bytes(data[offset + 5 : offset + 7], "big"),
                    int.from_bytes(data[offset + 3 : offset + 5], "big"),
                )
            if segment_length < 2:
                break
            offset += segment_length
    return None


def _normalized_image(image: dict[str, Any]) -> tuple[dict[str, Any], int | None, int | None]:
    normalized = {
        key: image[key]
        for key in (
            "b64_json",
            "image_base64",
            "result",
            "url",
            "seed",
            "revised_prompt",
        )
        if image.get(key) is not None
    }
    encoded = normalized.get("b64_json") or normalized.get("image_base64") or normalized.get("result")
    actual = _binary_image_dimensions(_decoded_base64(encoded))
    width, height = actual or _reported_dimensions(image)
    if width is not None:
        normalized["width"] = width
    if height is not None:
        normalized["height"] = height
    return normalized, width, height


def _images_endpoint_is_unavailable(response: httpx.Response) -> bool:
    if response.status_code in {404, 405, 501}:
        return True
    if response.status_code not in {400, 422}:
        return False
    detail = response.text.lower()
    return any(
        marker in detail
        for marker in (
            "unsupported endpoint",
            "unknown endpoint",
            "unknown path",
            "route not found",
            "images/generations is not supported",
            "not implemented",
        )
    )


def _should_probe_responses(response: httpx.Response) -> bool:
    # Some compatible gateways expose a model only through the Responses
    # image-generation tool. A 403 from /images/generations can therefore be
    # path/model-scope specific rather than proof that the shared key is
    # invalid. Probe Responses once, while keeping both failures if it fails.
    return response.status_code == 403 or _images_endpoint_is_unavailable(response)


def _response_image(payload: dict[str, Any]) -> dict[str, Any] | None:
    data = payload.get("data")
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        direct = item.get("result") or item.get("b64_json") or item.get("image_base64")
        if isinstance(direct, str) and direct:
            return {"b64_json": direct, "seed": item.get("seed")}
        for part in item.get("content", []):
            if not isinstance(part, dict):
                continue
            encoded = (
                part.get("result")
                or part.get("b64_json")
                or part.get("image_base64")
                or part.get("data")
            )
            if isinstance(encoded, str) and encoded:
                return {"b64_json": encoded, "seed": item.get("seed")}
    return None


def _standard_image_size(width: int, height: int) -> str:
    if width == height:
        return "1024x1024"
    return "1536x1024" if width > height else "1024x1536"


async def generate_image(
    *,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    prompt: str,
    negative_prompt: str | None,
    width: int,
    height: int,
    timeout_seconds: float,
) -> ImageGenerationResult:
    if provider != OPENAI_COMPATIBLE_PROVIDER:
        raise ImageGenerationError(f"Unsupported image provider: {provider}")

    endpoint = _image_endpoint(base_url)
    combined_prompt = _combined_prompt(prompt, negative_prompt)
    body = {
        "model": model,
        "prompt": combined_prompt,
        "size": f"{width}x{height}",
        "n": 1,
    }
    images_failure: httpx.Response | None = None
    try:
        # Upstream image generation must stay below the worker-side fetch
        # timeout (150s) so this inner layer aborts first and the worker's
        # per-scene slot is released promptly instead of racing at the same
        # boundary. connect stays at 30s.
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=30)
        ) as client:
            response = await client.post(
                endpoint,
                headers={
                    "authorization": f"Bearer {api_key}",
                    "content-type": "application/json",
                },
                json=body,
            )
            resolved_endpoint = "images/generations"
            if response.status_code >= 400 and _should_probe_responses(response):
                images_failure = response
                response = await client.post(
                    _responses_endpoint(base_url),
                    headers={
                        "authorization": f"Bearer {api_key}",
                        "content-type": "application/json",
                    },
                    json={
                        "model": model,
                        "input": (
                            f"{combined_prompt}\n\n目标画布比例：{width}:{height}；"
                            "构图必须适合该横纵比例，不生成 UI 或水印。"
                        ),
                        "tools": [
                            {
                                "type": "image_generation",
                                "size": _standard_image_size(width, height),
                            }
                        ],
                    },
                )
                resolved_endpoint = "responses"
    except httpx.TimeoutException as exc:
        raise ImageGenerationError("Image generation request timed out") from exc
    except httpx.HTTPError as exc:
        raise ImageGenerationError("Unable to call the image generation service") from exc

    if response.status_code >= 400:
        if images_failure is not None:
            raise ImageGenerationError(
                "Image generation failed after endpoint probe: "
                f"images/generations HTTP {images_failure.status_code} "
                f"({_safe_detail(images_failure, api_key)}); "
                f"responses HTTP {response.status_code} "
                f"({_safe_detail(response, api_key)})"
            )
        raise ImageGenerationError(
            f"Image generation failed (HTTP {response.status_code}): "
            f"{_safe_detail(response, api_key)}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ImageGenerationError("Image generation returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ImageGenerationError("Image generation returned an invalid object")
    first = _response_image(payload)
    if not isinstance(first, dict):
        raise ImageGenerationError("Image generation response did not contain image data")
    image, actual_width, actual_height = _normalized_image(first)
    if not (
        image.get("b64_json")
        or image.get("image_base64")
        or image.get("result")
        or image.get("url")
    ):
        raise ImageGenerationError(
            "Image generation response did not contain image bytes or url"
        )
    return ImageGenerationResult(
        image=image,
        provider=provider,
        model=model,
        endpoint=resolved_endpoint,
        width=actual_width,
        height=actual_height,
    )
