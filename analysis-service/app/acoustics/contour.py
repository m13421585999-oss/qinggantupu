from __future__ import annotations

import math
from statistics import median
from typing import Any, Iterable

import numpy as np


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
    return 12 * math.log2(value / median(pool))


def rounded(value: float | None) -> float | None:
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
    indexes: list[int],
    values: list[float | None],
    zones: int = 5,
    *,
    value_key: str = "normalized_pitch",
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
                value_key: round(float(np.mean(pool)), 3) if pool else None,
                "trend": trend_label(values[start:end]),
            }
        )
    return result


def _interpolate_missing(values: list[float | None]) -> list[float] | None:
    """Interpolate short unvoiced holes without inventing an absolute pitch level."""

    valid = [(index, float(value)) for index, value in enumerate(values) if value is not None]
    if not valid:
        return None
    positions = np.arange(len(values), dtype=float)
    known_positions = np.asarray([item[0] for item in valid], dtype=float)
    known_values = np.asarray([item[1] for item in valid], dtype=float)
    return [float(value) for value in np.interp(positions, known_positions, known_values)]


def continuous_macro_prosody_path(
    indexes: list[int],
    values: list[float | None],
) -> dict[str, Any]:
    """Build one height-continuous macro F0 path anchored to source token indexes.

    The path is deliberately less sensitive to lexical-tone spikes than the raw
    per-token F0 values, while retaining the first and final movements so an
    authentic sentence ending cannot disappear during smoothing.
    """

    if not indexes or len(indexes) != len(values):
        return {"points": [], "segments": []}
    interpolated = _interpolate_missing(values)
    if interpolated is None:
        return {"points": [], "segments": []}

    smoothed: list[float] = []
    for position, raw in enumerate(interpolated):
        window = interpolated[max(0, position - 2) : position + 3]
        local_center = float(median(window))
        raw_weight = 0.68 if position in {0, len(interpolated) - 1} else 0.32
        smoothed.append(raw * raw_weight + local_center * (1 - raw_weight))

    points = [
        {
            "token_index": index,
            "raw_normalized_pitch": rounded(values[position]),
            "normalized_level": round(smoothed[position], 3),
        }
        for position, index in enumerate(indexes)
    ]
    if len(points) == 1:
        return {
            "points": points,
            "segments": [
                {
                    "start_index": indexes[0],
                    "end_index": indexes[0],
                    "type": "level",
                    "start_level": points[0]["normalized_level"],
                    "end_level": points[0]["normalized_level"],
                    "confidence": 0.5,
                }
            ],
        }

    deltas = [smoothed[position + 1] - smoothed[position] for position in range(len(smoothed) - 1)]
    nonzero = [abs(value) for value in deltas if abs(value) > 0.02]
    adaptive = float(median(nonzero)) * 0.55 if nonzero else 0.22
    threshold = max(0.18, min(0.42, adaptive))
    labels = [
        "rising" if delta > threshold else "falling" if delta < -threshold else "level"
        for delta in deltas
    ]

    # A single flat edge between two movements in the same direction is usually
    # a smoothing plateau, not a new teaching event.
    for position in range(1, len(labels) - 1):
        if labels[position] == "level" and labels[position - 1] == labels[position + 1] != "level":
            labels[position] = labels[position - 1]

    runs: list[tuple[int, int, str]] = []
    run_start = 0
    for position in range(1, len(labels) + 1):
        if position == len(labels) or labels[position] != labels[run_start]:
            runs.append((run_start, position - 1, labels[run_start]))
            run_start = position

    segments = []
    for start_edge, end_edge, kind in runs:
        start_level = smoothed[start_edge]
        end_level = smoothed[end_edge + 1]
        movement = abs(end_level - start_level)
        confidence = 0.55 if kind == "level" else min(0.96, 0.58 + movement / 4)
        segments.append(
            {
                "start_index": indexes[start_edge],
                "end_index": indexes[end_edge + 1],
                "type": kind,
                "start_level": round(start_level, 3),
                "end_level": round(end_level, 3),
                "confidence": round(confidence, 3),
            }
        )
    return {"points": points, "segments": segments}
