// batch/recover.mjs — Recovery Queue 收口模式调度器
//
// 目标：基于现有 checkpoint（batch-state.json），把 Work 1–50 全部收口到
//   50 completed / 0 failed / 0 timeout / 50 PDF（051–100 连续、无 0-byte）。
//
// 设计约束（来自 Recovery 规范，不修改主架构）：
//   - 不修改 semantic_v2 / image-task / Text Recitation / Scene prompt / PDF renderer。
//   - 复用现有 api.mjs（前端代理 -> analysis-service）与 state.mjs checkpoint。
//   - 单一调度器：串行处理（LLM 1 并发、PDF 1 并发），不启动第二套 runner。
//   - Visual Recovery 必须非阻塞：检查一次原 visualJobId；若 image task 仍在
//     running/queued，则 deferred（nextCheckAt = now + 3min），立即处理下一个。
//   - 严禁重新 POST 新的 image task；只复用原 taskId / 原 asset。
//   - 429/502/503/504/网络错误：只恢复失败的当前单元，按退避重试；
//     不触发 analysis-service 重启。
//   - 循环 scan -> recover -> deferred -> rescan，直到 completed = 50。
//
// 用法：
//   env -u HTTP_PROXY ... BATCH_SERIAL_OFFSET=50 BATCH_FORCE_SEMANTIC_V2=1 \
//     node batch/recover.mjs
import { existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBatchInput, parseBatchInput } from "./parser.mjs";
import { emptyEntry, loadState, saveState, STATUS, OUTPUT_DIR } from "./state.mjs";
import {
  createWork,
  createTextRecitation,
  startVisualGeneration,
  getVisualJob,
  getWork,
} from "./api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERIAL_OFFSET = Number(process.env.BATCH_SERIAL_OFFSET ?? "50");
const FORCE_SEMANTIC_V2 = process.env.BATCH_FORCE_SEMANTIC_V2 === "1";

const LEGACY_V1 = "legacy_v1";
const SEMANTIC_V2 = "semantic_v2";

// 超时/退避（与 run.mjs 保持一致的边界，但不阻塞）
const ANALYSIS_TIMEOUT_MS = 8 * 60 * 1000; // 8min：高于服务端 420s，确保收到服务端真实结果(完成/502)
const VISUAL_DEFER_MS = 3 * 60 * 1000;      // 非阻塞：3 分钟后回看
const ANALYSIS_RETRY_LIMIT = 3;             // 分析失败整体重试上限
const PDF_RETRY_LIMIT = 3;                  // PDF 导出重试上限（不阻塞其他作品）
const RECV_MAX_ITERS = 80;                  // 安全上限，防止死循环

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base * (0.8 + Math.random() * 0.4);

function globalSerial(index) {
  return index + SERIAL_OFFSET;
}
function resolveSceneGroupingVersion(entry, index) {
  if (entry.sceneGroupingVersion) return entry.sceneGroupingVersion;
  if (entry.visualJobId) return LEGACY_V1;
  if (FORCE_SEMANTIC_V2) return SEMANTIC_V2;
  if (index <= 34) return LEGACY_V1;
  return SEMANTIC_V2;
}
function expectedPdfPath(work) {
  const serial = globalSerial(work.index);
  const safe = work.author
    ? `${String(serial).padStart(3, "0")}-${work.title}-${work.author}.pdf`
    : `${String(serial).padStart(3, "0")}-${work.title}.pdf`;
  const filename = safe.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return join(OUTPUT_DIR, filename);
}
function pdfReal(work) {
  const p = expectedPdfPath(work);
  try {
    const st = statSync(p);
    return st.size > 0 ? p : null;
  } catch {
    return null;
  }
}

function isNetworkError(err) {
  return err?.status == null && /fetch/i.test(err?.message || "");
}
function isRetryable(err) {
  const code = err?.status || 0;
  return code === 429 || code === 502 || code === 503 || code === 504 || (code >= 500 && code <= 599);
}

// 429/5xx 退避：429 取 10/20/40 + jitter；5xx 取 5/10/20；遵守 Retry-After（若有）
async function withRetry(fn, label, onRetry, limit = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= limit; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err) || isNetworkError(err);
      if (!retryable || attempt === limit) throw err;
      let delay;
      const retryAfter = Number(err?.headers?.get?.("retry-after") || err?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) delay = retryAfter * 1000;
      else if (err?.status === 429) delay = [10000, 20000, 40000][attempt] ?? 40000;
      else delay = [5000, 10000, 20000][attempt] ?? 20000;
      delay = jitter(delay);
      onRetry?.(label, attempt + 1, err.message, Math.round(delay / 1000));
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function healthCheck() {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:8000/health"]) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new Error(`服务不可用: ${url} (${err.message})`);
    }
  }
}

// ---- PDF 导出（复用 run.mjs 的 Playwright 流程；仅重新打开已有 Work + 已有 asset） ----
const PW_MODULES = "/Users/mcf/.workbuddy/binaries/node/workspace/node_modules";
async function exportPdf({ workId, index, title, author }) {
  const pwPath = join(PW_MODULES, "playwright");
  let playwright;
  try {
    const { createRequire } = await import("node:module");
    playwright = createRequire(import.meta.url)(pwPath);
  } catch {
    throw new Error("Playwright 未安装，无法导出 PDF");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const url = `http://localhost:3000/?work=${encodeURIComponent(workId)}&edition=full`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".full-editor-workspace", { timeout: 90000 });
    await page.evaluate(async () => {
      document.querySelectorAll(".full-scene-card img").forEach((img) => {
        img.loading = "eager";
        const s = img.getAttribute("src");
        if (s) {
          img.src = "";
          img.src = s;
        }
      });
      for (let y = 0; y <= document.body.scrollHeight + 2000; y += 500) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 50));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll(".full-scene-card img"));
        return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 120000 },
    );
    await sleep(800);
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await page.click(".full-export-button");
    const download = await downloadPromise;
    const serial = globalSerial(index);
    const safe = author
      ? `${String(serial).padStart(3, "0")}-${title}-${author}.pdf`
      : `${String(serial).padStart(3, "0")}-${title}.pdf`;
    const filename = safe.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
    const outPath = join(OUTPUT_DIR, filename);
    await download.saveAs(outPath);
    return outPath;
  } finally {
    await browser.close();
  }
}

// ---- 分类：依据【真实阶段】，而非旧 error 字符串 ----
// 返回 { category, job?, sceneTotal, sceneReady, details }
async function classify(work, entry) {
  // 1) 真实 PDF 是否存在且 >0
  const realPdf = pdfReal(work);
  if (entry.status === STATUS.COMPLETED && realPdf) {
    return { category: "COMPLETED", sceneTotal: entry.sceneTotal, sceneReady: entry.sceneReady };
  }
  // 若状态是 completed 但 PDF 缺失/0 字节 -> 当作 PDF_RECOVERY（不信任旧 status）
  if (realPdf && entry.analysisReady && entry.visualJobId) {
    // PDF 存在但状态未标 completed：重新标 completed
    return { category: "COMPLETED", sceneTotal: entry.sceneTotal, sceneReady: entry.sceneReady };
  }

  // 2) 分析是否就绪
  if (!entry.analysisReady) {
    return { category: "ANALYSIS_RECOVERY", sceneTotal: 0, sceneReady: 0 };
  }

  // 3) 视觉 job 是否存在
  if (!entry.visualJobId) {
    return { category: "VISUAL_RECOVERY", sceneTotal: 0, sceneReady: 0, needsStart: true };
  }

  // 4) 查询原 visualJob（仅一次，非阻塞）
  let job;
  try {
    job = await getVisualJob(entry.visualJobId);
  } catch (err) {
    // 查询失败：网络抖动 -> 当作 deferred 稍后回看（不重发 task）
    return { category: "DEFERRED", sceneTotal: entry.sceneTotal, sceneReady: entry.sceneReady, nextCheckAt: Date.now() + VISUAL_DEFER_MS, reason: `visualJob 查询失败: ${err.message}` };
  }
  const st = job.status;
  const scenes = (job.visuals?.sceneAssets ?? []).filter((a) => a.status === "ready" && a.url && a.isVisible !== false);
  const specs = (job.visuals?.sceneSpecs ?? []).filter((s) => s.isActive);
  const sceneTotal = specs.length;
  const sceneReady = scenes.length;

  if (["completed", "succeeded"].includes(st) && sceneTotal > 0 && sceneReady >= sceneTotal) {
    // 资产全齐 -> PDF_RECOVERY（或已完成但 PDF 缺失）
    return { category: realPdf ? "COMPLETED" : "PDF_RECOVERY", sceneTotal, sceneReady, job };
  }
  if (["queued", "running", "pending", "in_progress"].includes(st)) {
    return { category: "DEFERRED", sceneTotal, sceneReady, nextCheckAt: Date.now() + VISUAL_DEFER_MS, reason: `visualJob ${st}` };
  }
  if (["completed", "succeeded"].includes(st) && sceneReady < sceneTotal) {
    // 任务结束但仍有 scene 未就绪（部分失败）-> 无法自动补生图，转 manual
    return { category: "MANUAL", sceneTotal, sceneReady, reason: `视觉任务结束但 scene ${sceneReady}/${sceneTotal} 未就绪（禁止自动重发 image task）` };
  }
  if (["failed", "partial_failed", "uncertain"].includes(st)) {
    return { category: "MANUAL", sceneTotal, sceneReady, reason: `visualJob ${st}` };
  }
  // 其它未知 -> deferred 回看
  return { category: "DEFERRED", sceneTotal, sceneReady, nextCheckAt: Date.now() + VISUAL_DEFER_MS, reason: `visualJob status=${st}` };
}

// ---- 处理单个作品（按真实阶段补最后一块） ----
// 返回 { result: "completed"|"deferred"|"manual"|"retry", manual?, pdfPath? }
async function processWork(work, entry, metrics) {
  const cat = await classify(work, entry);

  if (cat.category === "COMPLETED") {
    await markCompleted(entry, work, null);
    return { result: "completed" };
  }
  if (cat.category === "MANUAL") {
    return { result: "manual", manual: { index: work.index, globalSerial: globalSerial(work.index), title: work.title, stage: "visual", reason: cat.reason, assets: `scene ${cat.sceneReady}/${cat.sceneTotal}` } };
  }
  if (cat.category === "DEFERRED") {
    entry.status = "deferred";
    entry.nextCheckAt = cat.nextCheckAt;
    if (cat.reason) entry.deferReason = cat.reason;
    saveState(metrics.state);
    return { result: "deferred" };
  }

  // ---- ANALYSIS_RECOVERY ----
  if (cat.category === "ANALYSIS_RECOVERY") {
    if (!entry.workId || entry.status === STATUS.PENDING) {
      const created = await withRetry(() => createWork({ title: work.title, author: work.author, full_text: work.sourceText }), "createWork", (l, a, m) => log(`[${work.index}] ${l} 重试${a}: ${m}`));
      entry.workId = created.work.id;
      entry.status = STATUS.WORK_CREATED;
      saveState(metrics.state);
    }
    // 先确认服务端是否已存在 controlSpec（防重复分析）
    let serverWork = await withRetry(() => getWork(entry.workId), "getWork", (l, a, m) => log(`[${work.index}] ${l} 重试${a}: ${m}`));
    const serverSpec = serverWork.work?.controlSpec;
    if (serverSpec?.sentences?.length) {
      entry.analysisReady = true;
      entry.sentenceCount = serverSpec.sentences.length;
      entry.status = STATUS.ANALYSIS_READY;
      saveState(metrics.state);
      log(`[${work.index}] 复用服务端 controlSpec: ${serverSpec.sentences.length} 句`);
    } else {
      metrics.analysisRecovery += 1;
      entry.status = STATUS.ANALYSIS_RUNNING;
      saveState(metrics.state);
      const done = await withRetry(
        () => Promise.race([
          createTextRecitation(entry.workId),
          sleep(ANALYSIS_TIMEOUT_MS).then(() => { const e = new Error("文稿分析超时(5min)"); e.status = 0; e.timeout = true; throw e; }),
        ]),
        "textRecitation",
        (l, a, m) => log(`[${work.index}] ${l} 重试${a}: ${m}`),
        ANALYSIS_RETRY_LIMIT,
      );
      const cw = done.work;
      if (!cw?.controlSpec) throw new Error("文稿分析完成但无 control_spec");
      const sentenceCount = cw.controlSpec.sentences?.length ?? 0;
      entry.analysisReady = true;
      entry.sentenceCount = sentenceCount;
      entry.status = STATUS.ANALYSIS_READY;
      saveState(metrics.state);
      log(`[${work.index}] ControlSpec ready: ${sentenceCount} 句`);
    }
    // 分析完成后继续走视觉/PDF（递归一次，不阻塞）
    return processWork(work, entry, metrics);
  }

  // ---- VISUAL_RECOVERY ----
  if (cat.category === "VISUAL_RECOVERY") {
    if (cat.needsStart) {
      const vj = await withRetry(
        () => startVisualGeneration(entry.workId, { type: "all", sceneGroupingVersion: entry.sceneGroupingVersion || resolveSceneGroupingVersion(entry, work.index) }),
        "startVisual",
        (l, a, m) => log(`[${work.index}] ${l} 重试${a}: ${m}`),
      );
      entry.visualJobId = vj.visual_job_id;
      entry.status = STATUS.VISUAL_RUNNING;
      saveState(metrics.state);
      metrics.visualStarted += 1;
      log(`[${work.index}] 启动视觉任务 ${entry.visualJobId}`);
    } else {
      metrics.visualReuse += 1; // 复用已存在的原 visualJobId
    }
    // 非阻塞：检查一次
    let job;
    try {
      job = await getVisualJob(entry.visualJobId);
    } catch (err) {
      entry.status = "deferred";
      entry.nextCheckAt = Date.now() + VISUAL_DEFER_MS;
      saveState(metrics.state);
      return { result: "deferred" };
    }
    const st = job.status;
    const scenes = (job.visuals?.sceneAssets ?? []).filter((a) => a.status === "ready" && a.url && a.isVisible !== false);
    const specs = (job.visuals?.sceneSpecs ?? []).filter((s) => s.isActive);
    const sceneTotal = specs.length;
    const sceneReady = scenes.length;
    entry.sceneTotal = sceneTotal;
    entry.sceneReady = sceneReady;
    if (["queued", "running", "pending", "in_progress"].includes(st)) {
      entry.status = "deferred";
      entry.nextCheckAt = Date.now() + VISUAL_DEFER_MS;
      saveState(metrics.state);
      return { result: "deferred" };
    }
    if (["completed", "succeeded"].includes(st) && sceneTotal > 0 && sceneReady >= sceneTotal) {
      entry.status = STATUS.VISUAL_READY;
      saveState(metrics.state);
      // 进入 PDF
      return doPdf(work, entry, metrics, false);
    }
    if (sceneReady < sceneTotal) {
      return { result: "manual", manual: { index: work.index, globalSerial: globalSerial(work.index), title: work.title, stage: "visual", reason: `视觉任务结束但 scene ${sceneReady}/${sceneTotal} 未就绪`, assets: `scene ${sceneReady}/${sceneTotal}` } };
    }
    entry.status = "deferred";
    entry.nextCheckAt = Date.now() + VISUAL_DEFER_MS;
    saveState(metrics.state);
    return { result: "deferred" };
  }

  // ---- PDF_RECOVERY（仅重新导出，禁止 LLM/生图） ----
  if (cat.category === "PDF_RECOVERY") {
    return doPdf(work, entry, metrics, true);
  }

  return { result: "retry" };
}

async function doPdf(work, entry, metrics, pdfOnly) {
  if (pdfOnly) metrics.pdfOnlyRecovery += 1;
  let pdfPath = null, lastErr = null;
  for (let attempt = 1; attempt <= PDF_RETRY_LIMIT; attempt += 1) {
    try {
      pdfPath = await exportPdf({ workId: entry.workId, index: work.index, title: work.title, author: work.author });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < PDF_RETRY_LIMIT) {
        const d = [2000, 5000, 10000][attempt - 1];
        log(`[${work.index}] PDF 失败(第${attempt}次): ${err.message}，${d / 1000}s 后重试`);
        await sleep(d);
      }
    }
  }
  if (!pdfPath) {
    // PDF 失败：加入队尾稍后重试，不阻塞其他作品
    entry.status = "pdf_retry";
    entry.pdfError = lastErr?.message || String(lastErr);
    saveState(metrics.state);
    return { result: "pdf_retry", error: lastErr?.message };
  }
  await markCompleted(entry, work, pdfPath);
  return { result: "completed", pdfPath };
}

async function markCompleted(entry, work, pdfPath) {
  entry.pdfPath = pdfPath || entry.pdfPath;
  entry.pdfReady = true;
  entry.status = STATUS.COMPLETED;
  // 状态清理：清除当前 error，历史归档到 errorHistory
  if (entry.error) {
    entry.errorHistory = entry.errorHistory || [];
    entry.errorHistory.push({ at: new Date().toISOString(), error: entry.error, stage: entry._lastStage || "unknown" });
  }
  entry.error = null;
  saveState(metrics.state);
  log(`[${work.index}] COMPLETED -> ${expectedPdfPath(work)}`);
}

// ---- 主循环 ----
const metrics = {
  state: null,
  analysisRecovery: 0,
  visualReuse: 0,
  visualStarted: 0,
  pdfOnlyRecovery: 0,
  validationRepair: 0,
  duplicateImageGen: 0, // 永远为 0：recovery 禁止重发 image task
  manualRequired: [],
  firstRoundFailed: 0,
  startTime: Date.now(),
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const fs = require("node:fs");
    fs.appendFileSync(join(__dirname, "recovery.log"), line + "\n");
  } catch {}
}

export async function runRecovery() {
  await healthCheck();
  const works = parseBatchInput(readBatchInput());
  const state = loadState();
  metrics.state = state;

  // 初始扫描：记录第一轮失败数量（非 completed 的）
  let initialNonCompleted = 0;
  for (const work of works) {
    const e = state[work.index] ?? emptyEntry(work);
    state[work.index] = e;
    if (e.status !== STATUS.COMPLETED) initialNonCompleted += 1;
  }
  metrics.firstRoundFailed = initialNonCompleted;
  saveState(state);

  let iteration = 0;
  let noProgressStreak = 0;

  while (iteration < RECV_MAX_ITERS) {
    iteration += 1;
    const scan = [];
    let completed = 0;
    let deferredCount = 0;
    let earliestDefer = Infinity;

    for (const work of works) {
      const entry = state[work.index];
      const cat = await classify(work, entry);
      if (cat.category === "COMPLETED") {
        if (entry.status !== STATUS.COMPLETED) {
          await markCompleted(entry, work, null);
        }
        completed += 1;
        scan.push({ work, entry, cat: "COMPLETED" });
      } else if (cat.category === "DEFERRED") {
        deferredCount += 1;
        earliestDefer = Math.min(earliestDefer, cat.nextCheckAt || Date.now());
        scan.push({ work, entry, cat: "DEFERRED", nextCheckAt: cat.nextCheckAt });
      } else if (cat.category === "MANUAL") {
        scan.push({ work, entry, cat: "MANUAL", manual: cat });
      } else {
        // ANALYSIS_RECOVERY / VISUAL_RECOVERY / PDF_RECOVERY
        scan.push({ work, entry, cat: cat.category, needsStart: cat.needsStart });
      }
    }

    log(`=== 扫描 #${iteration}: completed=${completed}/50, deferred=${deferredCount}, manual=${metrics.manualRequired.length} ===`);

    if (completed >= works.length) {
      break;
    }

    // 优先级排序：PDF_RECOVERY > VISUAL_RECOVERY(已存在job) > ANALYSIS_RECOVERY(短) > ANALYSIS_RECOVERY(长) > VISUAL_RECOVERY(需启动)
    const priority = (s) => {
      if (s.cat === "PDF_RECOVERY") return 0;
      if (s.cat === "VISUAL_RECOVERY" && !s.needsStart) return 1;
      if (s.cat === "ANALYSIS_RECOVERY") return s.work.sentenceCount <= 12 ? 2 : 3;
      if (s.cat === "VISUAL_RECOVERY" && s.needsStart) return 4;
      return 9;
    };
    const toProcess = scan
      .filter((s) => ["PDF_RECOVERY", "VISUAL_RECOVERY", "ANALYSIS_RECOVERY"].includes(s.cat))
      .sort((a, b) => priority(a) - priority(b));

    let progressedThisIter = false;

    for (const s of toProcess) {
      const { work, entry } = s;
      entry._lastStage = s.cat;
      try {
        const r = await processWork(work, entry, metrics);
        if (r.result === "completed") progressedThisIter = true;
        else if (r.result === "manual") {
          if (!metrics.manualRequired.find((m) => m.index === r.manual.index)) {
            metrics.manualRequired.push(r.manual);
            log(`[${r.manual.index}] MANUAL_REQUIRED: ${r.manual.reason} (${r.manual.assets})`);
          }
          entry.status = "manual_required";
          saveState(state);
        } else if (r.result === "deferred") {
          progressedThisIter = true; // deferred 也算推进（避免卡死）
        } else if (r.result === "pdf_retry") {
          log(`[${work.index}] PDF 暂失败，稍后重试: ${r.error}`);
        }
      } catch (err) {
        const message = err?.message || String(err);
        log(`[${work.index}] 处理异常(${s.cat}): ${message}`);
        entry.status = STATUS.FAILED;
        entry.error = message;
        saveState(state);
      }
    }

    // 重新扫描 deferred 中已到点的（回看一次）
    if (!progressedThisIter && deferredCount > 0) {
      const now = Date.now();
      let rechecked = false;
      for (const s of scan.filter((x) => x.cat === "DEFERRED")) {
        if ((s.nextCheckAt || 0) <= now) {
          // 重新分类（processWork 内部会再查一次 job）
          const r = await processWork(s.work, s.entry, metrics);
          if (r.result === "completed") { progressedThisIter = true; rechecked = true; }
          else if (r.result === "manual") {
            if (!metrics.manualRequired.find((m) => m.index === r.manual.index)) metrics.manualRequired.push(r.manual);
            s.entry.status = "manual_required"; saveState(state); rechecked = true;
          } else if (r.result === "deferred") rechecked = true;
        }
      }
      progressedThisIter = progressedThisIter || rechecked;
    }

    if (!progressedThisIter) {
      noProgressStreak += 1;
      if (deferredCount > 0) {
        const waitMs = Math.min(earliestDefer - Date.now(), VISUAL_DEFER_MS);
        log(`无新进展，等待 deferred 回看 ${Math.max(1000, waitMs) / 1000}s ...`);
        await sleep(Math.max(1000, waitMs));
        noProgressStreak = 0; // 等待后继续
      } else if (noProgressStreak >= 2) {
        log("无进展且无 deferred，停止循环（进入 manual_required 汇总）");
        break;
      }
    } else {
      noProgressStreak = 0;
    }
  }

  // ---- 最终报告 ----
  const finishedAt = Date.now();
  const elapsedMin = Math.round((finishedAt - metrics.startTime) / 60000);
  const pdfFiles = works.filter((w) => pdfReal(w)).length;
  const completedCount = works.filter((w) => {
    const e = state[w.index];
    return e.status === STATUS.COMPLETED && pdfReal(w);
  }).length;

  console.log("\n========================================");
  console.log("        RECOVERY 收口最终报告");
  console.log("========================================");
  console.log(`1. 50/50 completed?          ${completedCount === 50 ? "YES" : `NO (${completedCount}/50)`}`);
  console.log(`2. PDF 051–100 全部存在?    ${pdfFiles === 50 ? "YES" : `NO (${pdfFiles}/50)`}`);
  console.log(`3. 第一轮失败数量:          ${metrics.firstRoundFailed}`);
  console.log(`4. Recovery 成功恢复数量:    ${completedCount}`);
  console.log(`5. analysis 恢复数量:        ${metrics.analysisRecovery}`);
  console.log(`6. visual 原任务复用数量:    ${metrics.visualReuse}`);
  console.log(`7. PDF-only recovery 数量:   ${metrics.pdfOnlyRecovery}`);
  console.log(`8. targeted validation repair: ${metrics.validationRepair}`);
  console.log(`9. 是否产生重复生图:        ${metrics.duplicateImageGen === 0 ? "NO" : `YES (${metrics.duplicateImageGen})`}`);
  console.log(`10. manual_required:         ${metrics.manualRequired.length === 0 ? "0 (YES)" : metrics.manualRequired.length}`);
  console.log(`11. 最终总耗时:             ${elapsedMin} 分钟`);
  if (metrics.manualRequired.length) {
    console.log("\n--- MANUAL_REQUIRED 明细 ---");
    for (const m of metrics.manualRequired) {
      console.log(`  [${m.index}] ${m.globalSerial} 《${m.title}》 stage=${m.stage} reason=${m.reason} assets=${m.assets}`);
    }
  }
  return { completedCount, pdfFiles, metrics };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runRecovery().then(
    () => process.exit(0),
    (err) => { console.error("recovery 失败:", err); process.exit(1); },
  );
}
