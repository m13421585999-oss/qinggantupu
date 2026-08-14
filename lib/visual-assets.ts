export type VisualAssetKind = "hero" | "scene";

export type VisualGenerationStatus =
  | "draft"
  | "pending_generation"
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "needs_review";

export type TextValidationStatus =
  | "not_required"
  | "not_run"
  | "pending"
  | "pending_manual_review"
  | "human_approved"
  | "matched"
  | "mismatch"
  | "failed";

export interface WorkVisualProfile {
  visualStyle: string;
  palette: string[];
  texture: string;
  lighting: string;
  atmosphere: string;
  compositionRule: string;
  humanPresence: string;
  symbolicElements: string[];
  avoid: string[];
  directorEndpoint?: string;
  isLocked?: boolean;
  version?: number;
}

export interface HeroVisualSpec {
  type: "hero";
  size: { width: number; height: number };
  requiredText: string[];
  textLayout: string;
  visualSubject: string;
  composition: string;
  lighting: string;
  palette: string[];
  imagePrompt: string;
  negativePrompt: string;
  version?: number;
}

export type SceneVisualType =
  | "literal_scene"
  | "symbolic_scene"
  | "abstract_scene"
  | "environment"
  | "minimal";

export interface SceneVisualSpec {
  sceneId: string;
  sourceSentenceIds: string[];
  sourceText: string;
  narrativeFunction: string;
  visualType: SceneVisualType;
  sceneSummary: string;
  mainSubject: string;
  environment: string;
  emotion: string[];
  symbolism: string[];
  composition: string;
  cameraDistance: string;
  lighting: string;
  palette: string[];
  imagePrompt: string;
  negativePrompt: string;
  version?: number;
}

export interface VisualAsset {
  id: string;
  workId: string;
  kind: VisualAssetKind;
  sceneId?: string;
  /** Missing for failed or not-yet-generated metadata records. */
  url?: string;
  provider: string;
  model: string;
  endpoint?: string;
  status: VisualGenerationStatus;
  isVisible: boolean;
  isActive: boolean;
  version: number;
  width: number;
  height: number;
  prompt?: string;
  negativePrompt?: string;
  textValidationStatus?: TextValidationStatus;
  textValidationMessage?: string;
  createdAt: string;
}

export interface VisualProviderStatus {
  configured: boolean;
  provider?: string;
  model?: string;
  message?: string;
}

export interface WorkVisualBundle {
  profile?: WorkVisualProfile;
  heroSpec?: HeroVisualSpec;
  sceneSpecs: SceneVisualSpec[];
  assets: VisualAsset[];
  /** Active assets selected for the viewer. Published payloads contain only reviewed ready assets. */
  heroAsset?: VisualAsset;
  sceneAssets?: VisualAsset[];
  provider?: VisualProviderStatus;
}

export interface VisualSentenceReference {
  id: string;
  text: string;
}

type VisualResponse = { visuals: WorkVisualBundle } | WorkVisualBundle;

interface VisualGenerationResponse {
  visuals: WorkVisualBundle;
  visual_job_id?: string;
  status?: string;
  progress?: number;
  failures?: Array<{ specId?: string; sceneId?: string; message?: string }>;
  error?: { code?: string; message?: string };
}

function isVisualEnvelope(value: VisualResponse): value is { visuals: WorkVisualBundle } {
  return "visuals" in value;
}

async function visualJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error && typeof payload.error === "object"
      ? payload.error as Record<string, unknown>
      : {};
    throw new Error(String(error.message ?? payload.message ?? `请求失败（HTTP ${response.status}）`));
  }
  return payload as T;
}

function unwrapVisuals(payload: VisualResponse): WorkVisualBundle {
  const visuals = isVisualEnvelope(payload) ? payload.visuals : payload;
  const rawProfile = visuals.profile as WorkVisualProfile & Record<string, unknown> | undefined;
  const rawHero = visuals.heroSpec as HeroVisualSpec & Record<string, unknown> | undefined;
  const rawScenes = (visuals.sceneSpecs ?? []) as Array<SceneVisualSpec & Record<string, unknown>>;
  const normalizeAsset = (
    asset: VisualAsset & Record<string, unknown>,
  ): VisualAsset => ({
    ...asset,
    workId: String(asset.workId ?? asset.work_id ?? ""),
    sceneId: asset.sceneId == null && asset.scene_id == null
      ? undefined
      : String(asset.sceneId ?? asset.scene_id),
    url: typeof asset.url === "string" && asset.url ? asset.url : undefined,
    negativePrompt: asset.negativePrompt == null && asset.negative_prompt == null
      ? undefined
      : String(asset.negativePrompt ?? asset.negative_prompt),
    textValidationStatus: (asset.textValidationStatus ?? asset.text_validation_status) as
      | TextValidationStatus
      | undefined,
    textValidationMessage: asset.textValidationMessage == null && asset.text_validation_message == null
      ? undefined
      : String(asset.textValidationMessage ?? asset.text_validation_message),
    isVisible: Boolean(asset.isVisible ?? asset.is_visible),
    isActive: Boolean(asset.isActive ?? asset.is_active),
    createdAt: String(asset.createdAt ?? asset.created_at ?? ""),
  });
  const assets = ((visuals.assets ?? []) as Array<VisualAsset & Record<string, unknown>>)
    .map(normalizeAsset);
  const explicitHero = visuals.heroAsset as VisualAsset & Record<string, unknown> | undefined;
  const explicitScenes = (visuals.sceneAssets ?? []) as Array<VisualAsset & Record<string, unknown>>;
  return {
    ...visuals,
    profile: rawProfile ? {
      ...rawProfile,
      visualStyle: String(rawProfile.visualStyle ?? rawProfile.visual_style ?? ""),
      compositionRule: String(
        rawProfile.compositionRule
        ?? rawProfile.composition_language
        ?? rawProfile.composition_rule
        ?? "",
      ),
      humanPresence: String(rawProfile.humanPresence ?? rawProfile.human_presence ?? ""),
      symbolicElements: (
        rawProfile.symbolicElements
        ?? rawProfile.symbolic_language
        ?? rawProfile.symbolic_elements
        ?? []
      ) as string[],
    } : undefined,
    heroSpec: rawHero ? {
      ...rawHero,
      requiredText: (rawHero.requiredText ?? rawHero.required_text ?? []) as string[],
      textLayout: String(rawHero.textLayout ?? rawHero.text_layout ?? ""),
      visualSubject: String(rawHero.visualSubject ?? rawHero.visual_subject ?? ""),
      imagePrompt: String(rawHero.imagePrompt ?? rawHero.image_prompt ?? ""),
      negativePrompt: String(rawHero.negativePrompt ?? rawHero.negative_prompt ?? ""),
    } : undefined,
    sceneSpecs: rawScenes.map((scene) => ({
      ...scene,
      sceneId: String(scene.sceneId ?? scene.scene_id ?? ""),
      sourceSentenceIds: (scene.sourceSentenceIds ?? scene.source_sentence_ids ?? []) as string[],
      sourceText: String(scene.sourceText ?? scene.source_text ?? ""),
      narrativeFunction: String(scene.narrativeFunction ?? scene.narrative_function ?? ""),
      visualType: (scene.visualType ?? scene.visual_type ?? "minimal") as SceneVisualType,
      sceneSummary: String(scene.sceneSummary ?? scene.scene_meaning ?? scene.scene_summary ?? ""),
      mainSubject: String(scene.mainSubject ?? scene.main_subject ?? ""),
      cameraDistance: String(scene.cameraDistance ?? scene.camera_distance ?? ""),
      imagePrompt: String(scene.imagePrompt ?? scene.image_prompt ?? ""),
      negativePrompt: String(scene.negativePrompt ?? scene.negative_prompt ?? ""),
    })),
    assets,
    heroAsset: explicitHero ? normalizeAsset(explicitHero) : undefined,
    sceneAssets: explicitScenes.map(normalizeAsset),
  };
}

function normalizedSourceText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function orderedSceneSpecs(sceneSpecs: SceneVisualSpec[]) {
  return sceneSpecs
    .map((scene, index) => ({ scene, index }))
    .sort((left, right) => {
      const leftNumber = /^scene-(\d+)$/u.exec(left.scene.sceneId)?.[1];
      const rightNumber = /^scene-(\d+)$/u.exec(right.scene.sceneId)?.[1];
      if (leftNumber && rightNumber) return Number(leftNumber) - Number(rightNumber);
      return left.index - right.index;
    })
    .map(({ scene }) => scene);
}

/**
 * Build the complete Scene-to-sentence relationship in source order.
 * The cursor keeps repeated paragraphs attached to their corresponding Scene.
 */
export function mapSceneSpecsToSentences(
  sceneSpecs: SceneVisualSpec[],
  sentences: VisualSentenceReference[],
) {
  const result = new Map<string, SceneVisualSpec>();
  const sentenceIndexById = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  let sentenceCursor = 0;

  for (const scene of orderedSceneSpecs(sceneSpecs)) {
    const explicitIndexes = scene.sourceSentenceIds
      .map((sentenceId) => sentenceIndexById.get(sentenceId))
      .filter((index): index is number => index !== undefined);
    if (explicitIndexes.length) {
      for (const sentenceId of scene.sourceSentenceIds) {
        if (sentenceIndexById.has(sentenceId)) result.set(sentenceId, scene);
      }
      sentenceCursor = Math.max(sentenceCursor, Math.max(...explicitIndexes) + 1);
      continue;
    }

    const directIndex = sentenceIndexById.get(scene.sceneId);
    if (directIndex !== undefined) {
      result.set(scene.sceneId, scene);
      sentenceCursor = Math.max(sentenceCursor, directIndex + 1);
      continue;
    }

    const sceneText = normalizedSourceText(scene.sourceText);
    if (!sceneText) continue;
    let sceneOffset = 0;
    let matched = false;
    for (let index = sentenceCursor; index < sentences.length; index += 1) {
      const sentence = sentences[index];
      const sentenceText = normalizedSourceText(sentence.text);
      if (!sentenceText) continue;
      const position = sceneText.indexOf(sentenceText, sceneOffset);
      if (position >= 0) {
        result.set(sentence.id, scene);
        sceneOffset = position + sentenceText.length;
        sentenceCursor = index + 1;
        matched = true;
        continue;
      }
      if (!matched && sentenceText.includes(sceneText)) {
        result.set(sentence.id, scene);
        sentenceCursor = index + 1;
        matched = true;
      }
      if (matched) break;
    }
  }

  return result;
}

/**
 * Resolve a persisted Scene back to a graph sentence.
 *
 * Visual generation may intentionally start before acoustic analysis. In that
 * case there are no control-spec sentence ids yet, so sourceSentenceIds is
 * empty even though sourceText is authoritative. Keep the id lookup as the
 * primary path and fall back to the original source text instead of leaving a
 * generated image detached from the manuscript.
 */
export function findSceneSpecForSentence(
  sceneSpecs: SceneVisualSpec[],
  sentence: VisualSentenceReference,
) {
  return mapSceneSpecsToSentences(sceneSpecs, [sentence]).get(sentence.id);
}

export function mapSceneAssetsToSentences(
  visuals: WorkVisualBundle | undefined,
  sentences: VisualSentenceReference[],
) {
  const result = new Map<string, VisualAsset>();
  if (!visuals) return result;
  const sceneBySentenceId = mapSceneSpecsToSentences(visuals.sceneSpecs ?? [], sentences);
  const candidates = [...(visuals.sceneAssets?.length
    ? visuals.sceneAssets
    : visuals.assets.filter((asset) => asset.kind === "scene"))]
    .filter((asset) => (
      Boolean(asset.url)
      && asset.status === "ready"
      && asset.isVisible !== false
      && asset.isActive !== false
    ))
    .sort((left, right) => right.version - left.version);
  const assetBySceneId = new Map<string, VisualAsset>();
  for (const asset of candidates) {
    if (asset.sceneId && !assetBySceneId.has(asset.sceneId)) {
      assetBySceneId.set(asset.sceneId, asset);
    }
  }
  for (const sentence of sentences) {
    const asset = assetBySceneId.get(sentence.id)
      ?? assetBySceneId.get(sceneBySentenceId.get(sentence.id)?.sceneId ?? "");
    if (asset) result.set(sentence.id, asset);
  }
  return result;
}

export function findSceneAssetForSentence(
  visuals: WorkVisualBundle | undefined,
  sentence: VisualSentenceReference,
) {
  return mapSceneAssetsToSentences(visuals, [sentence]).get(sentence.id);
}

async function visualRequest(url: string, init?: RequestInit) {
  return unwrapVisuals(await visualJson<VisualResponse>(await fetch(url, init)));
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function visualGenerationRequest(url: string, init?: RequestInit) {
  const started = await visualJson<VisualGenerationResponse>(await fetch(url, init));
  if (!started.visual_job_id) return unwrapVisuals(started);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(1_200);
    const job = await visualJson<VisualGenerationResponse>(await fetch(
      `/api/visual-jobs/${encodeURIComponent(started.visual_job_id)}`,
    ));
    if (job.status === "completed" || job.status === "succeeded" || job.status === "partial_failed") {
      return unwrapVisuals(job);
    }
    if (job.status === "failed") {
      throw new Error(job.error?.message || "图片生成任务失败，请稍后重试。");
    }
  }
  throw new Error("图片仍在后台生成。请稍后重新打开作品视觉查看结果。");
}

export function getWorkVisuals(workId: string) {
  return visualRequest(`/api/works/${encodeURIComponent(workId)}/visuals`);
}

export function generateWorkVisualPlan(workId: string) {
  return visualRequest(`/api/works/${encodeURIComponent(workId)}/visuals/plan`, {
    method: "POST",
  });
}

export function generateWorkVisualAssets(
  workId: string,
  target: { type: "all" | "hero" | "scene"; sceneId?: string },
) {
  return visualGenerationRequest(`/api/works/${encodeURIComponent(workId)}/visuals/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
}

export function updateWorkVisuals(
  workId: string,
  update:
    | { action: "lock_style" | "unlock_style" }
    | {
      action: "update_spec";
      kind: VisualAssetKind;
      sceneId?: string;
      imagePrompt: string;
      negativePrompt: string;
    },
) {
  return visualRequest(`/api/works/${encodeURIComponent(workId)}/visuals`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

export function updateVisualAsset(
  assetId: string,
  action: "hide" | "show" | "activate",
) {
  return visualRequest(`/api/visual-assets/${encodeURIComponent(assetId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

export function regenerateVisualAsset(assetId: string) {
  return visualGenerationRequest(`/api/visual-assets/${encodeURIComponent(assetId)}/regenerate`, {
    method: "POST",
  });
}

export function uploadWorkVisualAsset(
  workId: string,
  file: File,
  kind: VisualAssetKind,
  sceneId?: string,
) {
  const body = new FormData();
  body.set("file", file);
  body.set("kind", kind);
  if (sceneId) body.set("scene_id", sceneId);
  return visualRequest(`/api/works/${encodeURIComponent(workId)}/visual-assets/upload`, {
    method: "POST",
    body,
  });
}
