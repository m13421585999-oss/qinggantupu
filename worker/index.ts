import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { importControlSpec } from "@/lib/control-spec-import";
import { withDynamicTimingProfile } from "@/lib/timing-profile";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  ANALYSIS_SERVICE_URL?: string;
  ANALYSIS_SERVICE_TOKEN?: string;
  ANALYSIS_CALLBACK_TOKEN?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Row = Record<string, string | number | null>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const ANALYSIS_JOB_TIMEOUT_MS = 12 * 60 * 1000;
const STANDARD_ANALYSIS_JOB_TYPE = "standard_audio_analysis";
const LEGACY_ANALYSIS_JOB_TYPE = "reference_analysis";
const VOICE_CHANGER_MODEL_ID = "eleven_multilingual_sts_v2";
const VOICE_CHANGER_OUTPUT_FORMAT = "mp3_44100_128";

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

function isAnalysisJobType(value: unknown) {
  return value === STANDARD_ANALYSIS_JOB_TYPE || value === LEGACY_ANALYSIS_JOB_TYPE;
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
      WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')
        AND status = 'succeeded'
      ORDER BY CASE WHEN type = 'standard_audio_analysis' THEN 0 ELSE 1 END,
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
  const latestAnalysisJob = !published
    ? await first<Row>(env.DB.prepare(
      `SELECT id, type, status, progress, input_json, output_json, error_code, error_message
         FROM processing_jobs
        WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')
        ORDER BY CASE WHEN type = 'standard_audio_analysis' THEN 0 ELSE 1 END,
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
    label: "Eleven Voice Changer 标准 AI 朗诵",
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
    controlSpec,
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
    ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
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
    if (sourceChanged) {
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE works
              SET title = ?, author = ?, source_text = ?, status = 'draft', audio_sync_status = 'pending',
                  current_spec_version_id = NULL, published_revision_id = NULL, updated_at = ?
            WHERE id = ?${expectedUpdatedAt ? " AND updated_at = ?" : ""}`,
        ).bind(
          title,
          author || null,
          fullText,
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
            WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')
              AND status IN ('queued', 'processing')
              AND EXISTS (SELECT 1 FROM works WHERE id = ? AND updated_at = ?)`,
        ).bind(savedAt, requestedWorkId, requestedWorkId, savedAt),
      ]);
      if (expectedUpdatedAt && Number(results[0]?.meta.changes ?? 0) === 0) {
        return apiError(
          409,
          "WORK_VERSION_CONFLICT",
          "作品已在其他窗口更新。为避免覆盖最新内容，请重新加载后再编辑。",
        );
      }
    } else {
      const updated = await env.DB.prepare(
        `UPDATE works SET title = ?, author = ?, updated_at = ?
          WHERE id = ?${expectedUpdatedAt ? " AND updated_at = ?" : ""}`,
      ).bind(
        title,
        author || null,
        savedAt,
        requestedWorkId,
        ...expectedUpdatedAt ? [expectedUpdatedAt] : [],
      ).run();
      if (expectedUpdatedAt && Number(updated.meta.changes ?? 0) === 0) {
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
       (id, slug, title, author, genre, language, source_text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 'zh-CN', ?, 'draft', ?, ?)`,
  ).bind(workId, slugFor(title, workId), title, author || null, fullText, savedAt, savedAt).run();
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
    for (let offset = 0; offset < storageKeys.length; offset += 1000) {
      await env.AUDIO_BUCKET.delete(storageKeys.slice(offset, offset + 1000));
    }
  } catch (error) {
    console.error("deleted work has orphaned R2 objects", {
      workId,
      storageKeyCount: storageKeys.length,
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
          WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')
            AND status IN ('queued', 'processing')`,
      ).bind(uploadedAt, workId),
      env.DB.prepare(
        `UPDATE works
            SET status = 'draft', audio_sync_status = 'pending',
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
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE assets SET kind = 'reference_audio_archived' WHERE work_id = ? AND kind = 'reference_audio'",
    ).bind(workId),
    env.DB.prepare(
      "UPDATE assets SET kind = 'standard_ai_audio_archived' WHERE work_id = ? AND kind = 'standard_ai_audio'",
    ).bind(workId),
    env.DB.prepare(
      `UPDATE processing_jobs
          SET status = 'failed', progress = 0, error_code = 'REFERENCE_AUDIO_REMOVED',
              error_message = '参考朗诵已移除，请上传匹配音频并重新发起分析。', updated_at = ?
        WHERE work_id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')
          AND status IN ('queued', 'processing')`,
    ).bind(deletedAt, workId),
    env.DB.prepare(
      `UPDATE works
          SET status = 'draft', audio_sync_status = 'pending', current_spec_version_id = NULL,
              published_revision_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(deletedAt, workId),
    env.DB.prepare(
      "UPDATE publications SET state = 'withdrawn', withdrawn_at = ? WHERE work_id = ? AND state = 'published'",
    ).bind(deletedAt, workId),
  ]);
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
      WHERE j.id = ? AND j.type IN ('standard_audio_analysis', 'reference_analysis')`,
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
    "SELECT id, work_id FROM processing_jobs WHERE id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')",
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
    "SELECT status FROM processing_jobs WHERE id = ? AND type IN ('standard_audio_analysis', 'reference_analysis')",
  ).bind(jobId));
  if (!stored || ["queued", "processing"].includes(String(stored.status))) {
    throw new Error("分析服务已结束，但终态回调没有写入网站。");
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
  if (!job || !isAnalysisJobType(job.type)) {
    return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
  }
  if (await expireStaleAnalysisJob(env, job)) {
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
    await failAnalysisCallback(
      env,
      job,
      String(error.code ?? error.error_code ?? "ANALYSIS_FAILED"),
      String(error.message ?? error.error_message ?? "声音分析失败。"),
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
  const usesStandardAudio = job.type === STANDARD_ANALYSIS_JOB_TYPE;
  const staleInput = usesStandardAudio
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
        referenceAudioAssetId: usesStandardAudio
          ? input.referenceAudioAssetId
          : input.assetId,
        referenceAudioOriginalAssetId: usesStandardAudio
          ? input.referenceAudioAssetId
          : undefined,
        standardAiAudioAssetId: usesStandardAudio ? input.assetId : undefined,
        analyzedAudioRole: usesStandardAudio ? "standard_ai_audio" : "reference_audio",
        pipelineVersion: String(
          pipeline.version
          ?? (usesStandardAudio ? "recitation-analysis-2.0-standard-audio" : "recitation-analysis-1.0"),
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
         VALUES (?, ?, ?, ?, 'eleven', ?, ?, '', NULL, ?, ?, 'candidate', ?)`,
      ).bind(
        audioVersionId,
        work.id,
        specId,
        input.assetId,
        String(voiceMetadata?.model_id ?? VOICE_CHANGER_MODEL_ID),
        String(voiceMetadata?.voice_id ?? env.ELEVENLABS_VOICE_ID ?? ""),
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

async function serveAsset(request: Request, env: Env, assetId: string) {
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId));
  if (!asset) return apiError(404, "ASSET_NOT_FOUND", "找不到音频素材。");
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
  if (!object) return apiError(404, "ASSET_OBJECT_NOT_FOUND", "音频记录存在，但 R2 文件缺失。");
  return new Response(object.body, { status, headers });
}

async function api(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (url.pathname === "/api/health" && request.method === "GET") {
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
  const jobMatch = url.pathname.match(/^\/api\/analysis-jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") return getAnalysisJob(env, jobMatch[1]);
  const inputMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/input$/);
  if (inputMatch && request.method === "GET") return getAnalysisInput(request, env, inputMatch[1]);
  const analysisAudioMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/audio$/);
  if (analysisAudioMatch && request.method === "GET") return getAnalysisAudio(request, env, analysisAudioMatch[1]);
  const callbackMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/callback$/);
  if (callbackMatch && request.method === "POST") return analysisCallback(request, env, callbackMatch[1]);
  const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch && request.method === "GET") return serveAsset(request, env, assetMatch[1]);
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

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const apiResponse = await api(request, env);
      if (apiResponse) return apiResponse;
      const url = new URL(request.url);
      if (url.pathname === "/_vinext/image") {
        const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
        return handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        }, allowedWidths);
      }
      return handler.fetch(request, env, ctx);
    } catch (error) {
      console.error("worker request failed", error);
      return apiError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "服务器发生未知错误。");
    }
  },
};

export default worker;
