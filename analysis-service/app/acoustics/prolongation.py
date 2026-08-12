from __future__ import annotations

from typing import Any, Iterable


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _focus_indexes(focus: Iterable[dict[str, Any]]) -> set[int]:
    indexes: set[int] = set()
    for item in focus:
        span = item.get("focus_span")
        if not isinstance(span, dict):
            continue
        try:
            start = int(span["start"])
            end = int(span["end"])
            confidence = float(item.get("confidence") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if confidence < 0.65 or end < start:
            continue
        indexes.update(range(start, end + 1))
    return indexes


def assess_prolongation_candidate(
    candidate: dict[str, Any],
    *,
    focus_indexes: set[int] | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Turn a broad duration anomaly into a conservative teaching decision."""
    index = int(candidate["token_index"])
    effective_ratio = _number(candidate.get("effective_voiced_duration_ratio"))
    alignment_ratio = _number(candidate.get("local_duration_ratio"), 1.0)
    continuity = _number(candidate.get("voiced_continuity_ratio"))
    effective_ms = _number(candidate.get("effective_voiced_duration_ms"))
    alignment_ms = max(
        _number(candidate.get("alignment_duration_ms", candidate.get("duration_ms"))),
        1.0,
    )
    low_energy_tail_ms = max(_number(candidate.get("low_energy_tail_ms")), 0.0)
    low_energy_tail_ratio = _number(
        candidate.get("low_energy_tail_ratio"), low_energy_tail_ms / alignment_ms
    )
    pause_after_ms = max(_number(candidate.get("pause_after_ms")), 0.0)
    boundary_type = str(candidate.get("boundary_type") or "none")
    is_focus = index in (focus_indexes or set())
    required_ratio = {
        "none": 1.85,
        "phrase_end": 2.10,
        "sentence_end": 2.30,
    }.get(boundary_type, 1.85)

    rejection_reasons: list[str] = []
    if effective_ratio < required_ratio:
        rejection_reasons.append(
            "normal_boundary_lengthening"
            if boundary_type != "none"
            else "insufficient_effective_voiced_extension"
        )
    if continuity < 0.72:
        rejection_reasons.append("insufficient_voiced_continuity")
    if low_energy_tail_ratio >= 0.60:
        rejection_reasons.append("alignment_window_is_mostly_low_energy_tail")
    elif low_energy_tail_ratio >= 0.45 and effective_ratio < required_ratio + 0.65:
        rejection_reasons.append("duration_outlier_is_pause_dominant")
    if effective_ms <= 0:
        rejection_reasons.append("no_effective_voiced_duration")

    margin = max(0.0, effective_ratio - required_ratio)
    confidence = _clamp(
        0.64
        + min(0.20, margin * 0.24)
        + max(0.0, min(0.10, (continuity - 0.72) * 0.36))
        + (0.02 if is_focus else 0.0)
        - min(0.12, low_energy_tail_ratio * 0.18),
        0.2,
        0.98,
    )
    if confidence < 0.68:
        rejection_reasons.append("low_perceptual_confidence")
    audit = {
        **candidate,
        "required_effective_voiced_ratio": round(required_ratio, 3),
        "focus_context": is_focus,
        "decision": "rejected" if rejection_reasons else "confirmed",
        "decision_reasons": rejection_reasons or ["clear_sustained_voiced_extension"],
        "confidence": round(confidence, 3),
    }
    if rejection_reasons:
        return None, audit

    degree = 1 if effective_ratio < 2.20 else 2 if effective_ratio < 2.80 else 3
    confirmed = {
        "token_index": index,
        "char": candidate.get("char"),
        "source_control_ref": f"analysis.acoustic_evidence.prolongations.token-{index}",
        "degree": degree,
        "duration_ms": round(alignment_ms),
        "alignment_duration_ms": round(alignment_ms),
        "alignment_local_duration_ratio": round(alignment_ratio, 3),
        "effective_voiced_duration_ms": round(effective_ms),
        "effective_voiced_duration_ratio": round(effective_ratio, 3),
        # Compatibility field now intentionally carries the confirmed metric.
        "local_duration_ratio": round(effective_ratio, 3),
        "voiced_continuity_ratio": round(continuity, 3),
        "low_energy_tail_ms": round(low_energy_tail_ms),
        "pause_after_ms": round(pause_after_ms),
        "boundary_type": boundary_type,
        "focus_context": is_focus,
        "source": "acoustic",
        "confidence": round(confidence, 3),
    }
    return confirmed, audit


def classify_prolongation_candidates(
    candidates: Iterable[dict[str, Any]],
    *,
    focus: Iterable[dict[str, Any]],
    start: int,
    end: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    focus_indexes = _focus_indexes(focus)
    confirmed: list[dict[str, Any]] = []
    audited: list[dict[str, Any]] = []
    for candidate in candidates:
        try:
            index = int(candidate["token_index"])
        except (KeyError, TypeError, ValueError):
            continue
        if index < start or index > end:
            continue
        mark, audit = assess_prolongation_candidate(
            candidate, focus_indexes=focus_indexes
        )
        audited.append(audit)
        if mark is not None:
            confirmed.append(mark)
    return confirmed, audited
