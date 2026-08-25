import type { RecitationSentence } from "./recitation-schema";

export const COMPACT_LEGEND_OPTIONS = [
  { id: "breath-major", label: "换气" },
  { id: "breath-minor", label: "偷气" },
  { id: "pause-short", label: "短停" },
  { id: "pause-long", label: "长停" },
  { id: "focus", label: "重音" },
  { id: "prosody-curve", label: "语势曲线" },
  { id: "intonation-rising", label: "上扬" },
  { id: "intonation-falling", label: "下降" },
  { id: "prolong", label: "拖音" },
  { id: "staccato", label: "一字一顿" },
  { id: "real-scene", label: "实景" },
  { id: "virtual-scene", label: "虚景" },
  { id: "virtual-voice", label: "虚声" },
  { id: "distant-view", label: "远景" },
  { id: "close-view", label: "近景" },
] as const;

export type CompactLegendItemId = typeof COMPACT_LEGEND_OPTIONS[number]["id"];

export const COMPACT_LEGEND_ITEM_IDS = COMPACT_LEGEND_OPTIONS.map(
  (option) => option.id,
) as CompactLegendItemId[];

/** Existing works keep their established six-item footer until the creator opts in. */
export const DEFAULT_COMPACT_LEGEND_ITEMS: CompactLegendItemId[] = [
  "breath-major",
  "breath-minor",
  "pause-short",
  "pause-long",
  "focus",
  "prosody-curve",
];

export function isCompactLegendItemId(value: unknown): value is CompactLegendItemId {
  return typeof value === "string"
    && COMPACT_LEGEND_ITEM_IDS.includes(value as CompactLegendItemId);
}

export function normalizeCompactLegendItems(value: unknown): CompactLegendItemId[] {
  if (!Array.isArray(value)) return [...DEFAULT_COMPACT_LEGEND_ITEMS];
  const selected = new Set(value.filter(isCompactLegendItemId));
  return COMPACT_LEGEND_ITEM_IDS.filter((id) => selected.has(id));
}

/** The footer is evidence-driven: only cues actually rendered in this work appear. */
export function usedCompactLegendItems(
  sentences: readonly RecitationSentence[],
  options: { showProsodyCurve?: boolean } = {},
) {
  const used = new Set<CompactLegendItemId>();
  if (options.showProsodyCurve !== false && sentences.length) used.add("prosody-curve");

  for (const sentence of sentences) {
    const focusIndexes = new Set(sentence.focus.flatMap((target) => target.tokenIndexes));
    const shortPauseIndexes = new Set(sentence.pauses.flatMap((pause) => (
      pause.type === "short" ? [pause.afterTokenIndex] : []
    )));

    if (focusIndexes.size) used.add("focus");
    if ([...focusIndexes].some((tokenIndex) => shortPauseIndexes.has(tokenIndex))) used.add("staccato");
    sentence.pauses.forEach((pause) => used.add(pause.type === "long" ? "pause-long" : "pause-short"));
    sentence.breaths?.forEach((breath) => used.add(
      breath.type === "breath_major" ? "breath-major" : "breath-minor",
    ));
    if (sentence.prolongations.length) used.add("prolong");
    if (sentence.endingIntonation.type === "rising") used.add("intonation-rising");
    if (sentence.endingIntonation.type === "falling") used.add("intonation-falling");
    sentence.sceneTechniqueMarks?.forEach((mark) => used.add(
      mark.type === "real" ? "real-scene" : "virtual-scene",
    ));
    sentence.deliveryTechniqueMarks?.forEach((mark) => {
      if (mark.type === "virtual_voice") used.add("virtual-voice");
      if (mark.type === "distant_view") used.add("distant-view");
      if (mark.type === "close_view") used.add("close-view");
    });
  }

  return COMPACT_LEGEND_ITEM_IDS.filter((id) => used.has(id));
}
