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
