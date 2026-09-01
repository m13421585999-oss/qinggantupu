import {
  createImageGenerationProvider,
  detectImageDimensions,
  ImageGenerationError,
  type GeneratedImage,
  type ImageGenerationProvider,
} from "@/lib/image-generation-provider";
import { importControlSpec } from "@/lib/control-spec-import";
import { validateHeroText, type HeroTextValidationResult } from "@/lib/hero-text-validator";
import {
  withHeroProductionLayout,
  withHeroProductionNegativePrompt,
} from "@/lib/hero-production-prompt";
import { withDynamicTimingProfile } from "@/lib/timing-profile";
import { requestVisualDirection, VisualDirectorRequestError } from "@/lib/visual-director";
import { sameVisualGenerationTarget } from "@/lib/visual-job-target";
import {
  DEFAULT_COMPACT_LEGEND_ITEMS,
  normalizeCompactLegendItems,
} from "@/lib/compact-legend";
import {
  buildSceneUnits,
  summarizeControlSpec,
  type SceneGroupingVersion,
  type SceneVisualSpec,
  type VisualAssetKind,
  type WorkVisualProfile,
} from "@/lib/visual-schema";

type Row = Record<string, string | number | null>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const ANALYSIS_JOB_TIMEOUT_MS = 12 * 60 * 1000;
const STANDARD_ANALYSIS_JOB_TYPE = "standard_audio_analysis";
const LEGACY_ANALYSIS_JOB_TYPE = "reference_analysis";
const AI_TTS_ANALYSIS_JOB_TYPE = "ai_tts_audio_analysis";
const AI_TTS_GENERATION_JOB_TYPE = "ai_tts_generation";
const TEXT_RECITATION_JOB_TYPE = "text_recitation";
const VISUAL_GENERATION_JOB_TYPE = "visual_generation";
const VISUAL_SCENE_CONCURRENCY = 3;
const VISUAL_GENERATION_RETRY_LIMIT = 1;
const VISUAL_JOB_LEASE_MS = 5 * 60 * 1000;
const VISUAL_TERMINAL_STATUSES = new Set(["completed", "succeeded", "partial_failed", "failed"]);
// Scene Cards render at 38mm x 51mm (portrait, ratio ~0.745). Generate the
// source image at the same ratio (768 x 1031) so it is never cropped by
// object-fit: cover; the image is produced portrait from the source.
const SCENE_IMAGE_WIDTH = 768;
const SCENE_IMAGE_HEIGHT = 1031;
const VOICE_CHANGER_MODEL_ID = "eleven_multilingual_sts_v2";
const VOICE_CHANGER_OUTPUT_FORMAT = "mp3_44100_128";
const ELEVEN_TTS_MODEL_ID = "eleven_v3";
const ELEVEN_TTS_OUTPUT_FORMAT = "mp3_44100_128";
const AI_TTS_JOB_LEASE_MS = 4 * 60 * 1000;
const AI_TTS_TERMINAL_STATUSES = new Set(["graph_ready", "error"]);
const DEFAULT_PRINT_SETTINGS = {
  paper: "A4",
  orientation: "portrait",
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 15,
  marginBottomMm: 15,
  marginLeftMm: 15,
  marginRightMm: 15,
  renderDpr: 2.5,
  compactLegendItems: [...DEFAULT_COMPACT_LEGEND_ITEMS],
} as const;

type AudioSourceType = "human_reference" | "ai_tts";

interface AiTtsJobOutput {
  performancePlan?: Record<string, unknown>;
  ttsText?: string;
  validation?: Record<string, unknown>;
  director?: Record<string, unknown>;
  audio?: {
    assetId: string;
    model: string;
    voiceId: string;
    createdAt: string;
  };
  analysisJobId?: string;
  retryInterpretation?: boolean;
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": "no-store", ...headers },
  });
}

function apiError(status: number, code: string, message: string, details?: unknown) {
  return json({ error: { code, message, details } }, status);
}

function now() {
  return new Date().toISOString();
}

function nextUpdatedAt(previous?: string | null) {
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "audio";
}

function slugFor(title: string, workId: string) {
  const ascii = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `${ascii || "recitation"}-${workId.slice(-8)}`;
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeAudioSourceType(value: unknown): AudioSourceType {
  return value === "ai_tts" ? "ai_tts" : "human_reference";
}

function normalizePrintSettings(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const margin = (key: string) => {
    const candidate = Number(source[key]);
    return Number.isFinite(candidate) ? Math.max(10, Math.min(25, candidate)) : 15;
  };
  const renderDpr = Number(source.renderDpr);
  return {
    ...DEFAULT_PRINT_SETTINGS,
    marginTopMm: margin("marginTopMm"),
    marginBottomMm: margin("marginBottomMm"),
    marginLeftMm: margin("marginLeftMm"),
    marginRightMm: margin("marginRightMm"),
    renderDpr: Number.isFinite(renderDpr) ? Math.max(2, Math.min(3, renderDpr)) : 2.5,
    compactLegendItems: normalizeCompactLegendItems(source.compactLegendItems),
  };
}

function semanticText(value: string, stripAudioTags = false) {
  const withoutTags = stripAudioTags
    ? value.replace(/\[[^[\]\r\n]{1,160}\]/gu, "")
    : value;
  return Array.from(withoutTags.normalize("NFKC"))
    .filter((character) => /[\p{Letter}\p{Number}]/u.test(character))
    .join("");
}

function validateTtsText(originalText: string, ttsText: string) {
  const expected = semanticText(originalText);
  const actual = semanticText(ttsText, true);
  if (!expected || expected !== actual) {
    throw new Error("TTS 脚本与原文不一致");
  }
  return { matched: true, normalizedCharacterCount: expected.length };
}

function safeVisualErrorMessage(env: Env, error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [
    env.AI_API_KEY,
    env.IMAGE_API_KEY,
    env.ANALYSIS_SERVICE_TOKEN,
    env.ANALYSIS_CALLBACK_TOKEN,
  ]) {
    if (secret?.trim()) message = message.split(secret.trim()).join("[redacted]");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, "$1[redacted]")
    .slice(0, 800);
}

function imageProvider(env: Env) {
  const requestedProvider = env.IMAGE_PROVIDER?.trim();
  const normalizedRequestedProvider = requestedProvider?.toLowerCase().replace(/_/gu, "-");
  const directApiKey = imageApiKey(env);
  const analysisProxyConfigured = Boolean(
    env.ANALYSIS_SERVICE_URL?.trim() && env.ANALYSIS_SERVICE_TOKEN?.trim(),
  );
  const useAnalysisProxy = analysisProxyConfigured
    && normalizedRequestedProvider !== "placeholder"
    && (!directApiKey || !requestedProvider || normalizedRequestedProvider === "analysis-service");
  return createImageGenerationProvider({
    provider: useAnalysisProxy ? "analysis_service" : requestedProvider,
    model: env.IMAGE_MODEL,
    apiKey: useAnalysisProxy ? env.ANALYSIS_SERVICE_TOKEN : directApiKey,
    baseUrl: useAnalysisProxy ? env.ANALYSIS_SERVICE_URL : imageBaseUrl(env),
    apiMode: env.IMAGE_API_MODE,
  });
}

function imageApiKey(env: Env) {
  return env.AI_API_KEY?.trim() || env.IMAGE_API_KEY?.trim();
}

function imageBaseUrl(env: Env) {
  return env.AI_BASE_URL?.trim() || env.IMAGE_BASE_URL?.trim();
}

function imageExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase().split(";", 1)[0].trim();
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/avif") return "avif";
  return "png";
}

function boolValue(value: unknown) {
  return Number(value ?? 0) > 0;
}

function visualSpecPayload(row: Row) {
  const spec = parseJson<Record<string, unknown>>(row.spec_json as string | null) ?? {};
  const base = {
    id: String(row.id),
    kind: String(row.kind),
    sceneId: row.scene_id == null ? undefined : String(row.scene_id),
    sourceSentenceIds: parseJson<string[]>(row.source_sentence_ids_json as string | null) ?? [],
    sourceText: row.source_text == null ? undefined : String(row.source_text),
    version: Number(row.version),
    state: String(row.state),
    isActive: boolValue(row.is_active),
    createdAt: String(row.created_at),
  };
  if (row.kind === "hero") {
    return {
      ...base,
      type: "hero",
      size: spec.size,
      requiredText: spec.required_text ?? [],
      textLayout: spec.text_layout ?? "",
      visualSubject: spec.visual_subject ?? "",
      composition: spec.composition ?? "",
      lighting: spec.lighting ?? "",
      palette: spec.palette ?? [],
      imagePrompt: spec.image_prompt ?? "",
      negativePrompt: spec.negative_prompt ?? "",
    };
  }
  return {
    ...base,
    sceneId: String(spec.scene_id ?? row.scene_id ?? ""),
    sourceSentenceIds: spec.source_sentence_ids ?? base.sourceSentenceIds,
    sourceText: spec.source_text ?? base.sourceText ?? "",
    narrativeFunction: spec.narrative_function ?? "",
    visualType: spec.visual_type ?? "minimal",
    sceneSummary: spec.scene_meaning ?? spec.scene_summary ?? "",
    mainSubject: spec.main_subject ?? "",
    environment: spec.environment ?? "",
    emotion: spec.emotion ?? [],
    symbolism: spec.symbolism ?? [],
    composition: spec.composition ?? "",
    cameraDistance: spec.camera_distance ?? "",
    lighting: spec.lighting ?? "",
    palette: spec.palette ?? [],
    imagePrompt: spec.image_prompt ?? "",
    negativePrompt: spec.negative_prompt ?? "",
  };
}

function visualAssetPayload(row: Row) {
  const validation = parseJson<Record<string, unknown>>(row.text_validation_json as string | null);
  const assetMetadata = parseJson<Record<string, unknown>>(row.asset_metadata_json as string | null);
  return {
    id: String(row.id),
    workId: String(row.work_id),
    specId: row.spec_id == null ? undefined : String(row.spec_id),
    assetId: row.asset_id == null ? undefined : String(row.asset_id),
    kind: String(row.kind),
    sceneId: row.scene_id == null ? undefined : String(row.scene_id),
    url: row.asset_id == null ? undefined : `/api/assets/${row.asset_id}`,
    provider: String(row.provider),
    model: String(row.model),
    endpoint: assetMetadata?.endpoint == null ? undefined : String(assetMetadata.endpoint),
    prompt: String(row.prompt),
    negativePrompt: row.negative_prompt == null ? undefined : String(row.negative_prompt),
    width: Number(row.width),
    height: Number(row.height),
    seed: row.seed == null ? undefined : String(row.seed),
    status: String(row.generation_status),
    generationStatus: String(row.generation_status),
    textValidationStatus: row.text_validation_status == null
      ? undefined
      : String(row.text_validation_status),
    textValidation: validation,
    textValidationMessage: validation?.message == null ? undefined : String(validation.message),
    errorMessage: row.error_message == null ? undefined : String(row.error_message),
    isVisible: boolValue(row.is_visible),
    isActive: boolValue(row.is_active),
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
}

async function getVisualBundle(env: Env, workId: string, published = false) {
  const profileRow = await first<Row>(env.DB.prepare(
    `SELECT * FROM work_visual_profiles
      WHERE work_id = ? AND is_active = 1
      ORDER BY version DESC LIMIT 1`,
  ).bind(workId));
  const specsResult = await env.DB.prepare(
    `SELECT * FROM visual_specs
      WHERE work_id = ? AND is_active = 1
      ORDER BY CASE WHEN kind = 'hero' THEN 0 ELSE 1 END, scene_id, version DESC`,
  ).bind(workId).all<Row>();
  const assetsResult = await env.DB.prepare(
    `SELECT va.*, a.metadata_json AS asset_metadata_json
       FROM visual_assets va
       LEFT JOIN assets a ON a.id = va.asset_id
      WHERE va.work_id = ?${published
        ? " AND va.is_active = 1 AND va.is_visible = 1 AND va.generation_status = 'ready'"
        : ""}
      ORDER BY CASE WHEN va.kind = 'hero' THEN 0 ELSE 1 END, va.scene_id, va.version DESC`,
  ).bind(workId).all<Row>();
  const rawProfile = profileRow
    ? parseJson<WorkVisualProfile & { _meta?: { director_endpoint?: unknown } }>(
      profileRow.profile_json as string | null,
    )
    : undefined;
  const specs = (specsResult.results ?? []).map(visualSpecPayload);
  const assets = (assetsResult.results ?? []).map(visualAssetPayload);
  const heroSpec = specs.find((spec) => spec.kind === "hero");
  const sceneSpecs = specs.filter((spec) => spec.kind === "scene");
  const heroAsset = assets.find((asset) => asset.kind === "hero" && asset.isActive && asset.isVisible);
  const sceneAssets = assets.filter((asset) => asset.kind === "scene" && asset.isActive && asset.isVisible);
  let provider: ImageGenerationProvider;
  try {
    provider = imageProvider(env);
  } catch {
    provider = imageProvider({ ...env, IMAGE_PROVIDER: "placeholder", IMAGE_API_KEY: undefined });
  }
  return {
    profile: rawProfile ? {
      visualStyle: rawProfile.visual_style,
      palette: rawProfile.palette,
      texture: rawProfile.texture,
      lighting: rawProfile.lighting,
      atmosphere: rawProfile.atmosphere,
      compositionRule: rawProfile.composition_language ?? rawProfile.composition_rule,
      humanPresence: rawProfile.human_presence,
      symbolicElements: rawProfile.symbolic_language ?? rawProfile.symbolic_elements,
      avoid: rawProfile.avoid,
      id: String(profileRow?.id),
      version: Number(profileRow?.version),
      isLocked: boolValue(profileRow?.is_locked),
      directorProvider: String(profileRow?.director_provider ?? "deepseek"),
      directorModel: String(profileRow?.director_model ?? ""),
      directorEndpoint: rawProfile._meta?.director_endpoint == null
        ? undefined
        : String(rawProfile._meta.director_endpoint),
      createdAt: String(profileRow?.created_at),
      updatedAt: String(profileRow?.updated_at),
    } : undefined,
    heroSpec,
    sceneSpecs,
    assets,
    heroAsset,
    sceneAssets,
    provider: {
      configured: provider.configured,
      provider: provider.provider,
      model: provider.model,
    },
  };
}

function isAnalysisJobType(value: unknown) {
  return value === STANDARD_ANALYSIS_JOB_TYPE
    || value === LEGACY_ANALYSIS_JOB_TYPE
    || value === AI_TTS_ANALYSIS_JOB_TYPE;
}

async function first<T extends Row>(statement: D1PreparedStatement): Promise<T | null> {
  return statement.first<T>();
}

function base64Url(bytes: ArrayBuffer) {
  let raw = "";
  for (const byte of new Uint8Array(bytes)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function handoffSignature(secret: string, scope: "input" | "audio", jobId: string, assetId: string, expires: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${scope}\n${jobId}\n${assetId}\n${expires}`),
  ));
}

async function secureSecretMatch(actual: string | null | undefined, expected: string | undefined) {
  if (!actual || !expected) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

function analysisTimeline(analysis: Record<string, unknown> | undefined) {
  const tokens = Array.isArray(analysis?.tokens) ? analysis.tokens as Array<Record<string, unknown>> : [];
  const sentences = Array.isArray(analysis?.sentences)
    ? analysis.sentences as Array<Record<string, unknown>>
    : Array.isArray(analysis?.segments) ? analysis.segments as Array<Record<string, unknown>> : [];
  return {
    granularity: "character",
    tokens: tokens.map((token) => ({
      tokenId: `token-${Number(token.index)}`,
      tokenIndex: Number(token.index),
      startMs: Number(token.start_ms),
      endMs: Number(token.end_ms),
      confidence: Number(token.confidence ?? 1),
    })),
    sentences: sentences.map((sentence, index) => ({
      sentenceId: String(sentence.id ?? `sentence-${index + 1}`),
      startMs: Number(sentence.start_ms),
      endMs: Number(sentence.end_ms),
    })),
  };
}

async function latestAnalysisPackage(
  env: Env,
  workId: string,
  sourceText: string,
): Promise<Record<string, unknown> | undefined> {
  const row = await first<Row>(env.DB.prepare(
    `SELECT output_json
       FROM processing_jobs
      WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')
        AND status = 'succeeded'
      ORDER BY CASE WHEN type IN ('standard_audio_analysis', 'ai_tts_audio_analysis') THEN 0 ELSE 1 END,
               created_at DESC LIMIT 1`,
  ).bind(workId));
  const output = parseJson<Record<string, unknown>>(row?.output_json as string | null);
  const analysisPackage = output?.analysis_package;
  if (!analysisPackage || typeof analysisPackage !== "object" || Array.isArray(analysisPackage)) {
    return undefined;
  }
  const analysisWork = (analysisPackage as Record<string, unknown>).work;
  const analyzedText = analysisWork && typeof analysisWork === "object" && !Array.isArray(analysisWork)
    ? String((analysisWork as Record<string, unknown>).full_text ?? "")
    : "";
  return analyzedText === sourceText
    ? analysisPackage as Record<string, unknown>
    : undefined;
}

async function getWorkPayload(env: Env, workId: string, published = false) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return null;

  const publication = published
    ? await first<Row>(env.DB.prepare(
      `SELECT id, control_spec_version_id, audio_version_id
         FROM publications
        WHERE work_id = ? AND state = 'published'
        ORDER BY published_at DESC LIMIT 1`,
    ).bind(workId))
    : null;
  if (published && !publication) return null;
  const reference = !published
    ? await first<Row>(env.DB.prepare(
      "SELECT * FROM assets WHERE work_id = ? AND kind = 'reference_audio' ORDER BY created_at DESC LIMIT 1",
    ).bind(workId))
    : null;
  const standardAsset = !published
    ? await first<Row>(env.DB.prepare(
      "SELECT * FROM assets WHERE work_id = ? AND kind = 'standard_ai_audio' ORDER BY created_at DESC LIMIT 1",
    ).bind(workId))
    : null;
  const latestAiTtsJob = !published
    ? await first<Row>(env.DB.prepare(
      `SELECT id, status, progress, output_json, error_code, error_message, created_at, updated_at
         FROM processing_jobs
        WHERE work_id = ? AND type = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(workId, AI_TTS_GENERATION_JOB_TYPE))
    : null;
  const aiTtsOutput = parseJson<AiTtsJobOutput>(latestAiTtsJob?.output_json as string | null);
  const latestAnalysisJob = !published
    ? await first<Row>(env.DB.prepare(
      `SELECT id, type, status, progress, input_json, output_json, error_code, error_message
         FROM processing_jobs
        WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')
        ORDER BY CASE WHEN type IN ('standard_audio_analysis', 'ai_tts_audio_analysis') THEN 0 ELSE 1 END,
                 created_at DESC LIMIT 1`,
    ).bind(workId))
    : null;
  const latestAnalysisInput = parseJson<{
    assetId?: string;
    standardAudioAssetId?: string;
  }>(latestAnalysisJob?.input_json as string | null);
  const expectedAnalysisAsset = standardAsset ?? reference;
  const analysisJob = expectedAnalysisAsset
    && latestAnalysisInput?.assetId === expectedAnalysisAsset.id
    ? latestAnalysisJob
    : null;
  const analysisOutput = parseJson<Record<string, unknown>>(analysisJob?.output_json as string | null);
  const analysisPackage = analysisOutput?.analysis_package as Record<string, unknown> | undefined;
  const selectedSpecVersionId = publication?.control_spec_version_id ?? work.current_spec_version_id;

  let controlSpec: Record<string, unknown> | undefined;
  if (selectedSpecVersionId) {
    const spec = await first<Row>(env.DB.prepare(
      "SELECT spec_json FROM control_spec_versions WHERE id = ?",
    ).bind(selectedSpecVersionId));
    controlSpec = parseJson<Record<string, unknown>>(spec?.spec_json as string | null);
  }

  const audioVersion = publication?.audio_version_id
    ? await first<Row>(env.DB.prepare(
      `SELECT av.*, a.kind AS asset_kind, a.filename, a.mime_type,
              a.duration_ms AS asset_duration_ms, a.source_asset_id, a.metadata_json
         FROM audio_versions av
         JOIN assets a ON a.id = av.audio_asset_id
        WHERE av.id = ? LIMIT 1`,
    ).bind(publication.audio_version_id))
    : selectedSpecVersionId
    ? await first<Row>(env.DB.prepare(
      `SELECT av.*, a.kind AS asset_kind, a.filename, a.mime_type,
              a.duration_ms AS asset_duration_ms, a.source_asset_id, a.metadata_json
         FROM audio_versions av
         JOIN assets a ON a.id = av.audio_asset_id
        WHERE av.work_id = ? AND av.control_spec_version_id = ?
        ORDER BY CASE WHEN a.kind = 'standard_ai_audio' THEN 0 ELSE 1 END,
                 av.created_at DESC LIMIT 1`,
    ).bind(workId, selectedSpecVersionId))
    : null;

  const referenceTrack = reference ? {
    id: String(reference.id),
    kind: "reference_original" as const,
    url: `/api/assets/${reference.id}`,
    filename: String(reference.filename),
    mimeType: String(reference.mime_type),
    durationMs: Number(reference.duration_ms ?? 0),
    provider: "upload" as const,
    label: "原始优秀真人朗诵",
  } : undefined;
  const publishedStandard = String(audioVersion?.asset_kind ?? "").startsWith("standard_ai_audio")
    ? audioVersion
    : null;
  const currentStandard = publishedStandard ?? standardAsset;
  const standardMetadata = parseJson<Record<string, unknown>>(currentStandard?.metadata_json as string | null);
  const standardTimeline = published
    ? parseJson(audioVersion?.timeline_json as string | null)
    : analysisPackage
      ? analysisTimeline(analysisPackage)
      : parseJson(audioVersion?.timeline_json as string | null);
  const standardTrack = currentStandard ? {
    id: String(currentStandard.audio_asset_id ?? currentStandard.id),
    kind: "standard_ai" as const,
    url: `/api/assets/${currentStandard.audio_asset_id ?? currentStandard.id}`,
    filename: String(currentStandard.filename),
    mimeType: String(currentStandard.mime_type),
    durationMs: Number(
      currentStandard.duration_ms
      ?? currentStandard.asset_duration_ms
      ?? (analysisPackage?.audio as Record<string, unknown> | undefined)?.duration_ms
      ?? 0,
    ),
    provider: "eleven" as const,
    label: standardMetadata?.generation_mode === "ai_tts"
      ? "AI 参考朗诵"
      : "Eleven Voice Changer 标准 AI 朗诵",
    timeline: standardTimeline,
  } : undefined;
  const legacyDemoTrack = audioVersion
    && !String(audioVersion.asset_kind ?? "").startsWith("standard_ai_audio") ? {
    id: String(audioVersion.audio_asset_id),
    kind: "ai_demo" as const,
    url: `/api/assets/${audioVersion.audio_asset_id}`,
    filename: String(audioVersion.filename),
    mimeType: String(audioVersion.mime_type),
    durationMs: Number(audioVersion.duration_ms ?? audioVersion.asset_duration_ms ?? 0),
    provider: "eleven" as const,
    label: "旧版 Eleven v3 AI 示范",
    timeline: parseJson(audioVersion.timeline_json as string),
  } : undefined;
  return {
    id: work.id,
    slug: work.slug,
    title: work.title,
    author: work.author ?? undefined,
    genre: work.genre,
    language: work.language,
    sourceText: work.source_text,
    printSettings: normalizePrintSettings(
      parseJson<Record<string, unknown>>(work.print_settings_json as string | null),
    ),
    audioSourceType: normalizeAudioSourceType(work.audio_source_type),
    status: published ? "published" : work.status,
    audioSyncStatus: work.audio_sync_status ?? (standardTrack ? "synced" : "pending"),
    currentSpecVersionId: selectedSpecVersionId ?? undefined,
    publishedRevisionId: publication?.id ?? work.published_revision_id ?? undefined,
    analysisJobId: analysisJob?.id ?? undefined,
    analysisJobStatus: analysisJob?.status ?? undefined,
    analysisPackage,
    referenceAudio: referenceTrack,
    referenceAudioOriginal: referenceTrack,
    aiDemoAudio: legacyDemoTrack,
    standardAiAudio: standardTrack,
    aiTts: latestAiTtsJob || standardMetadata?.generation_mode === "ai_tts" ? {
      jobId: latestAiTtsJob?.id == null ? undefined : String(latestAiTtsJob.id),
      status: latestAiTtsJob?.status == null ? "tts_audio_ready" : String(latestAiTtsJob.status),
      progress: Number(latestAiTtsJob?.progress ?? 0),
      performancePlan: aiTtsOutput?.performancePlan,
      ttsText: aiTtsOutput?.ttsText,
      model: String(aiTtsOutput?.audio?.model ?? standardMetadata?.model_id ?? ELEVEN_TTS_MODEL_ID),
      voiceId: String(aiTtsOutput?.audio?.voiceId ?? standardMetadata?.voice_id ?? ""),
      audioAssetId: aiTtsOutput?.audio?.assetId ?? (standardMetadata?.generation_mode === "ai_tts"
        ? String(currentStandard?.audio_asset_id ?? currentStandard?.id ?? "")
        : undefined),
      audioUrl: standardMetadata?.generation_mode === "ai_tts" && standardTrack
        ? standardTrack.url
        : undefined,
      createdAt: String(aiTtsOutput?.audio?.createdAt ?? standardMetadata?.generated_at ?? latestAiTtsJob?.created_at ?? ""),
      error: latestAiTtsJob?.error_code ? {
        code: String(latestAiTtsJob.error_code),
        message: String(latestAiTtsJob.error_message ?? "AI 参考朗诵生成失败。"),
      } : undefined,
    } : undefined,
    controlSpec,
    visuals: await getVisualBundle(env, workId, published),
    createdAt: work.created_at,
    updatedAt: work.updated_at,
    analysisError: analysisJob?.status === "failed" ? {
      code: analysisJob.error_code,
      message: analysisJob.error_message,
    } : undefined,
  };
}

async function listWorks(request: Request, env: Env) {
  if (!env.DB) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 尚未绑定，无法读取作品库。");
  }
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 30);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(200, Math.max(1, Math.trunc(requestedLimit)))
    : 30;
  const select = `SELECT
      w.id, w.slug, w.title, w.author, w.status, w.audio_sync_status,
      w.current_spec_version_id, w.created_at, w.updated_at,
      EXISTS (
        SELECT 1 FROM assets a
         WHERE a.work_id = w.id AND a.kind = 'reference_audio'
      ) AS has_reference_audio,
      EXISTS (
        SELECT 1 FROM assets a
         WHERE a.work_id = w.id AND a.kind = 'standard_ai_audio'
      ) AS has_standard_audio,
      EXISTS (
        SELECT 1 FROM publications p
         WHERE p.work_id = w.id AND p.state = 'published'
      ) AS has_published_version
    FROM works w`;
  const statement = query
    ? env.DB.prepare(
      `${select}
       WHERE w.title LIKE ? ESCAPE '\\' OR COALESCE(w.author, '') LIKE ? ESCAPE '\\'
       ORDER BY w.updated_at DESC
       LIMIT ?`,
    ).bind(
      `%${query.replace(/[\\%_]/g, "\\$&")}%`,
      `%${query.replace(/[\\%_]/g, "\\$&")}%`,
      limit,
    )
    : env.DB.prepare(`${select} ORDER BY w.updated_at DESC LIMIT ?`).bind(limit);
  const result = await statement.all<Row>();
  return json({
    items: (result.results ?? []).map((work) => ({
      id: String(work.id),
      slug: String(work.slug),
      title: String(work.title),
      author: work.author == null ? undefined : String(work.author),
      status: String(work.status),
      audioSyncStatus: String(work.audio_sync_status ?? "pending"),
      hasReferenceAudio: Number(work.has_reference_audio ?? 0) > 0,
      hasStandardAudio: Number(work.has_standard_audio ?? 0) > 0,
      hasControlSpec: Boolean(work.current_spec_version_id),
      hasPublishedVersion: Number(work.has_published_version ?? 0) > 0,
      createdAt: String(work.created_at),
      updatedAt: String(work.updated_at),
    })),
  });
}

async function createWork(request: Request, env: Env) {
  if (!env.DB) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 尚未绑定，无法保存正式作品。");
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return apiError(400, "INVALID_JSON", "作品数据必须是 JSON 对象。");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError(400, "INVALID_JSON", "作品数据必须是有效的 JSON。");
  }
  const title = String(body.title ?? "").trim();
  const author = String(body.author ?? "").trim();
  const fullText = String(body.full_text ?? "");
  const audioSourceType = normalizeAudioSourceType(body.audio_source_type ?? body.audioSourceType);
  const printSettings = normalizePrintSettings(body.print_settings ?? body.printSettings);
  const printSettingsJson = JSON.stringify(printSettings);
  const requestedWorkId = String(body.work_id ?? "").trim();
  const expectedUpdatedAt = String(body.expected_updated_at ?? body.expectedUpdatedAt ?? "").trim();
  if (!title || !fullText.trim()) {
    return apiError(400, "INVALID_WORK", "作品名称和完整正文不能为空。");
  }

  if (requestedWorkId) {
    const existing = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(requestedWorkId));
    if (!existing) return apiError(404, "WORK_NOT_FOUND", "找不到要更新的作品。");
    if (expectedUpdatedAt && String(existing.updated_at) !== expectedUpdatedAt) {
      return apiError(
        409,
        "WORK_VERSION_CONFLICT",
        "作品已在其他窗口更新。为避免覆盖最新内容，请重新加载后再编辑。",
        { expected_updated_at: expectedUpdatedAt, actual_updated_at: existing.updated_at },
      );
    }
    const savedAt = nextUpdatedAt(String(existing.updated_at));
    const sourceChanged = String(existing.source_text) !== fullText;
    const visualSourceChanged = sourceChanged
      || String(existing.title) !== title
      || String(existing.author ?? "") !== author;
    if (sourceChanged) {
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE works
              SET title = ?, author = ?, source_text = ?, audio_source_type = ?, print_settings_json = ?,
                  status = 'draft', audio_sync_status = 'pending',
                  current_spec_version_id = NULL, published_revision_id = NULL, updated_at = ?
            WHERE id = ?${expectedUpdatedAt ? " AND updated_at = ?" : ""}`,
        ).bind(
          title,
          author || null,
          fullText,
          audioSourceType,
          printSettingsJson,
          savedAt,
          requestedWorkId,
          ...expectedUpdatedAt ? [expectedUpdatedAt] : [],
        ),
        env.DB.prepare(
          `UPDATE publications SET state = 'withdrawn', withdrawn_at = ?
            WHERE work_id = ? AND state = 'published'
              AND EXISTS (SELECT 1 FROM works WHERE id = ? AND updated_at = ?)`,
        ).bind(savedAt, requestedWorkId, requestedWorkId, savedAt),
        env.DB.prepare(
          `UPDATE assets SET kind = 'reference_audio_archived'
            WHERE work_id = ? AND kind = 'reference_audio'
              AND EXISTS (SELECT 1 FROM works WHERE id = ? AND updated_at = ?)`,
        ).bind(requestedWorkId, requestedWorkId, savedAt),
        env.DB.prepare(
          `UPDATE assets SET kind = 'standard_ai_audio_archived'
            WHERE work_id = ? AND kind = 'standard_ai_audio'
              AND EXISTS (SELECT 1 FROM works WHERE id = ? AND updated_at = ?)`,
        ).bind(requestedWorkId, requestedWorkId, savedAt),
        env.DB.prepare(
          `UPDATE processing_jobs
              SET status = 'failed', progress = 0, error_code = 'WORK_SOURCE_CHANGED',
                  error_message = '作品正文已更新，请重新上传匹配的参考朗诵并发起分析。', updated_at = ?
            WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')
              AND status IN ('queued', 'processing')
              AND EXISTS (SELECT 1 FROM works WHERE id = ? AND updated_at = ?)`,
        ).bind(savedAt, requestedWorkId, requestedWorkId, savedAt),
        env.DB.prepare(
          `UPDATE processing_jobs
              SET status = 'error', progress = 0, error_code = 'WORK_SOURCE_CHANGED',
                  error_message = '作品正文已更新，请重新生成 AI 参考朗诵。', updated_at = ?
            WHERE work_id = ? AND type = ?
              AND status NOT IN ('graph_ready', 'error')`,
        ).bind(savedAt, requestedWorkId, AI_TTS_GENERATION_JOB_TYPE),
        env.DB.prepare(
          "UPDATE visual_assets SET is_visible = 0, is_active = 0 WHERE work_id = ?",
        ).bind(requestedWorkId),
        env.DB.prepare(
          "UPDATE visual_specs SET is_active = 0 WHERE work_id = ?",
        ).bind(requestedWorkId),
        env.DB.prepare(
          "UPDATE work_visual_profiles SET is_active = 0, updated_at = ? WHERE work_id = ?",
        ).bind(savedAt, requestedWorkId),
      ]);
      if (expectedUpdatedAt && Number(results[0]?.meta.changes ?? 0) === 0) {
        return apiError(
          409,
          "WORK_VERSION_CONFLICT",
          "作品已在其他窗口更新。为避免覆盖最新内容，请重新加载后再编辑。",
        );
      }
    } else {
      const updateWork = env.DB.prepare(
        `UPDATE works SET title = ?, author = ?, audio_source_type = ?, print_settings_json = ?, updated_at = ?
          WHERE id = ?${expectedUpdatedAt ? " AND updated_at = ?" : ""}`,
      ).bind(
        title,
        author || null,
        audioSourceType,
        printSettingsJson,
        savedAt,
        requestedWorkId,
        ...expectedUpdatedAt ? [expectedUpdatedAt] : [],
      );
      const results = visualSourceChanged
        ? await env.DB.batch([
          updateWork,
          env.DB.prepare("UPDATE visual_assets SET is_visible = 0, is_active = 0 WHERE work_id = ?").bind(requestedWorkId),
          env.DB.prepare("UPDATE visual_specs SET is_active = 0 WHERE work_id = ?").bind(requestedWorkId),
          env.DB.prepare("UPDATE work_visual_profiles SET is_active = 0, updated_at = ? WHERE work_id = ?").bind(savedAt, requestedWorkId),
        ])
        : [await updateWork.run()];
      if (expectedUpdatedAt && Number(results[0]?.meta.changes ?? 0) === 0) {
        return apiError(
          409,
          "WORK_VERSION_CONFLICT",
          "作品已在其他窗口更新。为避免覆盖最新内容，请重新加载后再编辑。",
        );
      }
    }
    return json({ work: await getWorkPayload(env, requestedWorkId) });
  }

  const workId = id("work");
  const savedAt = now();
  await env.DB.prepare(
    `INSERT INTO works
       (id, slug, title, author, genre, language, source_text, print_settings_json, audio_source_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 'zh-CN', ?, ?, ?, 'draft', ?, ?)`,
  ).bind(
    workId,
    slugFor(title, workId),
    title,
    author || null,
    fullText,
    printSettingsJson,
    audioSourceType,
    savedAt,
    savedAt,
  ).run();
  return json({ work: await getWorkPayload(env, workId) }, 201);
}

async function deleteWork(request: Request, env: Env, workId: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法删除作品。");
  }
  let expectedUpdatedAt = "";
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return apiError(400, "INVALID_JSON", "删除作品请求必须是 JSON 对象。");
    }
    const body = parsed as Record<string, unknown>;
    expectedUpdatedAt = String(body.expected_updated_at ?? body.expectedUpdatedAt ?? "").trim();
  } catch {
    return apiError(400, "INVALID_JSON", "删除作品请求必须是有效的 JSON。");
  }
  if (!expectedUpdatedAt) {
    return apiError(428, "WORK_VERSION_REQUIRED", "删除前必须确认当前作品版本，请刷新作品库后重试。");
  }

  const work = await first<Row>(env.DB.prepare(
    "SELECT id, title, updated_at FROM works WHERE id = ?",
  ).bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到要删除的作品。");
  if (String(work.updated_at) !== expectedUpdatedAt) {
    return apiError(
      409,
      "WORK_VERSION_CONFLICT",
      "作品已在其他窗口更新。为避免误删最新版本，请刷新作品库后重新确认。",
      { expected_updated_at: expectedUpdatedAt, actual_updated_at: work.updated_at },
    );
  }

  const assets = await env.DB.prepare(
    "SELECT storage_key FROM assets WHERE work_id = ? ORDER BY created_at ASC",
  ).bind(workId).all<Row>();
  const storageKeys = (assets.results ?? [])
    .map((asset) => String(asset.storage_key ?? "").trim())
    .filter(Boolean);
  const visualKeysOutsideAssets = await env.DB.prepare(
    `SELECT a.storage_key
       FROM visual_assets va
       JOIN assets a ON a.id = va.asset_id
      WHERE va.work_id = ? AND a.work_id = ?`,
  ).bind(workId, workId).all<Row>();
  const exactStorageKeys = [...new Set([
    ...storageKeys,
    ...(visualKeysOutsideAssets.results ?? [])
      .map((asset) => String(asset.storage_key ?? "").trim())
      .filter(Boolean),
  ])];
  const belongsToConfirmedVersion = `EXISTS (
    SELECT 1 FROM works WHERE id = ? AND updated_at = ?
  )`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM publications WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM audio_versions WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM processing_jobs WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM control_spec_versions WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM visual_assets WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM visual_specs WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM work_visual_profiles WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      `DELETE FROM assets WHERE work_id = ? AND ${belongsToConfirmedVersion}`,
    ).bind(workId, workId, expectedUpdatedAt),
    env.DB.prepare(
      "DELETE FROM works WHERE id = ? AND updated_at = ?",
    ).bind(workId, expectedUpdatedAt),
  ]);
  if (Number(results.at(-1)?.meta.changes ?? 0) === 0) {
    return apiError(
      409,
      "WORK_VERSION_CONFLICT",
      "作品已在其他窗口更新。为避免误删最新版本，请刷新作品库后重新确认。",
    );
  }

  try {
    for (let offset = 0; offset < exactStorageKeys.length; offset += 1000) {
      await env.AUDIO_BUCKET.delete(exactStorageKeys.slice(offset, offset + 1000));
    }
  } catch (error) {
    console.error("deleted work has orphaned R2 objects", {
      workId,
      storageKeyCount: exactStorageKeys.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return json({
    ok: true,
    deleted_work: {
      id: workId,
      title: String(work.title),
    },
  });
}

function referenceAssetPayload(asset: Row) {
  return {
    asset_id: asset.id,
    work_id: asset.work_id,
    filename: asset.filename,
    mime_type: asset.mime_type,
    file_size: Number(asset.byte_size),
    duration_ms: asset.duration_ms == null ? undefined : Number(asset.duration_ms),
    kind: "reference_audio",
  };
}

async function uploadReferenceAudio(request: Request, env: Env, workId: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法保存参考朗诵。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(400, "INVALID_MULTIPART", "参考朗诵必须使用文件上传表单。");
  }
  const expectedUpdatedAt = String(form.get("expected_updated_at") ?? "").trim();
  if (expectedUpdatedAt && String(work.updated_at) !== expectedUpdatedAt) {
    return apiError(
      409,
      "WORK_VERSION_CONFLICT",
      "作品已在其他窗口更新。为避免覆盖最新内容，请重新加载后再编辑。",
      { expected_updated_at: expectedUpdatedAt, actual_updated_at: work.updated_at },
    );
  }
  const fileValue = form.get("reference_audio_file") ?? form.get("file");
  if (!(fileValue instanceof File) || fileValue.size <= 0) {
    return apiError(400, "REFERENCE_AUDIO_REQUIRED", "请选择真实的参考朗诵音频文件。");
  }
  if (fileValue.size > 100 * 1024 * 1024) {
    return apiError(413, "REFERENCE_AUDIO_TOO_LARGE", "参考朗诵音频不能超过 100 MB。");
  }
  const extensionAllowed = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(fileValue.name);
  const mimeAllowed = fileValue.type.startsWith("audio/") || fileValue.type === "application/octet-stream";
  if (!extensionAllowed && !mimeAllowed) {
    return apiError(415, "UNSUPPORTED_AUDIO_TYPE", "仅支持常见的 MP3、WAV、M4A、AAC、OGG 或 FLAC 音频。");
  }

  const durationValue = Number(form.get("duration_ms") ?? 0);
  const durationMs = Number.isFinite(durationValue) && durationValue > 0 ? Math.round(durationValue) : null;
  const assetId = id("asset");
  const uploadedAt = nextUpdatedAt(String(work.updated_at));
  const bytes = await fileValue.arrayBuffer();
  const checksum = await sha256Hex(bytes);
  const filename = fileValue.name || "reference-audio";
  const mimeType = fileValue.type || "application/octet-stream";
  const storageKey = `works/${workId}/reference/${assetId}-${safeFilename(filename)}`;
  await env.AUDIO_BUCKET.put(storageKey, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { workId, assetId, checksum, kind: "reference_audio" },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE assets SET kind = 'reference_audio_archived' WHERE work_id = ? AND kind = 'reference_audio'",
      ).bind(workId),
      env.DB.prepare(
        "UPDATE assets SET kind = 'standard_ai_audio_archived' WHERE work_id = ? AND kind = 'standard_ai_audio'",
      ).bind(workId),
      env.DB.prepare(
        `INSERT INTO assets
           (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms, checksum, provider, created_at)
         VALUES (?, ?, 'reference_audio', ?, ?, ?, ?, ?, ?, 'upload', ?)`,
      ).bind(assetId, workId, storageKey, filename, mimeType, fileValue.size, durationMs, checksum, uploadedAt),
      env.DB.prepare(
        `UPDATE processing_jobs
            SET status = 'failed', progress = 0, error_code = 'REFERENCE_AUDIO_REPLACED',
                error_message = '参考朗诵已被替换，请重新发起分析。', updated_at = ?
          WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')
            AND status IN ('queued', 'processing')`,
      ).bind(uploadedAt, workId),
      env.DB.prepare(
        `UPDATE processing_jobs
            SET status = 'error', progress = 0, error_code = 'AUDIO_SOURCE_CHANGED',
                error_message = '参考朗诵来源已切换为真人音频。', updated_at = ?
          WHERE work_id = ? AND type = ? AND status NOT IN ('graph_ready', 'error')`,
      ).bind(uploadedAt, workId, AI_TTS_GENERATION_JOB_TYPE),
      env.DB.prepare(
        `UPDATE works
            SET status = 'draft', audio_source_type = 'human_reference', audio_sync_status = 'pending',
                current_spec_version_id = NULL, published_revision_id = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(uploadedAt, workId),
      env.DB.prepare(
        "UPDATE publications SET state = 'withdrawn', withdrawn_at = ? WHERE work_id = ? AND state = 'published'",
      ).bind(uploadedAt, workId),
    ]);
  } catch (error) {
    await env.AUDIO_BUCKET.delete(storageKey);
    throw error;
  }

  const asset = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId));
  if (!asset) return apiError(500, "ASSET_SAVE_FAILED", "参考朗诵已上传，但素材记录保存失败。");
  return json({ reference_audio: referenceAssetPayload(asset), work: await getWorkPayload(env, workId) }, 201);
}

async function deleteReferenceAudio(request: Request, env: Env, workId: string) {
  if (!env.DB) return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 尚未绑定，无法更新作品素材。");
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  let expectedUpdatedAt = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    expectedUpdatedAt = String(body.expected_updated_at ?? body.expectedUpdatedAt ?? "").trim();
  } catch {
    // An empty DELETE body is accepted for compatibility with older clients.
  }
  if (expectedUpdatedAt && String(work.updated_at) !== expectedUpdatedAt) {
    return apiError(
      409,
      "WORK_VERSION_CONFLICT",
      "作品已在其他窗口更新。为避免覆盖最新内容，请重新加载后再编辑。",
      { expected_updated_at: expectedUpdatedAt, actual_updated_at: work.updated_at },
    );
  }
  const deletedAt = nextUpdatedAt(String(work.updated_at));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE assets SET kind = 'reference_audio_archived' WHERE work_id = ? AND kind = 'reference_audio'",
    ).bind(workId),
    env.DB.prepare(
      `UPDATE assets SET kind = 'standard_ai_audio_archived'
        WHERE work_id = ? AND kind = 'standard_ai_audio' AND source_asset_id IS NOT NULL`,
    ).bind(workId),
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'failed', progress = 0, error_code = 'REFERENCE_AUDIO_REMOVED',
              error_message = '参考朗诵已移除，请上传匹配音频并重新发起分析。', updated_at = ?
        WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')
          AND status IN ('queued', 'processing')`,
    ).bind(deletedAt, workId),
  ];
  if (normalizeAudioSourceType(work.audio_source_type) === "ai_tts") {
    statements.push(
      env.DB.prepare("UPDATE works SET updated_at = ? WHERE id = ?").bind(deletedAt, workId),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE works
            SET status = 'draft', audio_sync_status = 'pending', current_spec_version_id = NULL,
                published_revision_id = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(deletedAt, workId),
      env.DB.prepare(
        "UPDATE publications SET state = 'withdrawn', withdrawn_at = ? WHERE work_id = ? AND state = 'published'",
      ).bind(deletedAt, workId),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true, work: await getWorkPayload(env, workId) });
}

async function ensureStandardAiAudio(env: Env, work: Row, reference: Row) {
  const existing = await first<Row>(env.DB.prepare(
    `SELECT * FROM assets
      WHERE work_id = ? AND kind = 'standard_ai_audio' AND source_asset_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(work.id, reference.id));
  if (existing) {
    const metadata = parseJson<Record<string, unknown>>(existing.metadata_json as string | null);
    if (
      !env.ELEVENLABS_VOICE_ID?.trim()
      || (
        metadata?.voice_id === env.ELEVENLABS_VOICE_ID
        && metadata?.model_id === VOICE_CHANGER_MODEL_ID
      )
    ) return existing;
  }
  if (!env.ELEVENLABS_API_KEY?.trim() || !env.ELEVENLABS_VOICE_ID?.trim()) {
    throw new Error("请先在网站服务端配置 ELEVENLABS_API_KEY 和 ELEVENLABS_VOICE_ID。");
  }

  const source = await env.AUDIO_BUCKET.get(String(reference.storage_key));
  if (!source) throw new Error("原始参考音频记录存在，但 R2 文件缺失。");
  const sourceBytes = await source.arrayBuffer();
  if (!sourceBytes.byteLength) throw new Error("原始参考音频为空，不能生成标准 AI 声音。");

  const form = new FormData();
  form.set(
    "audio",
    new Blob([sourceBytes], { type: String(reference.mime_type || "application/octet-stream") }),
    String(reference.filename || "reference-audio"),
  );
  form.set("model_id", VOICE_CHANGER_MODEL_ID);
  form.set("file_format", "other");

  let response: Response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}?output_format=${VOICE_CHANGER_OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        body: form,
        signal: AbortSignal.timeout(210_000),
      },
    );
  } catch (error) {
    throw new Error(`无法连接 Eleven Voice Changer：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    throw new Error(`Eleven Voice Changer 生成失败（HTTP ${response.status}）：${detail}`);
  }
  const standardBytes = new Uint8Array(await response.arrayBuffer());
  if (!standardBytes.byteLength) throw new Error("Eleven Voice Changer 返回了空音频。");
  if (standardBytes.byteLength > 150 * 1024 * 1024) {
    throw new Error("标准 AI 音频超过 150 MB，不能保存。");
  }

  const assetId = id("asset");
  const createdAt = nextUpdatedAt(String(work.updated_at));
  const checksum = await sha256Hex(standardBytes.slice().buffer);
  const storageKey = `works/${work.id}/standard-ai/${assetId}.mp3`;
  const metadata = {
    source_asset_id: reference.id,
    voice_id: env.ELEVENLABS_VOICE_ID,
    model_id: VOICE_CHANGER_MODEL_ID,
    output_format: VOICE_CHANGER_OUTPUT_FORMAT,
    generated_at: createdAt,
  };
  await env.AUDIO_BUCKET.put(storageKey, standardBytes, {
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: {
      workId: String(work.id),
      assetId,
      checksum,
      kind: "standard_ai_audio",
      sourceAssetId: String(reference.id),
      voiceId: env.ELEVENLABS_VOICE_ID,
      model: VOICE_CHANGER_MODEL_ID,
    },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE assets SET kind = 'standard_ai_audio_archived' WHERE work_id = ? AND kind = 'standard_ai_audio'",
      ).bind(work.id),
      env.DB.prepare(
        `INSERT INTO assets
          (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms,
           checksum, provider, source_asset_id, metadata_json, created_at)
         VALUES (?, ?, 'standard_ai_audio', ?, ?, 'audio/mpeg', ?, NULL, ?, 'eleven', ?, ?, ?)`,
      ).bind(
        assetId,
        work.id,
        storageKey,
        `${String(work.slug)}-standard-ai.mp3`,
        standardBytes.byteLength,
        checksum,
        reference.id,
        JSON.stringify(metadata),
        createdAt,
      ),
      env.DB.prepare(
        "UPDATE works SET audio_sync_status = 'pending', status = 'analyzing', updated_at = ? WHERE id = ?",
      ).bind(createdAt, work.id),
    ]);
  } catch (error) {
    await env.AUDIO_BUCKET.delete(storageKey).catch(() => undefined);
    throw error;
  }
  const saved = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId));
  if (!saved) throw new Error("标准 AI 音频已经生成，但素材记录保存失败。");
  return saved;
}

function handoffSecret(env: Env) {
  return env.ANALYSIS_CALLBACK_TOKEN;
}

async function jobContext(env: Env, jobId: string) {
  const job = await first<Row>(env.DB.prepare(
      `SELECT j.*, w.title, w.author, w.source_text
       FROM processing_jobs j
       JOIN works w ON w.id = j.work_id
      WHERE j.id = ? AND j.type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')`,
  ).bind(jobId));
  if (!job) return null;
  const input = parseJson<{
    assetId?: string;
    standardAudioAssetId?: string;
    referenceAudioAssetId?: string;
    handoffExpiresAt?: number;
  }>(job.input_json as string | null);
  if (!input?.assetId) return null;
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(input.assetId));
  if (!asset || asset.work_id !== job.work_id) return null;
  const reference = input.referenceAudioAssetId
    ? await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ? AND work_id = ?").bind(
      input.referenceAudioAssetId,
      job.work_id,
    ))
    : asset.kind === "reference_audio" ? asset : null;
  return { job, asset, reference, input };
}

async function signedHandoffUrl(
  env: Env,
  origin: string,
  scope: "input" | "audio",
  jobId: string,
  assetId: string,
  expires: number,
) {
  const secret = handoffSecret(env);
  if (!secret) throw new Error("ANALYSIS_CALLBACK_TOKEN is not configured");
  const signature = await handoffSignature(secret, scope, jobId, assetId, expires);
  return `${origin}/api/internal/analysis-jobs/${encodeURIComponent(jobId)}/${scope}?expires=${expires}&signature=${encodeURIComponent(signature)}`;
}

async function verifyHandoff(request: Request, env: Env, scope: "input" | "audio", jobId: string, assetId: string) {
  const secret = handoffSecret(env);
  if (!secret) return false;
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature");
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || !signature) return false;
  const expected = await handoffSignature(secret, scope, jobId, assetId, expires);
  return secureSecretMatch(signature, expected);
}

async function failActiveAnalysisJob(
  env: Env,
  jobId: string,
  code: string,
  message: string,
) {
  const job = await first<Row>(env.DB.prepare(
    "SELECT id, work_id FROM processing_jobs WHERE id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')",
  ).bind(jobId));
  if (!job) return;
  const failedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'failed', progress = 0, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'processing')`,
    ).bind(code, message, failedAt, jobId),
    env.DB.prepare(
      `UPDATE works
          SET status = 'draft', updated_at = ?
        WHERE id = ? AND status = 'analyzing'
          AND EXISTS (
            SELECT 1 FROM processing_jobs
             WHERE id = ? AND status = 'failed'
          )`,
    ).bind(failedAt, job.work_id, jobId),
  ]);
}

function isStaleAnalysisJob(job: Row) {
  if (!["queued", "processing"].includes(String(job.status))) return false;
  const updatedAt = Date.parse(String(job.updated_at ?? job.created_at ?? ""));
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > ANALYSIS_JOB_TIMEOUT_MS;
}

async function expireStaleAnalysisJob(env: Env, job: Row) {
  if (!isStaleAnalysisJob(job)) return false;
  await failActiveAnalysisJob(
    env,
    String(job.id),
    "ANALYSIS_TIMED_OUT",
    "声音分析超过 12 分钟仍未返回终态，请重新发起分析。",
  );
  return true;
}

async function dispatchAnalysisJob(env: Env, origin: string, jobId: string) {
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_SERVICE_TOKEN) {
    throw new Error("ANALYSIS_SERVICE_URL or ANALYSIS_SERVICE_TOKEN is not configured");
  }
  const context = await jobContext(env, jobId);
  if (!context) throw new Error("分析任务缺少作品正文或参考音频上下文。");
  const expires = Number(context.input.handoffExpiresAt ?? 0);
  const inputUrl = await signedHandoffUrl(env, origin, "input", jobId, String(context.asset.id), expires);
  const audioUrl = await signedHandoffUrl(env, origin, "audio", jobId, String(context.asset.id), expires);
  await env.DB.prepare(
    "UPDATE processing_jobs SET status = 'processing', progress = 1, updated_at = ? WHERE id = ? AND status = 'queued'",
  ).bind(now(), jobId).run();
  const response = await fetch(`${serviceUrl}/v1/jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.ANALYSIS_SERVICE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      job_id: jobId,
      input_url: inputUrl,
      audio_url: audioUrl,
      callback_url: `${origin}/api/internal/analysis-jobs/${encodeURIComponent(jobId)}/callback`,
    }),
  });
  if (response.status === 524) {
    // The analysis function can legitimately outlive the proxy's synchronous
    // waiting window. Vercel keeps the in-flight function running and the
    // authenticated callback remains the sole owner of the terminal state.
    // Leave the job processing here; the existing 12-minute stale-job guard
    // still turns a genuinely lost callback into an explicit failure.
    return;
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(`分析服务拒绝任务（HTTP ${response.status}）：${detail}`);
  }
  let completion: Record<string, unknown>;
  try {
    completion = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("分析服务完成响应不是有效 JSON。");
  }
  if (
    String(completion.job_id ?? "") !== jobId
    || !["succeeded", "failed"].includes(String(completion.status ?? ""))
  ) {
    throw new Error("分析服务没有返回与当前任务匹配的终态。");
  }
  const stored = await first<Row>(env.DB.prepare(
    "SELECT status FROM processing_jobs WHERE id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')",
  ).bind(jobId));
  if (!stored || ["queued", "processing"].includes(String(stored.status))) {
    throw new Error("分析服务已结束，但终态回调没有写入网站。");
  }
}

async function dispatchInterpretationJob(env: Env, origin: string, jobId: string) {
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_SERVICE_TOKEN) {
    throw new Error("ANALYSIS_SERVICE_URL or ANALYSIS_SERVICE_TOKEN is not configured");
  }
  const job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, AI_TTS_ANALYSIS_JOB_TYPE));
  if (!job) throw new Error("找不到需要重新解析的声音分析任务。");
  const partial = parseJson<Record<string, unknown>>(job.output_json as string | null);
  const analysisPackage = partial?.analysis_package;
  if (!analysisPackage || typeof analysisPackage !== "object" || Array.isArray(analysisPackage)) {
    throw new Error("上次分析没有保留可复用的声学数据，请改用重新分析。");
  }
  await env.DB.prepare(
    "UPDATE processing_jobs SET status = 'processing', progress = 78, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
  ).bind(now(), jobId).run();
  const response = await fetch(`${serviceUrl}/v1/interpretation-jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.ANALYSIS_SERVICE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      job_id: jobId,
      callback_url: `${origin}/api/internal/analysis-jobs/${encodeURIComponent(jobId)}/callback`,
      analysis_package: analysisPackage,
    }),
  });
  if (response.status === 524) return;
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(`图谱解析服务拒绝任务（HTTP ${response.status}）：${detail}`);
  }
}

async function createAnalysisJob(env: Env, origin: string, workId: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法创建分析任务。");
  }
  if (!env.ANALYSIS_SERVICE_URL || !env.ANALYSIS_SERVICE_TOKEN || !env.ANALYSIS_CALLBACK_TOKEN || !handoffSecret(env)) {
    return apiError(503, "ANALYSIS_SERVICE_NOT_CONFIGURED", "云端朗诵分析服务尚未完成服务端配置。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  const reference = await first<Row>(env.DB.prepare(
    "SELECT * FROM assets WHERE work_id = ? AND kind = 'reference_audio' ORDER BY created_at DESC LIMIT 1",
  ).bind(workId));
  if (!reference) return apiError(409, "REFERENCE_AUDIO_REQUIRED", "请先上传真实参考朗诵音频。");
  let standardAudio: Row;
  try {
    standardAudio = await ensureStandardAiAudio(env, work, reference);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      "UPDATE works SET status = 'draft', audio_sync_status = 'pending', updated_at = ? WHERE id = ?",
    ).bind(now(), workId).run();
    return apiError(502, "VOICE_CHANGER_FAILED", message);
  }
  const currentWork = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!currentWork) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  let active = await first<Row>(env.DB.prepare(
    `SELECT * FROM processing_jobs
      WHERE work_id = ? AND type = 'standard_audio_analysis' AND status IN ('queued', 'processing')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(workId));
  if (active) {
    if (await expireStaleAnalysisJob(env, active)) {
      active = await first<Row>(env.DB.prepare(
        "SELECT * FROM processing_jobs WHERE id = ?",
      ).bind(active.id));
    }
    if (active && ["queued", "processing"].includes(String(active.status))) {
      return json({ analysis_job_id: active.id, work_id: workId, status: active.status });
    }
  }

  const jobId = id("job");
  const createdAt = nextUpdatedAt(String(currentWork.updated_at));
  const handoffExpiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO processing_jobs
         (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
       VALUES (?, ?, 'standard_audio_analysis', 'queued', 0, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      workId,
      `standard-audio-analysis:${workId}:${String(standardAudio.checksum)}:${jobId}`,
      JSON.stringify({
        assetId: standardAudio.id,
        standardAudioAssetId: standardAudio.id,
        referenceAudioAssetId: reference.id,
        audioSha256: standardAudio.checksum,
        handoffExpiresAt,
      }),
      createdAt,
      createdAt,
    ),
    env.DB.prepare("UPDATE works SET status = 'analyzing', updated_at = ? WHERE id = ?").bind(createdAt, workId),
  ]);
  try {
    // The Vercel endpoint intentionally stays open until its terminal callback
    // is persisted. Await it in the request lifetime: Cloudflare waitUntil is
    // not a durable queue and may end before multi-minute audio analysis does.
    await dispatchAnalysisJob(env, origin, jobId);
  } catch (error) {
    await failActiveAnalysisJob(
      env,
      jobId,
      "ANALYSIS_SUBMISSION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
  const completed = await first<Row>(env.DB.prepare(
    "SELECT status FROM processing_jobs WHERE id = ?",
  ).bind(jobId));
  const status = String(completed?.status ?? "failed");
  return json(
    { analysis_job_id: jobId, work_id: workId, status },
    ["queued", "processing"].includes(status) ? 202 : 200,
  );
}

async function createAnalysisJobFromRequest(request: Request, env: Env, origin: string) {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError(400, "INVALID_JSON", "创建分析任务必须提供有效的 JSON 对象。");
  }
  const workId = String(body.work_id ?? "").trim();
  if (!workId) return apiError(400, "WORK_ID_REQUIRED", "创建分析任务必须提供 work_id。");
  return createAnalysisJob(env, origin, workId);
}

async function getAnalysisJob(env: Env, jobId: string) {
  let job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
  if (!job || (!isAnalysisJobType(job.type) && job.type !== TEXT_RECITATION_JOB_TYPE)) {
    return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
  }
  if (job.type === TEXT_RECITATION_JOB_TYPE && ["queued", "processing"].includes(String(job.status))) {
    await refreshTextRecitationJob(env, job);
    job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
    if (!job) return apiError(404, "JOB_NOT_FOUND", "找不到文稿分析任务。");
  } else if (isAnalysisJobType(job.type) && await expireStaleAnalysisJob(env, job)) {
    job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
    if (!job) return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
  }
  const output = parseJson<Record<string, unknown>>(job.output_json as string | null);
  const payload: Record<string, unknown> = {
    analysis_job_id: job.id,
    work_id: job.work_id,
    status: job.status,
    progress: Number(job.progress ?? 0),
  };
  if (job.status === "failed") {
    payload.error = { code: job.error_code, message: job.error_message };
  }
  if (output?.analysis_package) payload.analysis_package = output.analysis_package;
  if (output?.control_spec) payload.control_spec = output.control_spec;
  if (job.status === "succeeded") payload.work = await getWorkPayload(env, String(job.work_id));
  return json(payload);
}

async function failTextRecitationJob(env: Env, jobId: string, workId: string, message: string) {
  const failedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'failed', progress = 100, error_code = 'TEXT_RECITATION_FAILED',
              error_message = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'processing')`,
    ).bind(message.slice(0, 1_200), failedAt, jobId),
    env.DB.prepare("UPDATE works SET status = 'draft', updated_at = ? WHERE id = ?").bind(failedAt, workId),
  ]);
}

async function finalizeTextRecitationJob(
  env: Env,
  job: Row,
  result: Record<string, unknown>,
) {
  if (String(job.status) === "succeeded") return;
  const workId = String(job.work_id);
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) throw new Error("找不到文稿分析任务对应的作品。");
  const rawControlSpec = result.control_spec;
  if (!rawControlSpec) throw new Error("文稿分析服务未返回 control_spec。");

  let normalizedSpec: Record<string, unknown>;
  try {
    normalizedSpec = importControlSpec(
      rawControlSpec,
      String(work.source_text),
      workId,
    ) as unknown as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`文稿分析返回的 control_spec 无法导入：${message}`);
  }

  const latest = await first<Row>(env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM control_spec_versions WHERE work_id = ?",
  ).bind(workId));
  const version = Number(latest?.version ?? 0) + 1;
  const specId = id("spec");
  const updated = { ...normalizedSpec, id: specId, workId, version };
  const savedAt = nextUpdatedAt(String(work.updated_at));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO control_spec_versions
         (id, work_id, version, schema_version, source, spec_json, validation_state, created_by, created_at)
       VALUES (?, ?, ?, ?, 'ai', ?, 'valid', 'ai', ?)`,
    ).bind(specId, workId, version, String(normalizedSpec.schemaVersion ?? "2.0"), JSON.stringify(updated), savedAt),
    env.DB.prepare(
      `UPDATE works
          SET current_spec_version_id = ?, status = 'review', audio_sync_status = 'pending',
              published_revision_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(specId, savedAt, workId),
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'succeeded', progress = 100, output_json = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'processing')`,
    ).bind(JSON.stringify({ control_spec: updated }), savedAt, job.id),
  ]);
}

async function refreshTextRecitationJob(env: Env, job: Row) {
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_SERVICE_TOKEN) {
    await failTextRecitationJob(env, String(job.id), String(job.work_id), "文稿分析服务尚未配置。");
    return;
  }
  const input = parseJson<Record<string, unknown>>(job.input_json as string | null) ?? {};
  const serviceTaskId = String(input.serviceTaskId ?? "");
  if (!serviceTaskId) {
    await failTextRecitationJob(env, String(job.id), String(job.work_id), "文稿分析后台任务编号缺失。");
    return;
  }
  try {
    const response = await fetch(
      `${serviceUrl}/v1/text-recitation-tasks/${encodeURIComponent(serviceTaskId)}`,
      {
        headers: { authorization: `Bearer ${env.ANALYSIS_SERVICE_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const rawBody = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (!response.ok) throw new Error(`后台文稿任务查询失败（HTTP ${response.status}）：${rawBody.slice(0, 300)}`);
    const status = String(payload.status ?? "");
    if (status === "completed") {
      const result = payload.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("文稿分析后台任务完成，但结果为空。");
      }
      await finalizeTextRecitationJob(env, job, result as Record<string, unknown>);
      return;
    }
    if (status === "failed") {
      await failTextRecitationJob(
        env,
        String(job.id),
        String(job.work_id),
        String(payload.error ?? "文稿分析后台任务失败。"),
      );
      return;
    }
    const progress = status === "running" ? 55 : 15;
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'processing', progress = ?, updated_at = ? WHERE id = ?",
    ).bind(progress, now(), job.id).run();
  } catch (error) {
    console.warn("text recitation task poll deferred", {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createTextRecitationJob(env: Env, workId: string) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_SERVICE_TOKEN) {
    return apiError(503, "ANALYSIS_SERVICE_NOT_CONFIGURED", "文稿分析服务尚未配置。");
  }

  // Preserve any human pinyin overrides from the current control spec so a
  // re-analysis never loses creator-authored readings.
  let pinyinOverrides: Record<string, unknown> = {};
  if (work.current_spec_version_id) {
    const existingSpec = await first<Row>(env.DB.prepare(
      "SELECT spec_json FROM control_spec_versions WHERE id = ?",
    ).bind(work.current_spec_version_id));
    const existing = parseJson<Record<string, unknown>>(existingSpec?.spec_json as string | null);
    const overrides = existing?.pinyin_overrides ?? existing?.pinyinOverrides;
    if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
      pinyinOverrides = overrides as Record<string, unknown>;
    }
  }

  const jobId = id("job");
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO processing_jobs
         (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 5, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      workId,
      TEXT_RECITATION_JOB_TYPE,
      `text-recitation:${workId}:${jobId}`,
      JSON.stringify({ workId }),
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      "UPDATE works SET status = 'analyzing', updated_at = ? WHERE id = ?",
    ).bind(createdAt, workId),
  ]);
  try {
    const response = await fetch(`${serviceUrl}/v1/text-recitation-tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ANALYSIS_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: String(work.title),
        author: String(work.author ?? ""),
        text: String(work.source_text),
        pinyin_overrides: pinyinOverrides,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`文稿分析服务返回 HTTP ${response.status}：${detail.slice(0, 400)}`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const serviceTaskId = String(payload.text_recitation_task_id ?? "");
    if (!serviceTaskId) throw new Error("文稿分析服务没有返回后台任务编号。");
    await env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'processing', progress = 10, input_json = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(JSON.stringify({ workId, serviceTaskId }), now(), jobId).run();
    return json({ analysis_job_id: jobId, work_id: workId, status: "processing", progress: 10 }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTextRecitationJob(env, jobId, workId, message);
    return apiError(502, "TEXT_RECITATION_FAILED", message);
  }
}

async function requestTtsDirection(env: Env, work: Row) {
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_SERVICE_TOKEN) {
    throw new Error("朗诵导演服务尚未完成服务端配置。");
  }
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/v1/tts-director`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ANALYSIS_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: String(work.title),
        author: String(work.author ?? ""),
        original_text: String(work.source_text),
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new Error(`朗诵方案生成失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const rawBody = await response.text();
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    payload = { detail: rawBody.slice(0, 700) };
  }
  if (!response.ok) {
    throw new Error(String(payload.detail ?? `朗诵方案生成失败（HTTP ${response.status}）`));
  }
  const performancePlan = payload.performancePlan;
  const ttsText = String(payload.ttsText ?? "");
  if (!performancePlan || typeof performancePlan !== "object" || Array.isArray(performancePlan) || !ttsText) {
    throw new Error("朗诵导演没有返回完整的 performancePlan 与 ttsText。");
  }
  const validation = validateTtsText(String(work.source_text), ttsText);
  return {
    performancePlan: performancePlan as Record<string, unknown>,
    ttsText,
    validation: {
      ...(payload.validation && typeof payload.validation === "object"
        ? payload.validation as Record<string, unknown>
        : {}),
      ...validation,
    },
    director: payload._meta && typeof payload._meta === "object"
      ? payload._meta as Record<string, unknown>
      : {},
  };
}

async function generateElevenTts(env: Env, ttsText: string) {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
  if (!apiKey || !voiceId) {
    throw new Error("请先在网站服务端配置 ElevenLabs 标准朗诵声音。");
  }
  const model = env.ELEVENLABS_TTS_MODEL?.trim() || ELEVEN_TTS_MODEL_ID;
  let response: Response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ELEVEN_TTS_OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: model,
        }),
        signal: AbortSignal.timeout(240_000),
      },
    );
  } catch (error) {
    throw new Error(`无法连接 ElevenLabs TTS：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    throw new Error(`AI 参考声音生成失败（HTTP ${response.status}）：${detail}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("ElevenLabs TTS 返回了空音频。");
  if (bytes.byteLength > 150 * 1024 * 1024) throw new Error("AI 参考音频超过 150 MB，不能保存。");
  return { bytes, model, voiceId };
}

function aiTtsAssetId(jobId: string) {
  return `asset_ai_tts_${jobId.replace(/^ai_tts_job_/, "")}`;
}

async function storeAiTtsAudio(
  env: Env,
  work: Row,
  job: Row,
  output: AiTtsJobOutput,
  generated: { bytes: Uint8Array; model: string; voiceId: string },
) {
  if (!output.ttsText) throw new Error("朗诵方案尚未保存，不能生成声音。");
  const assetId = aiTtsAssetId(String(job.id));
  const createdAt = nextUpdatedAt(String(work.updated_at));
  const checksum = await sha256Hex(generated.bytes.slice().buffer);
  const storageKey = `works/${work.id}/ai-tts/${job.id}.mp3`;
  const metadata = {
    generation_mode: "ai_tts",
    voice_id: generated.voiceId,
    model_id: generated.model,
    output_format: ELEVEN_TTS_OUTPUT_FORMAT,
    generated_at: createdAt,
    tts_job_id: job.id,
  };
  await env.AUDIO_BUCKET.put(storageKey, generated.bytes, {
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: {
      workId: String(work.id),
      assetId,
      checksum,
      kind: "standard_ai_audio",
      generationMode: "ai_tts",
      voiceId: generated.voiceId,
      model: generated.model,
    },
  });
  const nextOutput: AiTtsJobOutput = {
    ...output,
    audio: {
      assetId,
      model: generated.model,
      voiceId: generated.voiceId,
      createdAt,
    },
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE assets SET kind = 'standard_ai_audio_archived' WHERE work_id = ? AND kind = 'standard_ai_audio' AND id != ?",
      ).bind(work.id, assetId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO assets
          (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms,
           checksum, provider, source_asset_id, metadata_json, created_at)
         VALUES (?, ?, 'standard_ai_audio', ?, ?, 'audio/mpeg', ?, NULL, ?, 'eleven', NULL, ?, ?)`,
      ).bind(
        assetId,
        work.id,
        storageKey,
        `${String(work.slug)}-ai-reference.mp3`,
        generated.bytes.byteLength,
        checksum,
        JSON.stringify(metadata),
        createdAt,
      ),
      env.DB.prepare(
        `UPDATE assets SET kind = 'standard_ai_audio', storage_key = ?, filename = ?,
          mime_type = 'audio/mpeg', byte_size = ?, checksum = ?, provider = 'eleven',
          source_asset_id = NULL, metadata_json = ?, created_at = ?
          WHERE id = ? AND work_id = ?`,
      ).bind(
        storageKey,
        `${String(work.slug)}-ai-reference.mp3`,
        generated.bytes.byteLength,
        checksum,
        JSON.stringify(metadata),
        createdAt,
        assetId,
        work.id,
      ),
      env.DB.prepare(
        `UPDATE processing_jobs
            SET status = 'failed', progress = 0, error_code = 'ANALYSIS_AUDIO_REPLACED',
                error_message = '分析音频已被新的 AI 参考朗诵替换。', updated_at = ?
          WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis', 'ai_tts_audio_analysis')
            AND status IN ('queued', 'processing')`,
      ).bind(createdAt, work.id),
      env.DB.prepare(
        `UPDATE works SET audio_source_type = 'ai_tts', status = 'analyzing',
          audio_sync_status = 'pending', current_spec_version_id = NULL,
          published_revision_id = NULL, updated_at = ? WHERE id = ?`,
      ).bind(createdAt, work.id),
      env.DB.prepare(
        "UPDATE publications SET state = 'withdrawn', withdrawn_at = ? WHERE work_id = ? AND state = 'published'",
      ).bind(createdAt, work.id),
      env.DB.prepare(
        `UPDATE processing_jobs SET status = 'tts_audio_ready', progress = 50,
          output_json = ?, error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ? AND type = ?`,
      ).bind(JSON.stringify(nextOutput), createdAt, job.id, AI_TTS_GENERATION_JOB_TYPE),
    ]);
  } catch (error) {
    await env.AUDIO_BUCKET.delete(storageKey).catch(() => undefined);
    throw error;
  }
  return nextOutput;
}

async function enqueueAiTtsAnalysisJob(env: Env, work: Row, asset: Row) {
  const existing = await env.DB.prepare(
    `SELECT * FROM processing_jobs WHERE work_id = ? AND type = ? ORDER BY created_at DESC LIMIT 8`,
  ).bind(work.id, AI_TTS_ANALYSIS_JOB_TYPE).all<Row>();
  const matching = (existing.results ?? []).find((row) => {
    const input = parseJson<{ assetId?: string }>(row.input_json as string | null);
    return input?.assetId === asset.id && ["queued", "processing", "succeeded"].includes(String(row.status));
  });
  if (matching) return String(matching.id);
  const jobId = id("job");
  const createdAt = nextUpdatedAt(String(work.updated_at));
  const handoffExpiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO processing_jobs
        (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      work.id,
      AI_TTS_ANALYSIS_JOB_TYPE,
      `ai-tts-audio-analysis:${work.id}:${String(asset.checksum)}:${jobId}`,
      JSON.stringify({
        assetId: asset.id,
        standardAudioAssetId: asset.id,
        audioSha256: asset.checksum,
        handoffExpiresAt,
      }),
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      "UPDATE works SET audio_source_type = 'ai_tts', status = 'analyzing', updated_at = ? WHERE id = ?",
    ).bind(createdAt, work.id),
  ]);
  return jobId;
}

async function failAiTtsJob(env: Env, jobId: string, code: string, message: string) {
  await env.DB.prepare(
    `UPDATE processing_jobs SET status = 'error', progress = 100, error_code = ?,
      error_message = ?, updated_at = ? WHERE id = ? AND type = ?`,
  ).bind(code, message.slice(0, 1_200), now(), jobId, AI_TTS_GENERATION_JOB_TYPE).run();
}

async function runAiTtsJobStage(env: Env, origin: string, jobId: string) {
  let job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, AI_TTS_GENERATION_JOB_TYPE));
  if (!job || AI_TTS_TERMINAL_STATUSES.has(String(job.status))) return;
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(job.work_id));
  if (!work) {
    await failAiTtsJob(env, jobId, "WORK_NOT_FOUND", "AI 参考朗诵对应的作品不存在。");
    return;
  }
  const output = parseJson<AiTtsJobOutput>(job.output_json as string | null) ?? {};
  const leaseExpired = Date.now() - Date.parse(String(job.updated_at)) >= AI_TTS_JOB_LEASE_MS;
  try {
    if (job.status === "queued" || (job.status === "tts_plan_generating" && leaseExpired)) {
      const claim = await env.DB.prepare(
        `UPDATE processing_jobs SET status = 'tts_plan_generating', progress = 8, updated_at = ?
          WHERE id = ? AND type = ? AND status = ? AND updated_at = ?`,
      ).bind(now(), jobId, AI_TTS_GENERATION_JOB_TYPE, job.status, job.updated_at).run();
      if (!Number(claim.meta.changes ?? 0)) return;
      let direction: Awaited<ReturnType<typeof requestTtsDirection>>;
      try {
        direction = await requestTtsDirection(env, work);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failAiTtsJob(
          env,
          jobId,
          message.includes("TTS 脚本与原文不一致") ? "TTS_TEXT_MISMATCH" : "TTS_PLAN_GENERATION_FAILED",
          message.includes("TTS 脚本与原文不一致") ? "TTS 脚本与原文不一致" : message,
        );
        return;
      }
      await env.DB.prepare(
        `UPDATE processing_jobs SET status = 'tts_plan_ready', progress = 25, output_json = ?,
          error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND type = ?`,
      ).bind(JSON.stringify(direction), now(), jobId, AI_TTS_GENERATION_JOB_TYPE).run();
      return;
    }

    if (job.status === "tts_plan_ready" || (job.status === "tts_audio_generating" && leaseExpired)) {
      const claim = await env.DB.prepare(
        `UPDATE processing_jobs SET status = 'tts_audio_generating', progress = 35, updated_at = ?
          WHERE id = ? AND type = ? AND status = ? AND updated_at = ?`,
      ).bind(now(), jobId, AI_TTS_GENERATION_JOB_TYPE, job.status, job.updated_at).run();
      if (!Number(claim.meta.changes ?? 0)) return;
      try {
        validateTtsText(String(work.source_text), String(output.ttsText ?? ""));
        const generated = await generateElevenTts(env, String(output.ttsText));
        job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
        if (!job) throw new Error("AI 参考朗诵任务不存在。");
        await storeAiTtsAudio(env, work, job, output, generated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failAiTtsJob(
          env,
          jobId,
          message.includes("TTS 脚本与原文不一致") ? "TTS_TEXT_MISMATCH" : "TTS_AUDIO_GENERATION_FAILED",
          message,
        );
      }
      return;
    }

    if (job.status === "tts_audio_ready") {
      const assetId = output.audio?.assetId;
      const asset = assetId
        ? await first<Row>(env.DB.prepare(
          "SELECT * FROM assets WHERE id = ? AND work_id = ? AND kind = 'standard_ai_audio'",
        ).bind(assetId, work.id))
        : null;
      if (!asset) {
        await failAiTtsJob(env, jobId, "TTS_AUDIO_MISSING", "AI 参考声音记录存在，但音频文件不可用。");
        return;
      }
      const analysisJobId = await enqueueAiTtsAnalysisJob(env, work, asset);
      await env.DB.prepare(
        `UPDATE processing_jobs SET status = 'audio_analyzing', progress = 58,
          output_json = ?, error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ? AND type = ?`,
      ).bind(
        JSON.stringify({ ...output, analysisJobId }),
        now(),
        jobId,
        AI_TTS_GENERATION_JOB_TYPE,
      ).run();
      return;
    }

    if (job.status === "audio_analyzing" || job.status === "llm_interpreting") {
      const analysisJobId = output.analysisJobId;
      if (!analysisJobId) {
        await env.DB.prepare(
          `UPDATE processing_jobs SET status = 'tts_audio_ready', progress = 50, updated_at = ?
            WHERE id = ? AND type = ?`,
        ).bind(now(), jobId, AI_TTS_GENERATION_JOB_TYPE).run();
        return;
      }
      let analysisJob = await first<Row>(env.DB.prepare(
        "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
      ).bind(analysisJobId, AI_TTS_ANALYSIS_JOB_TYPE));
      if (!analysisJob) {
        await failAiTtsJob(env, jobId, "ANALYSIS_JOB_MISSING", "AI 参考声音已生成，但分析任务不存在。");
        return;
      }
      if (analysisJob.status === "queued") {
        try {
          if (job.status === "llm_interpreting" && output.retryInterpretation) {
            await dispatchInterpretationJob(env, origin, analysisJobId);
          } else {
            await dispatchAnalysisJob(env, origin, analysisJobId);
          }
        } catch (error) {
          await failActiveAnalysisJob(
            env,
            analysisJobId,
            "ANALYSIS_SUBMISSION_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
        analysisJob = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(analysisJobId));
        if (!analysisJob) return;
      }
      if (analysisJob.status === "succeeded") {
        await env.DB.prepare(
          `UPDATE processing_jobs SET status = 'graph_ready', progress = 100,
            error_code = NULL, error_message = NULL, updated_at = ?
            WHERE id = ? AND type = ?`,
        ).bind(now(), jobId, AI_TTS_GENERATION_JOB_TYPE).run();
      } else if (analysisJob.status === "failed") {
        await failAiTtsJob(
          env,
          jobId,
          String(analysisJob.error_code ?? "AUDIO_ANALYSIS_FAILED"),
          String(analysisJob.error_message ?? "AI 参考声音已经生成，但声学分析失败。"),
        );
      } else {
        const rawProgress = Number(analysisJob.progress ?? 0);
        const progress = Math.min(96, Math.max(58, 58 + rawProgress * 0.38));
        await env.DB.prepare(
          "UPDATE processing_jobs SET status = ?, progress = ?, updated_at = ? WHERE id = ? AND type = ?",
        ).bind(
          rawProgress >= 78 ? "llm_interpreting" : "audio_analyzing",
          Math.round(progress),
          now(),
          jobId,
          AI_TTS_GENERATION_JOB_TYPE,
        ).run();
      }
    }
  } catch (error) {
    await failAiTtsJob(
      env,
      jobId,
      "AI_TTS_JOB_FAILED",
      safeVisualErrorMessage(env, error),
    );
  }
}

async function createAiTtsJob(env: Env, workId: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法生成 AI 参考朗诵。");
  }
  if (!env.ANALYSIS_SERVICE_URL || !env.ANALYSIS_SERVICE_TOKEN) {
    return apiError(503, "TTS_DIRECTOR_NOT_CONFIGURED", "GPT-5.6 Sol 朗诵导演服务尚未配置。");
  }
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    return apiError(503, "ELEVEN_TTS_NOT_CONFIGURED", "ElevenLabs 标准朗诵声音尚未配置。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  if (!String(work.title).trim() || !String(work.source_text).trim()) {
    return apiError(400, "WORK_TEXT_REQUIRED", "请先填写作品名称和完整正文。");
  }
  const active = await first<Row>(env.DB.prepare(
    `SELECT * FROM processing_jobs WHERE work_id = ? AND type = ?
      AND status NOT IN ('graph_ready', 'error') ORDER BY created_at DESC LIMIT 1`,
  ).bind(workId, AI_TTS_GENERATION_JOB_TYPE));
  if (active) {
    return json({
      ai_tts_job_id: active.id,
      work_id: workId,
      status: active.status,
      progress: Number(active.progress ?? 0),
    }, 202);
  }
  const jobId = id("ai_tts_job");
  const createdAt = nextUpdatedAt(String(work.updated_at));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO processing_jobs
        (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      workId,
      AI_TTS_GENERATION_JOB_TYPE,
      `ai-tts-generation:${workId}:${jobId}`,
      JSON.stringify({ sourceTextChecksum: await sha256Hex(new TextEncoder().encode(String(work.source_text)).buffer) }),
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      "UPDATE works SET audio_source_type = 'ai_tts', updated_at = ? WHERE id = ?",
    ).bind(createdAt, workId),
  ]);
  return json({ ai_tts_job_id: jobId, work_id: workId, status: "queued", progress: 0 }, 202);
}

async function getAiTtsJob(env: Env, origin: string, jobId: string) {
  let job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, AI_TTS_GENERATION_JOB_TYPE));
  if (!job) return apiError(404, "AI_TTS_JOB_NOT_FOUND", "找不到 AI 参考朗诵任务。");
  if (!AI_TTS_TERMINAL_STATUSES.has(String(job.status))) {
    await runAiTtsJobStage(env, origin, jobId);
    job = await first<Row>(env.DB.prepare(
      "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
    ).bind(jobId, AI_TTS_GENERATION_JOB_TYPE));
    if (!job) return apiError(404, "AI_TTS_JOB_NOT_FOUND", "找不到 AI 参考朗诵任务。");
  }
  const output = parseJson<AiTtsJobOutput>(job.output_json as string | null) ?? {};
  return json({
    ai_tts_job_id: job.id,
    work_id: job.work_id,
    status: job.status,
    progress: Number(job.progress ?? 0),
    performance_plan: output.performancePlan,
    tts_text: output.ttsText,
    audio_asset_id: output.audio?.assetId,
    analysis_job_id: output.analysisJobId,
    error: job.error_code ? { code: job.error_code, message: job.error_message } : undefined,
    work: await getWorkPayload(env, String(job.work_id)),
  });
}

async function retryAiTtsJob(
  env: Env,
  jobId: string,
  stage: "audio" | "analysis" | "interpretation",
) {
  const job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, AI_TTS_GENERATION_JOB_TYPE));
  if (!job) return apiError(404, "AI_TTS_JOB_NOT_FOUND", "找不到 AI 参考朗诵任务。");
  const output = parseJson<AiTtsJobOutput>(job.output_json as string | null) ?? {};
  if (stage === "audio" && !output.ttsText) {
    return apiError(409, "TTS_PLAN_REQUIRED", "朗诵方案尚未生成，不能单独重试声音。");
  }
  if ((stage === "analysis" || stage === "interpretation") && !output.audio?.assetId) {
    return apiError(409, "TTS_AUDIO_REQUIRED", "AI 参考声音尚未生成，不能单独重新分析。");
  }
  if (stage === "interpretation") {
    const analysisJobId = output.analysisJobId;
    if (!analysisJobId) {
      return apiError(409, "ANALYSIS_JOB_REQUIRED", "没有可复用的声音分析任务，请改用重新分析。");
    }
    const analysisJob = await first<Row>(env.DB.prepare(
      "SELECT output_json FROM processing_jobs WHERE id = ? AND type = ?",
    ).bind(analysisJobId, AI_TTS_ANALYSIS_JOB_TYPE));
    const partial = parseJson<Record<string, unknown>>(analysisJob?.output_json as string | null);
    if (!partial?.analysis_package) {
      return apiError(409, "ACOUSTIC_DATA_REQUIRED", "上次任务没有保留声学数据，请改用重新分析。");
    }
    await env.DB.prepare(
      `UPDATE processing_jobs SET status = 'queued', progress = 72,
        error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND type = ?`,
    ).bind(now(), analysisJobId, AI_TTS_ANALYSIS_JOB_TYPE).run();
  }
  const nextOutput = stage === "analysis"
    ? { ...output, analysisJobId: undefined, retryInterpretation: undefined }
    : stage === "interpretation"
      ? { ...output, retryInterpretation: true }
      : output;
  const nextStatus = stage === "analysis"
    ? "tts_audio_ready"
    : stage === "interpretation" ? "llm_interpreting" : "tts_plan_ready";
  const nextProgress = stage === "analysis" ? 50 : stage === "interpretation" ? 78 : 25;
  await env.DB.prepare(
    `UPDATE processing_jobs SET status = ?, progress = ?, output_json = ?,
      error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND type = ?`,
  ).bind(
    nextStatus,
    nextProgress,
    JSON.stringify(nextOutput),
    now(),
    jobId,
    AI_TTS_GENERATION_JOB_TYPE,
  ).run();
  return json({ ai_tts_job_id: jobId, work_id: job.work_id, status: nextStatus, progress: nextProgress }, 202);
}

async function getAnalysisInput(request: Request, env: Env, jobId: string) {
  const context = await jobContext(env, jobId);
  if (!context) return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务或参考素材。");
  if (
    !["queued", "processing"].includes(String(context.job.status))
    || !["standard_ai_audio", "reference_audio"].includes(String(context.asset.kind))
  ) {
    return apiError(409, "JOB_NOT_ACTIVE", "声音分析任务已失效，请重新发起分析。");
  }
  if (!await verifyHandoff(request, env, "input", jobId, String(context.asset.id))) {
    return apiError(401, "INVALID_HANDOFF_TOKEN", "分析任务交接链接无效或已过期。");
  }
  return json({
    work: {
      id: context.job.work_id,
      title: context.job.title,
      author: context.job.author ?? "",
      full_text: context.job.source_text,
    },
    analysis_audio: {
      asset_id: context.asset.id,
      filename: context.asset.filename,
      mime_type: context.asset.mime_type,
      duration_ms: context.asset.duration_ms == null ? undefined : Number(context.asset.duration_ms),
      role: context.asset.kind,
    },
    standard_ai_audio: context.asset.kind === "standard_ai_audio" ? {
      asset_id: context.asset.id,
      filename: context.asset.filename,
      mime_type: context.asset.mime_type,
      duration_ms: context.asset.duration_ms == null ? undefined : Number(context.asset.duration_ms),
      source_asset_id: context.asset.source_asset_id,
    } : undefined,
    reference_audio_original: context.reference ? referenceAssetPayload(context.reference) : undefined,
    // Legacy analysis-service versions read this field. For new jobs it still
    // points to the standard AI audio, never the original human recording.
    reference_audio: {
      asset_id: context.asset.id,
      filename: context.asset.filename,
      mime_type: context.asset.mime_type,
      duration_ms: context.asset.duration_ms == null ? undefined : Number(context.asset.duration_ms),
    },
  });
}

async function getAnalysisAudio(request: Request, env: Env, jobId: string) {
  const context = await jobContext(env, jobId);
  if (!context) return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务或参考素材。");
  if (
    !["queued", "processing"].includes(String(context.job.status))
    || !["standard_ai_audio", "reference_audio"].includes(String(context.asset.kind))
  ) {
    return apiError(409, "JOB_NOT_ACTIVE", "声音分析任务已失效，请重新发起分析。");
  }
  if (!await verifyHandoff(request, env, "audio", jobId, String(context.asset.id))) {
    return apiError(401, "INVALID_HANDOFF_TOKEN", "分析音频链接无效或已过期。");
  }
  const object = await env.AUDIO_BUCKET.get(String(context.asset.storage_key));
  if (!object) return apiError(404, "ASSET_OBJECT_NOT_FOUND", "分析音频记录存在，但 R2 文件缺失。");
  return new Response(object.body, {
    headers: {
      "content-type": String(context.asset.mime_type),
      "content-length": String(context.asset.byte_size),
      "content-disposition": `attachment; filename="${safeFilename(String(context.asset.filename))}"`,
      "cache-control": "private, no-store",
    },
  });
}

async function failAnalysisCallback(env: Env, job: Row, code: string, message: string, output?: unknown) {
  const failedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'failed', progress = 0, output_json = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(output ? JSON.stringify(output) : null, code, message, failedAt, job.id),
    env.DB.prepare("UPDATE works SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'analyzing'")
      .bind(failedAt, job.work_id),
  ]);
}

async function analysisCallback(request: Request, env: Env, jobId: string) {
  if (!await secureSecretMatch(bearer(request), env.ANALYSIS_CALLBACK_TOKEN)) {
    return apiError(401, "INVALID_CALLBACK_TOKEN", "分析回调身份校验失败。");
  }
  const job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
  if (!job || !isAnalysisJobType(job.type)) return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError(400, "INVALID_JSON", "分析回调必须是有效的 JSON 对象。");
  }
  if (body.job_id !== undefined && String(body.job_id) !== jobId) {
    return apiError(409, "JOB_ID_MISMATCH", "分析回调中的 job_id 与回调地址不一致。");
  }
  if (job.status === "failed") return json({ ok: true, duplicate: true });
  if (body.status === "processing") {
    const progress = Math.min(99, Math.max(1, Math.round(Number(body.progress ?? 10))));
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'processing', progress = ?, updated_at = ? WHERE id = ? AND status != 'succeeded'",
    ).bind(progress, now(), jobId).run();
    return json({ ok: true });
  }
  if (body.status === "failed") {
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : body;
    const partialOutput = body.analysis_package && typeof body.analysis_package === "object"
      ? { analysis_package: body.analysis_package, stage: body.stage ?? "audio_analyzing" }
      : undefined;
    await failAnalysisCallback(
      env,
      job,
      String(error.code ?? error.error_code ?? "ANALYSIS_FAILED"),
      String(error.message ?? error.error_message ?? "声音分析失败。"),
      partialOutput,
    );
    return json({ ok: true });
  }
  if (body.status !== "succeeded") {
    return apiError(422, "INVALID_JOB_STATUS", "分析回调 status 只允许 processing、succeeded 或 failed。");
  }
  if (job.status === "succeeded") return json({ ok: true, duplicate: true });
  if (!["queued", "processing"].includes(String(job.status))) {
    return apiError(409, "JOB_NOT_ACTIVE", "声音分析任务已失效，回调结果未被写入。");
  }

  const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : body;
  const analysisPackage = result.analysis_package as Record<string, unknown> | undefined;
  const rawControlSpec = result.control_spec;
  const tokens = Array.isArray(analysisPackage?.tokens)
    ? analysisPackage.tokens as Array<Record<string, unknown>>
    : [];
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(job.work_id));
  const input = parseJson<{
    assetId?: string;
    standardAudioAssetId?: string;
    referenceAudioAssetId?: string;
  }>(job.input_json as string | null);
  if (!work || !input?.assetId) return apiError(409, "JOB_CONTEXT_MISSING", "分析任务关联的作品或参考音频不存在。");
  const analysisAsset = await first<Row>(env.DB.prepare(
    "SELECT * FROM assets WHERE id = ? AND work_id = ?",
  ).bind(input.assetId, work.id));
  const currentReference = await first<Row>(env.DB.prepare(
    "SELECT id FROM assets WHERE work_id = ? AND kind = 'reference_audio' ORDER BY created_at DESC LIMIT 1",
  ).bind(work.id));
  const currentStandard = await first<Row>(env.DB.prepare(
    "SELECT id, source_asset_id FROM assets WHERE work_id = ? AND kind = 'standard_ai_audio' ORDER BY created_at DESC LIMIT 1",
  ).bind(work.id));
  const usesAiTts = job.type === AI_TTS_ANALYSIS_JOB_TYPE;
  const usesStandardAudio = job.type === STANDARD_ANALYSIS_JOB_TYPE || usesAiTts;
  const analysisAssetMetadata = parseJson<Record<string, unknown>>(analysisAsset?.metadata_json as string | null);
  const staleInput = usesAiTts
    ? !analysisAsset
      || analysisAsset.kind !== "standard_ai_audio"
      || currentStandard?.id !== input.assetId
      || analysisAssetMetadata?.generation_mode !== "ai_tts"
    : usesStandardAudio
      ? !analysisAsset
        || analysisAsset.kind !== "standard_ai_audio"
        || currentStandard?.id !== input.assetId
        || currentReference?.id !== input.referenceAudioAssetId
        || currentStandard.source_asset_id !== input.referenceAudioAssetId
    : currentReference?.id !== input.assetId;
  if (staleInput) {
    const message = "本次分析使用的声音素材已被替换，旧结果不会写入当前作品。";
    await failAnalysisCallback(env, job, "JOB_INPUT_STALE", message, { analysis_package: analysisPackage ?? null });
    return apiError(409, "JOB_INPUT_STALE", message);
  }
  if (usesStandardAudio) {
    const analyzedAudio = analysisPackage?.audio && typeof analysisPackage.audio === "object"
      ? analysisPackage.audio as Record<string, unknown>
      : {};
    const returnedRole = String(
      analysisPackage?.analyzed_audio_role ?? analyzedAudio.role ?? "",
    );
    const returnedAssetId = String(
      analysisPackage?.standard_ai_audio_asset_id ?? analyzedAudio.asset_id ?? "",
    );
    if (returnedRole !== "standard_ai_audio" || returnedAssetId !== String(input.assetId)) {
      const message = "分析服务返回的声音来源不是当前 standard_ai_audio，结果已拒绝写入。";
      await failAnalysisCallback(env, job, "ANALYSIS_AUDIO_PROVENANCE_MISMATCH", message, {
        analysis_package: analysisPackage ?? null,
      });
      return apiError(422, "ANALYSIS_AUDIO_PROVENANCE_MISMATCH", message);
    }
  }
  const alignedText = tokens.map((token) => String(token.char ?? "")).join("");
  if (!analysisPackage || !tokens.length || alignedText !== work.source_text) {
    const message = "分析结果 tokens 与保存的完整正文不一致，已拒绝写入控制谱。";
    await failAnalysisCallback(env, job, "TEXT_ALIGNMENT_MISMATCH", message, { analysis_package: analysisPackage ?? null });
    return apiError(422, "TEXT_ALIGNMENT_MISMATCH", message);
  }
  if (rawControlSpec === undefined) {
    const message = "分析服务没有返回 control_spec，任务不能标记为完成。";
    await failAnalysisCallback(env, job, "CONTROL_SPEC_REQUIRED", message, { analysis_package: analysisPackage });
    return apiError(422, "CONTROL_SPEC_REQUIRED", message);
  }

  let normalizedSpec: Record<string, unknown>;
  try {
    normalizedSpec = withDynamicTimingProfile(
      importControlSpec(
        rawControlSpec,
        String(work.source_text),
        String(work.id),
        input.assetId,
        usesStandardAudio ? input.referenceAudioAssetId : undefined,
      ),
      analysisPackage,
    );
    const provenance = normalizedSpec.analysisProvenance && typeof normalizedSpec.analysisProvenance === "object"
      ? normalizedSpec.analysisProvenance as Record<string, unknown>
      : {};
    const pipeline = body.pipeline && typeof body.pipeline === "object" ? body.pipeline as Record<string, unknown> : {};
    normalizedSpec = {
      ...normalizedSpec,
      source: "ai",
      analysisProvenance: {
        ...provenance,
        referenceAudioAssetId: usesAiTts
          ? undefined
          : usesStandardAudio
          ? input.referenceAudioAssetId
          : input.assetId,
        referenceAudioOriginalAssetId: usesAiTts
          ? undefined
          : usesStandardAudio
          ? input.referenceAudioAssetId
          : undefined,
        standardAiAudioAssetId: usesStandardAudio ? input.assetId : undefined,
        analyzedAudioRole: usesStandardAudio ? "standard_ai_audio" : "reference_audio",
        pipelineVersion: String(
          pipeline.version
          ?? (usesAiTts
            ? "recitation-analysis-2.1-ai-tts-audio"
            : usesStandardAudio ? "recitation-analysis-2.0-standard-audio" : "recitation-analysis-1.0"),
        ),
        alignmentModel: pipeline.alignment ? String(pipeline.alignment) : provenance.alignmentModel,
        acousticModel: pipeline.acoustics ? String(pipeline.acoustics) : provenance.acousticModel,
        languageModel: pipeline.language_model ? String(pipeline.language_model) : provenance.languageModel,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failAnalysisCallback(env, job, "INVALID_CONTROL_SPEC", message, { analysis_package: analysisPackage });
    return apiError(422, "INVALID_CONTROL_SPEC", message);
  }

  const completedAt = now();
  const durationMs = Number((analysisPackage.audio as Record<string, unknown> | undefined)?.duration_ms ?? 0);
  const latest = await first<Row>(env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM control_spec_versions WHERE work_id = ?",
  ).bind(work.id));
  const version = Number(latest?.version ?? 0) + 1;
  const specId = id("spec");
  const savedSpec = { ...normalizedSpec, id: specId, workId: work.id, version };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO control_spec_versions
         (id, work_id, version, schema_version, source, spec_json, validation_state, created_by, created_at)
       VALUES (?, ?, ?, '2.0', 'analysis_service', ?, 'valid', 'system', ?)`,
    ).bind(specId, work.id, version, JSON.stringify(savedSpec), completedAt),
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'succeeded', progress = 100, output_json = ?,
              error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'processing')`,
    ).bind(JSON.stringify({ analysis_package: analysisPackage, control_spec: savedSpec, pipeline: body.pipeline ?? null }), completedAt, jobId),
    env.DB.prepare(
      `UPDATE works
          SET current_spec_version_id = ?, status = 'review', audio_sync_status = ?,
              published_revision_id = NULL, updated_at = ?
        WHERE id = ? AND source_text = ?
          AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND work_id = ? AND kind = ?)`,
    ).bind(
      specId,
      usesStandardAudio ? "synced" : "pending",
      completedAt,
      work.id,
      work.source_text,
      input.assetId,
      work.id,
      usesStandardAudio ? "standard_ai_audio" : "reference_audio",
    ),
    env.DB.prepare("UPDATE assets SET duration_ms = COALESCE(?, duration_ms) WHERE id = ?")
      .bind(durationMs > 0 ? Math.round(durationMs) : null, input.assetId),
  ];
  if (usesStandardAudio && analysisAsset) {
    const audioVersionId = id("audio");
    const voiceMetadata = parseJson<Record<string, unknown>>(analysisAsset.metadata_json as string | null);
    const aiTtsJob = usesAiTts
      ? await first<Row>(env.DB.prepare(
        `SELECT output_json FROM processing_jobs
          WHERE work_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(work.id, AI_TTS_GENERATION_JOB_TYPE))
      : null;
    const aiTtsOutput = parseJson<AiTtsJobOutput>(aiTtsJob?.output_json as string | null);
    const promptTrace = usesAiTts ? {
      performancePlan: aiTtsOutput?.performancePlan,
      validation: aiTtsOutput?.validation,
      director: aiTtsOutput?.director,
    } : undefined;
    statements.push(
      env.DB.prepare(
        `UPDATE audio_versions SET candidate_state = 'superseded'
          WHERE work_id = ? AND audio_asset_id IN (
            SELECT id FROM assets WHERE work_id = ? AND kind LIKE 'standard_ai_audio%'
          )`,
      ).bind(work.id, work.id),
      env.DB.prepare(
        `INSERT INTO audio_versions
          (id, work_id, control_spec_version_id, audio_asset_id, provider, model, voice_id,
           prompt_text, prompt_trace_json, timeline_json, duration_ms, candidate_state, created_at)
         VALUES (?, ?, ?, ?, 'eleven', ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
      ).bind(
        audioVersionId,
        work.id,
        specId,
        input.assetId,
        String(voiceMetadata?.model_id ?? VOICE_CHANGER_MODEL_ID),
        String(voiceMetadata?.voice_id ?? env.ELEVENLABS_VOICE_ID ?? ""),
        usesAiTts ? String(aiTtsOutput?.ttsText ?? "") : "",
        promptTrace ? JSON.stringify(promptTrace) : null,
        JSON.stringify(analysisTimeline(analysisPackage)),
        Math.max(0, Math.round(durationMs)),
        completedAt,
      ),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true, work: await getWorkPayload(env, String(work.id)) });
}

function validateControlSpec(spec: Record<string, unknown>, sourceText: string) {
  const tokens = Array.isArray(spec.tokens) ? spec.tokens as Array<Record<string, unknown>> : [];
  const chars = Array.from(sourceText);
  if (tokens.length !== chars.length) throw new Error("控制谱 tokens 数量与正文不一致。");
  tokens.forEach((token, index) => {
    if (Number(token.index) !== index || token.char !== chars[index]) {
      throw new Error(`控制谱 token ${index} 与保存的正文不一致。`);
    }
  });
  if (!Array.isArray(spec.sentences) || !spec.sentences.length) {
    throw new Error("控制谱缺少 sentences。");
  }
  (spec.sentences as unknown[]).forEach((sentenceValue, sentencePosition) => {
    const sentence = sentenceValue && typeof sentenceValue === "object" && !Array.isArray(sentenceValue)
      ? sentenceValue as Record<string, unknown>
      : {};
    const sentenceTokens = Array.isArray(sentence.tokens)
      ? sentence.tokens as Array<Record<string, unknown>>
      : [];
    const sentenceTokensByIndex = new Map(sentenceTokens.flatMap((token) => {
      const tokenIndex = Number(token.index);
      return Number.isInteger(tokenIndex) ? [[tokenIndex, token] as const] : [];
    }));
    const breaths = sentence.breaths;
    if (breaths !== undefined && !Array.isArray(breaths)) {
      throw new Error(`第 ${sentencePosition + 1} 句的换气标识必须是数组。`);
    }
    const seenBoundaries = new Set<number>();
    (Array.isArray(breaths) ? breaths : []).forEach((breathValue) => {
      const breath = breathValue && typeof breathValue === "object" && !Array.isArray(breathValue)
        ? breathValue as Record<string, unknown>
        : {};
      const afterTokenIndex = Number(breath.afterTokenIndex);
      const token = sentenceTokensByIndex.get(afterTokenIndex);
      if (!Number.isInteger(afterTokenIndex) || !token) {
        throw new Error(`第 ${sentencePosition + 1} 句的换气标识引用了无效 token index。`);
      }
      if (seenBoundaries.has(afterTokenIndex)) {
        throw new Error(`第 ${sentencePosition + 1} 句的同一位置不能保存多个换气标识。`);
      }
      seenBoundaries.add(afterTokenIndex);
      if (breath.type !== "breath_major" && breath.type !== "breath_minor") {
        throw new Error(`第 ${sentencePosition + 1} 句包含不支持的换气类型。`);
      }
      if (String(breath.afterTokenId ?? "") !== String(token.id ?? "")) {
        throw new Error(`第 ${sentencePosition + 1} 句的换气标识与 token id 不一致。`);
      }
    });
    const sceneTechniqueMarks = sentence.sceneTechniqueMarks;
    if (sceneTechniqueMarks !== undefined && !Array.isArray(sceneTechniqueMarks)) {
      throw new Error(`第 ${sentencePosition + 1} 句的实景/虚景标识必须是数组。`);
    }
    const sceneTechniqueTokens = new Set<number>();
    (Array.isArray(sceneTechniqueMarks) ? sceneTechniqueMarks : []).forEach((markValue) => {
      const mark = markValue && typeof markValue === "object" && !Array.isArray(markValue)
        ? markValue as Record<string, unknown>
        : {};
      const tokenIndex = Number(mark.tokenIndex);
      const token = sentenceTokensByIndex.get(tokenIndex);
      if (!Number.isInteger(tokenIndex) || !token) {
        throw new Error(`第 ${sentencePosition + 1} 句的实景/虚景标识引用了无效 token index。`);
      }
      if (sceneTechniqueTokens.has(tokenIndex)) {
        throw new Error(`第 ${sentencePosition + 1} 句的同一文字不能保存多个实景/虚景标识。`);
      }
      sceneTechniqueTokens.add(tokenIndex);
      if (mark.type !== "real" && mark.type !== "virtual") {
        throw new Error(`第 ${sentencePosition + 1} 句包含不支持的实景/虚景类型。`);
      }
      if (String(mark.tokenId ?? "") !== String(token.id ?? "")) {
        throw new Error(`第 ${sentencePosition + 1} 句的实景/虚景标识与 token id 不一致。`);
      }
    });
    const deliveryTechniqueMarks = sentence.deliveryTechniqueMarks;
    if (deliveryTechniqueMarks !== undefined && !Array.isArray(deliveryTechniqueMarks)) {
      throw new Error(`第 ${sentencePosition + 1} 句的虚声/远近景标识必须是数组。`);
    }
    const deliveryTechniqueGroups = new Set<string>();
    (Array.isArray(deliveryTechniqueMarks) ? deliveryTechniqueMarks : []).forEach((markValue) => {
      const mark = markValue && typeof markValue === "object" && !Array.isArray(markValue)
        ? markValue as Record<string, unknown>
        : {};
      const tokenIndex = Number(mark.tokenIndex);
      const token = sentenceTokensByIndex.get(tokenIndex);
      if (!Number.isInteger(tokenIndex) || !token) {
        throw new Error(`第 ${sentencePosition + 1} 句的虚声/远近景标识引用了无效 token index。`);
      }
      if (
        mark.type !== "virtual_voice"
        && mark.type !== "distant_view"
        && mark.type !== "close_view"
      ) {
        throw new Error(`第 ${sentencePosition + 1} 句包含不支持的虚声/远近景类型。`);
      }
      const group = mark.type === "virtual_voice" ? "voice" : "distance";
      const groupKey = `${tokenIndex}:${group}`;
      if (deliveryTechniqueGroups.has(groupKey)) {
        throw new Error(`第 ${sentencePosition + 1} 句的同一文字不能保存多个同类虚声/远近景标识。`);
      }
      deliveryTechniqueGroups.add(groupKey);
      if (String(mark.tokenId ?? "") !== String(token.id ?? "")) {
        throw new Error(`第 ${sentencePosition + 1} 句的虚声/远近景标识与 token id 不一致。`);
      }
    });
    const overrides = sentence.prosodyPointOverrides;
    if (overrides !== undefined && !Array.isArray(overrides)) {
      throw new Error(`第 ${sentencePosition + 1} 句的语势节点调整必须是数组。`);
    }
    const overriddenTokens = new Set<number>();
    (Array.isArray(overrides) ? overrides : []).forEach((overrideValue) => {
      const override = overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue)
        ? overrideValue as Record<string, unknown>
        : {};
      const tokenIndex = Number(override.tokenIndex);
      const visualLevel = Number(override.visualLevel);
      if (!Number.isInteger(tokenIndex) || !sentenceTokensByIndex.has(tokenIndex)) {
        throw new Error(`第 ${sentencePosition + 1} 句的语势节点引用了无效 token index。`);
      }
      if (overriddenTokens.has(tokenIndex)) {
        throw new Error(`第 ${sentencePosition + 1} 句的同一文字不能保存多个语势高度。`);
      }
      overriddenTokens.add(tokenIndex);
      if (!Number.isInteger(visualLevel) || visualLevel < 0 || visualLevel > 8) {
        throw new Error(`第 ${sentencePosition + 1} 句的语势高度必须是 0 到 8 的整数。`);
      }
    });
  });
  const editionLayouts = spec.editionLayouts;
  if (editionLayouts !== undefined) {
    if (!editionLayouts || typeof editionLayouts !== "object" || Array.isArray(editionLayouts)) {
      throw new Error("控制谱 editionLayouts 必须是对象。");
    }
    for (const edition of ["compact", "full"] as const) {
      const layout = (editionLayouts as Record<string, unknown>)[edition];
      if (layout === undefined) continue;
      if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
        throw new Error(`${edition} 版分行方案必须是对象。`);
      }
      const rows = (layout as Record<string, unknown>).rows;
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error(`${edition} 版分行方案缺少 rows。`);
      }
      const seen = new Set<number>();
      rows.forEach((rowValue, rowPosition) => {
        const row = rowValue && typeof rowValue === "object" && !Array.isArray(rowValue)
          ? rowValue as Record<string, unknown>
          : {};
        if (!String(row.id ?? "").trim()) {
          throw new Error(`${edition} 版第 ${rowPosition + 1} 行缺少 id。`);
        }
        const tokenIndexes = row.tokenIndexes;
        if (!Array.isArray(tokenIndexes) || !tokenIndexes.length) {
          throw new Error(`${edition} 版第 ${rowPosition + 1} 行缺少 tokenIndexes。`);
        }
        const included = new Set<number>();
        tokenIndexes.forEach((value) => {
          const tokenIndex = Number(value);
          if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex >= tokens.length) {
            throw new Error(`${edition} 版第 ${rowPosition + 1} 行引用了无效 token index。`);
          }
          if (seen.has(tokenIndex) || included.has(tokenIndex)) {
            throw new Error(`${edition} 版分行方案重复引用了 token ${tokenIndex}。`);
          }
          included.add(tokenIndex);
          seen.add(tokenIndex);
        });
        const lineBreaks = row.lineBreakAfterTokenIndexes;
        if (lineBreaks !== undefined && !Array.isArray(lineBreaks)) {
          throw new Error(`${edition} 版第 ${rowPosition + 1} 行的手动换行点必须是数组。`);
        }
        (Array.isArray(lineBreaks) ? lineBreaks : []).forEach((value) => {
          const tokenIndex = Number(value);
          if (!Number.isInteger(tokenIndex) || !included.has(tokenIndex)) {
            throw new Error(`${edition} 版第 ${rowPosition + 1} 行包含无效手动换行点。`);
          }
        });
      });
      if (seen.size !== tokens.length) {
        throw new Error(`${edition} 版分行方案没有完整覆盖正文。`);
      }
    }
  }
}

async function saveControlSpec(request: Request, env: Env, workId: string) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  const body = await request.json() as Record<string, unknown>;
  const expectedUpdatedAt = String(body.expected_updated_at ?? body.expectedUpdatedAt ?? "").trim();
  if (expectedUpdatedAt && String(work.updated_at) !== expectedUpdatedAt) {
    return apiError(
      409,
      "WORK_VERSION_CONFLICT",
      "作品已在其他窗口更新。为避免覆盖最新控制谱，请重新加载后再编辑。",
      { expected_updated_at: expectedUpdatedAt, actual_updated_at: work.updated_at },
    );
  }
  const spec = body.control_spec as Record<string, unknown> | undefined;
  if (!spec) return apiError(400, "CONTROL_SPEC_REQUIRED", "请提供 control_spec。");
  const analysisPackage = await latestAnalysisPackage(env, workId, String(work.source_text));
  const specWithTiming = withDynamicTimingProfile(spec, analysisPackage);
  try {
    validateControlSpec(specWithTiming, String(work.source_text));
  } catch (error) {
    return apiError(422, "INVALID_CONTROL_SPEC", error instanceof Error ? error.message : String(error));
  }
  const latest = await first<Row>(env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM control_spec_versions WHERE work_id = ?",
  ).bind(workId));
  const version = Number(latest?.version ?? 0) + 1;
  const specId = id("spec");
  const updated = { ...specWithTiming, id: specId, workId, version };
  const createdAt = nextUpdatedAt(String(work.updated_at));
  const source = String(body.source ?? "human");
  const standardAudio = await first<Row>(env.DB.prepare(
    "SELECT id FROM assets WHERE work_id = ? AND kind = 'standard_ai_audio' ORDER BY created_at DESC LIMIT 1",
  ).bind(workId));
  const audioSyncStatus = source === "analysis"
    ? "synced"
    : standardAudio ? "modified" : "pending";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO control_spec_versions
       (id, work_id, version, schema_version, source, spec_json, validation_state, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'valid', 'creator', ?)`,
    ).bind(specId, workId, version, String(specWithTiming.schemaVersion ?? "2.0"), source, JSON.stringify(updated), createdAt),
    env.DB.prepare(
      `UPDATE works
          SET current_spec_version_id = ?, status = 'review', audio_sync_status = ?,
              published_revision_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(specId, audioSyncStatus, createdAt, workId),
  ]);
  return json({ control_spec: updated, work: await getWorkPayload(env, workId) });
}

async function publishWork(request: Request, env: Env, workId: string, origin: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法发布作品。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work?.current_spec_version_id) return apiError(409, "CONTROL_SPEC_REQUIRED", "作品没有已确认控制谱。");
  let expectedUpdatedAt = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    expectedUpdatedAt = String(body.expected_updated_at ?? body.expectedUpdatedAt ?? "").trim();
  } catch {
    // An empty POST body is accepted for compatibility with older clients.
  }
  if (expectedUpdatedAt && String(work.updated_at) !== expectedUpdatedAt) {
    return apiError(
      409,
      "WORK_VERSION_CONFLICT",
      "作品已在其他窗口更新。为避免发布旧版本，请重新加载后再发布。",
      { expected_updated_at: expectedUpdatedAt, actual_updated_at: work.updated_at },
    );
  }
  const audio = await first<Row>(env.DB.prepare(
    `SELECT av.id, av.audio_asset_id, av.timeline_json, a.kind AS asset_kind
       FROM audio_versions av
       JOIN assets a ON a.id = av.audio_asset_id
      WHERE av.work_id = ?
        AND av.candidate_state IN ('candidate', 'approved')
        AND (
          a.kind = 'standard_ai_audio'
          OR (a.kind = 'ai_demo_audio' AND av.control_spec_version_id = ?)
        )
      ORDER BY CASE WHEN a.kind = 'standard_ai_audio' THEN 0 ELSE 1 END,
               av.created_at DESC LIMIT 1`,
  ).bind(workId, work.current_spec_version_id));
  if (!audio) return apiError(409, "STANDARD_AUDIO_REQUIRED", "请先生成并解析标准 AI 朗诵。");
  const timeline = parseJson<Record<string, unknown>>(audio.timeline_json as string | null);
  if (!timeline || !Array.isArray(timeline.tokens) || !timeline.tokens.length) {
    return apiError(409, "STANDARD_AUDIO_TIMELINE_REQUIRED", "当前标准 AI 朗诵缺少字符时间戳，不能发布。");
  }
  const existing = await first<Row>(env.DB.prepare("SELECT id FROM publications WHERE slug = ?").bind(work.slug));
  const publicationId = String(existing?.id ?? id("publication"));
  const publishedAt = nextUpdatedAt(String(work.updated_at));
  const publicationStatement = existing
    ? env.DB.prepare(
      "UPDATE publications SET control_spec_version_id = ?, audio_version_id = ?, state = 'published', published_at = ?, withdrawn_at = NULL WHERE id = ?",
    ).bind(work.current_spec_version_id, audio.id, publishedAt, publicationId)
    : env.DB.prepare(
      `INSERT INTO publications (id, work_id, slug, control_spec_version_id, audio_version_id, state, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    ).bind(publicationId, workId, work.slug, work.current_spec_version_id, audio.id, publishedAt);
  await env.DB.batch([
    publicationStatement,
    env.DB.prepare(
      `UPDATE audio_versions
          SET candidate_state = CASE
            WHEN id = ? THEN 'approved'
            WHEN candidate_state = 'candidate' THEN 'superseded'
            ELSE candidate_state
          END
        WHERE work_id = ?`,
    ).bind(audio.id, workId),
    env.DB.prepare(
      "UPDATE works SET status = 'published', published_revision_id = ?, updated_at = ? WHERE id = ? AND current_spec_version_id = ?",
    ).bind(publicationId, publishedAt, workId, work.current_spec_version_id),
  ]);
  return json({
    publication_id: publicationId,
    public_url: `${origin}/?work=${encodeURIComponent(workId)}&view=1`,
    work: await getWorkPayload(env, workId),
  });
}

function visualDirectorModelFromResult(response: Record<string, unknown>) {
  const metadata = response._meta;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? String((metadata as Record<string, unknown>).model ?? "")
    : "";
}

function visualDirectorProviderFromResult(response: Record<string, unknown>) {
  const metadata = response._meta;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? String((metadata as Record<string, unknown>).provider ?? "unknown")
    : "unknown";
}

function visualDirectorEndpointFromResult(response: Record<string, unknown>) {
  const metadata = response._meta;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? String((metadata as Record<string, unknown>).endpoint ?? "")
    : "";
}

async function planWorkVisuals(
  env: Env,
  workId: string,
  activeJobId?: string,
  sceneGroupingVersion?: SceneGroupingVersion,
) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  if (!activeJobId) {
    const conflict = await rejectWhileVisualGenerationIsActive(env, workId);
    if (conflict) return conflict;
  }
  const current = await getVisualBundle(env, workId);
  const lockedProfile = current.profile?.isLocked ? {
    visual_style: String(current.profile.visualStyle ?? ""),
    palette: current.profile.palette as string[],
    texture: String(current.profile.texture ?? ""),
    lighting: String(current.profile.lighting ?? ""),
    atmosphere: String(current.profile.atmosphere ?? ""),
    composition_language: String(current.profile.compositionRule ?? ""),
    human_presence: String(current.profile.humanPresence ?? ""),
    symbolic_language: current.profile.symbolicElements as string[],
    avoid: current.profile.avoid as string[],
  } satisfies WorkVisualProfile : undefined;
  const controlSpec = work.current_spec_version_id
    ? parseJson<Record<string, unknown>>((await first<Row>(env.DB.prepare(
      "SELECT spec_json FROM control_spec_versions WHERE id = ?",
    ).bind(work.current_spec_version_id)))?.spec_json as string | null)
    : undefined;
  const sceneUnits = buildSceneUnits(
    String(work.source_text),
    controlSpec,
    sceneGroupingVersion ?? "legacy_v1",
  );
  if (!sceneUnits.length) return apiError(422, "VISUAL_SCENES_REQUIRED", "作品正文无法划分视觉场景。");
  let direction;
  try {
    direction = await requestVisualDirection({
      title: String(work.title),
      author: String(work.author ?? ""),
      full_text: String(work.source_text),
      genre: String(work.genre),
      control_spec_summary: summarizeControlSpec(controlSpec),
      scene_units: sceneUnits,
      locked_profile: lockedProfile,
    }, {
      serviceUrl: env.ANALYSIS_SERVICE_URL,
      serviceToken: env.ANALYSIS_SERVICE_TOKEN,
    });
  } catch (error) {
    const status = error instanceof VisualDirectorRequestError ? error.status ?? 502 : 502;
    return apiError(
      status,
      "VISUAL_DIRECTOR_FAILED",
      safeVisualErrorMessage(env, error),
    );
  }
  const createdAt = now();
  const latestProfile = await first<Row>(env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM work_visual_profiles WHERE work_id = ?",
  ).bind(workId));
  const profileVersion = Number(latestProfile?.version ?? 0) + 1;
  const profileId = id("visual_profile");
  const directorEndpoint = visualDirectorEndpointFromResult(
    direction as unknown as Record<string, unknown>,
  );
  const persistedProfile = {
    ...direction.work_visual_profile,
    ...(directorEndpoint ? { _meta: { director_endpoint: directorEndpoint } } : {}),
  };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE work_visual_profiles SET is_active = 0 WHERE work_id = ?").bind(workId),
    env.DB.prepare("UPDATE visual_specs SET is_active = 0 WHERE work_id = ?").bind(workId),
    env.DB.prepare(
      `INSERT INTO work_visual_profiles
        (id, work_id, version, profile_json, director_provider, director_model,
         is_locked, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      profileId,
      workId,
      profileVersion,
      JSON.stringify(persistedProfile),
      visualDirectorProviderFromResult(direction as unknown as Record<string, unknown>),
      visualDirectorModelFromResult(direction as unknown as Record<string, unknown>),
      lockedProfile ? 1 : 0,
      createdAt,
      createdAt,
    ),
  ];
  // Hero / cover art is removed from the generation flow — only per-sentence
  // Scene Cards are planned. Any hero spec returned by the director is ignored.
  const specs: Array<{ kind: VisualAssetKind; sceneId?: string; spec: SceneVisualSpec }> = direction.scene_visual_specs.map(
    (spec) => ({ kind: "scene" as const, sceneId: spec.scene_id, spec }),
  );
  for (const entry of specs) {
    const latest = await first<Row>(env.DB.prepare(
      `SELECT COALESCE(MAX(version), 0) AS version FROM visual_specs
        WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?`,
    ).bind(workId, entry.kind, entry.sceneId ?? ""));
    const specId = id("visual_spec");
    const sourceSentenceIds = entry.kind === "scene"
      ? (entry.spec as SceneVisualSpec).source_sentence_ids
      : [];
    const sourceText = entry.kind === "scene" ? (entry.spec as SceneVisualSpec).source_text : null;
    statements.push(env.DB.prepare(
      `INSERT INTO visual_specs
        (id, work_id, profile_id, kind, scene_id, source_sentence_ids_json,
         source_text, spec_json, version, state, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?)`,
    ).bind(
      specId,
      workId,
      profileId,
      entry.kind,
      entry.sceneId ?? null,
      JSON.stringify(sourceSentenceIds),
      sourceText,
      JSON.stringify(entry.spec),
      Number(latest?.version ?? 0) + 1,
      createdAt,
    ));
  }
  statements.push(env.DB.prepare("UPDATE works SET updated_at = ? WHERE id = ?").bind(
    nextUpdatedAt(String(work.updated_at)),
    workId,
  ));
  await env.DB.batch(statements);
  return json({ visuals: await getVisualBundle(env, workId) });
}

async function patchWorkVisuals(request: Request, env: Env, workId: string) {
  const work = await first<Row>(env.DB.prepare("SELECT id, updated_at FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return apiError(400, "INVALID_JSON", "作品视觉更新必须是有效 JSON。");
  }
  const action = String(body.action ?? "");
  if (action === "lock_style" || action === "unlock_style") {
    const result = await env.DB.prepare(
      "UPDATE work_visual_profiles SET is_locked = ?, updated_at = ? WHERE work_id = ? AND is_active = 1",
    ).bind(action === "lock_style" ? 1 : 0, now(), workId).run();
    if (!Number(result.meta.changes ?? 0)) {
      return apiError(409, "VISUAL_PROFILE_REQUIRED", "请先生成作品视觉方案。");
    }
    return json({ visuals: await getVisualBundle(env, workId) });
  }
  if (action !== "update_spec") return apiError(400, "INVALID_VISUAL_ACTION", "不支持的作品视觉操作。");
  const kind = String(body.kind ?? "") as VisualAssetKind;
  const sceneId = String(body.sceneId ?? body.scene_id ?? "").trim();
  if (!(["hero", "scene"] as string[]).includes(kind) || (kind === "scene" && !sceneId)) {
    return apiError(400, "INVALID_VISUAL_SPEC_TARGET", "请指定 Hero 或具体 Scene。");
  }
  const current = await first<Row>(env.DB.prepare(
    `SELECT * FROM visual_specs WHERE work_id = ? AND kind = ?
      AND COALESCE(scene_id, '') = ? AND is_active = 1 ORDER BY version DESC LIMIT 1`,
  ).bind(workId, kind, sceneId));
  if (!current) return apiError(404, "VISUAL_SPEC_NOT_FOUND", "找不到当前视觉方案。");
  const spec = parseJson<Record<string, unknown>>(current.spec_json as string | null) ?? {};
  const imagePrompt = typeof body.imagePrompt === "string" ? body.imagePrompt.trim() : String(spec.image_prompt ?? "");
  const negativePrompt = typeof body.negativePrompt === "string"
    ? body.negativePrompt.trim()
    : String(spec.negative_prompt ?? "");
  if (!imagePrompt) return apiError(400, "IMAGE_PROMPT_REQUIRED", "图片 Prompt 不能为空。");
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE visual_specs SET is_active = 0 WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?")
      .bind(workId, kind, sceneId),
    env.DB.prepare(
      `INSERT INTO visual_specs
        (id, work_id, profile_id, kind, scene_id, source_sentence_ids_json, source_text,
         spec_json, version, state, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?)`,
    ).bind(
      id("visual_spec"), workId, current.profile_id, kind, sceneId || null,
      current.source_sentence_ids_json, current.source_text,
      JSON.stringify({ ...spec, image_prompt: imagePrompt, negative_prompt: negativePrompt }),
      Number(current.version) + 1, createdAt,
    ),
  ]);
  return json({ visuals: await getVisualBundle(env, workId) });
}

async function storeGeneratedVisual(
  env: Env,
  workId: string,
  specRow: Row,
  generated: GeneratedImage,
  version: number,
  textValidation?: HeroTextValidationResult,
) {
  const kind = String(specRow.kind) as VisualAssetKind;
  const sceneId = specRow.scene_id == null ? undefined : String(specRow.scene_id);
  const spec = parseJson<Record<string, unknown>>(specRow.spec_json as string | null) ?? {};
  const visualId = id("visual_asset");
  const assetId = id("asset");
  const extension = imageExtension(generated.mimeType);
  const storageKey = kind === "hero"
    ? `works/${workId}/visuals/hero/v${version}.${extension}`
    : `works/${workId}/visuals/scenes/${sceneId}/v${version}.${extension}`;
  const checksum = await sha256Hex(generated.bytes);
  const createdAt = now();
  const isHero = kind === "hero";
  const detectedDimensions = detectImageDimensions(generated.bytes);
  const generatedWidth = detectedDimensions?.width ?? generated.width ?? (isHero ? 1500 : SCENE_IMAGE_WIDTH);
  const generatedHeight = detectedDimensions?.height ?? generated.height ?? (isHero ? 280 : SCENE_IMAGE_HEIGHT);
  const heroMatched = isHero && textValidation?.status === "matched";
  const needsReview = isHero && !generated.isPlaceholder && !heroMatched;
  const ready = !generated.isPlaceholder && !needsReview;
  const generationStatus = generated.isPlaceholder ? "pending_generation" : needsReview ? "needs_review" : "ready";
  const textValidationStatus = isHero
    ? generated.isPlaceholder ? "not_required" : textValidation?.status ?? "pending"
    : null;
  await env.AUDIO_BUCKET.put(storageKey, generated.bytes, {
    httpMetadata: { contentType: generated.mimeType },
    customMetadata: { workId, assetId, kind: `visual_${kind}`, sceneId: sceneId ?? "" },
  });
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO assets
          (id, work_id, kind, storage_key, filename, mime_type, byte_size, checksum,
           provider, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        assetId, workId, `visual_${kind}`, storageKey, `${kind}-${sceneId ?? "hero"}-v${version}.${extension}`,
        generated.mimeType, generated.bytes.byteLength, checksum, generated.provider,
        JSON.stringify({
          model: generated.model,
          endpoint: generated.endpoint,
          scene_id: sceneId,
          version,
          width: generatedWidth,
          height: generatedHeight,
        }), createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO visual_assets
          (id, work_id, spec_id, asset_id, kind, scene_id, provider, model, prompt,
           negative_prompt, width, height, seed, generation_status, text_validation_status, text_validation_json,
           is_visible, is_active, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        visualId, workId, specRow.id, assetId, kind, sceneId ?? null, generated.provider,
        generated.model, String(spec.image_prompt ?? ""), String(spec.negative_prompt ?? "") || null,
        generatedWidth, generatedHeight, generated.seed ?? null,
        generationStatus, textValidationStatus, textValidation ? JSON.stringify(textValidation) : null,
        ready ? 1 : 0, ready ? 1 : 0, version, createdAt,
      ),
    ];
    if (ready) {
      statements.unshift(env.DB.prepare(
        `UPDATE visual_assets SET is_active = 0
          WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?`,
      ).bind(workId, kind, sceneId ?? ""));
    }
    await env.DB.batch(statements);
  } catch (error) {
    await env.AUDIO_BUCKET.delete(storageKey).catch(() => undefined);
    throw error;
  }
  return visualId;
}

async function storeFailedVisual(
  env: Env,
  work: Row,
  specRow: Row,
  provider: ImageGenerationProvider,
  version: number,
  error: unknown,
) {
  const spec = parseJson<Record<string, unknown>>(specRow.spec_json as string | null) ?? {};
  const kind = String(specRow.kind) as VisualAssetKind;
  const sceneId = specRow.scene_id == null ? undefined : String(specRow.scene_id);
  const visualId = id("visual_asset");
  await env.DB.prepare(
    `INSERT INTO visual_assets
      (id, work_id, spec_id, kind, scene_id, provider, model, prompt, negative_prompt,
       width, height, generation_status, error_message, is_visible, is_active, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, 0, 0, ?, ?)`,
  ).bind(
    visualId, work.id, specRow.id, kind, sceneId ?? null,
    provider.provider, provider.model, String(spec.image_prompt ?? ""),
    String(spec.negative_prompt ?? "") || null, kind === "hero" ? 1500 : SCENE_IMAGE_WIDTH,
    kind === "hero" ? 280 : SCENE_IMAGE_HEIGHT, safeVisualErrorMessage(env, error), version, now(),
  ).run();
}

async function generateOneVisual(env: Env, work: Row, specRow: Row, recordFailure = true) {
  const provider = imageProvider(env);
  const spec = parseJson<Record<string, unknown>>(specRow.spec_json as string | null) ?? {};
  const kind = String(specRow.kind) as VisualAssetKind;
  const sceneId = specRow.scene_id == null ? undefined : String(specRow.scene_id);
  const title = String(work.title);
  const author = String(work.author ?? "");
  const basePrompt = String(spec.image_prompt ?? "");
  const baseNegativePrompt = String(spec.negative_prompt ?? "");
  const productionPrompt = kind === "hero"
    ? withHeroProductionLayout(basePrompt, title, author)
    : basePrompt;
  const productionNegativePrompt = kind === "hero"
    ? withHeroProductionNegativePrompt(baseNegativePrompt)
    : baseNegativePrompt;
  const latest = await first<Row>(env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS version FROM visual_assets
      WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?`,
  ).bind(work.id, kind, sceneId ?? ""));
  const version = Number(latest?.version ?? 0) + 1;
  try {
    let generated: GeneratedImage | undefined;
    let textValidation: HeroTextValidationResult | undefined;
    const proxyOcrConfigured = provider.provider === "analysis-service"
      && Boolean(env.ANALYSIS_SERVICE_URL?.trim() && env.ANALYSIS_SERVICE_TOKEN?.trim());
    const directOcrConfigured = Boolean(env.IMAGE_OCR_MODEL?.trim() && imageApiKey(env));
    const attempts = kind === "hero" && provider.configured
      && (proxyOcrConfigured || directOcrConfigured) ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      generated = await provider.generate({
        kind,
        prompt: productionPrompt,
        negativePrompt: productionNegativePrompt || undefined,
        width: kind === "hero" ? 1500 : SCENE_IMAGE_WIDTH,
        height: kind === "hero" ? 280 : SCENE_IMAGE_HEIGHT,
        title,
        author,
        sceneId,
        workId: String(work.id),
      });
      if (kind !== "hero" || generated.isPlaceholder) break;
      textValidation = await validateHeroText(
        generated.bytes,
        generated.mimeType,
        String(work.title),
        String(work.author ?? ""),
        {
          model: env.IMAGE_OCR_MODEL,
          apiKey: imageApiKey(env),
          baseUrl: imageBaseUrl(env),
          serviceUrl: provider.provider === "analysis-service" ? env.ANALYSIS_SERVICE_URL : undefined,
          serviceToken: provider.provider === "analysis-service" ? env.ANALYSIS_SERVICE_TOKEN : undefined,
        },
      );
      if (textValidation.status === "matched") break;
    }
    if (!generated) throw new ImageGenerationError("图片生成服务没有返回图片。");
    return await storeGeneratedVisual(env, String(work.id), specRow, generated, version, textValidation);
  } catch (error) {
    if (recordFailure) await storeFailedVisual(env, work, specRow, provider, version, error);
    throw error;
  }
}

interface VisualGenerationTarget {
  type: "all" | "hero" | "scene";
  sceneId?: string;
  includePlan: boolean;
  /** Which SceneUnit grouping produced this plan. Legacy = 1 row / 1 scene. */
  sceneGroupingVersion?: SceneGroupingVersion;
}

function visualTargetKey(target: VisualGenerationTarget) {
  const grouping = target.sceneGroupingVersion ?? "legacy_v1";
  return `${target.type}:${target.sceneId ?? ""}:${target.includePlan ? "plan" : "reuse"}:${grouping}`;
}

async function activeVisualGenerationJobs(env: Env, workId: string) {
  const result = await env.DB.prepare(
    `SELECT * FROM processing_jobs WHERE work_id = ? AND type = ?
      AND status IN ('queued', 'planning', 'generating_hero', 'generating_scenes', 'uploading', 'processing')
      ORDER BY created_at DESC`,
  ).bind(workId, VISUAL_GENERATION_JOB_TYPE).all<Row>();
  return result.results ?? [];
}

async function rejectWhileVisualGenerationIsActive(env: Env, workId: string) {
  const active = (await activeVisualGenerationJobs(env, workId))[0];
  return active
    ? apiError(409, "VISUAL_GENERATION_IN_PROGRESS", "作品视觉正在生成，请等待当前任务完成后再修改。", {
      visual_job_id: String(active.id),
      status: String(active.status),
    })
    : null;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

async function updateVisualJobProgress(env: Env, jobId: string, progress: number) {
  const clamped = Math.min(99, Math.max(1, Math.round(progress)));
  await env.DB.prepare(
    `UPDATE processing_jobs
        SET progress = CASE WHEN progress < ? THEN ? ELSE progress END, updated_at = ?
      WHERE id = ? AND type = ?
        AND status NOT IN ('completed', 'succeeded', 'partial_failed', 'failed')`,
  ).bind(clamped, clamped, now(), jobId, VISUAL_GENERATION_JOB_TYPE).run();
}

async function setVisualJobStage(env: Env, jobId: string, stage: string, progress: number) {
  await env.DB.prepare(
    `UPDATE processing_jobs SET status = ?, progress = CASE WHEN progress < ? THEN ? ELSE progress END,
      updated_at = ? WHERE id = ? AND type = ?
      AND status NOT IN ('completed', 'succeeded', 'partial_failed', 'failed')`,
  ).bind(stage, progress, progress, now(), jobId, VISUAL_GENERATION_JOB_TYPE).run();
}

async function visualResultSince(env: Env, specId: string, jobCreatedAt: string) {
  return first<Row>(env.DB.prepare(
    `SELECT id, generation_status, error_message FROM visual_assets
      WHERE spec_id = ? AND created_at >= ?
        AND generation_status IN ('ready', 'needs_review', 'failed')
      ORDER BY version DESC LIMIT 1`,
  ).bind(specId, jobCreatedAt));
}

async function runVisualGenerationJob(env: Env, jobId: string) {
  let job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, VISUAL_GENERATION_JOB_TYPE));
  if (!job) return;
  if (VISUAL_TERMINAL_STATUSES.has(String(job.status))) return;
  const leaseExpired = Date.now() - Date.parse(String(job.updated_at)) >= VISUAL_JOB_LEASE_MS;
  if (job.status !== "queued" && !leaseExpired) return;
  const claim = await env.DB.prepare(
    `UPDATE processing_jobs SET status = 'planning', progress = CASE WHEN progress < 1 THEN 1 ELSE progress END,
      updated_at = ? WHERE id = ? AND type = ? AND status = ? AND updated_at = ?`,
  ).bind(now(), jobId, VISUAL_GENERATION_JOB_TYPE, job.status, job.updated_at).run();
  if (!Number(claim.meta.changes ?? 0)) return;
  job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, VISUAL_GENERATION_JOB_TYPE));
  if (!job) return;
  const target = parseJson<VisualGenerationTarget>(job.input_json as string | null);
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(job.work_id));
  if (!target || !work) {
    await env.DB.prepare(
      `UPDATE processing_jobs SET status = 'failed', progress = 0, error_code = ?,
        error_message = ?, updated_at = ? WHERE id = ? AND type = ?`,
    ).bind(
      "VISUAL_JOB_INPUT_INVALID",
      work ? "视觉生成任务参数无效。" : "视觉生成任务对应的作品不存在。",
      now(),
      jobId,
      VISUAL_GENERATION_JOB_TYPE,
    ).run();
    return;
  }

  try {
    const plannedForJob = target.includePlan
      ? await first<Row>(env.DB.prepare(
        `SELECT id FROM visual_specs WHERE work_id = ? AND is_active = 1 AND created_at >= ? LIMIT 1`,
      ).bind(work.id, job.created_at))
      : null;
    if (target.includePlan && !plannedForJob) {
      const planResponse = await planWorkVisuals(
        env,
        String(work.id),
        jobId,
        target.sceneGroupingVersion,
      );
      if (!planResponse.ok) {
        const payload = await planResponse.json().catch(() => ({})) as Record<string, unknown>;
        const error = payload.error && typeof payload.error === "object"
          ? payload.error as Record<string, unknown>
          : {};
        throw new Error(String(error.message ?? `视觉方案生成失败（HTTP ${planResponse.status}）。`));
      }
      await updateVisualJobProgress(env, jobId, 10);
    }

    const result = await env.DB.prepare(
      `SELECT * FROM visual_specs WHERE work_id = ? AND is_active = 1
        AND (? = 'all' OR kind = ?)
        AND (? != 'scene' OR scene_id = ?)
        ORDER BY CASE WHEN kind = 'hero' THEN 0 ELSE 1 END, scene_id`,
    ).bind(work.id, target.type, target.type, target.type, target.sceneId ?? "").all<Row>();
    const specs = (result.results ?? []).filter((spec) => spec.kind === "scene");
    if (!specs.length) throw new Error("请先生成作品视觉方案。");

    const generated: string[] = [];
    const failures: Array<{ specId: string; kind: string; sceneId?: string; message: string }> = [];
    let completed = 0;
    const progressBase = target.includePlan ? 10 : 1;
    const recordCompletion = async () => {
      completed += 1;
      await updateVisualJobProgress(
        env,
        jobId,
        progressBase + ((99 - progressBase) * completed) / specs.length,
      );
    };
    const generateSpec = async (spec: Row) => {
      const sceneId = spec.scene_id == null ? undefined : String(spec.scene_id);
      console.log(`[${work.index}] ${sceneId ?? spec.id} dispatched`);
      const existing = await visualResultSince(env, String(spec.id), String(job.created_at));
      if (existing) {
        if (existing.generation_status === "failed") {
          failures.push({
            specId: String(spec.id),
            kind: String(spec.kind),
            sceneId: spec.scene_id == null ? undefined : String(spec.scene_id),
            message: String(existing.error_message ?? "图片生成失败。"),
          });
        } else {
          generated.push(String(existing.id));
        }
        await recordCompletion();
        return;
      }
      const startedAt = Date.now();
      let lastError: unknown;
      for (let attempt = 1; attempt <= VISUAL_GENERATION_RETRY_LIMIT + 1; attempt += 1) {
        try {
          const assetId = await generateOneVisual(env, work, spec, false);
          generated.push(assetId);
          console.log(`[${work.index}] ${sceneId ?? spec.id} success attempt=${attempt} duration=${Date.now() - startedAt}ms`);
          break;
        } catch (error) {
          lastError = error;
          if (attempt <= VISUAL_GENERATION_RETRY_LIMIT) {
            console.log(`[${work.index}] ${sceneId ?? spec.id} retry attempt=${attempt + 1} duration=${Date.now() - startedAt}ms`);
            continue;
          }
          const provider = imageProvider(env);
          const latest = await first<Row>(env.DB.prepare(
            `SELECT COALESCE(MAX(version), 0) AS version FROM visual_assets
              WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?`,
          ).bind(work.id, spec.kind, sceneId ?? ""));
          await storeFailedVisual(env, work, spec, provider, Number(latest?.version ?? 0) + 1, lastError);
          console.log(`[${work.index}] ${sceneId ?? spec.id} failed duration=${Date.now() - startedAt}ms: ${safeVisualErrorMessage(env, lastError)}`);
          failures.push({
            specId: String(spec.id),
            kind: String(spec.kind),
            sceneId: spec.scene_id == null ? undefined : String(spec.scene_id),
            message: safeVisualErrorMessage(env, lastError),
          });
        }
      }
      await recordCompletion();
    };

    // Hero is removed from the generation flow — only Scene Cards are produced.
    if (specs.length) await setVisualJobStage(env, jobId, "generating_scenes", Math.max(progressBase, 20));
    await mapWithConcurrency(specs, VISUAL_SCENE_CONCURRENCY, generateSpec);
    await setVisualJobStage(env, jobId, "uploading", 99);

    const status = failures.length === 0
      ? "completed"
      : generated.length > 0
        ? "partial_failed"
        : "failed";
    const finishedAt = now();
    await env.DB.prepare(
      `UPDATE processing_jobs
          SET status = ?, progress = 100, output_json = ?, error_code = ?,
              error_message = ?, updated_at = ?
        WHERE id = ? AND type = ?
          AND status NOT IN ('completed', 'succeeded', 'partial_failed', 'failed')`,
    ).bind(
      status,
      JSON.stringify({
        target,
        generated_asset_ids: generated,
        failures,
        scene_concurrency: VISUAL_SCENE_CONCURRENCY,
        retry_limit: VISUAL_GENERATION_RETRY_LIMIT,
      }),
      failures.length ? "VISUAL_GENERATION_PARTIAL_FAILED" : null,
      failures.length ? `${failures.length} 张图片生成失败。` : null,
      finishedAt,
      jobId,
      VISUAL_GENERATION_JOB_TYPE,
    ).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'failed', progress = 100, output_json = ?, error_code = ?,
              error_message = ?, updated_at = ?
        WHERE id = ? AND type = ?
          AND status NOT IN ('completed', 'succeeded', 'partial_failed', 'failed')`,
    ).bind(
      JSON.stringify({ target, generated_asset_ids: [], failures: [] }),
      "VISUAL_GENERATION_FAILED",
      safeVisualErrorMessage(env, error),
      now(),
      jobId,
      VISUAL_GENERATION_JOB_TYPE,
    ).run();
  }
}

async function createVisualGenerationJob(
  env: Env,
  workId: string,
  target: Omit<VisualGenerationTarget, "includePlan"> & { includePlan?: boolean },
) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  if (!['all', 'hero', 'scene'].includes(target.type) || (target.type === "scene" && !target.sceneId)) {
    return apiError(400, "INVALID_VISUAL_TARGET", "请指定 all、hero 或具体 scene。");
  }
  let provider: ImageGenerationProvider;
  try {
    provider = imageProvider(env);
  } catch (error) {
    const status = error instanceof ImageGenerationError ? error.status : 503;
    return apiError(status, "IMAGE_PROVIDER_INVALID", error instanceof Error ? error.message : String(error));
  }
  if (!provider.configured) {
    return apiError(503, "IMAGE_PROVIDER_NOT_CONFIGURED", "图片生成服务尚未完成服务端配置。");
  }

  const currentSpecs = await env.DB.prepare(
    `SELECT id FROM visual_specs WHERE work_id = ? AND is_active = 1
      AND (? = 'all' OR kind = ?)
      AND (? != 'scene' OR scene_id = ?) LIMIT 1`,
  ).bind(workId, target.type, target.type, target.type, target.sceneId ?? "").all<Row>();
  const includePlan = target.type === "all"
    && (target.includePlan === true || !(currentSpecs.results ?? []).length);
  if (target.type !== "all" && !(currentSpecs.results ?? []).length) {
    return apiError(409, "VISUAL_PLAN_REQUIRED", "请先生成作品视觉方案。");
  }
  const normalizedTarget: VisualGenerationTarget = {
    type: target.type,
    sceneId: target.sceneId,
    includePlan,
    sceneGroupingVersion: target.sceneGroupingVersion,
  };

  const activeRows = await activeVisualGenerationJobs(env, workId);
  const active = activeRows.find((row) => {
    const input = parseJson<VisualGenerationTarget>(row.input_json as string | null);
    return input && sameVisualGenerationTarget(input, normalizedTarget);
  });
  if (active) {
    return json({
      visual_job_id: active.id,
      work_id: workId,
      status: active.status,
      progress: Number(active.progress ?? 0),
      visuals: await getVisualBundle(env, workId),
    }, 202);
  }
  if (activeRows.length) {
    const current = activeRows[0];
    return apiError(409, "VISUAL_GENERATION_IN_PROGRESS", "作品视觉已有生成任务正在运行，请等待完成后重试。", {
      visual_job_id: String(current.id),
      status: String(current.status),
    });
  }

  const jobId = id("visual_job");
  const createdAt = now();
  await env.DB.prepare(
    `INSERT INTO processing_jobs
      (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  ).bind(
    jobId,
    workId,
    VISUAL_GENERATION_JOB_TYPE,
    `visual-generation:${workId}:${visualTargetKey(normalizedTarget)}:${jobId}`,
    JSON.stringify(normalizedTarget),
    createdAt,
    createdAt,
  ).run();
  return json({
    visual_job_id: jobId,
    work_id: workId,
    status: "queued",
    progress: 0,
    visuals: await getVisualBundle(env, workId),
  }, 202);
}

async function generateWorkVisuals(
  request: Request,
  env: Env,
  workId: string,
) {
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { /* optional body */ }
  const type = String(body.type ?? "all") as VisualGenerationTarget["type"];
  const sceneId = String(body.sceneId ?? body.scene_id ?? "").trim() || undefined;
  const rawGrouping = String(body.sceneGroupingVersion ?? body.scene_grouping_version ?? "");
  const sceneGroupingVersion: VisualGenerationTarget["sceneGroupingVersion"] =
    rawGrouping === "semantic_v2" ? "semantic_v2" : "legacy_v1";
  return createVisualGenerationJob(env, workId, {
    type,
    sceneId,
    includePlan: body.includePlan === true || body.include_plan === true,
    sceneGroupingVersion,
  });
}

async function getVisualGenerationJob(env: Env, jobId: string) {
  let job = await first<Row>(env.DB.prepare(
    "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
  ).bind(jobId, VISUAL_GENERATION_JOB_TYPE));
  if (!job) return apiError(404, "VISUAL_JOB_NOT_FOUND", "找不到视觉生成任务。");
  if (!VISUAL_TERMINAL_STATUSES.has(String(job.status))) {
    // Keep the generation promise attached to this polling request. Sites may
    // cancel waitUntil work after the response is returned, while a pending
    // request remains alive for the upstream LLM/image calls and R2 writes.
    await runVisualGenerationJob(env, jobId);
    job = await first<Row>(env.DB.prepare(
      "SELECT * FROM processing_jobs WHERE id = ? AND type = ?",
    ).bind(jobId, VISUAL_GENERATION_JOB_TYPE));
    if (!job) return apiError(404, "VISUAL_JOB_NOT_FOUND", "找不到视觉生成任务。");
  }
  const output = parseJson<Record<string, unknown>>(job.output_json as string | null);
  return json({
    visual_job_id: job.id,
    work_id: job.work_id,
    status: job.status,
    progress: Number(job.progress ?? 0),
    target: parseJson<VisualGenerationTarget>(job.input_json as string | null),
    generated_asset_ids: output?.generated_asset_ids ?? [],
    failures: output?.failures ?? [],
    error: job.error_code ? { code: job.error_code, message: job.error_message } : undefined,
    visuals: await getVisualBundle(env, String(job.work_id)),
  });
}

async function uploadVisualReplacement(request: Request, env: Env, workId: string) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  const conflict = await rejectWhileVisualGenerationIsActive(env, workId);
  if (conflict) return conflict;
  let form: FormData;
  try { form = await request.formData(); } catch { return apiError(400, "INVALID_MULTIPART", "图片必须使用文件上传表单。"); }
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "") as VisualAssetKind;
  const sceneId = String(form.get("scene_id") ?? form.get("sceneId") ?? "").trim();
  if (!(file instanceof File) || file.size <= 0) return apiError(400, "VISUAL_FILE_REQUIRED", "请选择图片文件。");
  if (!file.type.startsWith("image/")) return apiError(415, "UNSUPPORTED_IMAGE_TYPE", "仅支持图片文件。");
  if (file.size > 20 * 1024 * 1024) return apiError(413, "VISUAL_FILE_TOO_LARGE", "图片不能超过 20 MB。");
  if (!['hero', 'scene'].includes(kind) || (kind === 'scene' && !sceneId)) {
    return apiError(400, "INVALID_VISUAL_TARGET", "请指定 Hero 或具体 Scene。");
  }
  const spec = await first<Row>(env.DB.prepare(
    `SELECT * FROM visual_specs WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?
      AND is_active = 1 ORDER BY version DESC LIMIT 1`,
  ).bind(workId, kind, sceneId));
  if (!spec) return apiError(409, "VISUAL_PLAN_REQUIRED", "请先生成对应视觉方案。");
  const latest = await first<Row>(env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS version FROM visual_assets
      WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?`,
  ).bind(workId, kind, sceneId));
  const generated: GeneratedImage = {
    bytes: await file.arrayBuffer(), mimeType: file.type, provider: "upload", model: "human-upload",
    isPlaceholder: false,
  };
  const visualId = await storeGeneratedVisual(env, workId, spec, generated, Number(latest?.version ?? 0) + 1, {
    status: "matched",
    message: "human uploaded and approved",
  });
  // Human upload is explicitly trusted as reviewed. Activate it immediately.
  await env.DB.batch([
    env.DB.prepare("UPDATE visual_assets SET is_active = 0 WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?").bind(workId, kind, sceneId),
    env.DB.prepare(
      `UPDATE visual_assets SET generation_status = 'ready', text_validation_status = ?,
       is_visible = 1, is_active = 1 WHERE id = ?`,
    ).bind(kind === "hero" ? "matched" : null, visualId),
  ]);
  return json({ visuals: await getVisualBundle(env, workId) }, 201);
}

async function patchVisualAsset(request: Request, env: Env, visualId: string) {
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM visual_assets WHERE id = ?").bind(visualId));
  if (!asset) return apiError(404, "VISUAL_ASSET_NOT_FOUND", "找不到视觉资产。");
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return apiError(400, "INVALID_JSON", "视觉资产操作必须是有效 JSON。"); }
  const action = String(body.action ?? "");
  if (action === "hide" || action === "show") {
    if (action === "show" && String(asset.generation_status) !== "ready") {
      return apiError(409, "VISUAL_ASSET_NOT_REVIEWED", "该视觉资产尚未通过审核，不能展示。");
    }
    await env.DB.prepare("UPDATE visual_assets SET is_visible = ? WHERE id = ?").bind(action === "show" ? 1 : 0, visualId).run();
  } else if (action === "activate") {
    const approveHero = asset.kind === "hero" && String(asset.generation_status) === "needs_review";
    if (asset.asset_id == null) return apiError(409, "VISUAL_ASSET_FILE_REQUIRED", "失败记录没有可启用的图片。");
    if (String(asset.generation_status) !== "ready" && !approveHero) {
      return apiError(409, "VISUAL_ASSET_NOT_READY", "该视觉资产尚未生成完成，不能设为使用版本。");
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE visual_assets SET is_active = 0 WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ?",
      ).bind(asset.work_id, asset.kind, asset.scene_id ?? ""),
      env.DB.prepare(
        `UPDATE visual_assets SET is_active = 1, is_visible = 1,
          generation_status = ?, text_validation_status = ? WHERE id = ?`,
      ).bind(
        approveHero ? "ready" : asset.generation_status,
        approveHero ? "matched" : asset.text_validation_status,
        visualId,
      ),
    ]);
  } else {
    return apiError(400, "INVALID_VISUAL_ACTION", "不支持的视觉资产操作。");
  }
  return json({ visuals: await getVisualBundle(env, String(asset.work_id)) });
}

async function regenerateVisualAsset(
  env: Env,
  visualId: string,
) {
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM visual_assets WHERE id = ?").bind(visualId));
  if (!asset) return apiError(404, "VISUAL_ASSET_NOT_FOUND", "找不到视觉资产。");
  const spec = await first<Row>(env.DB.prepare(
    `SELECT * FROM visual_specs
      WHERE work_id = ? AND kind = ? AND COALESCE(scene_id, '') = ? AND is_active = 1
      ORDER BY version DESC LIMIT 1`,
  ).bind(asset.work_id, asset.kind, asset.scene_id ?? ""));
  if (!spec) return apiError(409, "VISUAL_SPEC_REQUIRED", "该图片缺少可重生成的视觉方案。");
  return createVisualGenerationJob(env, String(asset.work_id), {
    type: String(asset.kind) as "hero" | "scene",
    sceneId: asset.scene_id == null ? undefined : String(asset.scene_id),
    includePlan: false,
  });
}

async function serveAsset(request: Request, env: Env, assetId: string) {
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId));
  if (!asset) return apiError(404, "ASSET_NOT_FOUND", "找不到素材。");
  const total = Number(asset.byte_size);
  const rangeHeader = request.headers.get("range");
  let object: R2ObjectBody | null;
  let status = 200;
  const headers = new Headers({
    "content-type": String(asset.mime_type),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  });
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start >= total || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    object = await env.AUDIO_BUCKET.get(String(asset.storage_key), { range: { offset: start, length: end - start + 1 } });
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
    headers.set("content-length", String(end - start + 1));
    status = 206;
  } else {
    object = await env.AUDIO_BUCKET.get(String(asset.storage_key));
    headers.set("content-length", String(total));
  }
  if (!object) return apiError(404, "ASSET_OBJECT_NOT_FOUND", "素材记录存在，但 R2 文件缺失。");
  return new Response(object.body, { status, headers });
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (url.pathname === "/api/health" && request.method === "GET") {
    let configuredImageProvider: ImageGenerationProvider;
    let imageProviderError: string | undefined;
    try {
      configuredImageProvider = imageProvider(env);
    } catch (error) {
      configuredImageProvider = imageProvider({ ...env, IMAGE_PROVIDER: "placeholder", IMAGE_API_KEY: undefined });
      imageProviderError = error instanceof Error ? error.message : String(error);
    }
    return json({
      ok: true,
      storage: { d1: Boolean(env.DB), r2: Boolean(env.AUDIO_BUCKET) },
      analysis_service_configured: Boolean(
        env.ANALYSIS_SERVICE_URL
        && env.ANALYSIS_SERVICE_TOKEN
        && env.ANALYSIS_CALLBACK_TOKEN
        && handoffSecret(env),
      ),
      voice_changer: {
        configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
        model_id: VOICE_CHANGER_MODEL_ID,
        voice_id_configured: Boolean(env.ELEVENLABS_VOICE_ID),
      },
      ai_reference_recitation: {
        configured: Boolean(
          env.ANALYSIS_SERVICE_URL
          && env.ANALYSIS_SERVICE_TOKEN
          && env.ELEVENLABS_API_KEY
          && env.ELEVENLABS_VOICE_ID,
        ),
        director_endpoint: "/v1/tts-director",
        tts_model: env.ELEVENLABS_TTS_MODEL?.trim() || ELEVEN_TTS_MODEL_ID,
        voice_id_configured: Boolean(env.ELEVENLABS_VOICE_ID),
      },
      visual_director: {
        configured: Boolean(env.ANALYSIS_SERVICE_URL && env.ANALYSIS_SERVICE_TOKEN),
        endpoint: "/v1/visual-director",
      },
      image_generation: {
        configured: configuredImageProvider.configured,
        provider: configuredImageProvider.provider,
        model: configuredImageProvider.model,
        error: imageProviderError,
      },
    });
  }
  if (url.pathname === "/api/works" && request.method === "GET") return listWorks(request, env);
  if (url.pathname === "/api/works" && request.method === "POST") return createWork(request, env);
  if (url.pathname === "/api/analysis-jobs" && request.method === "POST") {
    return createAnalysisJobFromRequest(request, env, url.origin);
  }
  const uploadMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/reference-audio$/);
  if (uploadMatch && request.method === "POST") return uploadReferenceAudio(request, env, uploadMatch[1]);
  if (uploadMatch && request.method === "DELETE") return deleteReferenceAudio(request, env, uploadMatch[1]);
  const createJobMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/analysis-jobs$/);
  if (createJobMatch && request.method === "POST") {
    return createAnalysisJob(env, url.origin, createJobMatch[1]);
  }
  const textRecitationMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/text-recitation-jobs$/);
  if (textRecitationMatch && request.method === "POST") {
    return createTextRecitationJob(env, textRecitationMatch[1]);
  }
  const jobMatch = url.pathname.match(/^\/api\/analysis-jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") return getAnalysisJob(env, jobMatch[1]);
  const createAiTtsJobMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/ai-tts-jobs$/);
  if (createAiTtsJobMatch && request.method === "POST") {
    return createAiTtsJob(env, createAiTtsJobMatch[1]);
  }
  const retryAiTtsAudioMatch = url.pathname.match(/^\/api\/ai-tts-jobs\/([^/]+)\/retry-audio$/);
  if (retryAiTtsAudioMatch && request.method === "POST") {
    return retryAiTtsJob(env, retryAiTtsAudioMatch[1], "audio");
  }
  const retryAiTtsAnalysisMatch = url.pathname.match(/^\/api\/ai-tts-jobs\/([^/]+)\/retry-analysis$/);
  if (retryAiTtsAnalysisMatch && request.method === "POST") {
    return retryAiTtsJob(env, retryAiTtsAnalysisMatch[1], "analysis");
  }
  const retryAiTtsInterpretationMatch = url.pathname.match(/^\/api\/ai-tts-jobs\/([^/]+)\/retry-interpretation$/);
  if (retryAiTtsInterpretationMatch && request.method === "POST") {
    return retryAiTtsJob(env, retryAiTtsInterpretationMatch[1], "interpretation");
  }
  const aiTtsJobMatch = url.pathname.match(/^\/api\/ai-tts-jobs\/([^/]+)$/);
  if (aiTtsJobMatch && request.method === "GET") {
    return getAiTtsJob(env, url.origin, aiTtsJobMatch[1]);
  }
  const visualJobMatch = url.pathname.match(/^\/api\/visual-jobs\/([^/]+)$/);
  if (visualJobMatch && request.method === "GET") {
    return getVisualGenerationJob(env, visualJobMatch[1]);
  }
  const inputMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/input$/);
  if (inputMatch && request.method === "GET") return getAnalysisInput(request, env, inputMatch[1]);
  const analysisAudioMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/audio$/);
  if (analysisAudioMatch && request.method === "GET") return getAnalysisAudio(request, env, analysisAudioMatch[1]);
  const callbackMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/callback$/);
  if (callbackMatch && request.method === "POST") return analysisCallback(request, env, callbackMatch[1]);
  const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch && request.method === "GET") return serveAsset(request, env, assetMatch[1]);
  const visualBundleMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/visuals$/);
  if (visualBundleMatch && request.method === "GET") {
    const work = await first<Row>(env.DB.prepare("SELECT id FROM works WHERE id = ?").bind(visualBundleMatch[1]));
    return work
      ? json({ visuals: await getVisualBundle(env, visualBundleMatch[1], url.searchParams.get("published") === "1") })
      : apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  }
  if (visualBundleMatch && request.method === "PATCH") return patchWorkVisuals(request, env, visualBundleMatch[1]);
  const visualPlanMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/visuals\/plan$/);
  if (visualPlanMatch && request.method === "POST") return planWorkVisuals(env, visualPlanMatch[1]);
  const visualGenerateMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/visuals\/generate$/);
  if (visualGenerateMatch && request.method === "POST") {
    return generateWorkVisuals(request, env, visualGenerateMatch[1]);
  }
  const visualUploadMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/visual-assets\/upload$/);
  if (visualUploadMatch && request.method === "POST") return uploadVisualReplacement(request, env, visualUploadMatch[1]);
  const visualAssetMatch = url.pathname.match(/^\/api\/visual-assets\/([^/]+)$/);
  if (visualAssetMatch && request.method === "PATCH") return patchVisualAsset(request, env, visualAssetMatch[1]);
  const visualRegenerateMatch = url.pathname.match(/^\/api\/visual-assets\/([^/]+)\/regenerate$/);
  if (visualRegenerateMatch && request.method === "POST") {
    return regenerateVisualAsset(env, visualRegenerateMatch[1]);
  }
  const workMatch = url.pathname.match(/^\/api\/works\/([^/]+)$/);
  if (workMatch && request.method === "GET") {
    const work = await getWorkPayload(env, workMatch[1], url.searchParams.get("published") === "1");
    return work ? json({ work }) : apiError(404, "WORK_NOT_FOUND", "找不到作品。");
  }
  if (workMatch && request.method === "DELETE") return deleteWork(request, env, workMatch[1]);
  const specMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/control-spec$/);
  if (specMatch && request.method === "PATCH") return saveControlSpec(request, env, specMatch[1]);
  const publishMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/publish$/);
  if (publishMatch && request.method === "POST") return publishWork(request, env, publishMatch[1], url.origin);
  return apiError(404, "API_NOT_FOUND", "找不到接口。");
}
