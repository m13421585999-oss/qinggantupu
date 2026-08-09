from __future__ import annotations

import asyncio
import difflib
import re
import tempfile
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pypinyin import Style, lazy_pinyin

from .acoustics.parselmouth_analyzer import PUNCTUATION, analyze_wav
from .providers.eleven_alignment import forced_align
from .schemas.control_spec import RecitationAnalysisPackage


class AnalysisPipelineError(RuntimeError):
    pass


async def run_pipeline(
    *,
    title: str,
    author: str,
    full_text: str,
    filename: str,
    mime_type: str,
    audio_bytes: bytes,
    elevenlabs_api_key: str,
) -> tuple[RecitationAnalysisPackage, dict[str, Any]]:
    alignment = await forced_align(
        api_key=elevenlabs_api_key,
        filename=filename,
        audio_bytes=audio_bytes,
        mime_type=mime_type,
        full_text=full_text,
    )
    tokens, quality = map_alignment_to_source(full_text, alignment)
    sentence_ranges = split_sentence_ranges(full_text)
    with tempfile.TemporaryDirectory(prefix="recitation-analysis-") as directory:
        source = Path(directory) / f"source{Path(filename).suffix or '.audio'}"
        wav = Path(directory) / "mono.wav"
        source.write_bytes(audio_bytes)
        await convert_to_wav(source, wav)
        acoustics = await asyncio.to_thread(analyze_wav, str(wav), tokens, sentence_ranges)

    token_evidence = {item["index"]: item for item in acoustics["token_evidence"]}
    analysis_tokens: list[dict[str, Any]] = []
    for token in tokens:
        evidence = token_evidence[token["index"]]
        machine, display = pinyin_for_char(token["char"])
        analysis_tokens.append(
            {
                **token,
                "machine_pinyin": machine,
                "display_pinyin": display,
                "duration_ms": evidence["duration_ms"],
            }
        )

    words = normalize_words(alignment.get("words", []))
    package = RecitationAnalysisPackage(
        generated_at=datetime.now(UTC).isoformat(),
        work={"title": title, "author": author, "full_text": full_text},
        audio={"duration_ms": acoustics["duration_ms"], "sample_rate": acoustics["sample_rate"]},
        alignment_quality=quality,
        tokens=analysis_tokens,
        words=words,
        pauses=acoustics["pauses"],
        elongations=acoustics["elongations"],
        pitch=acoustics["pitch"],
        energy=acoustics["energy"],
        sentences=acoustics["sentences"],
    )
    provider_quality = {
        "loss": alignment.get("loss"),
        "source_character_count": len(full_text),
        "provider_character_count": len(alignment.get("characters", [])),
        **quality,
    }
    return package, provider_quality


async def convert_to_wav(source: Path, target: Path) -> None:
    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(target),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0 or not target.exists():
        raise AnalysisPipelineError(f"FFmpeg conversion failed: {stderr.decode(errors='replace')[:800]}")


def _provider_char(item: dict[str, Any]) -> str:
    return str(item.get("text") or item.get("character") or item.get("char") or "")


def _time_ms(item: dict[str, Any], key: str) -> int:
    seconds = item.get(key)
    if seconds is None:
        seconds = item.get(f"{key}_seconds")
    return round(float(seconds or 0) * 1000)


def map_alignment_to_source(full_text: str, payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    provider = payload.get("characters")
    if not isinstance(provider, list) or not provider:
        raise AnalysisPipelineError("Forced Alignment returned no characters")
    provider_chars = [_provider_char(item) for item in provider]
    provider_text = "".join(provider_chars)
    matcher = difflib.SequenceMatcher(a=provider_text, b=full_text, autojunk=False)
    source_to_provider: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            source_to_provider[block.b + offset] = block.a + offset

    spoken = [index for index, char in enumerate(full_text) if char not in PUNCTUATION]
    matched_spoken = [index for index in spoken if index in source_to_provider]
    coverage = len(matched_spoken) / max(len(spoken), 1)
    if coverage < 0.98:
        raise AnalysisPipelineError(
            f"Forced Alignment text coverage is too low ({len(matched_spoken)}/{len(spoken)}); verify exact transcript"
        )

    tokens: list[dict[str, Any]] = []
    last_end = 0
    for index, char in enumerate(full_text):
        provider_index = source_to_provider.get(index)
        if provider_index is not None:
            item = provider[provider_index]
            start_ms = _time_ms(item, "start")
            end_ms = max(start_ms, _time_ms(item, "end"))
            confidence = float(item.get("confidence", 1.0) or 1.0)
        else:
            next_start = next(
                (
                    _time_ms(provider[source_to_provider[cursor]], "start")
                    for cursor in range(index + 1, len(full_text))
                    if cursor in source_to_provider
                ),
                last_end,
            )
            start_ms = min(last_end, next_start)
            end_ms = start_ms
            confidence = 1.0 if char in PUNCTUATION else 0.0
        if start_ms < last_end and char not in PUNCTUATION:
            start_ms = last_end
            end_ms = max(start_ms, end_ms)
        last_end = max(last_end, end_ms)
        tokens.append(
            {
                "index": index,
                "char": char,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "confidence": round(confidence, 4),
            }
        )
    if "".join(token["char"] for token in tokens) != full_text:
        raise AnalysisPipelineError("Internal text mapping changed the source transcript")
    return tokens, {
        "character_coverage": round(coverage, 5),
        "matched_spoken_characters": len(matched_spoken),
        "spoken_characters": len(spoken),
        "provider_loss": payload.get("loss"),
    }


def normalize_words(words: Any) -> list[dict[str, Any]]:
    if not isinstance(words, list):
        return []
    result: list[dict[str, Any]] = []
    for item in words:
        if not isinstance(item, dict):
            continue
        result.append(
            {
                "text": str(item.get("text") or item.get("word") or ""),
                "start_ms": _time_ms(item, "start"),
                "end_ms": _time_ms(item, "end"),
                "confidence": item.get("confidence"),
            }
        )
    return result


def split_sentence_ranges(text: str) -> list[tuple[int, int]]:
    if not text:
        raise AnalysisPipelineError("full_text is empty")
    ranges: list[tuple[int, int]] = []
    start = 0
    for index, char in enumerate(text):
        if char in "。！？!?；;\n":
            if text[start : index + 1].strip():
                ranges.append((start, index))
                start = index + 1
    if start < len(text):
        if text[start:].strip() or not ranges:
            ranges.append((start, len(text) - 1))
        elif ranges:
            ranges[-1] = (ranges[-1][0], len(text) - 1)
    if not ranges:
        ranges = [(0, len(text) - 1)]
    # Keep every source character in exactly one contiguous sentence range.
    normalized: list[tuple[int, int]] = []
    cursor = 0
    for _, end in ranges:
        normalized.append((cursor, end))
        cursor = end + 1
    if normalized[-1][1] < len(text) - 1:
        normalized[-1] = (normalized[-1][0], len(text) - 1)
    return normalized


def pinyin_for_char(char: str) -> tuple[str | None, str | None]:
    if char in PUNCTUATION or not re.search(r"[\u3400-\u9fff]", char):
        return None, None
    numbered = lazy_pinyin(char, style=Style.TONE3, neutral_tone_with_five=True, errors="ignore")
    marked = lazy_pinyin(char, style=Style.TONE, neutral_tone_with_five=False, errors="ignore")
    machine = numbered[0] if numbered else None
    display = marked[0] if marked else None
    return machine, display
