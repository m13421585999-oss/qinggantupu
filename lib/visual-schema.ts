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

export function buildSceneUnits(
  fullText: string,
  controlSpec?: Record<string, unknown>,
): SceneUnit[] {
  const chars = Array.from(fullText);
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
    };
  });

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
