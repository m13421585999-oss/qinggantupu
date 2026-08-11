from __future__ import annotations

from statistics import median
from typing import Any


SEMANTIC_BOUNDARIES = set("，、；：。！？,.!?;:\n\r")


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _quantile(values: list[float], position: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    offset = (len(ordered) - 1) * _clamp(position, 0.0, 1.0)
    lower = int(offset)
    upper = min(len(ordered) - 1, lower + 1)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (offset - lower)


def _weighted_median(values: list[tuple[float, int]]) -> float:
    valid = sorted(
        ((value, weight) for value, weight in values if value > 0 and weight > 0),
        key=lambda item: item[0],
    )
    if not valid:
        return 0.0
    total = sum(weight for _, weight in valid)
    accumulated = 0
    for value, weight in valid:
        accumulated += weight
        if accumulated >= total / 2:
            return value
    return valid[-1][0]


def _pace_for_rate(rate: float) -> str:
    # General Mandarin delivery bands. Selection always uses the current
    # recording's aligned phrase durations, never its title or wording.
    if rate <= 2.8:
        return "slow"
    if rate <= 3.6:
        return "moderately_slow"
    if rate <= 4.8:
        return "medium"
    return "brisk"


def _expansion_for_ratio(ratio: float) -> str:
    if ratio < 0.82:
        return "compressed"
    if ratio < 1.18:
        return "baseline"
    if ratio < 1.55:
        return "expanded"
    return "strongly_expanded"


def _is_spoken(char: str) -> bool:
    return bool(char) and char.isalnum()


def _last_spoken_index(tokens: list[dict[str, Any]], start: int, end: int) -> int | None:
    for token in reversed(tokens):
        index = int(token["index"])
        if start <= index <= end and _is_spoken(str(token.get("char") or "")):
            return index
    return None


def derive_timing_profile(analysis_package: dict[str, Any]) -> dict[str, Any] | None:
    tokens = sorted(
        (
            token
            for token in analysis_package.get("tokens", [])
            if isinstance(token, dict)
            and isinstance(token.get("index"), int)
            and isinstance(token.get("char"), str)
        ),
        key=lambda token: int(token["index"]),
    )
    if not tokens:
        return None

    segments = [
        segment
        for segment in analysis_package.get("segments", analysis_package.get("sentences", []))
        if isinstance(segment, dict)
        and isinstance(segment.get("start_index"), int)
        and isinstance(segment.get("end_index"), int)
    ]
    if not segments:
        segments = [{
            "id": "sentence-1",
            "start_index": int(tokens[0]["index"]),
            "end_index": int(tokens[-1]["index"]),
        }]

    acoustic = analysis_package.get("acoustic_evidence")
    acoustic = acoustic if isinstance(acoustic, dict) else {}
    token_evidence = {
        int(item["token_index"]): item
        for item in acoustic.get("tokens", [])
        if isinstance(item, dict) and isinstance(item.get("token_index"), int)
    }

    pause_candidates: dict[int, dict[str, Any]] = {}

    def add_pause(
        after_index: int | None,
        gap_ms: Any,
        source_ref: str,
        level_hint: str | None = None,
    ) -> None:
        if after_index is None:
            return
        try:
            gap = float(gap_ms)
        except (TypeError, ValueError):
            return
        if gap <= 0:
            return
        existing = pause_candidates.get(after_index)
        if existing is None or gap > float(existing["gap_ms"]):
            pause_candidates[after_index] = {
                "gap_ms": gap,
                "source_control_ref": source_ref,
                "level_hint": level_hint or (existing or {}).get("level_hint"),
            }
        elif level_hint:
            existing["level_hint"] = level_hint

    for pause in acoustic.get("pauses", []):
        if not isinstance(pause, dict):
            continue
        after = pause.get("after_index")
        if not isinstance(after, int):
            continue
        add_pause(
            after,
            pause.get("gap_ms"),
            str(
                pause.get("source_control_ref")
                or f"analysis.acoustic_evidence.pauses.after-{after}"
            ),
            "paragraph" if pause.get("relative_level") == "long" else None,
        )

    previous_spoken: int | None = None
    for token in tokens:
        index = int(token["index"])
        char = str(token.get("char") or "")
        if char in SEMANTIC_BOUNDARIES and previous_spoken is not None:
            evidence = token_evidence.get(previous_spoken, {})
            add_pause(
                previous_spoken,
                evidence.get("silence_gap_after_ms"),
                f"analysis.acoustic_evidence.tokens.{previous_spoken}.silence_gap_after_ms",
            )
        if _is_spoken(char):
            previous_spoken = index

    for segment in segments[:-1]:
        after = _last_spoken_index(
            tokens,
            int(segment["start_index"]),
            int(segment["end_index"]),
        )
        if after is not None:
            add_pause(
                after,
                token_evidence.get(after, {}).get("silence_gap_after_ms"),
                f"analysis.segments.{segment.get('id', 'unknown')}.boundary_gap",
            )

    boundary_indexes = set(pause_candidates)
    previous_spoken = None
    for token in tokens:
        index = int(token["index"])
        char = str(token.get("char") or "")
        if char in SEMANTIC_BOUNDARIES and previous_spoken is not None:
            boundary_indexes.add(previous_spoken)
        if _is_spoken(char):
            previous_spoken = index
    for segment in segments:
        after = _last_spoken_index(
            tokens,
            int(segment["start_index"]),
            int(segment["end_index"]),
        )
        if after is not None:
            boundary_indexes.add(after)

    token_by_index = {int(token["index"]): token for token in tokens}
    phrases: list[dict[str, Any]] = []
    for segment in segments:
        spoken = [
            int(token["index"])
            for token in tokens
            if int(segment["start_index"]) <= int(token["index"]) <= int(segment["end_index"])
            and _is_spoken(str(token.get("char") or ""))
        ]
        phrase_start = 0
        for position, token_index in enumerate(spoken):
            if token_index not in boundary_indexes and position != len(spoken) - 1:
                continue
            phrase_indexes = spoken[phrase_start : position + 1]
            phrase_start = position + 1
            if not phrase_indexes:
                continue
            first = token_by_index[phrase_indexes[0]]
            last = token_by_index[phrase_indexes[-1]]
            elapsed_seconds = max(
                (float(last["end_ms"]) - float(first["start_ms"])) / 1000,
                0.001,
            )
            phrases.append({
                "sentence_id": str(segment.get("id") or ""),
                "start_index": phrase_indexes[0],
                "end_index": phrase_indexes[-1],
                "spoken_count": len(phrase_indexes),
                "speaking_rate_chars_per_sec": len(phrase_indexes) / elapsed_seconds,
            })

    global_rate = _weighted_median([
        (float(phrase["speaking_rate_chars_per_sec"]), int(phrase["spoken_count"]))
        for phrase in phrases
    ])
    if global_rate <= 0:
        return None

    quality = analysis_package.get("alignment_quality")
    quality = quality if isinstance(quality, dict) else {}
    coverage = quality.get("character_coverage", quality.get("coverage", 0.85))
    try:
        confidence = _clamp(float(coverage), 0.45, 0.99)
    except (TypeError, ValueError):
        confidence = 0.85

    global_pace = _pace_for_rate(global_rate)
    phrase_duration_profile = []
    for position, phrase in enumerate(phrases):
        rate = float(phrase["speaking_rate_chars_per_sec"])
        relative_expansion = global_rate / max(rate, 0.001)
        phrase_duration_profile.append({
            "sentence_id": phrase["sentence_id"],
            "start_index": phrase["start_index"],
            "end_index": phrase["end_index"],
            "speaking_rate_chars_per_sec": round(rate, 3),
            "relative_expansion": round(relative_expansion, 3),
            "expansion": _expansion_for_ratio(relative_expansion),
            "confidence": round(confidence, 3),
            "source_control_ref": f"analysis.timing_profile.phrase_duration_profile.{position}",
        })

    pause_values = [float(entry["gap_ms"]) for entry in pause_candidates.values()]
    pause_median = median(pause_values) if pause_values else 1.0
    marked_floor = _quantile(pause_values, 0.45)
    paragraph_floor = _quantile(pause_values, 0.82)
    pause_hierarchy = []
    for after_index, entry in sorted(pause_candidates.items()):
        gap = float(entry["gap_ms"])
        is_paragraph = entry.get("level_hint") == "paragraph" or (
            len(pause_values) >= 3
            and gap >= paragraph_floor
            and gap >= pause_median * 1.18
        )
        level = "paragraph" if is_paragraph else "marked" if gap >= marked_floor else "light"
        pause_hierarchy.append({
            "after_token_index": after_index,
            "level": level,
            "observed_gap_ms": round(gap),
            "relative_ratio": round(gap / max(pause_median, 1), 3),
            "confidence": round(confidence, 3),
            "source_control_ref": entry["source_control_ref"],
        })

    def phrase_for_token(token_index: int) -> dict[str, Any] | None:
        return next(
            (
                phrase
                for phrase in phrase_duration_profile
                if int(phrase["start_index"]) <= token_index <= int(phrase["end_index"])
            ),
            None,
        )

    prolongation_strength = []
    for entry in acoustic.get("duration_outliers", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("token_index"), int):
            continue
        token_index = int(entry["token_index"])
        try:
            ratio = float(entry.get("local_duration_ratio") or 0)
        except (TypeError, ValueError):
            continue
        if ratio <= 1:
            continue
        phrase = phrase_for_token(token_index)
        expansion = str((phrase or {}).get("expansion") or "baseline")
        try:
            item_confidence = _clamp(
                float(entry.get("confidence")), 0.45, 0.98
            )
        except (TypeError, ValueError):
            item_confidence = _clamp(0.58 + max(0.0, ratio - 1.45) / 1.5, 0.45, 0.98)

        clear_threshold = 1.75
        strong_threshold = 2.25
        if global_pace == "brisk":
            clear_threshold += 0.2
            strong_threshold += 0.35
        if expansion == "compressed":
            clear_threshold += 0.15
            strong_threshold += 0.25
        strength = (
            "strong"
            if ratio >= strong_threshold and item_confidence >= 0.8
            else "clear"
            if ratio >= clear_threshold and item_confidence >= 0.65
            else "subtle"
        )
        prolongation_strength.append({
            "token_index": token_index,
            "local_duration_ratio": round(ratio, 3),
            "strength": strength,
            "phrase_expansion": expansion,
            "confidence": round(item_confidence, 3),
            "source_control_ref": str(
                entry.get("source_control_ref")
                or f"analysis.acoustic_evidence.duration_outliers.token-{token_index}"
            ),
        })

    return {
        "source": "acoustic",
        "source_control_ref": "analysis.timing_profile",
        "global_pace": {
            "value": global_pace,
            "speaking_rate_chars_per_sec": round(global_rate, 3),
            "confidence": round(confidence, 3),
            "source_control_ref": "analysis.timing_profile.global_pace",
        },
        "pause_hierarchy": pause_hierarchy,
        "phrase_duration_profile": phrase_duration_profile,
        "prolongation_strength": prolongation_strength,
    }
