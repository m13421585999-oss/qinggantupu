from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np
import parselmouth

from app.acoustics.contour import (
    continuous_macro_prosody_path,
    finite,
    macro_contour,
    robust_z,
    rolling_median,
    rounded,
    semitone_normalize,
    trend_label,
    turning_regions,
)
from app.providers.eleven_alignment import PUNCTUATION


SENTENCE_ENDINGS = set("。！？!?；;\n")
PHRASE_BOUNDARIES = set("，、：,.!?！？。；;:\n\r")
ACOUSTIC_FRAME_SECONDS = 0.01


class AcousticAnalysisError(RuntimeError):
    pass


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
        return [(0, len(text) - 1)]
    normalized: list[tuple[int, int]] = []
    cursor = 0
    for _, end in ranges:
        normalized.append((cursor, end))
        cursor = end + 1
    if normalized[-1][1] < len(text) - 1:
        normalized[-1] = (normalized[-1][0], len(text) - 1)
    return normalized


def resolve_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        bundled = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # Keep the provider detail out of the user-facing callback.
        raise AcousticAnalysisError(
            "FFmpeg is unavailable in the analysis service runtime"
        ) from exc
    if not bundled or not Path(bundled).is_file():
        raise AcousticAnalysisError("FFmpeg is unavailable in the analysis service runtime")
    return bundled


def convert_to_mono_wav(source: Path, target: Path) -> None:
    process = subprocess.run(
        [
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
        ],
        capture_output=True,
        check=False,
    )
    if process.returncode != 0 or not target.is_file():
        detail = process.stderr.decode("utf-8", errors="replace")[-800:]
        raise AcousticAnalysisError(f"FFmpeg could not decode the reference audio: {detail}")


def _interval(
    times: np.ndarray,
    values: np.ndarray,
    start_s: float,
    end_s: float,
    *,
    positive_only: bool = False,
) -> list[float]:
    mask = (times >= start_s) & (times <= max(start_s, end_s))
    result: list[float] = []
    for value in values[mask]:
        number = float(value)
        if not math.isfinite(number) or (positive_only and number <= 0):
            continue
        result.append(number)
    return result


def _sample_nearest(
    source_times: np.ndarray,
    source_values: np.ndarray,
    target_times: np.ndarray,
) -> np.ndarray:
    if not len(source_times) or not len(source_values) or not len(target_times):
        return np.zeros(len(target_times), dtype=float)
    right = np.searchsorted(source_times, target_times, side="left")
    right = np.clip(right, 0, len(source_times) - 1)
    left = np.clip(right - 1, 0, len(source_times) - 1)
    choose_left = np.abs(target_times - source_times[left]) <= np.abs(
        source_times[right] - target_times
    )
    return np.asarray(source_values[np.where(choose_left, left, right)], dtype=float)


def _bridge_short_activity_gaps(
    active: np.ndarray,
    energy_support: np.ndarray,
    *,
    maximum_gap_frames: int = 3,
) -> np.ndarray:
    bridged = np.asarray(active, dtype=bool).copy()
    cursor = 0
    while cursor < len(bridged):
        if bridged[cursor]:
            cursor += 1
            continue
        start = cursor
        while cursor < len(bridged) and not bridged[cursor]:
            cursor += 1
        end = cursor
        if (
            start > 0
            and end < len(bridged)
            and end - start <= maximum_gap_frames
            and bool(np.all(energy_support[start:end]))
        ):
            bridged[start:end] = True
    return bridged


def _effective_voice_measurement(
    *,
    pitch_times: np.ndarray,
    pitch_values: np.ndarray,
    intensity_times: np.ndarray,
    intensity_values: np.ndarray,
    start_s: float,
    end_s: float,
    noise_floor_db: float,
    speech_reference_db: float,
) -> dict[str, float]:
    """Measure sustained sound inside an alignment token window."""
    alignment_duration_ms = max(0.0, (end_s - start_s) * 1000)
    if alignment_duration_ms <= 0:
        return {
            "effective_voiced_duration_ms": 0.0,
            "low_energy_tail_ms": 0.0,
            "voiced_continuity_ratio": 0.0,
        }
    frame_times = np.arange(
        start_s + ACOUSTIC_FRAME_SECONDS / 2,
        end_s,
        ACOUSTIC_FRAME_SECONDS,
        dtype=float,
    )
    if not len(frame_times):
        frame_times = np.asarray([(start_s + end_s) / 2], dtype=float)
    sampled_pitch = _sample_nearest(pitch_times, pitch_values, frame_times)
    finite_intensity_mask = np.isfinite(intensity_values)
    if np.any(finite_intensity_mask):
        sampled_intensity = np.interp(
            frame_times,
            intensity_times[finite_intensity_mask],
            intensity_values[finite_intensity_mask],
        )
    else:
        sampled_intensity = np.full(len(frame_times), noise_floor_db, dtype=float)
    local_peak = float(np.quantile(sampled_intensity, 0.9))
    activity_floor = max(
        noise_floor_db + 6.0,
        min(local_peak - 14.0, speech_reference_db - 16.0),
    )
    energy_support = sampled_intensity >= activity_floor - 3.0
    pitch_active = np.isfinite(sampled_pitch) & (sampled_pitch > 0) & energy_support
    active = (
        pitch_active | (sampled_intensity >= activity_floor + 3.0)
        if bool(np.any(pitch_active))
        else sampled_intensity >= activity_floor + 3.0
    )
    active = _bridge_short_activity_gaps(active, energy_support)
    active_indexes = np.flatnonzero(active)
    if not len(active_indexes):
        return {
            "effective_voiced_duration_ms": 0.0,
            "low_energy_tail_ms": alignment_duration_ms,
            "voiced_continuity_ratio": 0.0,
        }
    frame_ms = ACOUSTIC_FRAME_SECONDS * 1000
    effective_ms = min(alignment_duration_ms, len(active_indexes) * frame_ms)
    last_active_end_s = min(
        end_s,
        float(frame_times[int(active_indexes[-1])]) + ACOUSTIC_FRAME_SECONDS / 2,
    )
    low_energy_tail_ms = max(0.0, (end_s - last_active_end_s) * 1000)
    active_span_frames = int(active_indexes[-1] - active_indexes[0] + 1)
    return {
        "effective_voiced_duration_ms": round(effective_ms),
        "low_energy_tail_ms": round(low_energy_tail_ms),
        "voiced_continuity_ratio": round(
            len(active_indexes) / max(active_span_frames, 1), 3
        ),
    }


def _boundary_type(tokens: list[dict[str, Any]], position: int) -> str:
    between: list[str] = []
    for token in tokens[position + 1 :]:
        char = str(token.get("char") or "")
        if char not in PUNCTUATION:
            break
        between.append(char)
    if any(char in SENTENCE_ENDINGS for char in between):
        return "sentence_end"
    if any(char in PHRASE_BOUNDARIES for char in between):
        return "phrase_end"
    if not any(token.get("char") not in PUNCTUATION for token in tokens[position + 1 :]):
        return "sentence_end"
    return "none"


def _pause_evidence(
    tokens: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    spoken_positions: list[int],
) -> list[dict[str, Any]]:
    gaps = [
        float(evidence[position].get("pause_after_ms", 0))
        for position in spoken_positions[:-1]
    ]
    positive = sorted(gap for gap in gaps if gap >= 40)
    if not positive:
        return []
    median_gap = median(positive)
    upper_quartile = float(np.quantile(positive, 0.75)) if len(positive) >= 4 else max(positive)
    short_floor = max(80.0, median_gap * 0.85)
    long_floor = max(short_floor * 2.1, upper_quartile * 1.35)
    result: list[dict[str, Any]] = []
    for position in spoken_positions[:-1]:
        gap = float(evidence[position].get("pause_after_ms", 0))
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


def _ending_intonation(
    evidence: list[dict[str, Any]],
    positions: list[int],
    macro_path: dict[str, Any],
    tail_pitch_path: list[dict[str, Any]],
) -> dict[str, Any]:
    valid = [
        position
        for position in positions
        if evidence[position].get("pitch_start") is not None
        and evidence[position].get("pitch_end") is not None
        and float(evidence[position].get("voiced_ratio") or 0) >= 0.15
    ]
    if not valid:
        return {
            "type": "level",
            "strength": 1,
            "confidence": 0.2,
            "source": "acoustic",
            "evidence_indexes": [],
            "pitch_delta": None,
        }

    final_positions = valid[-3:]
    last = evidence[final_positions[-1]]
    within_final = float(last.get("pitch_delta") or 0)
    path_points = [
        point
        for point in macro_path.get("points", [])
        if int(point["token_index"]) in {int(evidence[position]["token_index"]) for position in final_positions}
    ]
    across_final = 0.0
    if len(path_points) >= 2:
        across_final = float(path_points[-1]["normalized_level"]) - float(
            path_points[0]["normalized_level"]
        )

    tail_delta = 0.0
    if len(tail_pitch_path) >= 2:
        tail_delta = float(tail_pitch_path[-1]["normalized_level"]) - float(
            tail_pitch_path[-2]["normalized_level"]
        )
    if abs(tail_delta) >= 0.55:
        delta = tail_delta
    elif abs(within_final) >= 0.65:
        delta = within_final * 0.72 + across_final * 0.28
    else:
        delta = across_final * 0.72 + within_final * 0.28
    ending_type = "rising" if delta >= 0.55 else "falling" if delta <= -0.55 else "level"
    movement = abs(delta)
    strength = 1 if movement < 1.2 else 2 if movement < 2.5 else 3
    confidence = min(0.98, 0.5 + movement / 4) if ending_type != "level" else max(0.45, 0.7 - movement / 3)
    return {
        "type": ending_type,
        "strength": strength,
        "confidence": round(confidence, 3),
        "source": "acoustic",
        "evidence_indexes": [int(evidence[position]["token_index"]) for position in final_positions],
        "pitch_delta": round(delta, 3),
        "within_final_syllable_delta": round(within_final, 3),
        "final_phrase_delta": round(across_final, 3),
        "tail_frame_delta": round(tail_delta, 3),
        "tail_pitch_path": tail_pitch_path,
    }


def _tail_pitch_path(
    pitch_times: np.ndarray,
    pitch_values: np.ndarray,
    start_ms: int,
    end_ms: int,
    reference_f0: list[float | None],
) -> list[dict[str, Any]]:
    pool = [value for value in finite(reference_f0) if value > 0]
    if not pool:
        return []
    reference = float(median(pool))
    start_s = max(start_ms / 1000, end_ms / 1000 - 1.3)
    end_s = end_ms / 1000
    boundaries = np.linspace(start_s, end_s, 5)
    result: list[dict[str, Any]] = []
    for position in range(4):
        mask = (pitch_times >= boundaries[position]) & (pitch_times < boundaries[position + 1])
        samples = [
            float(value)
            for value in pitch_values[mask]
            if math.isfinite(float(value))
            and float(value) > 0
            and reference / 2.2 <= float(value) <= reference * 2.2
        ]
        if not samples:
            continue
        f0 = float(median(samples))
        result.append(
            {
                "relative_position": round((position + 0.5) / 4, 3),
                "normalized_level": round(12 * math.log2(f0 / reference), 3),
            }
        )
    return result


def _sentence_summary(
    tokens: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    pauses: list[dict[str, Any]],
    duration_outliers: list[dict[str, Any]],
    start: int,
    end: int,
    order: int,
    pitch_times: np.ndarray,
    pitch_values: np.ndarray,
    reference_f0: list[float | None],
) -> dict[str, Any]:
    positions = [
        position for position in range(start, end + 1) if tokens[position]["char"] not in PUNCTUATION
    ]
    indexes = [tokens[position]["index"] for position in positions]
    pitch = [evidence[position]["normalized_pitch"] for position in positions]
    smooth_pitch = rolling_median(pitch, radius=2)
    energy = [evidence[position]["normalized_energy"] for position in positions]
    duration_ratios = [
        evidence[position].get("effective_voiced_duration_ratio")
        for position in positions
    ]
    durations = [
        float(
            evidence[position].get(
                "effective_voiced_duration_ms", evidence[position]["duration_ms"]
            )
            or 0
        )
        for position in positions
    ]
    start_ms = min((tokens[position]["start_ms"] for position in positions), default=tokens[start]["start_ms"])
    end_ms = max((tokens[position]["end_ms"] for position in positions), default=tokens[end]["end_ms"])
    duration_seconds = max((end_ms - start_ms) / 1000, 0.001)
    sentence_pauses = [item for item in pauses if start <= item["after_index"] <= end]
    sentence_durations = [item for item in duration_outliers if start <= item["token_index"] <= end]
    pitch_pool = finite(smooth_pitch)
    energy_pool = finite(energy)
    tail_pitch_path = _tail_pitch_path(
        pitch_times,
        pitch_values,
        int(start_ms),
        int(end_ms),
        reference_f0,
    )
    pitch_for_path = list(pitch)
    if len(tail_pitch_path) >= 2 and len(pitch_for_path) >= 2:
        pitch_for_path[-2] = tail_pitch_path[-2]["normalized_level"]
        pitch_for_path[-1] = tail_pitch_path[-1]["normalized_level"]
    macro_path = continuous_macro_prosody_path(indexes, pitch_for_path)
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
            "local_median_effective_voiced_ms": round(float(median(durations))) if durations else 0,
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
        "macro_prosody_path": macro_path,
        "ending_intonation": _ending_intonation(
            evidence,
            positions,
            macro_path,
            tail_pitch_path,
        ),
        "macro_energy_contour": macro_contour(
            indexes,
            energy,
            value_key="normalized_energy",
        ),
        "macro_duration_contour": macro_contour(
            indexes,
            duration_ratios,
            value_key="effective_voiced_duration_ratio",
        ),
    }


def analyze_wav(
    wav_path: Path,
    tokens: list[dict[str, Any]],
    sentence_ranges: list[tuple[int, int]],
) -> dict[str, Any]:
    try:
        sound = parselmouth.Sound(str(wav_path))
        pitch = sound.to_pitch_cc(
            time_step=0.01,
            pitch_floor=55,
            pitch_ceiling=500,
            very_accurate=True,
            silence_threshold=0.015,
            voicing_threshold=0.32,
            octave_jump_cost=0.4,
            voiced_unvoiced_cost=0.18,
        )
        intensity = sound.to_intensity(time_step=0.01, minimum_pitch=60)
    except Exception as exc:  # Parselmouth exposes native exception types.
        raise AcousticAnalysisError(f"Parselmouth could not analyze the audio: {exc}") from exc

    pitch_times = np.asarray(pitch.xs(), dtype=float)
    pitch_values = np.asarray(pitch.selected_array["frequency"], dtype=float)
    intensity_times = np.asarray(intensity.xs(), dtype=float)
    intensity_values = np.asarray(intensity.values[0], dtype=float)

    finite_intensity_mask = np.isfinite(intensity_values)
    finite_intensity = intensity_values[finite_intensity_mask]
    finite_intensity_times = intensity_times[finite_intensity_mask]
    noise_floor_db = (
        float(np.quantile(finite_intensity, 0.1)) if len(finite_intensity) else 0.0
    )
    voiced_pitch_mask = np.isfinite(pitch_values) & (pitch_values > 0)
    voiced_times = pitch_times[voiced_pitch_mask]
    if len(voiced_times) and len(finite_intensity_times):
        voiced_intensity = np.interp(
            voiced_times,
            finite_intensity_times,
            finite_intensity,
        )
        speech_reference_db = float(median(voiced_intensity.tolist()))
    elif len(finite_intensity):
        speech_reference_db = float(np.quantile(finite_intensity, 0.75))
    else:
        speech_reference_db = noise_floor_db

    token_acoustics: list[dict[str, Any]] = []
    for token in tokens:
        start_s = token["start_ms"] / 1000
        end_s = token["end_ms"] / 1000
        raw_pitch = _interval(pitch_times, pitch_values, start_s, end_s)
        f0_samples = [value for value in raw_pitch if value > 0]
        edge_size = max(1, len(f0_samples) // 3)
        f0_start = float(median(f0_samples[:edge_size])) if f0_samples else None
        f0_end = float(median(f0_samples[-edge_size:])) if f0_samples else None
        intensity_samples = _interval(intensity_times, intensity_values, start_s, end_s)
        voice_measurement = _effective_voice_measurement(
            pitch_times=pitch_times,
            pitch_values=pitch_values,
            intensity_times=intensity_times,
            intensity_values=intensity_values,
            start_s=start_s,
            end_s=end_s,
            noise_floor_db=noise_floor_db,
            speech_reference_db=speech_reference_db,
        )
        alignment_duration_ms = max(0, token["end_ms"] - token["start_ms"])
        token_acoustics.append(
            {
                "token_index": token["index"],
                "char": token["char"],
                "alignment_duration_ms": alignment_duration_ms,
                "duration_ms": alignment_duration_ms,
                "local_duration_ratio": None,
                "effective_voiced_duration_ms": voice_measurement[
                    "effective_voiced_duration_ms"
                ],
                "effective_voiced_duration_ratio": None,
                "low_energy_tail_ms": voice_measurement["low_energy_tail_ms"],
                "voiced_continuity_ratio": voice_measurement[
                    "voiced_continuity_ratio"
                ],
                "f0_hz": round(float(median(f0_samples)), 2) if f0_samples else None,
                "_pitch_start_hz": f0_start,
                "_pitch_end_hz": f0_end,
                "normalized_pitch": None,
                "pitch_start": None,
                "pitch_end": None,
                "pitch_delta": None,
                "pitch_trend": "level",
                "intensity_db": round(float(np.mean(intensity_samples)), 2) if intensity_samples else None,
                "normalized_energy": None,
                "voiced_ratio": round(len(f0_samples) / max(len(raw_pitch), 1), 3),
                "silence_gap_before_ms": 0,
                "silence_gap_after_ms": 0,
                "alignment_gap_after_ms": 0,
                "pause_after_ms": voice_measurement["low_energy_tail_ms"],
            }
        )

    spoken_positions = [
        position for position, token in enumerate(tokens) if token["char"] not in PUNCTUATION
    ]
    durations = [float(token_acoustics[position]["duration_ms"]) for position in spoken_positions]
    effective_durations = [
        float(token_acoustics[position]["effective_voiced_duration_ms"])
        for position in spoken_positions
    ]
    f0_pool = [token_acoustics[position]["f0_hz"] for position in spoken_positions]
    energy_pool = [token_acoustics[position]["intensity_db"] for position in spoken_positions]
    for order, position in enumerate(spoken_positions):
        local_window = durations[max(0, order - 3) : order + 4]
        baseline = median(local_window) if local_window else 1
        effective_window = effective_durations[max(0, order - 3) : order + 4]
        positive_effective = [value for value in effective_window if value > 0]
        effective_baseline = median(positive_effective) if positive_effective else 1
        item = token_acoustics[position]
        item["local_duration_ratio"] = round(item["duration_ms"] / max(baseline, 1), 3)
        item["effective_voiced_duration_ratio"] = round(
            item["effective_voiced_duration_ms"] / max(effective_baseline, 1), 3
        )
        item["normalized_pitch"] = rounded(semitone_normalize(item["f0_hz"], f0_pool))
        item["pitch_start"] = rounded(semitone_normalize(item["_pitch_start_hz"], f0_pool))
        item["pitch_end"] = rounded(semitone_normalize(item["_pitch_end_hz"], f0_pool))
        if item["pitch_start"] is not None and item["pitch_end"] is not None:
            item["pitch_delta"] = round(float(item["pitch_end"]) - float(item["pitch_start"]), 3)
            item["pitch_trend"] = (
                "rising" if item["pitch_delta"] >= 0.55
                else "falling" if item["pitch_delta"] <= -0.55
                else "level"
            )
        item["normalized_energy"] = rounded(robust_z(item["intensity_db"], energy_pool))

    for order in range(len(spoken_positions) - 1):
        left = spoken_positions[order]
        right = spoken_positions[order + 1]
        gap = max(0, tokens[right]["start_ms"] - tokens[left]["end_ms"])
        token_acoustics[left]["alignment_gap_after_ms"] = gap
        token_acoustics[left]["pause_after_ms"] = round(
            float(token_acoustics[left].get("low_energy_tail_ms") or 0) + gap
        )
        # Compatibility alias: unlike the historical value, this now also
        # recovers silence absorbed into the preceding alignment window.
        token_acoustics[left]["silence_gap_after_ms"] = token_acoustics[left][
            "pause_after_ms"
        ]
        token_acoustics[right]["silence_gap_before_ms"] = gap

    if spoken_positions:
        final_spoken = spoken_positions[-1]
        token_acoustics[final_spoken]["pause_after_ms"] = round(
            float(token_acoustics[final_spoken].get("low_energy_tail_ms") or 0)
        )
        token_acoustics[final_spoken]["silence_gap_after_ms"] = token_acoustics[
            final_spoken
        ]["pause_after_ms"]

    pauses = _pause_evidence(tokens, token_acoustics, spoken_positions)
    duration_outliers = []
    prolongation_candidates = []
    token_position_by_index = {
        int(token["index"]): position for position, token in enumerate(tokens)
    }
    for item in token_acoustics:
        if item["char"] in PUNCTUATION:
            continue
        alignment_ratio = float(item.get("local_duration_ratio") or 0)
        effective_ratio = float(item.get("effective_voiced_duration_ratio") or 0)
        if alignment_ratio < 1.45 and effective_ratio < 1.45:
            continue
        alignment_duration = max(float(item.get("alignment_duration_ms") or 0), 1)
        candidate = {
            "token_index": item["token_index"],
            "char": item["char"],
            "duration_ms": item["duration_ms"],
            "alignment_duration_ms": item["alignment_duration_ms"],
            "local_duration_ratio": item["local_duration_ratio"],
            "effective_voiced_duration_ms": item["effective_voiced_duration_ms"],
            "effective_voiced_duration_ratio": item[
                "effective_voiced_duration_ratio"
            ],
            "voiced_continuity_ratio": item["voiced_continuity_ratio"],
            "low_energy_tail_ms": item["low_energy_tail_ms"],
            "low_energy_tail_ratio": round(
                float(item.get("low_energy_tail_ms") or 0) / alignment_duration, 3
            ),
            "alignment_gap_after_ms": item["alignment_gap_after_ms"],
            "pause_after_ms": item["pause_after_ms"],
            "boundary_type": _boundary_type(
                tokens, token_position_by_index[int(item["token_index"])]
            ),
            "candidate_basis": (
                "alignment_and_effective"
                if alignment_ratio >= 1.45 and effective_ratio >= 1.45
                else "effective_voicing"
                if effective_ratio >= 1.45
                else "alignment_duration"
            ),
            "source_control_ref": (
                f"analysis.internal_analysis.prolongation_candidates.token-{item['token_index']}"
            ),
        }
        duration_outliers.append(candidate.copy())
        prolongation_candidates.append(candidate)
    sentences = [
        _sentence_summary(
            tokens,
            token_acoustics,
            pauses,
            duration_outliers,
            start,
            end,
            order + 1,
            pitch_times,
            pitch_values,
            f0_pool,
        )
        for order, (start, end) in enumerate(sentence_ranges)
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
    for item in token_acoustics:
        item.pop("_pitch_start_hz", None)
        item.pop("_pitch_end_hz", None)
    return {
        "duration_ms": round(sound.get_total_duration() * 1000),
        "sample_rate": round(sound.sampling_frequency),
        "token_acoustics": token_acoustics,
        "pauses": pauses,
        "duration_outliers": duration_outliers,
        "prolongation_candidates": prolongation_candidates,
        "energy_changes": energy_changes,
        "sentences": sentences,
    }
