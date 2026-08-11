export const SENTENCE_PRE_ROLL_MS = 180;
export const SENTENCE_TAIL_PADDING_MS = 120;

export interface SentencePlaybackTiming {
  startMs: number;
  endMs: number;
}

export function sentencePlaybackWindow(
  timing: SentencePlaybackTiming,
  trackDurationMs?: number,
) {
  const startMs = Math.max(0, timing.startMs - SENTENCE_PRE_ROLL_MS);
  const requestedEndMs = timing.endMs + SENTENCE_TAIL_PADDING_MS;
  const durationLimit = Number.isFinite(trackDurationMs) && Number(trackDurationMs) > 0
    ? Number(trackDurationMs)
    : requestedEndMs;
  const endMs = Math.max(startMs, Math.min(requestedEndMs, durationLimit));
  return { startMs, endMs };
}
