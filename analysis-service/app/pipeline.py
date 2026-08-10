from __future__ import annotations

import asyncio
import mimetypes
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from pypinyin import Style, lazy_pinyin

from app.acoustics.parselmouth_analyzer import (
    analyze_wav,
    convert_to_mono_wav,
    split_sentence_ranges,
)
from app.config import Settings
from app.interpretation.llm_interpreter import interpret_control_spec
from app.providers.eleven_alignment import (
    PUNCTUATION,
    forced_align,
    map_to_source,
    normalized_words,
)


class PipelineError(RuntimeError):
    pass


def normalize_source_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip("\ufeff")
    if not normalized.strip():
        raise PipelineError("Source text is empty")
    if len(normalized) > 20_000:
        raise PipelineError("Source text exceeds the 20,000 character limit")
    return normalized


def pinyin_for_char(char: str) -> tuple[str | None, str | None]:
    if char in PUNCTUATION or not re.search(r"[\u3400-\u9fff]", char):
        return None, None
    machine = lazy_pinyin(char, style=Style.TONE3, neutral_tone_with_five=True, errors="ignore")
    display = lazy_pinyin(char, style=Style.TONE, neutral_tone_with_five=False, errors="ignore")
    return (machine[0] if machine else None, display[0] if display else None)


def _sites_headers(bypass_token: str) -> dict[str, str]:
    return {"OAI-Sites-Authorization": f"Bearer {bypass_token}"}


async def _get_json(url: str, timeout_seconds: float, bypass_token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_seconds, connect=30), follow_redirects=True
    ) as client:
        response = await client.get(url, headers=_sites_headers(bypass_token))
    if response.status_code >= 400:
        raise PipelineError(f"Unable to fetch analysis input (HTTP {response.status_code})")
    try:
        payload = response.json()
    except ValueError as exc:
        raise PipelineError("Analysis input endpoint returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise PipelineError("Analysis input endpoint returned an invalid object")
    return payload


async def _download_audio(
    url: str, target: Path, timeout_seconds: float, bypass_token: str
) -> None:
    maximum_bytes = 150 * 1024 * 1024
    written = 0
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_seconds, connect=30), follow_redirects=True
    ) as client:
        async with client.stream("GET", url, headers=_sites_headers(bypass_token)) as response:
            if response.status_code >= 400:
                raise PipelineError(f"Unable to fetch reference audio (HTTP {response.status_code})")
            declared = int(response.headers.get("content-length") or 0)
            if declared > maximum_bytes:
                raise PipelineError("Reference audio exceeds the 150 MB limit")
            with target.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    written += len(chunk)
                    if written > maximum_bytes:
                        raise PipelineError("Reference audio exceeds the 150 MB limit")
                    output.write(chunk)
    if written == 0:
        raise PipelineError("Reference audio is empty")


def _audio_suffix(input_payload: dict[str, Any], audio_url: str) -> str:
    reference = input_payload.get("reference_audio")
    reference = reference if isinstance(reference, dict) else {}
    filename = str(reference.get("filename") or Path(urlparse(audio_url).path).name)
    suffix = Path(filename).suffix.lower()
    if suffix in {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4"}:
        return suffix
    mime = str(reference.get("mime_type") or "")
    return mimetypes.guess_extension(mime) or ".audio"


def _work_from_input(payload: dict[str, Any]) -> dict[str, Any]:
    work = payload.get("work")
    work = work if isinstance(work, dict) else payload
    full_text = work.get("full_text", work.get("source_text", work.get("sourceText")))
    if not isinstance(full_text, str):
        raise PipelineError("Analysis input is missing exact full_text")
    return {
        "id": str(work.get("id") or work.get("work_id") or ""),
        "title": str(work.get("title") or ""),
        "author": str(work.get("author") or ""),
        "full_text": normalize_source_text(full_text),
    }


async def analyze_job(
    *,
    input_url: str,
    audio_url: str,
    settings: Settings,
) -> tuple[dict[str, Any], dict[str, Any]]:
    input_payload = await _get_json(
        input_url, settings.request_timeout_seconds, settings.sites_bypass_token
    )
    work = _work_from_input(input_payload)
    reference = input_payload.get("reference_audio")
    reference = reference if isinstance(reference, dict) else {}

    with tempfile.TemporaryDirectory(prefix="recitation-analysis-") as temporary:
        temp_dir = Path(temporary)
        audio_path = temp_dir / f"reference{_audio_suffix(input_payload, audio_url)}"
        wav_path = temp_dir / "reference-mono-16k.wav"
        await _download_audio(
            audio_url,
            audio_path,
            settings.request_timeout_seconds,
            settings.sites_bypass_token,
        )
        alignment = await forced_align(
            api_key=settings.elevenlabs_api_key,
            audio_path=audio_path,
            full_text=work["full_text"],
            timeout_seconds=settings.request_timeout_seconds,
        )
        tokens, quality = map_to_source(work["full_text"], alignment)
        await asyncio.to_thread(convert_to_mono_wav, audio_path, wav_path)
        acoustics = await asyncio.to_thread(
            analyze_wav,
            wav_path,
            tokens,
            split_sentence_ranges(work["full_text"]),
        )

    acoustic_by_index = {
        int(item["token_index"]): item for item in acoustics["token_acoustics"]
    }
    result_tokens: list[dict[str, Any]] = []
    for token in tokens:
        machine_pinyin, display_pinyin = pinyin_for_char(token["char"])
        evidence = acoustic_by_index[token["index"]]
        result_tokens.append(
            {
                "index": token["index"],
                "char": token["char"],
                "machine_pinyin": machine_pinyin,
                "display_pinyin": display_pinyin,
                "start_ms": token["start_ms"],
                "end_ms": token["end_ms"],
                "duration_ms": evidence["duration_ms"],
                "confidence": token["confidence"],
            }
        )

    analysis_package = {
        "schema_version": "recitation-analysis-1.0",
        "generated_at": datetime.now(UTC).isoformat(),
        "work": work,
        "reference_audio_asset_id": reference.get("asset_id") or reference.get("id"),
        "audio": {
            "filename": reference.get("filename"),
            "mime_type": reference.get("mime_type"),
            "duration_ms": acoustics["duration_ms"],
            "sample_rate": acoustics["sample_rate"],
        },
        "alignment_quality": quality,
        "tokens": result_tokens,
        "words": normalized_words(alignment),
        "segments": acoustics["sentences"],
        "acoustic_evidence": {
            "tokens": acoustics["token_acoustics"],
            "pauses": acoustics["pauses"],
            "duration_outliers": acoustics["duration_outliers"],
            "energy_changes": acoustics["energy_changes"],
        },
    }
    control_spec = await interpret_control_spec(
        analysis_package=analysis_package,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
        timeout_seconds=settings.request_timeout_seconds,
    )
    return analysis_package, control_spec
