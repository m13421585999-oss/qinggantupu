import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { importControlSpec } from "@/lib/control-spec-import";
import { buildElevenTimeline, compileElevenV3Prompt } from "@/lib/eleven-tts";

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
  const latestAnalysisJob = !published
    ? await first<Row>(env.DB.prepare(
      "SELECT id, status, progress, input_json, output_json, error_code, error_message FROM processing_jobs WHERE work_id = ? AND type = 'reference_analysis' ORDER BY created_at DESC LIMIT 1",
    ).bind(workId))
    : null;
  const latestAnalysisInput = parseJson<{ assetId?: string }>(latestAnalysisJob?.input_json as string | null);
  const analysisJob = reference && latestAnalysisInput?.assetId === reference.id ? latestAnalysisJob : null;
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

  const ai = publication?.audio_version_id
    ? await first<Row>(env.DB.prepare(
      `SELECT av.*, a.filename, a.mime_type, a.duration_ms AS asset_duration_ms
         FROM audio_versions av
         JOIN assets a ON a.id = av.audio_asset_id
        WHERE av.id = ? LIMIT 1`,
    ).bind(publication.audio_version_id))
    : selectedSpecVersionId
    ? await first<Row>(env.DB.prepare(
      `SELECT av.*, a.filename, a.mime_type, a.duration_ms AS asset_duration_ms
         FROM audio_versions av
         JOIN assets a ON a.id = av.audio_asset_id
        WHERE av.work_id = ? AND av.control_spec_version_id = ?
        ORDER BY av.created_at DESC LIMIT 1`,
    ).bind(workId, selectedSpecVersionId))
    : null;

  return {
    id: work.id,
    slug: work.slug,
    title: work.title,
    author: work.author ?? undefined,
    genre: work.genre,
    language: work.language,
    sourceText: work.source_text,
    status: published ? "published" : work.status,
    currentSpecVersionId: selectedSpecVersionId ?? undefined,
    publishedRevisionId: publication?.id ?? work.published_revision_id ?? undefined,
    analysisJobId: analysisJob?.id ?? undefined,
    analysisPackage,
    referenceAudio: reference ? {
      id: reference.id,
      kind: "reference",
      url: `/api/assets/${reference.id}`,
      filename: reference.filename,
      mimeType: reference.mime_type,
      durationMs: Number(reference.duration_ms ?? (analysisPackage?.audio as Record<string, unknown> | undefined)?.duration_ms ?? 0),
      provider: "upload",
      label: "上传的优质参考朗诵",
      timeline: analysisPackage ? analysisTimeline(analysisPackage) : undefined,
    } : undefined,
    aiDemoAudio: ai ? {
      id: ai.audio_asset_id,
      kind: "ai_demo",
      url: `/api/assets/${ai.audio_asset_id}`,
      filename: ai.filename,
      mimeType: ai.mime_type,
      durationMs: Number(ai.duration_ms ?? ai.asset_duration_ms ?? 0),
      provider: "eleven",
      label: "Eleven v3 AI 示范",
      timeline: parseJson(ai.timeline_json as string),
    } : undefined,
    controlSpec,
    createdAt: work.created_at,
    updatedAt: work.updated_at,
    analysisError: analysisJob?.status === "failed" ? {
      code: analysisJob.error_code,
      message: analysisJob.error_message,
    } : undefined,
  };
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
  if (!title || !fullText.trim()) {
    return apiError(400, "INVALID_WORK", "作品名称和完整正文不能为空。");
  }

  const savedAt = now();
  if (requestedWorkId) {
    const existing = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(requestedWorkId));
    if (!existing) return apiError(404, "WORK_NOT_FOUND", "找不到要更新的作品。");
    const sourceChanged = String(existing.source_text) !== fullText;
    if (sourceChanged) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE works
              SET title = ?, author = ?, source_text = ?, status = 'draft',
                  current_spec_version_id = NULL, published_revision_id = NULL, updated_at = ?
            WHERE id = ?`,
        ).bind(title, author || null, fullText, savedAt, requestedWorkId),
        env.DB.prepare(
          "UPDATE publications SET state = 'withdrawn', withdrawn_at = ? WHERE work_id = ? AND state = 'published'",
        ).bind(savedAt, requestedWorkId),
        env.DB.prepare(
          "UPDATE assets SET kind = 'reference_audio_archived' WHERE work_id = ? AND kind = 'reference_audio'",
        ).bind(requestedWorkId),
        env.DB.prepare(
          `UPDATE processing_jobs
              SET status = 'failed', progress = 0, error_code = 'WORK_SOURCE_CHANGED',
                  error_message = '作品正文已更新，请重新上传匹配的参考朗诵并发起分析。', updated_at = ?
            WHERE work_id = ? AND type = 'reference_analysis' AND status IN ('queued', 'processing')`,
        ).bind(savedAt, requestedWorkId),
      ]);
    } else {
      await env.DB.prepare(
        "UPDATE works SET title = ?, author = ?, updated_at = ? WHERE id = ?",
      ).bind(title, author || null, savedAt, requestedWorkId).run();
    }
    return json({ work: await getWorkPayload(env, requestedWorkId) });
  }

  const workId = id("work");
  await env.DB.prepare(
    `INSERT INTO works
       (id, slug, title, author, genre, language, source_text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 'zh-CN', ?, 'draft', ?, ?)`,
  ).bind(workId, slugFor(title, workId), title, author || null, fullText, savedAt, savedAt).run();
  return json({ work: await getWorkPayload(env, workId) }, 201);
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
  const uploadedAt = now();
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
        `INSERT INTO assets
           (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms, checksum, provider, created_at)
         VALUES (?, ?, 'reference_audio', ?, ?, ?, ?, ?, ?, 'upload', ?)`,
      ).bind(assetId, workId, storageKey, filename, mimeType, fileValue.size, durationMs, checksum, uploadedAt),
      env.DB.prepare(
        `UPDATE processing_jobs
            SET status = 'failed', progress = 0, error_code = 'REFERENCE_AUDIO_REPLACED',
                error_message = '参考朗诵已被替换，请重新发起分析。', updated_at = ?
          WHERE work_id = ? AND type = 'reference_analysis' AND status IN ('queued', 'processing')`,
      ).bind(uploadedAt, workId),
      env.DB.prepare(
        `UPDATE works
            SET status = 'draft', current_spec_version_id = NULL, updated_at = ?
          WHERE id = ?`,
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

function handoffSecret(env: Env) {
  return env.ANALYSIS_CALLBACK_TOKEN;
}

async function jobContext(env: Env, jobId: string) {
  const job = await first<Row>(env.DB.prepare(
    `SELECT j.*, w.title, w.author, w.source_text
       FROM processing_jobs j
       JOIN works w ON w.id = j.work_id
      WHERE j.id = ? AND j.type = 'reference_analysis'`,
  ).bind(jobId));
  if (!job) return null;
  const input = parseJson<{ assetId?: string; handoffExpiresAt?: number }>(job.input_json as string | null);
  if (!input?.assetId) return null;
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(input.assetId));
  if (!asset || asset.work_id !== job.work_id) return null;
  return { job, asset, input };
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

async function dispatchAnalysisJob(env: Env, origin: string, jobId: string) {
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_SERVICE_TOKEN) return;
  const context = await jobContext(env, jobId);
  if (!context) return;
  const expires = Number(context.input.handoffExpiresAt ?? 0);
  try {
    const inputUrl = await signedHandoffUrl(env, origin, "input", jobId, String(context.asset.id), expires);
    const audioUrl = await signedHandoffUrl(env, origin, "audio", jobId, String(context.asset.id), expires);
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
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 600);
      throw new Error(`分析服务拒绝任务（HTTP ${response.status}）：${detail}`);
    }
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'processing', progress = 5, updated_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(now(), jobId).run();
  } catch (error) {
    const failedAt = now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE processing_jobs
            SET status = 'failed', progress = 0, error_code = 'ANALYSIS_SUBMISSION_FAILED',
                error_message = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      ).bind(error instanceof Error ? error.message : String(error), failedAt, jobId),
      env.DB.prepare("UPDATE works SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'analyzing'")
        .bind(failedAt, context.job.work_id),
    ]);
  }
}

async function createAnalysisJob(env: Env, ctx: ExecutionContext, origin: string, workId: string) {
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
  const active = await first<Row>(env.DB.prepare(
    `SELECT id, status FROM processing_jobs
      WHERE work_id = ? AND type = 'reference_analysis' AND status IN ('queued', 'processing')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(workId));
  if (active) {
    return json({ analysis_job_id: active.id, work_id: workId, status: active.status });
  }

  const jobId = id("job");
  const createdAt = now();
  const handoffExpiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO processing_jobs
         (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
       VALUES (?, ?, 'reference_analysis', 'queued', 0, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      workId,
      `reference-analysis:${workId}:${String(reference.checksum)}:${jobId}`,
      JSON.stringify({ assetId: reference.id, audioSha256: reference.checksum, handoffExpiresAt }),
      createdAt,
      createdAt,
    ),
    env.DB.prepare("UPDATE works SET status = 'analyzing', updated_at = ? WHERE id = ?").bind(createdAt, workId),
  ]);
  ctx.waitUntil(dispatchAnalysisJob(env, origin, jobId));
  return json({ analysis_job_id: jobId, work_id: workId, status: "queued" }, 202);
}

async function createAnalysisJobFromRequest(request: Request, env: Env, ctx: ExecutionContext, origin: string) {
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
  return createAnalysisJob(env, ctx, origin, workId);
}

async function getAnalysisJob(env: Env, jobId: string) {
  const job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
  if (!job || job.type !== "reference_analysis") {
    return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
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
  if (!["queued", "processing"].includes(String(context.job.status)) || context.asset.kind !== "reference_audio") {
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
  if (!["queued", "processing"].includes(String(context.job.status)) || context.asset.kind !== "reference_audio") {
    return apiError(409, "JOB_NOT_ACTIVE", "声音分析任务已失效，请重新发起分析。");
  }
  if (!await verifyHandoff(request, env, "audio", jobId, String(context.asset.id))) {
    return apiError(401, "INVALID_HANDOFF_TOKEN", "分析音频链接无效或已过期。");
  }
  const object = await env.AUDIO_BUCKET.get(String(context.asset.storage_key));
  if (!object) return apiError(404, "ASSET_OBJECT_NOT_FOUND", "参考音频记录存在，但 R2 文件缺失。");
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
  if (!job || job.type !== "reference_analysis") return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
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
  const input = parseJson<{ assetId?: string }>(job.input_json as string | null);
  if (!work || !input?.assetId) return apiError(409, "JOB_CONTEXT_MISSING", "分析任务关联的作品或参考音频不存在。");
  const currentReference = await first<Row>(env.DB.prepare(
    "SELECT id FROM assets WHERE work_id = ? AND kind = 'reference_audio' ORDER BY created_at DESC LIMIT 1",
  ).bind(work.id));
  if (currentReference?.id !== input.assetId) {
    const message = "参考朗诵已被替换，旧分析结果不会写入当前作品。";
    await failAnalysisCallback(env, job, "JOB_INPUT_STALE", message, { analysis_package: analysisPackage ?? null });
    return apiError(409, "JOB_INPUT_STALE", message);
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
    normalizedSpec = importControlSpec(rawControlSpec, String(work.source_text), String(work.id), input.assetId) as unknown as Record<string, unknown>;
    const provenance = normalizedSpec.analysisProvenance && typeof normalizedSpec.analysisProvenance === "object"
      ? normalizedSpec.analysisProvenance as Record<string, unknown>
      : {};
    const pipeline = body.pipeline && typeof body.pipeline === "object" ? body.pipeline as Record<string, unknown> : {};
    normalizedSpec = {
      ...normalizedSpec,
      source: "ai",
      analysisProvenance: {
        ...provenance,
        pipelineVersion: String(pipeline.version ?? "recitation-analysis-1.0"),
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
  await env.DB.batch([
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
          SET current_spec_version_id = ?, status = 'review', published_revision_id = NULL, updated_at = ?
        WHERE id = ? AND source_text = ?
          AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND work_id = ? AND kind = 'reference_audio')`,
    ).bind(specId, completedAt, work.id, work.source_text, input.assetId, work.id),
    env.DB.prepare("UPDATE assets SET duration_ms = COALESCE(?, duration_ms) WHERE id = ? AND kind = 'reference_audio'")
      .bind(durationMs > 0 ? Math.round(durationMs) : null, input.assetId),
  ]);
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
  const spec = body.control_spec as Record<string, unknown> | undefined;
  if (!spec) return apiError(400, "CONTROL_SPEC_REQUIRED", "请提供 control_spec。");
  try {
    validateControlSpec(spec, String(work.source_text));
  } catch (error) {
    return apiError(422, "INVALID_CONTROL_SPEC", error instanceof Error ? error.message : String(error));
  }
  const latest = await first<Row>(env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM control_spec_versions WHERE work_id = ?",
  ).bind(workId));
  const version = Number(latest?.version ?? 0) + 1;
  const specId = id("spec");
  const updated = { ...spec, id: specId, workId, version };
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO control_spec_versions
       (id, work_id, version, schema_version, source, spec_json, validation_state, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'valid', 'creator', ?)`,
    ).bind(specId, workId, version, String(spec.schemaVersion ?? "2.0"), String(body.source ?? "human"), JSON.stringify(updated), createdAt),
    env.DB.prepare(
      "UPDATE works SET current_spec_version_id = ?, status = 'review', published_revision_id = NULL, updated_at = ? WHERE id = ?",
    ).bind(specId, createdAt, workId),
  ]);
  return json({ control_spec: updated, work: await getWorkPayload(env, workId) });
}

function decodeBase64(input: string) {
  const raw = atob(input);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function generateAiDemo(env: Env, workId: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法保存 AI 示范。");
  }
  if (!env.ELEVENLABS_API_KEY?.trim() || !env.ELEVENLABS_VOICE_ID?.trim()) {
    return apiError(503, "ELEVEN_TTS_NOT_CONFIGURED", "请在网站服务端配置 ELEVENLABS_API_KEY 和 ELEVENLABS_VOICE_ID。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work?.current_spec_version_id) return apiError(409, "CONTROL_SPEC_REQUIRED", "请先导入并确认控制谱。");
  const specRow = await first<Row>(env.DB.prepare("SELECT * FROM control_spec_versions WHERE id = ?").bind(work.current_spec_version_id));
  const spec = parseJson<Record<string, unknown>>(specRow?.spec_json as string);
  if (!spec) return apiError(500, "INVALID_STORED_SPEC", "保存的控制谱无法读取。");
  let prompt: ReturnType<typeof compileElevenV3Prompt>;
  try {
    prompt = compileElevenV3Prompt(spec);
  } catch (error) {
    return apiError(422, "TTS_PROMPT_COMPILE_FAILED", error instanceof Error ? error.message : String(error));
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
        body: JSON.stringify({
          text: prompt.text,
          model_id: "eleven_v3",
          language_code: "zh",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        }),
      },
    );
  } catch (error) {
    return apiError(502, "ELEVEN_TTS_UNAVAILABLE", `无法连接 ElevenLabs：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    return apiError(502, "ELEVEN_TTS_FAILED", `Eleven v3 生成失败（HTTP ${response.status}）：${(await response.text()).slice(0, 600)}`);
  }
  let providerResponse: Record<string, unknown>;
  try {
    providerResponse = await response.json() as Record<string, unknown>;
  } catch {
    return apiError(502, "ELEVEN_TTS_INVALID_RESPONSE", "Eleven v3 返回了无法解析的数据。");
  }
  const audioBase64 = String(providerResponse.audio_base64 ?? "");
  if (!audioBase64) return apiError(502, "ELEVEN_TTS_EMPTY_AUDIO", "Eleven v3 没有返回音频。");
  let timeline: ReturnType<typeof buildElevenTimeline>;
  try {
    timeline = buildElevenTimeline(spec, prompt, providerResponse);
  } catch (error) {
    return apiError(502, "ELEVEN_TTS_ALIGNMENT_FAILED", error instanceof Error ? error.message : String(error));
  }
  let audioBytes: Uint8Array;
  try {
    audioBytes = decodeBase64(audioBase64);
  } catch {
    return apiError(502, "ELEVEN_TTS_INVALID_AUDIO", "Eleven v3 返回的音频数据无效。");
  }
  if (!audioBytes.byteLength) return apiError(502, "ELEVEN_TTS_EMPTY_AUDIO", "Eleven v3 返回了空音频。");
  const assetId = id("asset");
  const audioVersionId = id("audio");
  const storageKey = `works/${workId}/ai-demo/${assetId}.mp3`;
  const checksum = await sha256Hex(audioBytes.slice().buffer);
  const durationMs = timeline.durationMs;
  if (!durationMs) return apiError(502, "ELEVEN_TTS_INVALID_DURATION", "Eleven v3 没有返回可用的音频时长。");
  const createdAt = now();
  await env.AUDIO_BUCKET.put(storageKey, audioBytes, {
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: {
      workId,
      assetId,
      checksum,
      kind: "ai_demo",
      controlSpecVersionId: String(work.current_spec_version_id),
      provider: "eleven",
      model: "eleven_v3",
    },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE audio_versions SET candidate_state = 'superseded'
          WHERE work_id = ? AND control_spec_version_id = ? AND candidate_state = 'candidate'`,
      ).bind(workId, work.current_spec_version_id),
      env.DB.prepare(
        `INSERT INTO assets (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms, checksum, provider, created_at)
         VALUES (?, ?, 'ai_demo_audio', ?, ?, 'audio/mpeg', ?, ?, ?, 'eleven', ?)`,
      ).bind(assetId, workId, storageKey, `${work.slug}-ai-demo.mp3`, audioBytes.byteLength, durationMs, checksum, createdAt),
      env.DB.prepare(
        `INSERT INTO audio_versions
         (id, work_id, control_spec_version_id, audio_asset_id, provider, model, voice_id, prompt_text, timeline_json, duration_ms, candidate_state, created_at)
         VALUES (?, ?, ?, ?, 'eleven', 'eleven_v3', ?, ?, ?, ?, 'candidate', ?)`,
      ).bind(audioVersionId, workId, work.current_spec_version_id, assetId, env.ELEVENLABS_VOICE_ID, prompt.text, JSON.stringify(timeline), durationMs, createdAt),
      env.DB.prepare(
        "UPDATE works SET status = 'audio_ready', updated_at = ? WHERE id = ? AND current_spec_version_id = ?",
      ).bind(createdAt, workId, work.current_spec_version_id),
    ]);
  } catch (error) {
    await env.AUDIO_BUCKET.delete(storageKey).catch(() => undefined);
    throw error;
  }
  return json({ work: await getWorkPayload(env, workId) });
}

async function publishWork(env: Env, workId: string, origin: string) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法发布作品。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work?.current_spec_version_id) return apiError(409, "CONTROL_SPEC_REQUIRED", "作品没有已确认控制谱。");
  const audio = await first<Row>(env.DB.prepare(
    `SELECT av.id, av.audio_asset_id, av.timeline_json
       FROM audio_versions av
       JOIN assets a ON a.id = av.audio_asset_id
      WHERE av.work_id = ? AND av.control_spec_version_id = ?
        AND av.candidate_state IN ('candidate', 'approved')
        AND a.kind = 'ai_demo_audio'
      ORDER BY av.created_at DESC LIMIT 1`,
  ).bind(workId, work.current_spec_version_id));
  if (!audio) return apiError(409, "AI_DEMO_REQUIRED", "请先为当前控制谱生成 AI 示范。");
  const timeline = parseJson<Record<string, unknown>>(audio.timeline_json as string | null);
  if (!timeline || !Array.isArray(timeline.tokens) || !timeline.tokens.length) {
    return apiError(409, "AI_DEMO_TIMELINE_REQUIRED", "当前 AI 示范缺少字符时间戳，不能发布。");
  }
  const existing = await first<Row>(env.DB.prepare("SELECT id FROM publications WHERE slug = ?").bind(work.slug));
  const publicationId = String(existing?.id ?? id("publication"));
  const publishedAt = now();
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
        WHERE work_id = ? AND control_spec_version_id = ?`,
    ).bind(audio.id, workId, work.current_spec_version_id),
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

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
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
      eleven_tts_configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
    });
  }
  if (url.pathname === "/api/works" && request.method === "POST") return createWork(request, env);
  if (url.pathname === "/api/analysis-jobs" && request.method === "POST") {
    return createAnalysisJobFromRequest(request, env, ctx, url.origin);
  }
  const uploadMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/reference-audio$/);
  if (uploadMatch && request.method === "POST") return uploadReferenceAudio(request, env, uploadMatch[1]);
  const createJobMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/analysis-jobs$/);
  if (createJobMatch && request.method === "POST") {
    return createAnalysisJob(env, ctx, url.origin, createJobMatch[1]);
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
  const specMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/control-spec$/);
  if (specMatch && request.method === "PATCH") return saveControlSpec(request, env, specMatch[1]);
  const ttsMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/ai-demo$/);
  if (ttsMatch && request.method === "POST") return generateAiDemo(env, ttsMatch[1]);
  const publishMatch = url.pathname.match(/^\/api\/works\/([^/]+)\/publish$/);
  if (publishMatch && request.method === "POST") return publishWork(env, publishMatch[1], url.origin);
  return apiError(404, "API_NOT_FOUND", "找不到接口。");
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const apiResponse = await api(request, env, ctx);
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
