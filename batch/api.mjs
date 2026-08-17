// batch/api.mjs
// Thin HTTP client over the existing Worker API. Reuses the exact endpoints the
// frontend already calls — no business logic is reimplemented.
const FRONTEND = "http://localhost:3000";

async function jsonOrThrow(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.error?.message || body?.detail || text.slice(0, 300);
    const err = new Error(`${res.status} ${detail}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function apiFetch(path, options = {}) {
  return jsonOrThrow(await fetch(`${FRONTEND}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  }));
}

export async function createWork({ title, author, full_text }) {
  return apiFetch("/api/works", {
    method: "POST",
    body: JSON.stringify({
      title,
      author: author || "",
      full_text,
      audio_source_type: "human_reference",
    }),
  });
}

export async function createTextRecitation(workId) {
  // POST is synchronous in the worker — it calls the analysis service and
  // returns the completed work with control_spec (may take up to ~5 min).
  return apiFetch(`/api/works/${encodeURIComponent(workId)}/text-recitation-jobs`, {
    method: "POST",
    body: "{}",
  });
}

export async function startVisualGeneration(workId, target = { type: "scene" }) {
  return apiFetch(`/api/works/${encodeURIComponent(workId)}/visuals/generate`, {
    method: "POST",
    body: JSON.stringify(target),
  });
}

export async function getVisualJob(jobId) {
  return apiFetch(`/api/visual-jobs/${encodeURIComponent(jobId)}`);
}

export async function getWork(workId) {
  return apiFetch(`/api/works/${encodeURIComponent(workId)}`);
}
