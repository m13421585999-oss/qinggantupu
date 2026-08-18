// batch:run — drive the existing API to process works from batch-input.txt.
// One work at a time (WORK_CONCURRENCY=1, PDF_CONCURRENCY=1). Uses
// batch-state.json as a checkpoint so re-running resumes without re-paying for
// analysis/images that already succeeded.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBatchInput, parseBatchInput, batchDir } from "./parser.mjs";
import { emptyEntry, loadState, saveState, STATUS, OUTPUT_DIR } from "./state.mjs";
import { createWork, createTextRecitation, startVisualGeneration, getVisualJob, getWork } from "./api.mjs";

const WORK_CONCURRENCY = 1;
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
const VISUAL_POLL_INTERVAL_MS = 3000;
const VISUAL_MAX_POLLS = 150; // 7.5 min cap per work
const RETRY_LIMIT = 2;
const IMAGE_COST_YUAN = 0.04;
const NODE_MODULES = join(batchDir, "..", "node_modules");
// Playwright is installed in the managed node workspace; resolve it there.
const PW_MODULES = "/Users/mcf/.workbuddy/binaries/node/workspace/node_modules";

const LEGACY_V1 = "legacy_v1";
const SEMANTIC_V2 = "semantic_v2";

// Scene-grouping compatibility for old checkpoints:
// - explicit sceneGroupingVersion wins
// - any work that already has a visual job (or completed scenes) stays legacy
// - index <= 34 is legacy (all created before semantic_v2 shipped)
// - index >= 35 with no visual job yet → semantic_v2
function resolveSceneGroupingVersion(entry, index) {
  if (entry.sceneGroupingVersion) return entry.sceneGroupingVersion;
  if (entry.visualJobId) return LEGACY_V1;
  if (index <= 34) return LEGACY_V1;
  return SEMANTIC_V2;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Network-level failures (e.g. Node's `TypeError: fetch failed`) carry no HTTP
// status, so `isRetryable` would treat them as fatal. These are transient —
// the worker often completed the job server-side, only the poll fetch broke.
function isNetworkError(err) {
  return err?.status == null && /fetch/i.test(err?.message || "");
}

function isRetryable(err) {
  const code = err?.status || 0;
  return code === 502 || code === 503 || code === 429 || (code >= 500 && code <= 599);
}

async function withRetry(fn, label, onRetry) {
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === RETRY_LIMIT) throw err;
      const delay = 1500 * (attempt + 1);
      onRetry?.(label, attempt + 1, err.message, delay);
      await sleep(delay);
    }
  }
}

// Stage-level retry with explicit backoff for visual polling: a transient
// network error (or 5xx/429) retries 2s -> 5s -> 10s, max 3 attempts, then
// gives up so the work is marked failed and the batch moves on.
async function withPollRetry(fn, label, onRetry) {
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const retryable = isNetworkError(err) || isRetryable(err);
      if (!retryable || attempt === delays.length) throw err;
      const delay = delays[attempt];
      onRetry?.(label, attempt + 1, err.message, delay);
      await sleep(delay);
    }
  }
}

async function healthCheck() {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:8000/health"]) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new Error(`服务不可用: ${url} (${err.message})。请先确保前端和 analysis-service 已启动。`);
    }
  }
}

async function exportPdf({ workId, index, title, author }) {
  // Load Playwright from the managed workspace.
  const pwPath = join(PW_MODULES, "playwright");
  let playwright;
  try {
    const { createRequire } = await import("node:module");
    playwright = createRequire(import.meta.url)(pwPath);
  } catch {
    throw new Error("Playwright 未安装，无法导出 PDF。请先 npm i playwright");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    // Open the real Full A4 editor for this work.
    const url = `http://localhost:3000/?work=${encodeURIComponent(workId)}&edition=full`;
    // Use domcontentloaded + explicit selector wait: networkidle is unreliable
    // behind a dev-server with HMR websockets. The Full editor is client-rendered
    // after the work is fetched, so wait for it explicitly.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".full-editor-workspace", { timeout: 90000 });
    // Scene images use loading="lazy": viewport-offscreen images never load on
    // their own. Force-load them (eager + re-assign src) and scroll through
    // the page, then wait for all to be ready (naturalWidth > 0).
    await page.evaluate(async () => {
      document.querySelectorAll(".full-scene-card img").forEach((img) => {
        img.loading = "eager";
        const s = img.getAttribute("src");
        if (s) {
          img.src = "";
          img.src = s;
        }
      });
      const step = 500;
      for (let y = 0; y <= document.body.scrollHeight + 2000; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 50));
      }
      window.scrollTo(0, 0);
    });
    // Wait for all Scene images to load (naturalWidth > 0).
    // NOTE: waitForFunction signature is (fn, arg, options); passing the
    // options object as the 2nd arg silently falls back to the 30s default
    // timeout. Pass `undefined` as arg so { timeout } is honored.
    await page.waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll(".full-scene-card img"));
        return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 120000 },
    );
    await sleep(800); // settle
    // Click the existing PDF export button and capture the download.
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await page.click(".full-export-button");
    const download = await downloadPromise;
    const safe = author ? `${String(index).padStart(3, "0")}-${title}-${author}.pdf` : `${String(index).padStart(3, "0")}-${title}.pdf`;
    const filename = safe.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
    const outPath = join(OUTPUT_DIR, filename);
    await download.saveAs(outPath);
    return outPath;
  } finally {
    await browser.close();
  }
}

export async function runBatch({ maxWorks } = {}) {
  await healthCheck();
  const works = parseBatchInput(readBatchInput());
  const limited = maxWorks ? works.slice(0, maxWorks) : works;
  const state = loadState();

  const results = [];
  let totalSentences = 0;
  let totalImages = 0;
  let actualSceneReady = 0;
  let pdfCount = 0;
  const startedAt = new Date().toISOString();

  for (const work of limited) {
    const entry = state[work.index] ?? emptyEntry(work);
    state[work.index] = entry;
    // Skip fully completed unless source changed.
    if (entry.status === STATUS.COMPLETED) {
      if (entry.sourceHash !== work.sourceHash) {
        entry.status = STATUS.SOURCE_CHANGED;
        entry.error = "正文或标题/作者已修改，需要重新生成";
        console.log(`[${work.index}] 《${work.title}》 SOURCE_CHANGED，需重新生成`);
      } else {
        console.log(`[${work.index}] 《${work.title}》 已完成，跳过`);
        if (entry.pdfPath) pdfCount += 1;
        if (entry.sceneReady) actualSceneReady += entry.sceneReady;
        if (entry.sentenceCount) totalSentences += entry.sentenceCount;
        if (entry.sceneTotal) totalImages += entry.sceneTotal;
        continue;
      }
    }
    console.log(`\n========== [${work.index}] 《${work.title}》==========`);
    const result = { index: work.index, title: work.title, stage: "", error: null, completed: false };
    results.push(result);

    // Resolve and persist the SceneGrouping version for this work. Never
    // touches an existing visualJobId (legacy jobs stay untouched).
    const groupingVersion = resolveSceneGroupingVersion(entry, work.index);
    if (entry.sceneGroupingVersion !== groupingVersion) {
      entry.sceneGroupingVersion = groupingVersion;
      saveState(state);
    }

    try {
      // 1. Create / reuse work
      if (!entry.workId || entry.status === STATUS.PENDING) {
        const created = await withRetry(() => createWork({ title: work.title, author: work.author, full_text: work.sourceText }), "createWork");
        entry.workId = created.work.id;
        entry.status = STATUS.WORK_CREATED;
        saveState(state);
      }

      // 2. Text Recitation -> ControlSpec (POST is synchronous; may take up to 5 min)
      if (!entry.analysisReady) {
        // Resume safety: the previous runner may have died while the worker
        // was still finishing analysis server-side. If the work already has a
        // control spec, reuse it instead of re-paying for a second analysis.
        // If the worker is still analyzing (work.status === "analyzing"),
        // poll until it finishes instead of starting a duplicate analysis.
        let serverWork = await withRetry(() => getWork(entry.workId), "getWork");
        let serverSpec = serverWork.work?.controlSpec;
        if (!serverSpec?.sentences?.length && serverWork.work?.status === "analyzing") {
          console.log(`[${work.index}] 服务端分析进行中，等待完成…`);
          const resumeDeadline = Date.now() + ANALYSIS_TIMEOUT_MS;
          while (Date.now() < resumeDeadline) {
            await sleep(5000);
            serverWork = await withRetry(() => getWork(entry.workId), "getWork");
            serverSpec = serverWork.work?.controlSpec;
            if (serverSpec?.sentences?.length) break;
            // A zombie analyzing state (job untouched for > ANALYSIS_TIMEOUT_MS)
            // means the previous analysis died; break out and re-run it.
            const lastTouch = Date.parse(String(serverWork.work?.updatedAt ?? ""));
            if (Number.isFinite(lastTouch) && Date.now() - lastTouch >= ANALYSIS_TIMEOUT_MS) {
              console.log(`[${work.index}] 服务端分析疑似中断（状态长期未更新），重新分析`);
              break;
            }
            if (serverWork.work?.status === "draft" || serverWork.work?.status === "failed") break;
          }
        }
        if (serverSpec?.sentences?.length) {
          const serverCount = serverSpec.sentences.length;
          if (serverCount !== work.sentenceCount) {
            throw new Error(`Sentence 数不一致(服务端): 期望 ${work.sentenceCount}, 实际 ${serverCount}`);
          }
          entry.analysisReady = true;
          entry.analysisJobId = null;
          entry.sentenceCount = serverCount;
          entry.status = STATUS.ANALYSIS_READY;
          saveState(state);
          console.log(`[${work.index}] ControlSpec 已就绪（服务端复用）: ${serverCount} 句`);
        } else {
          entry.status = STATUS.ANALYSIS_RUNNING;
          saveState(state);
          const done = await withRetry(
            () => Promise.race([
              createTextRecitation(entry.workId),
              sleep(ANALYSIS_TIMEOUT_MS).then(() => { const e = new Error("文稿分析超时"); e.status = 0; e.timeout = true; throw e; }),
            ]),
            "textRecitation",
          );
          const completedWork = done.work;
          if (!completedWork?.controlSpec) throw new Error("文稿分析完成但无 control_spec");
          const sentenceCount = completedWork.controlSpec.sentences?.length ?? 0;
          if (sentenceCount !== work.sentenceCount) {
            throw new Error(`Sentence 数不一致: 期望 ${work.sentenceCount}, 实际 ${sentenceCount}`);
          }
          entry.analysisReady = true;
          entry.analysisJobId = done.analysis_job_id ?? null;
          entry.sentenceCount = sentenceCount;
          entry.status = STATUS.ANALYSIS_READY;
          saveState(state);
          console.log(`[${work.index}] ControlSpec ready: ${sentenceCount} 句`);
        }
      } else {
        console.log(`[${work.index}] ControlSpec 已就绪（复用）`);
      }

      // 3. Visual generation (explicitly; batch API does not auto-trigger).
      //    "all" generates every active scene spec (one Scene Card image per
      //    scene). For semantic_v2, scenes < sentences (shared SceneUnits).
      if (!entry.visualJobId) {
        const vj = await withRetry(
          () => startVisualGeneration(entry.workId, {
            type: "all",
            sceneGroupingVersion: entry.sceneGroupingVersion || LEGACY_V1,
          }),
          "startVisual",
        );
        entry.visualJobId = vj.visual_job_id;
        entry.status = STATUS.VISUAL_RUNNING;
        saveState(state);
      }
      // Poll visual job until terminal.
      entry.status = STATUS.VISUAL_RUNNING;
      let visualTerminal = false;
      for (let i = 0; i < VISUAL_MAX_POLLS; i += 1) {
        const job = await withPollRetry(
          () => getVisualJob(entry.visualJobId),
          "visualPoll",
          (label, attempt, message, delay) =>
            console.log(`[${work.index}] ${label} 网络错误(第${attempt}次): ${message}，${delay / 1000}s 后重试`),
        );
        const st = job.status;
        if (["completed", "succeeded", "partial_failed", "failed"].includes(st)) {
          visualTerminal = true;
          if (st === "failed") throw new Error(job.error?.message || "视觉任务失败");
          const scenes = (job.visuals?.sceneAssets ?? []).filter((a) => a.status === "ready" && a.url && a.isVisible !== false);
          const specs = (job.visuals?.sceneSpecs ?? []).filter((s) => s.isActive);
          entry.sceneTotal = specs.length;
          entry.sceneReady = scenes.length;
          if (entry.sceneReady < entry.sceneTotal) throw new Error(`Scene ready ${entry.sceneReady}/${entry.sceneTotal}`);
          // semantic_v2 validation: Scene units must cover every sentence and
          // scenes must not exceed sentences (rows share SceneUnits).
          if (entry.sceneGroupingVersion === SEMANTIC_V2) {
            const covered = new Set(
              (job.visuals?.sceneSpecs ?? [])
                .flatMap((s) => s.sourceSentenceIds ?? s.source_sentence_ids ?? []),
            );
            const expected = entry.sentenceCount || work.sentenceCount;
            const missing = expected - covered.size;
            const saved = Math.max(0, expected - entry.sceneTotal);
            console.log(`[${work.index}] sceneGroupingVersion=${entry.sceneGroupingVersion}`);
            console.log(`[${work.index}] sentences=${expected}`);
            console.log(`[${work.index}] scenes=${entry.sceneTotal}`);
            console.log(`[${work.index}] savedImages=${saved}`);
            if (entry.sceneTotal > expected) {
              throw new Error(`semantic_v2 异常: scenes(${entry.sceneTotal}) > sentences(${expected})`);
            }
            if (missing > 0) {
              throw new Error(`semantic_v2 异常: ${missing} 个 sentence 未映射到任何 scene`);
            }
          }
          break;
        }
        await sleep(VISUAL_POLL_INTERVAL_MS);
      }
      if (!visualTerminal) {
        entry.status = STATUS.TIMEOUT;
        entry.error = "视觉任务超时，请稍后重新运行 batch（会优先复用已完成的 job）";
        saveState(state);
        console.log(`[${work.index}] 视觉任务超时，保存 job id ${entry.visualJobId}`);
        continue; // continue to next work, do not count as completed
      }
      entry.status = STATUS.VISUAL_READY;
      saveState(state);
      console.log(`[${work.index}] Scene ready: ${entry.sceneReady}/${entry.sceneTotal}`);

      // 4. PDF export (retry up to 3 times, PDF-only — never re-run LLM/images)
      if (!entry.pdfReady || !entry.pdfPath) {
        entry.status = STATUS.PDF_RUNNING;
        saveState(state);
        let pdfPath = null;
        let lastPdfError = null;
        const pdfDelays = [2000, 5000, 10000];
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            pdfPath = await exportPdf({ workId: entry.workId, index: work.index, title: work.title, author: work.author });
            break;
          } catch (err) {
            lastPdfError = err;
            if (attempt < 3) {
              const delay = pdfDelays[attempt - 1];
              console.log(`[${work.index}] PDF 失败(第${attempt}次): ${err.message}，${delay / 1000}s 后重试`);
              await sleep(delay);
            }
          }
        }
        if (!pdfPath) throw lastPdfError || new Error("PDF 导出失败");
        entry.pdfPath = pdfPath;
        entry.pdfReady = true;
        entry.status = STATUS.COMPLETED;
        saveState(state);
        console.log(`[${work.index}] PDF: ${pdfPath}`);
      }

      result.completed = true;
      result.stage = "completed";
      totalSentences += work.sentenceCount;
      totalImages += entry.sceneTotal;
      actualSceneReady += entry.sceneReady;
      pdfCount += 1;
    } catch (err) {
      const message = err?.message || String(err);
      entry.status = entry.status === STATUS.TIMEOUT ? STATUS.TIMEOUT : STATUS.FAILED;
      entry.error = message;
      saveState(state);
      result.stage = result.stage || "unknown";
      result.error = message;
      console.log(`[${work.index}] 失败(${result.stage}): ${message}`);
      // continue to next work
    }
  }

  const finishedAt = new Date().toISOString();
  const completedWorks = results.filter((r) => r.completed).length;
  const failedWorks = results.filter((r) => r.error).length;
  const report = {
    totalWorks: limited.length,
    completedWorks,
    failedWorks,
    totalSentences,
    totalImages,
    estimatedImageCost: totalImages * IMAGE_COST_YUAN,
    actualSceneReady,
    pdfCount,
    startedAt,
    finishedAt,
    failures: results.filter((r) => r.error).map((r) => ({ index: r.index, title: r.title, stage: r.stage, error: r.error })),
  };
  return report;
}
