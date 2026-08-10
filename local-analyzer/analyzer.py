from __future__ import annotations

import difflib
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from typing import Any, Iterable

import httpx
import numpy as np
import parselmouth
from pypinyin import Style, lazy_pinyin

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - setup.bat normally installs python-dotenv.
    load_dotenv = None


ELEVEN_ALIGNMENT_URL = "https://api.elevenlabs.io/v1/forced-alignment"
PUNCTUATION = set("，。！？、；：,.!?;:\n\r\t ‘’“”\"'（）()【】[]《》〈〉—…·")
SENTENCE_ENDINGS = set("。！？!?；;\n")


class AnalyzerError(RuntimeError):
    """A user-actionable analysis error."""


def load_local_environment(base_dir: Path | None = None) -> Path:
    """Load only the .env next to this local tool and return its path."""

    env_path = (base_dir or Path(__file__).resolve().parent) / ".env"
    if load_dotenv is not None:
        load_dotenv(env_path, override=True)
    elif env_path.exists():
        # Small fallback for environments where dependencies are not installed yet.
        for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip().strip('"').strip("'")
    return env_path


def analyze_recitation(
    *,
    full_text: str,
    audio_path: str | Path,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Run forced alignment and compact acoustic analysis for one recitation."""

    text = normalize_source_text(full_text)
    source = Path(audio_path).expanduser().resolve()
    if not source.is_file():
        raise AnalyzerError("找不到所选音频文件，请重新选择。")
    if source.suffix.lower() not in {".mp3", ".wav", ".m4a", ".mp4", ".aac", ".flac", ".ogg"}:
        raise AnalyzerError("暂不支持该音频格式。请使用 MP3 或 WAV（也兼容 M4A、AAC、FLAC、OGG）。")

    key = (api_key or os.getenv("ELEVENLABS_API_KEY", "")).strip()
    if not key:
        raise AnalyzerError("未找到 ELEVENLABS_API_KEY。请先运行 setup.bat，或在本工具目录的 .env 中配置。")

    alignment = forced_align(api_key=key, audio_path=source, full_text=text)
    tokens, alignment_quality = map_alignment_to_source(text, alignment)
    words = normalize_words(alignment.get("words"))
    sentence_ranges = split_sentence_ranges(text)

    with tempfile.TemporaryDirectory(prefix="recitation-local-analysis-") as temp_dir:
        wav_path = Path(temp_dir) / "mono-16k.wav"
        convert_to_mono_wav(source, wav_path)
        acoustics = analyze_wav(wav_path, tokens, sentence_ranges)

    token_evidence = {item["token_index"]: item for item in acoustics["token_acoustics"]}
    result_tokens: list[dict[str, Any]] = []
    for token in tokens:
        evidence = token_evidence[token["index"]]
        machine_pinyin, display_pinyin = pinyin_for_char(token["char"])
        result_tokens.append(
            {
                "index": token["index"],
                "char": token["char"],
                "machine_pinyin": machine_pinyin,
                "display_pinyin": display_pinyin,
                "start_ms": token["start_ms"],
                "end_ms": token["end_ms"],
                "duration_ms": evidence["duration_ms"],
                "alignment_confidence": token["confidence"],
            }
        )

    return {
        "schema_version": "recitation-analysis-1.0",
        "generated_at": datetime.now(UTC).isoformat(),
        "work": {"full_text": text},
        "audio": {
            "filename": source.name,
            "duration_ms": acoustics["duration_ms"],
            "sample_rate": acoustics["sample_rate"],
        },
        "alignment_quality": {
            **alignment_quality,
            "provider_loss": alignment.get("loss"),
        },
        "tokens": result_tokens,
        "words": words,
        "token_acoustics": [
            item for item in acoustics["token_acoustics"] if item["char"] not in PUNCTUATION
        ],
        "pauses": acoustics["pauses"],
        "duration_outliers": acoustics["duration_outliers"],
        "pitch": acoustics["pitch"],
        "energy_changes": acoustics["energy_changes"],
        "sentences": acoustics["sentences"],
        "scope_note": "仅包含时间轴与声音事实；未判断重音、停顿符号、拖音、语势、句尾语调或节奏等教学标签。",
    }


def normalize_source_text(text: str) -> str:
    # Preserve every visible character and line break because indexes must remain stable.
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip("\ufeff")
    if not normalized.strip():
        raise AnalyzerError("请先粘贴完整正文。")
    if len(normalized) > 20_000:
        raise AnalyzerError("正文过长。当前工具单次最多分析 20,000 个字符。")
    return normalized


def forced_align(
    *,
    api_key: str,
    audio_path: Path,
    full_text: str,
    timeout_seconds: float = 300.0,
) -> dict[str, Any]:
    mime_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    try:
        with audio_path.open("rb") as audio_file, httpx.Client(
            timeout=httpx.Timeout(timeout_seconds, connect=30.0),
            follow_redirects=True,
        ) as client:
            response = client.post(
                ELEVEN_ALIGNMENT_URL,
                headers={"xi-api-key": api_key},
                data={"text": full_text},
                files={"file": (audio_path.name, audio_file, mime_type)},
            )
    except httpx.TimeoutException as exc:
        raise AnalyzerError("ElevenLabs 对齐超时。请检查网络后重试。") from exc
    except (httpx.HTTPError, OSError) as exc:
        raise AnalyzerError(f"无法连接 ElevenLabs：{exc}") from exc

    if response.status_code >= 400:
        detail = _safe_provider_error(response)
        if response.status_code in {401, 403}:
            raise AnalyzerError("ElevenLabs 鉴权失败，请检查本地 .env 中的 API Key。")
        if response.status_code == 429:
            raise AnalyzerError("ElevenLabs 请求过于频繁或额度不足，请稍后重试并检查账户额度。")
        raise AnalyzerError(f"ElevenLabs 对齐失败（HTTP {response.status_code}）：{detail}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise AnalyzerError("ElevenLabs 返回了无法解析的数据。") from exc
    if not isinstance(payload, dict):
        raise AnalyzerError("ElevenLabs 返回格式不正确。")
    normalized = normalize_alignment_payload(payload)
    if not normalized["characters"]:
        raise AnalyzerError("ElevenLabs 未返回字符时间轴。请确认音频内容与正文一致。")
    return normalized


def _safe_provider_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            detail = payload.get("detail") or payload.get("message")
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("status")
            if detail:
                return str(detail)[:500]
    except ValueError:
        pass
    return response.text.strip()[:500] or "未知错误"


def normalize_alignment_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Accept both object-list and parallel-array Eleven alignment responses."""

    raw_characters = payload.get("characters")
    characters: list[dict[str, Any]] = []
    if isinstance(raw_characters, list) and raw_characters:
        if isinstance(raw_characters[0], dict):
            for item in raw_characters:
                if not isinstance(item, dict):
                    continue
                characters.append(
                    {
                        "text": str(item.get("text") or item.get("character") or item.get("char") or ""),
                        "start": _seconds(item, "start"),
                        "end": _seconds(item, "end"),
                        "confidence": _optional_float(item.get("confidence")),
                    }
                )
        else:
            starts = payload.get("character_start_times_seconds") or payload.get("character_start_times") or []
            ends = payload.get("character_end_times_seconds") or payload.get("character_end_times") or []
            for index, character in enumerate(raw_characters):
                characters.append(
                    {
                        "text": str(character),
                        "start": _array_float(starts, index),
                        "end": _array_float(ends, index),
                        "confidence": None,
                    }
                )

    return {
        **payload,
        "characters": characters,
        "words": normalize_raw_words(payload),
    }


def normalize_raw_words(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_words = payload.get("words")
    result: list[dict[str, Any]] = []
    if isinstance(raw_words, list):
        for item in raw_words:
            if isinstance(item, dict):
                result.append(
                    {
                        "text": str(item.get("text") or item.get("word") or ""),
                        "start": _seconds(item, "start"),
                        "end": _seconds(item, "end"),
                        "confidence": _optional_float(item.get("confidence")),
                    }
                )
    if result:
        return result

    words = payload.get("word_texts") or payload.get("word_characters") or []
    starts = payload.get("word_start_times_seconds") or payload.get("word_start_times") or []
    ends = payload.get("word_end_times_seconds") or payload.get("word_end_times") or []
    if isinstance(words, list):
        for index, word in enumerate(words):
            result.append(
                {
                    "text": str(word),
                    "start": _array_float(starts, index),
                    "end": _array_float(ends, index),
                    "confidence": None,
                }
            )
    return result


def _seconds(item: dict[str, Any], key: str) -> float:
    value = item.get(key)
    if value is None:
        value = item.get(f"{key}_seconds")
    return float(value or 0.0)


def _array_float(values: Any, index: int) -> float:
    if not isinstance(values, list) or index >= len(values):
        return 0.0
    try:
        return float(values[index] or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _optional_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def map_alignment_to_source(
    full_text: str, payload: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    provider = payload.get("characters")
    if not isinstance(provider, list) or not provider:
        raise AnalyzerError("Forced Alignment 没有返回字符数据。")

    provider_text = "".join(str(item.get("text") or "") for item in provider if isinstance(item, dict))
    matcher = difflib.SequenceMatcher(a=provider_text, b=full_text, autojunk=False)
    source_to_provider: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            source_to_provider[block.b + offset] = block.a + offset

    spoken_indexes = [index for index, char in enumerate(full_text) if char not in PUNCTUATION]
    matched_spoken = [index for index in spoken_indexes if index in source_to_provider]
    coverage = len(matched_spoken) / max(len(spoken_indexes), 1)
    if coverage < 0.98:
        raise AnalyzerError(
            f"音频与正文的字符覆盖率只有 {coverage:.1%}。请确认正文与朗诵内容完全一致后重试。"
        )

    tokens: list[dict[str, Any]] = []
    last_spoken_end = 0
    for index, char in enumerate(full_text):
        provider_index = source_to_provider.get(index)
        if provider_index is not None:
            item = provider[provider_index]
            start_ms = round(float(item.get("start") or 0.0) * 1000)
            end_ms = max(start_ms, round(float(item.get("end") or 0.0) * 1000))
            confidence = item.get("confidence")
            confidence = 1.0 if confidence is None else float(confidence)
            if char not in PUNCTUATION and start_ms < last_spoken_end:
                start_ms = last_spoken_end
                end_ms = max(start_ms, end_ms)
            if char not in PUNCTUATION:
                last_spoken_end = max(last_spoken_end, end_ms)
        else:
            next_start = next(
                (
                    round(float(provider[source_to_provider[cursor]].get("start") or 0.0) * 1000)
                    for cursor in range(index + 1, len(full_text))
                    if cursor in source_to_provider
                ),
                last_spoken_end,
            )
            start_ms = min(last_spoken_end, next_start)
            end_ms = start_ms
            confidence = 1.0 if char in PUNCTUATION else 0.0
        tokens.append(
            {
                "index": index,
                "char": char,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "confidence": round(confidence, 4),
            }
        )

    if "".join(item["char"] for item in tokens) != full_text:
        raise AnalyzerError("内部时间轴映射意外改变了正文，分析已停止。")
    return tokens, {
        "character_coverage": round(coverage, 5),
        "matched_spoken_characters": len(matched_spoken),
        "spoken_characters": len(spoken_indexes),
        "provider_character_count": len(provider),
    }


def normalize_words(raw_words: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_words, list):
        return []
    result: list[dict[str, Any]] = []
    for item in raw_words:
        if not isinstance(item, dict):
            continue
        result.append(
            {
                "text": str(item.get("text") or ""),
                "start_ms": round(float(item.get("start") or 0.0) * 1000),
                "end_ms": round(float(item.get("end") or 0.0) * 1000),
                "confidence": item.get("confidence"),
            }
        )
    return result


def split_sentence_ranges(text: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = 0
    for index, char in enumerate(text):
        if char in SENTENCE_ENDINGS and text[start : index + 1].strip():
            ranges.append((start, index))
            start = index + 1
    if start < len(text):
        ranges.append((start, len(text) - 1))
    if not ranges:
        ranges = [(0, len(text) - 1)]

    # Include blank separators in the following range so every source index is preserved.
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
    machine = lazy_pinyin(char, style=Style.TONE3, neutral_tone_with_five=True, errors="ignore")
    display = lazy_pinyin(char, style=Style.TONE, neutral_tone_with_five=False, errors="ignore")
    return (machine[0] if machine else None, display[0] if display else None)


def resolve_ffmpeg() -> str:
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    try:
        import imageio_ffmpeg

        bundled = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001 - convert to a user-facing setup error.
        raise AnalyzerError("未找到 FFmpeg。请重新运行 setup.bat 完成安装。") from exc
    if not bundled or not Path(bundled).is_file():
        raise AnalyzerError("未找到可用的 FFmpeg。请重新运行 setup.bat。")
    return bundled


def convert_to_mono_wav(source: Path, target: Path) -> None:
    command = [
        resolve_ffmpeg(),
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
    ]
    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    process = subprocess.run(
        command,
        capture_output=True,
        check=False,
        startupinfo=startupinfo,
    )
    if process.returncode != 0 or not target.is_file():
        detail = process.stderr.decode("utf-8", errors="replace")[-800:]
        raise AnalyzerError(f"FFmpeg 无法读取该音频：{detail or '未知转换错误'}")


def analyze_wav(
    wav_path: Path, tokens: list[dict[str, Any]], sentence_ranges: list[tuple[int, int]]
) -> dict[str, Any]:
    try:
        sound = parselmouth.Sound(str(wav_path))
        pitch = sound.to_pitch(time_step=0.01, pitch_floor=60, pitch_ceiling=500)
        intensity = sound.to_intensity(time_step=0.01, minimum_pitch=60)
    except Exception as exc:  # noqa: BLE001 - Parselmouth exposes several native exception types.
        raise AnalyzerError(f"Parselmouth 无法分析音频：{exc}") from exc

    pitch_times = np.asarray(pitch.xs(), dtype=float)
    pitch_values = np.asarray(pitch.selected_array["frequency"], dtype=float)
    intensity_times = np.asarray(intensity.xs(), dtype=float)
    intensity_values = np.asarray(intensity.values[0], dtype=float)

    token_acoustics: list[dict[str, Any]] = []
    for token in tokens:
        start_s = token["start_ms"] / 1000.0
        end_s = token["end_ms"] / 1000.0
        f0_samples = interval_values(pitch_times, pitch_values, start_s, end_s, positive_only=True)
        intensity_samples = interval_values(intensity_times, intensity_values, start_s, end_s)
        token_acoustics.append(
            {
                "token_index": token["index"],
                "char": token["char"],
                "duration_ms": max(0, token["end_ms"] - token["start_ms"]),
                "local_duration_ratio": None,
                "f0_hz": round(float(median(f0_samples)), 2) if f0_samples else None,
                "normalized_pitch": None,
                "intensity_db": round(float(np.mean(intensity_samples)), 2) if intensity_samples else None,
                "normalized_energy": None,
                "voiced": bool(f0_samples),
                "silence_gap_before_ms": 0,
                "silence_gap_after_ms": 0,
            }
        )

    spoken_positions = [
        position for position, token in enumerate(tokens) if token["char"] not in PUNCTUATION
    ]
    durations = [float(token_acoustics[position]["duration_ms"]) for position in spoken_positions]
    f0_pool = [token_acoustics[position]["f0_hz"] for position in spoken_positions]
    energy_pool = [token_acoustics[position]["intensity_db"] for position in spoken_positions]

    for order, position in enumerate(spoken_positions):
        local_window = durations[max(0, order - 3) : order + 4]
        baseline = median(local_window) if local_window else 1.0
        evidence = token_acoustics[position]
        evidence["local_duration_ratio"] = round(evidence["duration_ms"] / max(baseline, 1.0), 3)
        evidence["normalized_pitch"] = round_optional(semitone_normalize(evidence["f0_hz"], f0_pool))
        evidence["normalized_energy"] = round_optional(robust_z(evidence["intensity_db"], energy_pool))

    for left_order in range(len(spoken_positions) - 1):
        left = spoken_positions[left_order]
        right = spoken_positions[left_order + 1]
        gap = max(0, tokens[right]["start_ms"] - tokens[left]["end_ms"])
        token_acoustics[left]["silence_gap_after_ms"] = gap
        token_acoustics[right]["silence_gap_before_ms"] = gap

    pauses = pause_evidence(tokens, token_acoustics, spoken_positions)
    duration_outliers = [
        {
            "token_index": item["token_index"],
            "char": item["char"],
            "duration_ms": item["duration_ms"],
            "local_duration_ratio": item["local_duration_ratio"],
        }
        for item in token_acoustics
        if item.get("local_duration_ratio") is not None
        and item["local_duration_ratio"] >= 1.45
        and item["char"] not in PUNCTUATION
    ]
    sentences = [
        sentence_summary(
            tokens,
            token_acoustics,
            pauses,
            duration_outliers,
            start,
            end,
            order + 1,
        )
        for order, (start, end) in enumerate(sentence_ranges)
    ]
    pitch_summary = [
        {
            "sentence_id": sentence["id"],
            "start_index": sentence["start_index"],
            "end_index": sentence["end_index"],
            **sentence["pitch_summary"],
            "macro_pitch_contour": sentence["macro_pitch_contour"],
        }
        for sentence in sentences
    ]
    energy_changes = [
        {
            "token_index": item["token_index"],
            "char": item["char"],
            "normalized_energy": item["normalized_energy"],
            "direction": "stronger" if item["normalized_energy"] > 0 else "softer",
        }
        for item in token_acoustics
        if item.get("normalized_energy") is not None and abs(item["normalized_energy"]) >= 0.9
    ]
    return {
        "duration_ms": round(sound.get_total_duration() * 1000),
        "sample_rate": round(sound.sampling_frequency),
        "token_acoustics": token_acoustics,
        "pauses": pauses,
        "duration_outliers": duration_outliers,
        "pitch": pitch_summary,
        "energy_changes": energy_changes,
        "sentences": sentences,
    }


def interval_values(
    times: np.ndarray,
    values: np.ndarray,
    start_s: float,
    end_s: float,
    *,
    positive_only: bool = False,
) -> list[float]:
    mask = (times >= start_s) & (times <= max(start_s, end_s))
    selected = values[mask]
    result: list[float] = []
    for value in selected:
        number = float(value)
        if not math.isfinite(number) or (positive_only and number <= 0):
            continue
        result.append(number)
    return result


def finite(values: Iterable[float | None]) -> list[float]:
    return [float(value) for value in values if value is not None and math.isfinite(float(value))]


def robust_z(value: float | None, values: Iterable[float | None]) -> float | None:
    pool = finite(values)
    if value is None or not pool:
        return None
    center = median(pool)
    deviations = [abs(item - center) for item in pool]
    mad = median(deviations) or float(np.std(pool)) or 1.0
    return (value - center) / (1.4826 * mad)


def semitone_normalize(value: float | None, values: Iterable[float | None]) -> float | None:
    pool = [item for item in finite(values) if item > 0]
    if value is None or value <= 0 or not pool:
        return None
    return 12.0 * math.log2(value / median(pool))


def round_optional(value: float | None) -> float | None:
    return round(value, 3) if value is not None and math.isfinite(value) else None


def rolling_median(values: list[float | None], radius: int = 2) -> list[float | None]:
    result: list[float | None] = []
    for index in range(len(values)):
        window = finite(values[max(0, index - radius) : index + radius + 1])
        result.append(float(median(window)) if window else None)
    return result


def trend_label(values: list[float | None]) -> str:
    points = [(index, value) for index, value in enumerate(values) if value is not None]
    if len(points) < 2:
        return "flat"
    x = np.asarray([point[0] for point in points], dtype=float)
    y = np.asarray([point[1] for point in points], dtype=float)
    slope = float(np.polyfit(x, y, 1)[0])
    if slope > 0.22:
        return "rising"
    if slope < -0.22:
        return "falling"
    return "flat"


def turning_regions(indexes: list[int], values: list[float | None]) -> list[dict[str, Any]]:
    smooth = rolling_median(values, radius=2)
    regions: list[dict[str, Any]] = []
    for position in range(1, len(smooth) - 1):
        left, current, right = smooth[position - 1 : position + 2]
        if left is None or current is None or right is None:
            continue
        kind = None
        if current - left > 0.3 and current - right > 0.3:
            kind = "local_peak"
        elif left - current > 0.3 and right - current > 0.3:
            kind = "local_valley"
        if kind:
            regions.append(
                {
                    "start_index": indexes[max(0, position - 1)],
                    "end_index": indexes[min(len(indexes) - 1, position + 1)],
                    "kind": kind,
                    "normalized_pitch": round(current, 3),
                }
            )
    return regions[:6]


def macro_contour(
    indexes: list[int], values: list[float | None], zones: int = 5
) -> list[dict[str, Any]]:
    if not indexes:
        return []
    zone_count = min(zones, len(indexes))
    boundaries = np.linspace(0, len(indexes), zone_count + 1, dtype=int)
    result: list[dict[str, Any]] = []
    for zone in range(zone_count):
        start, end = int(boundaries[zone]), int(boundaries[zone + 1])
        if end <= start:
            continue
        pool = finite(values[start:end])
        result.append(
            {
                "start_index": indexes[start],
                "end_index": indexes[end - 1],
                "normalized_pitch": round(float(np.mean(pool)), 3) if pool else None,
                "trend": trend_label(values[start:end]),
            }
        )
    return result


def pause_evidence(
    tokens: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    spoken_positions: list[int],
) -> list[dict[str, Any]]:
    gaps = [float(evidence[position]["silence_gap_after_ms"]) for position in spoken_positions[:-1]]
    positive = sorted(gap for gap in gaps if gap >= 40)
    if not positive:
        return []
    median_gap = median(positive)
    upper_quartile = float(np.quantile(positive, 0.75)) if len(positive) >= 4 else max(positive)
    short_floor = max(80.0, median_gap * 0.85)
    long_floor = max(short_floor * 2.1, upper_quartile * 1.35)
    result: list[dict[str, Any]] = []
    for position in spoken_positions[:-1]:
        gap = float(evidence[position]["silence_gap_after_ms"])
        if gap < short_floor:
            continue
        result.append(
            {
                "after_index": tokens[position]["index"],
                "gap_ms": round(gap),
                "relative_level": "long" if gap >= long_floor else "short",
            }
        )
    return result


def sentence_summary(
    tokens: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    pauses: list[dict[str, Any]],
    duration_outliers: list[dict[str, Any]],
    start: int,
    end: int,
    order: int,
) -> dict[str, Any]:
    positions = [
        position for position in range(start, end + 1) if tokens[position]["char"] not in PUNCTUATION
    ]
    indexes = [tokens[position]["index"] for position in positions]
    pitch = [evidence[position]["normalized_pitch"] for position in positions]
    smooth_pitch = rolling_median(pitch, radius=2)
    energy = [evidence[position]["normalized_energy"] for position in positions]
    durations = [evidence[position]["duration_ms"] for position in positions]
    start_ms = min((tokens[position]["start_ms"] for position in positions), default=tokens[start]["start_ms"])
    end_ms = max((tokens[position]["end_ms"] for position in positions), default=tokens[end]["end_ms"])
    duration_seconds = max((end_ms - start_ms) / 1000.0, 0.001)
    sentence_pauses = [item for item in pauses if start <= item["after_index"] <= end]
    sentence_durations = [item for item in duration_outliers if start <= item["token_index"] <= end]
    pitch_pool = finite(smooth_pitch)
    energy_pool = finite(energy)
    return {
        "id": f"sentence-{order}",
        "order": order,
        "text": "".join(token["char"] for token in tokens[start : end + 1]),
        "start_index": start,
        "end_index": end,
        "start_ms": int(start_ms),
        "end_ms": int(end_ms),
        "speaking_rate_chars_per_sec": round(len(positions) / duration_seconds, 3),
        "pause_summary": {
            "count": len(sentence_pauses),
            "total_gap_ms": sum(item["gap_ms"] for item in sentence_pauses),
            "items": sentence_pauses,
        },
        "duration_summary": {
            "local_median_ms": round(float(median(durations))) if durations else 0,
            "outlier_tokens": sentence_durations,
        },
        "pitch_summary": {
            "median_normalized_pitch": round(float(median(pitch_pool)), 3) if pitch_pool else None,
            "range": round(max(pitch_pool) - min(pitch_pool), 3) if pitch_pool else None,
            "trend": trend_label(smooth_pitch),
            "turning_regions": turning_regions(indexes, smooth_pitch),
        },
        "energy_summary": {
            "median_normalized_energy": round(float(median(energy_pool)), 3) if energy_pool else None,
            "significant_regions": [
                {
                    "token_index": indexes[index],
                    "normalized_energy": round(float(value), 3),
                    "direction": "stronger" if value > 0 else "softer",
                }
                for index, value in enumerate(energy)
                if value is not None and abs(value) >= 0.9
            ],
        },
        "macro_pitch_contour": macro_contour(indexes, smooth_pitch),
    }


def save_analysis_result(result: dict[str, Any], output_path: str | Path) -> Path:
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    return target
