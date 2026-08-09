import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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

function analysisTimeline(analysis: Record<string, unknown> | undefined) {
  const tokens = Array.isArray(analysis?.tokens) ? analysis.tokens as Array<Record<string, unknown>> : [];
  const sentences = Array.isArray(analysis?.sentences) ? analysis.sentences as Array<Record<string, unknown>> : [];
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

async function getWorkPayload(env: Env, workId: string) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work) return null;

  const reference = await first<Row>(env.DB.prepare(
    "SELECT * FROM assets WHERE work_id = ? AND kind = 'reference_audio' ORDER BY created_at DESC LIMIT 1",
  ).bind(workId));
  const analysisJob = await first<Row>(env.DB.prepare(
    "SELECT id, status, output_json, error_code, error_message FROM processing_jobs WHERE work_id = ? AND type = 'reference_analysis' ORDER BY created_at DESC LIMIT 1",
  ).bind(workId));
  const analysisOutput = parseJson<Record<string, unknown>>(analysisJob?.output_json as string | null);
  const analysisPackage = analysisOutput?.analysis_package as Record<string, unknown> | undefined;

  let controlSpec: Record<string, unknown> | undefined;
  if (work.current_spec_version_id) {
    const spec = await first<Row>(env.DB.prepare(
      "SELECT spec_json FROM control_spec_versions WHERE id = ?",
    ).bind(work.current_spec_version_id));
    controlSpec = parseJson<Record<string, unknown>>(spec?.spec_json as string | null);
  }

  const ai = work.current_spec_version_id
    ? await first<Row>(env.DB.prepare(
      `SELECT av.*, a.filename, a.mime_type, a.duration_ms AS asset_duration_ms
         FROM audio_versions av
         JOIN assets a ON a.id = av.audio_asset_id
        WHERE av.work_id = ? AND av.control_spec_version_id = ?
        ORDER BY av.created_at DESC LIMIT 1`,
    ).bind(workId, work.current_spec_version_id))
    : null;

  return {
    id: work.id,
    slug: work.slug,
    title: work.title,
    author: work.author ?? undefined,
    genre: work.genre,
    language: work.language,
    sourceText: work.source_text,
    status: work.status,
    currentSpecVersionId: work.current_spec_version_id ?? undefined,
    publishedRevisionId: work.published_revision_id ?? undefined,
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

async function submitAnalysisJob(env: Env, origin: string, jobId: string) {
  const serviceUrl = env.ANALYSIS_SERVICE_URL?.replace(/\/$/, "");
  if (!serviceUrl || !env.ANALYSIS_CALLBACK_TOKEN) {
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'failed', progress = 0, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
    ).bind(
      "ANALYSIS_SERVICE_NOT_CONFIGURED",
      "Python 音频分析服务尚未配置。请设置 ANALYSIS_SERVICE_URL 和 ANALYSIS_CALLBACK_TOKEN。",
      now(),
      jobId,
    ).run();
    return;
  }

  const job = await first<Row>(env.DB.prepare(
    `SELECT j.*, w.title, w.author, w.source_text
       FROM processing_jobs j JOIN works w ON w.id = j.work_id
      WHERE j.id = ?`,
  ).bind(jobId));
  if (!job) return;
  const input = parseJson<{ assetId: string }>(job.input_json as string);
  if (!input?.assetId) throw new Error("analysis job is missing assetId");
  const asset = await first<Row>(env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(input.assetId));
  if (!asset) throw new Error("reference asset is missing");
  const stored = await env.AUDIO_BUCKET.get(String(asset.storage_key));
  if (!stored) throw new Error("reference audio object is missing from R2");

  await env.DB.prepare(
    "UPDATE processing_jobs SET status = 'processing', progress = 10, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
  ).bind(now(), jobId).run();

  try {
    const form = new FormData();
    form.set("job_id", jobId);
    form.set("work_id", String(job.work_id));
    form.set("title", String(job.title));
    form.set("author", String(job.author ?? ""));
    form.set("full_text", String(job.source_text));
    form.set("callback_url", `${origin}/api/internal/analysis-jobs/${jobId}/callback`);
    form.set("callback_token", env.ANALYSIS_CALLBACK_TOKEN);
    form.set(
      "audio_file",
      new File([await stored.arrayBuffer()], String(asset.filename), { type: String(asset.mime_type) }),
    );
    const response = await fetch(`${serviceUrl}/v1/jobs`, {
      method: "POST",
      headers: env.ANALYSIS_SERVICE_TOKEN
        ? { authorization: `Bearer ${env.ANALYSIS_SERVICE_TOKEN}` }
        : undefined,
      body: form,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`分析服务拒绝任务（HTTP ${response.status}）：${detail}`);
    }
  } catch (error) {
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'failed', progress = 0, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
    ).bind("ANALYSIS_SUBMISSION_FAILED", error instanceof Error ? error.message : String(error), now(), jobId).run();
    await env.DB.prepare("UPDATE works SET status = 'draft', updated_at = ? WHERE id = ?")
      .bind(now(), job.work_id).run();
  }
}

async function createAnalysisJob(request: Request, env: Env, ctx: ExecutionContext) {
  if (!env.DB || !env.AUDIO_BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "D1 或 R2 尚未绑定，无法保存正式作品。");
  }
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  const author = String(form.get("author") ?? "").trim();
  const fullText = String(form.get("full_text") ?? "");
  const audio = form.get("reference_audio_file");
  const requestedWorkId = String(form.get("work_id") ?? "").trim();
  const durationMs = Math.max(0, Math.round(Number(form.get("duration_ms") ?? 0)));
  if (!title || !fullText.trim()) {
    return apiError(400, "INVALID_WORK", "作品名称和完整正文不能为空。");
  }
  if (!(audio instanceof File) || audio.size <= 0) {
    return apiError(400, "REFERENCE_AUDIO_REQUIRED", "必须上传真实参考朗诵音频。");
  }
  if (audio.size > 100 * 1024 * 1024) {
    return apiError(413, "REFERENCE_AUDIO_TOO_LARGE", "参考音频不能超过 100 MB。");
  }

  const existing = requestedWorkId
    ? await first<Row>(env.DB.prepare("SELECT id FROM works WHERE id = ?").bind(requestedWorkId))
    : null;
  const workId = existing ? requestedWorkId : id("work");
  const assetId = id("asset");
  const jobId = id("job");
  const createdAt = now();
  const bytes = await audio.arrayBuffer();
  const checksum = await sha256Hex(bytes);
  const storageKey = `works/${workId}/reference/${assetId}-${safeFilename(audio.name)}`;
  await env.AUDIO_BUCKET.put(storageKey, bytes, {
    httpMetadata: { contentType: audio.type || "application/octet-stream" },
    customMetadata: { workId, assetId, checksum, kind: "reference_audio" },
  });

  try {
    const workStatement = existing
      ? env.DB.prepare(
        `UPDATE works SET title = ?, author = ?, source_text = ?, status = 'analyzing',
          current_spec_version_id = NULL, published_revision_id = NULL, updated_at = ? WHERE id = ?`,
      ).bind(title, author || null, fullText, createdAt, workId)
      : env.DB.prepare(
        `INSERT INTO works (id, slug, title, author, genre, language, source_text, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'other', 'zh-CN', ?, 'analyzing', ?, ?)`,
      ).bind(workId, slugFor(title, workId), title, author || null, fullText, createdAt, createdAt);
    await env.DB.batch([
      workStatement,
      env.DB.prepare(
        `INSERT INTO assets (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms, checksum, provider, created_at)
         VALUES (?, ?, 'reference_audio', ?, ?, ?, ?, ?, ?, 'upload', ?)`,
      ).bind(assetId, workId, storageKey, audio.name, audio.type || "application/octet-stream", audio.size, durationMs || null, checksum, createdAt),
      env.DB.prepare(
        `INSERT INTO processing_jobs (id, work_id, type, status, progress, idempotency_key, input_json, created_at, updated_at)
         VALUES (?, ?, 'reference_analysis', 'queued', 0, ?, ?, ?, ?)`,
      ).bind(jobId, workId, `${workId}:${checksum}:${jobId}`, JSON.stringify({ assetId, audioSha256: checksum }), createdAt, createdAt),
    ]);
  } catch (error) {
    await env.AUDIO_BUCKET.delete(storageKey);
    throw error;
  }

  ctx.waitUntil(submitAnalysisJob(env, new URL(request.url).origin, jobId));
  return json({
    analysis_job_id: jobId,
    work_id: workId,
    status: "queued",
    reference_audio: {
      id: assetId,
      kind: "reference",
      url: `/api/assets/${assetId}`,
      filename: audio.name,
      mimeType: audio.type || "application/octet-stream",
      durationMs,
      provider: "upload",
      label: "上传的优质参考朗诵",
    },
  }, 202);
}

async function getAnalysisJob(env: Env, jobId: string) {
  const job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
  if (!job) return apiError(404, "JOB_NOT_FOUND", "找不到这次声音分析任务。");
  const payload: Record<string, unknown> = {
    analysis_job_id: job.id,
    work_id: job.work_id,
    status: job.status,
    progress: job.progress,
  };
  if (job.status === "failed") {
    payload.error = { code: job.error_code, message: job.error_message };
  }
  if (job.status === "succeeded") {
    payload.result = parseJson(job.output_json as string);
    payload.work = await getWorkPayload(env, String(job.work_id));
  }
  return json(payload);
}

async function analysisCallback(request: Request, env: Env, jobId: string) {
  const expected = env.ANALYSIS_CALLBACK_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied !== expected) {
    return apiError(401, "INVALID_CALLBACK_TOKEN", "分析回调身份校验失败。");
  }
  const job = await first<Row>(env.DB.prepare("SELECT * FROM processing_jobs WHERE id = ?").bind(jobId));
  if (!job) return apiError(404, "JOB_NOT_FOUND", "找不到声音分析任务。");
  const body = await request.json() as Record<string, unknown>;
  if (body.status === "failed") {
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE processing_jobs SET status = 'failed', progress = 0, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
      ).bind(String(error.code ?? "ANALYSIS_FAILED"), String(error.message ?? "声音分析失败"), now(), jobId),
      env.DB.prepare("UPDATE works SET status = 'draft', updated_at = ? WHERE id = ?").bind(now(), job.work_id),
    ]);
    return json({ ok: true });
  }

  const analysisPackage = body.analysis_package as Record<string, unknown> | undefined;
  const tokens = Array.isArray(analysisPackage?.tokens)
    ? analysisPackage.tokens as Array<Record<string, unknown>>
    : [];
  const work = await first<Row>(env.DB.prepare("SELECT source_text FROM works WHERE id = ?").bind(job.work_id));
  const alignedText = tokens.map((token) => String(token.char ?? "")).join("");
  if (!analysisPackage || !tokens.length || alignedText !== work?.source_text) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE processing_jobs SET status = 'failed', progress = 0, error_code = 'TEXT_ALIGNMENT_MISMATCH', error_message = ?, updated_at = ? WHERE id = ?",
      ).bind("Eleven 对齐结果与保存的完整正文不一致，已拒绝生成分析包。", now(), jobId),
      env.DB.prepare("UPDATE works SET status = 'draft', updated_at = ? WHERE id = ?").bind(now(), job.work_id),
    ]);
    return apiError(422, "TEXT_ALIGNMENT_MISMATCH", "分析包正文校验失败。");
  }
  const input = parseJson<{ assetId: string }>(job.input_json as string);
  const durationMs = Number((analysisPackage.audio as Record<string, unknown> | undefined)?.duration_ms ?? 0);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE processing_jobs SET status = 'succeeded', progress = 100, output_json = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
    ).bind(JSON.stringify({ analysis_package: analysisPackage, provider_quality: body.provider_quality ?? null }), now(), jobId),
    env.DB.prepare("UPDATE works SET status = 'analysis_ready', updated_at = ? WHERE id = ?").bind(now(), job.work_id),
    env.DB.prepare("UPDATE assets SET duration_ms = ? WHERE id = ?").bind(durationMs || null, input?.assetId ?? ""),
  ]);
  return json({ ok: true });
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

function rhythmTag(value: unknown) {
  const tags: Record<string, string> = {
    light: "[lively]",
    solemn: "[solemn]",
    relaxed: "[calm]",
    tense: "[tense]",
    soaring: "[passionately]",
    low: "[low voice]",
  };
  return tags[String(value)] ?? "[natural]";
}

function compilePrompt(spec: Record<string, unknown>) {
  const sentences = spec.sentences as Array<Record<string, unknown>>;
  let text = "";
  const sourceOffsets = new Map<number, number>();
  for (const sentence of sentences) {
    text += rhythmTag(sentence.rhythm) + " ";
    const focuses = Array.isArray(sentence.focus) ? sentence.focus as Array<Record<string, unknown>> : [];
    const focusIndexes = new Set(focuses.flatMap((focus) => (focus.tokenIndexes ?? focus.token_indexes ?? []) as number[]));
    const pauses = new Map<number, string>();
    for (const pause of (Array.isArray(sentence.pauses) ? sentence.pauses : []) as Array<Record<string, unknown>>) {
      pauses.set(Number(pause.afterTokenIndex ?? pause.after_index), String(pause.type));
    }
    const prolongs = new Set(((sentence.prolongations ?? []) as Array<Record<string, unknown>>).map((item) => Number(item.tokenIndex ?? item.token_index)));
    for (const token of sentence.tokens as Array<Record<string, unknown>>) {
      const index = Number(token.index);
      if (focusIndexes.has(index)) text += "[emphasized]";
      sourceOffsets.set(index, Array.from(text).length);
      text += String(token.char);
      if (prolongs.has(index)) text += "—";
      const pause = pauses.get(index);
      if (pause) text += pause === "long" ? "……" : "，";
    }
    text += "\n";
  }
  return { text: text.trim(), sourceOffsets };
}

function decodeBase64(input: string) {
  const raw = atob(input);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function buildTtsTimeline(spec: Record<string, unknown>, prompt: ReturnType<typeof compilePrompt>, response: Record<string, unknown>) {
  const alignment = (response.normalized_alignment ?? response.alignment) as Record<string, unknown> | undefined;
  const characters = Array.isArray(alignment?.characters) ? alignment.characters.map(String) : [];
  const starts = Array.isArray(alignment?.character_start_times_seconds)
    ? alignment.character_start_times_seconds.map(Number)
    : [];
  const ends = Array.isArray(alignment?.character_end_times_seconds)
    ? alignment.character_end_times_seconds.map(Number)
    : [];
  if (!characters.length || starts.length !== characters.length || ends.length !== characters.length) {
    throw new Error("Eleven TTS 未返回完整字符时间戳。");
  }
  const promptChars = Array.from(prompt.text);
  const allTokens = (spec.tokens as Array<Record<string, unknown>>).slice().sort((a, b) => Number(a.index) - Number(b.index));
  const timelineTokens: Array<Record<string, unknown>> = [];
  let spokenCount = 0;
  let matchedSpokenCount = 0;
  for (const token of allTokens) {
    const index = Number(token.index);
    const char = String(token.char);
    const punctuation = /[，。！？、；：\s]/.test(char);
    if (!punctuation) spokenCount += 1;
    const offset = prompt.sourceOffsets.get(index);
    let alignedIndex = offset !== undefined && promptChars[offset] === char && characters[offset] === char ? offset : -1;
    if (alignedIndex < 0) {
      const expectedOffset = offset ?? 0;
      for (let cursor = Math.max(0, expectedOffset - 2); cursor < Math.min(characters.length, expectedOffset + 6); cursor += 1) {
        if (characters[cursor] === char) { alignedIndex = cursor; break; }
      }
    }
    if (alignedIndex >= 0) {
      if (!punctuation) matchedSpokenCount += 1;
      timelineTokens.push({
        tokenId: String(token.id ?? `token-${index}`),
        tokenIndex: index,
        startMs: Math.round(starts[alignedIndex] * 1000),
        endMs: Math.round(ends[alignedIndex] * 1000),
        confidence: 1,
      });
    }
  }
  if (!spokenCount || matchedSpokenCount / spokenCount < 0.95) {
    throw new Error(`Eleven 字符时间戳与正文覆盖率不足（${matchedSpokenCount}/${spokenCount}）。`);
  }
  const tokenMap = new Map(timelineTokens.map((item) => [Number(item.tokenIndex), item]));
  const sentenceTimeline = (spec.sentences as Array<Record<string, unknown>>).map((sentence, index) => {
    const tokens = sentence.tokens as Array<Record<string, unknown>>;
    const timings = tokens.map((token) => tokenMap.get(Number(token.index))).filter(Boolean) as Array<Record<string, unknown>>;
    return {
      sentenceId: String(sentence.id ?? `sentence-${index + 1}`),
      startMs: Math.min(...timings.map((item) => Number(item.startMs))),
      endMs: Math.max(...timings.map((item) => Number(item.endMs))),
    };
  });
  return { granularity: "character", tokens: timelineTokens, sentences: sentenceTimeline };
}

async function generateAiDemo(env: Env, workId: string) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    return apiError(503, "ELEVEN_TTS_NOT_CONFIGURED", "请在网站服务端配置 ELEVENLABS_API_KEY 和 ELEVENLABS_VOICE_ID。");
  }
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work?.current_spec_version_id) return apiError(409, "CONTROL_SPEC_REQUIRED", "请先导入并确认控制谱。");
  const specRow = await first<Row>(env.DB.prepare("SELECT * FROM control_spec_versions WHERE id = ?").bind(work.current_spec_version_id));
  const spec = parseJson<Record<string, unknown>>(specRow?.spec_json as string);
  if (!spec) return apiError(500, "INVALID_STORED_SPEC", "保存的控制谱无法读取。");
  const prompt = compilePrompt(spec);
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
      body: JSON.stringify({
        text: prompt.text,
        model_id: "eleven_v3",
        language_code: "zh",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!response.ok) {
    return apiError(502, "ELEVEN_TTS_FAILED", `Eleven v3 生成失败（HTTP ${response.status}）：${(await response.text()).slice(0, 600)}`);
  }
  const providerResponse = await response.json() as Record<string, unknown>;
  const audioBase64 = String(providerResponse.audio_base64 ?? "");
  if (!audioBase64) return apiError(502, "ELEVEN_TTS_EMPTY_AUDIO", "Eleven v3 没有返回音频。");
  let timeline: ReturnType<typeof buildTtsTimeline>;
  try {
    timeline = buildTtsTimeline(spec, prompt, providerResponse);
  } catch (error) {
    return apiError(502, "ELEVEN_TTS_ALIGNMENT_FAILED", error instanceof Error ? error.message : String(error));
  }
  const audioBytes = decodeBase64(audioBase64);
  const assetId = id("asset");
  const audioVersionId = id("audio");
  const storageKey = `works/${workId}/ai-demo/${assetId}.mp3`;
  const checksum = await sha256Hex(audioBytes.buffer as ArrayBuffer);
  const durationMs = Math.max(...timeline.tokens.map((token) => Number(token.endMs)), 0);
  const createdAt = now();
  await env.AUDIO_BUCKET.put(storageKey, audioBytes, {
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: { workId, assetId, checksum, kind: "ai_demo" },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, work_id, kind, storage_key, filename, mime_type, byte_size, duration_ms, checksum, provider, created_at)
       VALUES (?, ?, 'ai_demo_audio', ?, ?, 'audio/mpeg', ?, ?, ?, 'eleven', ?)`,
    ).bind(assetId, workId, storageKey, `${work.slug}-ai-demo.mp3`, audioBytes.byteLength, durationMs, checksum, createdAt),
    env.DB.prepare(
      `INSERT INTO audio_versions
       (id, work_id, control_spec_version_id, audio_asset_id, provider, model, voice_id, prompt_text, timeline_json, duration_ms, candidate_state, created_at)
       VALUES (?, ?, ?, ?, 'eleven', 'eleven_v3', ?, ?, ?, ?, 'candidate', ?)`,
    ).bind(audioVersionId, workId, work.current_spec_version_id, assetId, env.ELEVENLABS_VOICE_ID, prompt.text, JSON.stringify(timeline), durationMs, createdAt),
    env.DB.prepare("UPDATE works SET status = 'audio_ready', updated_at = ? WHERE id = ?").bind(createdAt, workId),
  ]);
  return json({ work: await getWorkPayload(env, workId) });
}

async function publishWork(env: Env, workId: string, origin: string) {
  const work = await first<Row>(env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(workId));
  if (!work?.current_spec_version_id) return apiError(409, "CONTROL_SPEC_REQUIRED", "作品没有已确认控制谱。");
  const audio = await first<Row>(env.DB.prepare(
    "SELECT id FROM audio_versions WHERE work_id = ? AND control_spec_version_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(workId, work.current_spec_version_id));
  if (!audio) return apiError(409, "AI_DEMO_REQUIRED", "请先为当前控制谱生成 AI 示范。");
  const existing = await first<Row>(env.DB.prepare("SELECT id FROM publications WHERE slug = ?").bind(work.slug));
  const publicationId = String(existing?.id ?? id("publication"));
  const publishedAt = now();
  if (existing) {
    await env.DB.prepare(
      "UPDATE publications SET control_spec_version_id = ?, audio_version_id = ?, state = 'published', published_at = ?, withdrawn_at = NULL WHERE id = ?",
    ).bind(work.current_spec_version_id, audio.id, publishedAt, publicationId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO publications (id, work_id, slug, control_spec_version_id, audio_version_id, state, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    ).bind(publicationId, workId, work.slug, work.current_spec_version_id, audio.id, publishedAt).run();
  }
  await env.DB.prepare(
    "UPDATE works SET status = 'published', published_revision_id = ?, updated_at = ? WHERE id = ?",
  ).bind(publicationId, publishedAt, workId).run();
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
      analysis_service_configured: Boolean(env.ANALYSIS_SERVICE_URL && env.ANALYSIS_CALLBACK_TOKEN),
      eleven_tts_configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
    });
  }
  if (url.pathname === "/api/analysis-jobs" && request.method === "POST") {
    return createAnalysisJob(request, env, ctx);
  }
  const jobMatch = url.pathname.match(/^\/api\/analysis-jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") return getAnalysisJob(env, jobMatch[1]);
  const callbackMatch = url.pathname.match(/^\/api\/internal\/analysis-jobs\/([^/]+)\/callback$/);
  if (callbackMatch && request.method === "POST") return analysisCallback(request, env, callbackMatch[1]);
  const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch && request.method === "GET") return serveAsset(request, env, assetMatch[1]);
  const workMatch = url.pathname.match(/^\/api\/works\/([^/]+)$/);
  if (workMatch && request.method === "GET") {
    const work = await getWorkPayload(env, workMatch[1]);
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
