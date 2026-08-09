from __future__ import annotations

import math
from statistics import median
from typing import Any

import numpy as np
import parselmouth

from .contour import macro_contour, robust_z, rolling_median, semitone_normalize, trend_label, turning_regions


PUNCTUATION = set("，。！？、；：,.!?;:\n\r\t ")


def _interval_values(times: np.ndarray, values: np.ndarray, start_s: float, end_s: float) -> list[float]:
    mask = (times >= start_s) & (times <= max(start_s, end_s))
    selected = values[mask]
    return [float(value) for value in selected if math.isfinite(float(value)) and float(value) > 0]


def _median_or_none(values: list[float]) -> float | None:
    return float(median(values)) if values else None


def analyze_wav(wav_path: str, tokens: list[dict[str, Any]], sentence_ranges: list[tuple[int, int]]) -> dict[str, Any]:
    sound = parselmouth.Sound(wav_path)
    pitch = sound.to_pitch(time_step=0.01, pitch_floor=60, pitch_ceiling=500)
    intensity = sound.to_intensity(time_step=0.01, minimum_pitch=60)
    pitch_times = np.asarray(pitch.xs(), dtype=float)
    pitch_values = np.asarray(pitch.selected_array["frequency"], dtype=float)
    intensity_times = np.asarray(intensity.xs(), dtype=float)
    intensity_values = np.asarray(intensity.values[0], dtype=float)

    evidence: list[dict[str, Any]] = []
    for token in tokens:
        start_s = token["start_ms"] / 1000.0
        end_s = token["end_ms"] / 1000.0
        f0 = _median_or_none(_interval_values(pitch_times, pitch_values, start_s, end_s))
        energy_values = _interval_values(intensity_times, intensity_values, start_s, end_s)
        energy = float(np.mean(energy_values)) if energy_values else None
        evidence.append(
            {
                "index": token["index"],
                "char": token["char"],
                "duration_ms": max(0, token["end_ms"] - token["start_ms"]),
                "f0_hz": f0,
                "intensity_db": energy,
                "voiced": f0 is not None,
                "silence_gap_before_ms": 0,
                "silence_gap_after_ms": 0,
            }
        )

    spoken_positions = [index for index, token in enumerate(tokens) if token["char"] not in PUNCTUATION]
    durations = [float(evidence[index]["duration_ms"]) for index in spoken_positions]
    f0_values = [evidence[index]["f0_hz"] for index in spoken_positions]
    energy_values = [evidence[index]["intensity_db"] for index in spoken_positions]
    for order, position in enumerate(spoken_positions):
        local = durations[max(0, order - 3) : order + 4]
        local_baseline = median(local) if local else 1.0
        evidence[position]["local_duration_ratio"] = round(
            evidence[position]["duration_ms"] / max(local_baseline, 1.0), 3
        )
        evidence[position]["normalized_pitch"] = _round_or_none(
            semitone_normalize(evidence[position]["f0_hz"], f0_values)
        )
        evidence[position]["normalized_energy"] = _round_or_none(
            robust_z(evidence[position]["intensity_db"], energy_values)
        )

    for left_order in range(len(spoken_positions) - 1):
        left_position = spoken_positions[left_order]
        right_position = spoken_positions[left_order + 1]
        gap = max(0, tokens[right_position]["start_ms"] - tokens[left_position]["end_ms"])
        evidence[left_position]["silence_gap_after_ms"] = gap
        evidence[right_position]["silence_gap_before_ms"] = gap

    pauses = _pause_evidence(tokens, evidence, spoken_positions)
    elongations = [
        {
            "token_index": item["index"],
            "duration_ms": int(item["duration_ms"]),
            "local_duration_ratio": item["local_duration_ratio"],
        }
        for item in evidence
        if item.get("local_duration_ratio", 0) >= 1.45 and item["char"] not in PUNCTUATION
    ]
    sentences = [
        _sentence_summary(tokens, evidence, pauses, elongations, start, end, order + 1)
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
            "token_index": item["index"],
            "char": item["char"],
            "normalized_energy": item.get("normalized_energy"),
            "direction": "stronger" if item.get("normalized_energy", 0) > 0 else "softer",
        }
        for item in evidence
        if item.get("normalized_energy") is not None and abs(item["normalized_energy"]) >= 0.9
    ]
    return {
        "duration_ms": round(sound.get_total_duration() * 1000),
        "sample_rate": round(sound.sampling_frequency),
        "token_evidence": evidence,
        "pauses": pauses,
        "elongations": elongations,
        "pitch": pitch_summary,
        "energy": energy_changes,
        "sentences": sentences,
    }


def _round_or_none(value: float | None) -> float | None:
    return round(value, 3) if value is not None and math.isfinite(value) else None


def _pause_evidence(tokens: list[dict[str, Any]], evidence: list[dict[str, Any]], spoken_positions: list[int]) -> list[dict[str, Any]]:
    gaps = [float(evidence[position].get("silence_gap_after_ms", 0)) for position in spoken_positions[:-1]]
    positive = sorted(gap for gap in gaps if gap >= 40)
    if not positive:
        return []
    median_gap = median(positive)
    high_quantile = float(np.quantile(positive, 0.75)) if len(positive) >= 4 else max(positive)
    short_floor = max(80.0, median_gap * 0.85)
    long_floor = max(short_floor * 2.1, high_quantile * 1.35)
    result: list[dict[str, Any]] = []
    for position in spoken_positions[:-1]:
        gap = float(evidence[position].get("silence_gap_after_ms", 0))
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


def _sentence_summary(
    tokens: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    pauses: list[dict[str, Any]],
    elongations: list[dict[str, Any]],
    start: int,
    end: int,
    order: int,
) -> dict[str, Any]:
    positions = [position for position in range(start, end + 1) if tokens[position]["char"] not in PUNCTUATION]
    indexes = [tokens[position]["index"] for position in positions]
    pitch = [evidence[position].get("normalized_pitch") for position in positions]
    smooth_pitch = rolling_median(pitch, radius=2)
    energy = [evidence[position].get("normalized_energy") for position in positions]
    durations = [evidence[position]["duration_ms"] for position in positions]
    start_ms = min((tokens[position]["start_ms"] for position in positions), default=tokens[start]["start_ms"])
    end_ms = max((tokens[position]["end_ms"] for position in positions), default=tokens[end]["end_ms"])
    duration_seconds = max((end_ms - start_ms) / 1000.0, 0.001)
    sentence_pauses = [item for item in pauses if start <= item["after_index"] <= end]
    sentence_elongations = [item for item in elongations if start <= item["token_index"] <= end]
    pitch_pool = [value for value in smooth_pitch if value is not None]
    energy_pool = [value for value in energy if value is not None]
    return {
        "id": f"sentence-{order}",
        "order": order,
        "text": "".join(token["char"] for token in tokens[start : end + 1]),
        "start_index": start,
        "end_index": end,
        "start_ms": int(start_ms),
        "end_ms": int(end_ms),
        "speaking_rate": round(len(positions) / duration_seconds, 3),
        "pause_summary": {
            "count": len(sentence_pauses),
            "items": sentence_pauses,
            "total_gap_ms": sum(item["gap_ms"] for item in sentence_pauses),
        },
        "duration_summary": {
            "local_median_ms": round(float(median(durations))) if durations else 0,
            "elongated_tokens": sentence_elongations,
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
