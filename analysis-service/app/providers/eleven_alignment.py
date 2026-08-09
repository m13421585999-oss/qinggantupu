from __future__ import annotations

from typing import Any

import httpx


class ElevenAlignmentError(RuntimeError):
    pass


async def forced_align(
    *,
    api_key: str,
    filename: str,
    audio_bytes: bytes,
    mime_type: str,
    full_text: str,
    timeout_seconds: float = 180.0,
) -> dict[str, Any]:
    if not api_key:
        raise ElevenAlignmentError("ELEVENLABS_API_KEY is not configured")
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds)) as client:
        response = await client.post(
            "https://api.elevenlabs.io/v1/forced-alignment",
            headers={"xi-api-key": api_key},
            data={"text": full_text},
            files={"file": (filename, audio_bytes, mime_type or "application/octet-stream")},
        )
    if response.status_code >= 400:
        detail = response.text[:1000]
        raise ElevenAlignmentError(
            f"ElevenLabs Forced Alignment failed ({response.status_code}): {detail}"
        )
    payload = response.json()
    if not isinstance(payload, dict) or not payload.get("characters"):
        raise ElevenAlignmentError("ElevenLabs returned no character alignment")
    return payload
