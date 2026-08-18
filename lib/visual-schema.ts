export type VisualAssetKind = "hero" | "scene";
export type VisualGenerationStatus =
  | "pending_generation"
  | "generating"
  | "ready"
  | "needs_review"
  | "failed";

export interface WorkVisualProfile {
  visual_style: string;
  palette: string[];
  texture: string;
  lighting: string;
  atmosphere: string;
  composition_language: string;
  /** Deprecated persisted alias accepted during rolling upgrades. */
  composition_rule?: string;
  human_presence: string;
  symbolic_language: string[];
  /** Deprecated persisted alias accepted during rolling upgrades. */
  symbolic_elements?: string[];
  avoid: string[];
}

export interface HeroVisualSpec {
  type: "hero";
  size: { width: 1500; height: 280 };
  required_text: string[];
  text_layout: string;
  visual_subject: string;
  composition: string;
  lighting: string;
  palette: string[];
  image_prompt: string;
  negative_prompt: string;
}

export interface SceneVisualSpec {
  scene_id: string;
  source_sentence_ids: string[];
  source_text: string;
  narrative_function: string;
  visual_type:
    | "literal_scene"
    | "symbolic_scene"
    | "abstract_scene"
    | "environment"
    | "minimal";
  scene_meaning: string;
  main_subject: string;
  environment: string;
  emotion: string[];
  symbolism: string[];
  composition: string;
  camera_distance: string;
  lighting: string;
  palette: string[];
  image_prompt: string;
  negative_prompt: string;
}

export interface SceneUnit {
  scene_id: string;
  source_sentence_ids: string[];
  source_text: string;
  previous_text?: string;
  next_text?: string;
  position: number;
}

export interface VisualDirectorInput {
  title: string;
  author: string;
  full_text: string;
  genre: string;
  control_spec_summary: Record<string, unknown>;
  scene_units: SceneUnit[];
  locked_profile?: WorkVisualProfile;
}

export interface VisualDirectorOutput {
  work_visual_profile: WorkVisualProfile;
  hero_visual_spec: HeroVisualSpec;
  scene_visual_specs: SceneVisualSpec[];
  /** Transport metadata returned by the Visual Director service. */
  _meta?: {
    provider?: string;
    model?: string;
    endpoint?: string;
    output_mode?: string;
    request_count?: number;
  };
}

export type SceneGroupingVersion = "legacy_v1" | "semantic_v2";

/** Terminators that close a semantic sentence for SceneUnit grouping. */
const SCENE_GROUP_TERMINATORS = /[。！？；]/u;
/** Max chars (excluding punctuation) per line to still count as verse-like. */
const VERSE_MAX_LINE_CHARS = 12;
const VERSE_MIN_LINES = 4;
/**
 * Min fraction of lines ending with a full terminator (。！？；) for the text
 * to be treated as verse. Verse lines are self-contained sentences; prose
 * wrapped at <=9 chars mostly ends lines with commas or no punctuation.
 */
const VERSE_MIN_TERMINATOR_FRACTION = 0.5;

function lineWithoutPunctuation(text: string) {
  return Array.from(text.replace(/[。，！？；、：…—～“”‘’（）《》〈〉「」『』]/gu, "")).length;
}

/** Strip trailing right-closing quotes/brackets before checking line end. */
function trimClosingMarkers(text: string) {
  return text.replace(/[”’』」）》】]+$/u, "");
}

function endsWithTerminator(text: string) {
  const trimmed = trimClosingMarkers(text.trim());
  return trimmed.length > 0 && SCENE_GROUP_TERMINATORS.test(trimmed.charAt(trimmed.length - 1));
}

/**
 * Conservative verse-like detection. Ancient poetry, ci and other verse are
 * made of short lines that are themselves complete sentences — most lines end
 * with a full terminator (。！？；). Prose wrapped at <=9 chars per line mostly
 * ends lines with a comma or nothing. When the terminator density is high we
 * keep one Scene per line so distinct imagery is never fused; otherwise we
 * merge wrapped rows into shared SceneUnits.
 */
export function isVerseLikeRows(
  rows: Array<{ text: string }>,
  opts: {
    minLines?: number;
    maxLineChars?: number;
    minTerminatorFraction?: number;
  } = {},
) {
  const minLines = opts.minLines ?? VERSE_MIN_LINES;
  const maxLineChars = opts.maxLineChars ?? VERSE_MAX_LINE_CHARS;
  const minTerminatorFraction = opts.minTerminatorFraction ?? VERSE_MIN_TERMINATOR_FRACTION;
  if (rows.length < minLines) return false;
  let terminators = 0;
  let long = 0;
  for (const row of rows) {
    if (endsWithTerminator(row.text)) terminators += 1;
    if (lineWithoutPunctuation(row.text) > maxLineChars) long += 1;
  }
  // A single long line (e.g. one row merged two verse lines) is tolerated,
  // but several long rows mean the text is prose-style line-wrapped.
  const longTolerated = long <= 1 || long / rows.length <= 0.2;
  return terminators / rows.length >= minTerminatorFraction && longTolerated;
}

export function buildSceneUnits(
  fullText: string,
  controlSpec?: Record<string, unknown>,
  sceneGroupingVersion: SceneGroupingVersion = "legacy_v1",
): SceneUnit[] {
  const chars = Array.from(fullText);
  const sentences = Array.isArray(controlSpec?.sentences)
    ? controlSpec.sentences as Array<Record<string, unknown>>
    : [];
  let searchFrom = 0;
  const sentenceRanges = sentences.map((sentence, index) => {
    const text = String(sentence.text ?? "");
    const explicitStart = Number(sentence.startIndex ?? sentence.start_index);
    const explicitEnd = Number(sentence.endIndex ?? sentence.end_index);
    let sentenceStart = Number.isInteger(explicitStart) ? explicitStart : -1;
    let sentenceEnd = Number.isInteger(explicitEnd) ? explicitEnd : -1;
    if (sentenceStart < 0 || sentenceEnd < sentenceStart) {
      sentenceStart = fullText.indexOf(text, searchFrom);
      sentenceEnd = sentenceStart >= 0 ? sentenceStart + Array.from(text).length - 1 : -1;
    }
    if (sentenceEnd >= 0) searchFrom = sentenceEnd + 1;
    return {
      id: String(sentence.id ?? `sentence-${index + 1}`),
      start: sentenceStart,
      end: sentenceEnd,
      text,
    };
  });

  if (sentenceRanges.length) {
    // semantic_v2: multiple manuscript Sentence Rows may share one Scene
    // (one Scene Card image) when they are pieces of one full semantic
    // sentence that was line-wrapped at <=9 chars. Sentence Rows themselves
    // are never merged — only the SceneUnit mapping. Verse texts are kept
    // fine-grained so distinct imagery is never fused.
    if (sceneGroupingVersion === "semantic_v2") {
      const units = buildSemanticV2Units(fullText, sentenceRanges);
      if (units.length) return units;
    }
    // legacy_v1 (and semantic_v2 fallback): one Scene unit per manuscript row.
    // Each non-empty line is its own Sentence = Scene = one Scene Card image.
    // Blank lines only separate paragraphs and never produce a scene.
    return sentenceRanges.map((sentence, index) => ({
      scene_id: `scene-${index + 1}`,
      source_sentence_ids: [sentence.id],
      source_text: sentence.text,
      previous_text: index > 0 ? sentenceRanges[index - 1].text : undefined,
      next_text: index + 1 < sentenceRanges.length ? sentenceRanges[index + 1].text : undefined,
      position: index,
    }));
  }

  // Fallback: no parsed control spec — split the raw text on terminal
  // punctuation so a standalone planning flow still yields one unit per
  // completed sentence (never empty blank-line scenes).
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (!/[。！？]/u.test(chars[index])) continue;
    let end = index;
    while (end + 1 < chars.length && /[”’」』）》】]/u.test(chars[end + 1])) end += 1;
    const text = chars.slice(start, end + 1).join("");
    if (text.trim()) ranges.push({ start, end, text });
    start = end + 1;
    index = end;
  }
  if (start < chars.length) {
    const text = chars.slice(start).join("");
    if (text.trim()) ranges.push({ start, end: chars.length - 1, text });
  }
  if (!ranges.length && fullText.trim()) ranges.push({ start: 0, end: chars.length - 1, text: fullText });

  return ranges.map((range, index) => ({
    scene_id: `scene-${index + 1}`,
    source_sentence_ids: sentenceRanges
      .filter((sentence) => sentence.start <= range.end && sentence.end >= range.start)
      .map((sentence) => sentence.id),
    source_text: range.text,
    previous_text: index > 0 ? ranges[index - 1].text : undefined,
    next_text: index + 1 < ranges.length ? ranges[index + 1].text : undefined,
    position: index,
  }));
}

interface SentenceRange {
  id: string;
  start: number;
  end: number;
  text: string;
}

/**
 * semantic_v2 deterministic grouping. No extra LLM call.
 *
 * Start from the current Sentence Row and keep aggregating consecutive rows
 * into one SceneUnit until the full semantic sentence ends. The following
 * terminators close a SceneUnit: 。！？；
 * A paragraph / blank-line boundary always force-closes as well.
 *
 * Verse (ancient poetry/ci/verse) is handled conservatively: when the rows
 * themselves look like independent verse lines, each row keeps its own Scene
 * so distinct imagery is never fused. Rows are only merged for prose-style
 * line-wrapped text (e.g. modern poetry wrapped at <=9 chars per line).
 */
export function buildSemanticV2Units(
  fullText: string,
  rows: SentenceRange[],
): SceneUnit[] {
  if (!rows.length) return [];

  // Verse-like texts keep fine-grained scenes (1 row = 1 scene).
  if (isVerseLikeRows(rows)) {
    return rows.map((sentence, index) => ({
      scene_id: `scene-${index + 1}`,
      source_sentence_ids: [sentence.id],
      source_text: sentence.text,
      previous_text: index > 0 ? rows[index - 1].text : undefined,
      next_text: index + 1 < rows.length ? rows[index + 1].text : undefined,
      position: index,
    }));
  }

  // Prose-style: group consecutive rows until a terminator or paragraph gap.
  const units: SceneUnit[] = [];
  let group: SentenceRange[] = [];

  const flushGroup = () => {
    if (!group.length) return;
    const ids = group.map((sentence) => sentence.id);
    // Rebuild source_text without the hard line-wrap: join the wrapped pieces
    // with a space, keeping the original punctuation inside each piece.
    const joined = group.map((sentence) => sentence.text.trim()).join(" ");
    const previousText = units.length > 0
      ? units[units.length - 1].source_text
      : undefined;
    units.push({
      scene_id: `scene-${units.length + 1}`,
      source_sentence_ids: ids,
      source_text: joined,
      previous_text: previousText,
      next_text: undefined, // patched after the pass
      position: units.length,
    });
    group = [];
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    group.push(row);
    const isLast = index === rows.length - 1;
    const next = isLast ? undefined : rows[index + 1];

    // Paragraph boundary: any blank line between this row and the next
    // forces the SceneUnit to close (next row starts a new unit).
    const hasParagraphGap = !isLast
      && row.end >= 0
      && next !== undefined
      && next.start >= 0
      && /\n\s*\n/u.test(fullText.slice(row.end + 1, next.start));

    // A row that itself ends with a terminator closes the unit.
    const closes = endsWithTerminator(row.text);

    if (isLast || hasParagraphGap || closes) flushGroup();
  }

  // Patch next_text now that all units are known.
  for (let index = 0; index < units.length; index += 1) {
    if (index + 1 < units.length) {
      units[index] = { ...units[index], next_text: units[index + 1].source_text };
    }
  }
  return units;
}

export function summarizeControlSpec(controlSpec?: Record<string, unknown>) {
  const sentences = Array.isArray(controlSpec?.sentences)
    ? controlSpec.sentences as Array<Record<string, unknown>>
    : [];
  return {
    performance_profile: controlSpec?.performanceProfile ?? controlSpec?.performance_profile ?? null,
    timing_profile: controlSpec?.timingProfile ?? controlSpec?.timing_profile ?? null,
    sentences: sentences.map((sentence) => ({
      id: sentence.id,
      text: sentence.text,
      rhythm: sentence.rhythm,
      emotional_interpretation:
        sentence.emotionalInterpretation ?? sentence.emotional_interpretation,
    })),
  };
}
