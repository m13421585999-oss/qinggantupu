from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.schemas.control_spec import Prosody, Span

# The visual teaching curve uses 9 levels (0..8). Automatic generation only
# uses 1..7; 0 and 8 are reserved for human extremes.
MIN_AUTO_LEVEL = 1
MAX_AUTO_LEVEL = 7
BASE_LEVEL = 4

# strength -> required visible amplitude in levels. Every non-flat event must
# move by at least 3 levels, matching the acceptance criteria.
STRENGTH_AMPLITUDE = {1: 3, 2: 4, 3: 5}


@dataclass(frozen=True)
class CompiledProsody:
    points: list[dict[str, Any]]
    segments: list[dict[str, Any]]


def _clamp(value: float) -> int:
    return int(round(max(MIN_AUTO_LEVEL, min(MAX_AUTO_LEVEL, value))))


def _interpolate_levels(
    levels: dict[int, int],
    anchors: list[tuple[int, int]],
) -> None:
    """Fill a token range with a piecewise-linear, integer-quantized level."""
    if not anchors:
        return
    anchors = sorted(set(anchors), key=lambda pair: pair[0])
    for index in range(anchors[0][0], anchors[-1][0] + 1):
        if index < anchors[0][0] or index > anchors[-1][0]:
            continue
        left = anchors[0]
        right = anchors[-1]
        for anchor in anchors:
            if anchor[0] <= index:
                left = anchor
            if anchor[0] >= index:
                right = anchor
                break
        if left[0] == right[0]:
            levels[index] = left[1]
            continue
        progress = (index - left[0]) / (right[0] - left[0])
        levels[index] = _clamp(left[1] + (right[1] - left[1]) * progress)


def _resolve_curve(event: Prosody, start_level: int) -> tuple[int, int, int]:
    """Return (start_level, peak_or_trough_level, end_level) for one event."""
    amplitude = STRENGTH_AMPLITUDE[event.strength]
    typ = event.type

    if typ == "rising":
        high = start_level + amplitude
        if high > MAX_AUTO_LEVEL:
            start_level = MAX_AUTO_LEVEL - amplitude
            high = MAX_AUTO_LEVEL
        start_level = max(MIN_AUTO_LEVEL, start_level)
        high = min(MAX_AUTO_LEVEL, high)
        return start_level, high, high

    if typ == "falling":
        low = start_level - amplitude
        if low < MIN_AUTO_LEVEL:
            start_level = MIN_AUTO_LEVEL + amplitude
            low = MIN_AUTO_LEVEL
        start_level = min(MAX_AUTO_LEVEL, start_level)
        low = max(MIN_AUTO_LEVEL, low)
        return start_level, low, low

    if typ == "peak":
        low = start_level
        high = low + amplitude
        if high > MAX_AUTO_LEVEL:
            low = MAX_AUTO_LEVEL - amplitude
            high = MAX_AUTO_LEVEL
        low = max(MIN_AUTO_LEVEL, low)
        high = min(MAX_AUTO_LEVEL, high)
        return low, high, low

    # valley
    high = start_level
    low = high - amplitude
    if low < MIN_AUTO_LEVEL:
        high = MIN_AUTO_LEVEL + amplitude
        low = MIN_AUTO_LEVEL
    high = min(MAX_AUTO_LEVEL, high)
    low = max(MIN_AUTO_LEVEL, low)
    return high, low, high


def _event_anchors(event: Prosody, start_level: int) -> list[tuple[int, int]]:
    """Anchor points (token_index -> level) describing one event's contour."""
    start, end = event.active_span.start, event.active_span.end
    core_start, core_end = event.core_zone.start, event.core_zone.end
    start_level, peak_level, end_level = _resolve_curve(event, start_level)
    typ = event.type

    if typ == "rising":
        return [
            (start, start_level),
            (core_start, start_level),
            (core_end, peak_level),
            (end, end_level),
        ]
    if typ == "falling":
        return [
            (start, start_level),
            (core_start, start_level),
            (core_end, peak_level),
            (end, end_level),
        ]
    if typ == "peak":
        return [
            (start, start_level),
            (core_start, peak_level),
            (core_end, peak_level),
            (end, end_level),
        ]
    # valley
    return [
        (start, start_level),
        (core_start, peak_level),
        (core_end, peak_level),
        (end, end_level),
    ]


def normalize_events(events: list[Prosody]) -> list[Prosody]:
    """Sort, deduplicate and merge adjacent same-type events.

    Enforces the two-event-per-sentence cap upstream; here we only guarantee a
    clean, non-overlapping, index-ordered sequence for the compiler.
    """
    if not events:
        return []
    ordered = sorted(events, key=lambda event: (event.active_span.start, event.active_span.end))
    normalized: list[Prosody] = []
    for event in ordered:
        if not normalized:
            normalized.append(event)
            continue
        previous = normalized[-1]
        if (
            previous.type == event.type
            and event.active_span.start <= previous.active_span.end
        ):
            merged = Prosody(
                type=previous.type,
                active_span=Span(
                    start=previous.active_span.start,
                    end=max(previous.active_span.end, event.active_span.end),
                ),
                core_zone=Span(
                    start=min(previous.core_zone.start, event.core_zone.start),
                    end=max(previous.core_zone.end, event.core_zone.end),
                ),
                strength=max(previous.strength, event.strength),
                confidence=max(previous.confidence, event.confidence),
            )
            normalized[-1] = merged
            continue
        normalized.append(event)
    return normalized


def compile_sentence_prosody(
    min_index: int,
    max_index: int,
    events: list[Prosody],
    base_level: int = BASE_LEVEL,
) -> CompiledProsody:
    """Compile teaching prosody events into a 9-level monotone curve.

    Outside every active span the curve stays flat at the carried level so two
    connected events inherit each other's ending height instead of jumping.
    """
    levels: dict[int, int] = {
        index: base_level for index in range(min_index, max_index + 1)
    }
    segments: list[dict[str, Any]] = []
    carried = base_level

    for event in normalize_events(events):
        start, end = event.active_span.start, event.active_span.end
        start_level, _peak, end_level = _resolve_curve(event, carried)
        anchors = _event_anchors(event, carried)
        _interpolate_levels(levels, anchors)
        segment_type = "level"
        if event.type in {"rising", "peak"}:
            segment_type = "rising"
        elif event.type in {"falling", "valley"}:
            segment_type = "falling"
        segments.append(
            {
                "start_index": start,
                "end_index": end,
                "type": segment_type,
                "start_level": start_level,
                "end_level": end_level,
                "confidence": event.confidence,
            }
        )
        carried = end_level

    points = [
        {"token_index": index, "normalized_level": levels[index]}
        for index in range(min_index, max_index + 1)
    ]
    return CompiledProsody(points=points, segments=segments)
