// harvest.mjs — 非阻塞收割驱动（Recovery 阶段专用）
// 设计：复用现有模块（api.mjs / state.mjs / parser.mjs）与 run.mjs 的 exportPdf 逻辑。
// 不修改任何 pipeline 代码（chunk / semantic_v2 / image-task / prompt / PDF renderer 冻结）。
// 关键修复（相对 batch runner）：visualPoll 网络错误计入轮询上限、短窗口后 defer、3 分钟复查，
// 因此不会像 batch runner 那样在 [3] 巨型 visual 任务上永久阻塞。
import { readBatchInput, parseBatchInput } from "./parser.mjs";
import { emptyEntry, loadState, saveState, STATUS, OUTPUT_DIR } from "./state.mjs";
import { createWork, createTextRecitation, startVisualGeneration, getVisualJob, getWork } from "./api.mjs";
import { reconcileWork } from "./reconcile.mjs";
import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ---- constants (mirror run.mjs) ----
const SERIAL_OFFSET = 50;
const PW_MODULES = "/Users/mcf/.workbuddy/binaries/node/workspace/node_modules";
const LEGACY_V1 = "legacy_v1";
const SEMANTIC_V2 = "semantic_v2";
const ANALYSIS_TIMEOUT_MS = 9 * 60 * 1000;   // 客户端分析上限
const VISUAL_POLL_INTERVAL_MS = 3000;
const VISUAL_SHORT_CAP = 2;                   // 非阻塞窗口 ~6s（极快 defer，交给后台 3 分钟复查）
const VISUAL_MAX_NETWORK_RETRIES = 12;       // 网络错误计数上限 -> 之后 defer
const DEFER_WAIT_MS = 3 * 60 * 1000;         // 3 分钟复查
const IMAGE_TASK_MAX_RETRIES = 3;            // 单 scene failed 显式重试上限（与 store.MAX_RETRIES 对齐）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const globalSerial = (index) => index + SERIAL_OFFSET;
const pdfSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// ---- analysis-service 直连（用于 failed image task 的显式 retry）----
const ANALYSIS = "http://localhost:8000";
const ANALYSIS_TOKEN = (() => {
  if (process.env.ANALYSIS_SERVICE_TOKEN) return process.env.ANALYSIS_SERVICE_TOKEN;
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "analysis-service", ".env");
    const txt = fs.readFileSync(envPath, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*ANALYSIS_SERVICE_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* token 缺失时调用将 401，由 withRetry 之外显式报错 */ }
  return "";
})();
async function analysisFetch(path, options = {}) {
  const res = await fetch(`${ANALYSIS}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${ANALYSIS_TOKEN}`, ...(options.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.detail || body?.error?.message || text.slice(0, 300);
    throw new Error(`${res.status} ${detail}`);
  }
  return body;
}
const listImageTasks = (workId) => analysisFetch(`/v1/image-tasks?work_id=${encodeURIComponent(workId)}`);
const retryImageTask = (taskId) => analysisFetch(`/v1/image-tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: "{}" });

// ---- exportPdf (copied verbatim from run.mjs 106-171) ----
export async function exportPdf({ workId, index, title, author }) {
  const pwPath = path.join(PW_MODULES, "playwright");
  let playwright;
  try {
    playwright = createRequire(import.meta.url)(pwPath);
  } catch {
    throw new Error("Playwright 未安装，无法导出 PDF。");
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
        if (s) { img.src = ""; img.src = s; }
      });
      const step = 500;
      for (let y = 0; y <= document.body.scrollHeight + 2000; y += step) {
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
    const safe = author ? `${String(serial).padStart(3, "0")}-${title}-${author}.pdf` : `${String(serial).padStart(3, "0")}-${title}.pdf`;
    const filename = safe.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
    const outPath = path.join(OUTPUT_DIR, filename);
    await download.saveAs(outPath);
    return outPath;
  } finally {
    await browser.close();
  }
}

// ---- helpers ----
async function withTimeout(promise, ms, label) {
  let timer;
  const to = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms); });
  try { return await Promise.race([promise, to]); } finally { clearTimeout(timer); }
}
async function withRetry(fn, label, max = 2) {
  let lastErr;
  for (let i = 0; i <= max; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const transient = /502|503|504|429|fetch failed|network|Unable to call the LLM|ETIMEDOUT|ECONN/.test(err?.message || String(err));
      if (!transient || i === max) throw err;
      const delay = 10000 * (i + 1);
      console.log(`  [${label}] 瞬时错误(第${i + 1}次): ${err.message?.slice(0, 80)}，${delay / 1000}s 后重试`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---- stage logic ----
async function ensureCreate(entry, work, state) {
  if (!entry.workId) {
    const created = await withRetry(() => createWork({ title: work.title, author: work.author, full_text: work.sourceText }), "createWork");
    entry.workId = created.work.id;
    entry.status = STATUS.WORK_CREATED;
    saveState(state);
  }
}

async function ensureAnalysis(entry, work, state) {
  if (entry.analysisReady) { console.log(`  [${work.index}] ControlSpec 已就绪（复用）`); return; }
  let serverWork = await withRetry(() => getWork(entry.workId), "getWork");
  let serverSpec = serverWork?.work?.controlSpec;
  if (!serverSpec?.sentences?.length && serverWork?.work?.status === "analyzing") {
    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(5000);
      serverWork = await withRetry(() => getWork(entry.workId), "getWork");
      serverSpec = serverWork?.work?.controlSpec;
      if (serverSpec?.sentences?.length) break;
      const lastTouch = Date.parse(String(serverWork?.work?.updatedAt ?? ""));
      if (Number.isFinite(lastTouch) && Date.now() - lastTouch >= ANALYSIS_TIMEOUT_MS) break;
      if (["draft", "failed"].includes(serverWork?.work?.status)) break;
    }
  }
  if (serverSpec?.sentences?.length) {
    const sc = serverSpec.sentences.length;
    if (sc !== work.sentenceCount) throw new Error(`Sentence 数不一致(服务端): 期望 ${work.sentenceCount}, 实际 ${sc}`);
    entry.analysisReady = true; entry.analysisJobId = null; entry.sentenceCount = sc;
    entry.status = STATUS.ANALYSIS_READY; saveState(state);
    console.log(`  [${work.index}] ControlSpec 已就绪（服务端复用）: ${sc} 句`);
    return;
  }
  // run analysis
  entry.status = STATUS.ANALYSIS_RUNNING; saveState(state);
  const done = await withTimeout(withRetry(() => createTextRecitation(entry.workId), "textRecitation"), ANALYSIS_TIMEOUT_MS, "textRecitation");
  const cw = done?.work;
  if (!cw?.controlSpec) throw new Error("文稿分析完成但无 control_spec");
  const sc = cw.controlSpec.sentences?.length ?? 0;
  if (sc !== work.sentenceCount) throw new Error(`Sentence 数不一致: 期望 ${work.sentenceCount}, 实际 ${sc}`);
  entry.analysisReady = true; entry.analysisJobId = done.analysis_job_id ?? null; entry.sentenceCount = sc;
  entry.status = STATUS.ANALYSIS_READY; saveState(state);
  console.log(`  [${work.index}] ControlSpec ready: ${sc} 句`);
}

async function ensureVisual(entry, work, state) {
  // validate existing visualJobId (handle invalid/stale ids)
  if (entry.visualJobId) {
    try {
      const t = await getVisualJob(entry.visualJobId);
      if (!t || t.status === undefined) throw new Error("invalid visualJob");
    } catch {
      console.log(`  [${work.index}] visualJobId 失效，重建`);
      entry.visualJobId = null; saveState(state);
    }
  }
  if (!entry.visualJobId) {
    const vj = await withRetry(() => startVisualGeneration(entry.workId, { type: "all", sceneGroupingVersion: entry.sceneGroupingVersion || LEGACY_V1 }), "startVisual");
    entry.visualJobId = vj.visual_job_id;
    entry.status = STATUS.VISUAL_RUNNING; saveState(state);
    console.log(`  [${work.index}] 已启动 visual job ${entry.visualJobId}`);
  }
  // poll short window (non-blocking)
  let job = null;
  for (let i = 0; i < VISUAL_SHORT_CAP; i++) {
    try {
      job = await getVisualJob(entry.visualJobId);
    } catch (err) {
      if (i >= VISUAL_MAX_NETWORK_RETRIES - 1) throw new Error(`视觉轮询网络错误过多: ${err.message}`);
      await sleep(VISUAL_POLL_INTERVAL_MS); continue;
    }
    const st = job?.status;
    if (["completed", "succeeded"].includes(st)) {
      const scenes = (job.visuals?.sceneAssets ?? []).filter((a) => a.status === "ready" && a.url && a.isVisible !== false);
      const specs = (job.visuals?.sceneSpecs ?? []).filter((s) => s.isActive);
      entry.sceneTotal = specs.length; entry.sceneReady = scenes.length;
      if (entry.sceneGroupingVersion === SEMANTIC_V2) {
        const covered = new Set((job.visuals?.sceneSpecs ?? []).flatMap((s) => s.sourceSentenceIds ?? s.source_sentence_ids ?? []));
        const expected = entry.sentenceCount || work.sentenceCount;
        const missing = expected - covered.size;
        if (entry.sceneTotal > expected) throw new Error(`semantic_v2 异常: scenes(${entry.sceneTotal}) > sentences(${expected})`);
        if (missing > 0) throw new Error(`semantic_v2 异常: ${missing} 个 sentence 未映射`);
      }
      entry.status = STATUS.VISUAL_READY; saveState(state);
      console.log(`  [${work.index}] Scene ready: ${entry.sceneReady}/${entry.sceneTotal}`);
      return { done: true };
    }
    if (st === "failed") throw new Error(job?.error?.message || "视觉任务失败");
    if (st === "partial_failed") {
      // 只对 failed scene 显式 retry（同 taskId、同 scene_request_key），
      // 禁止重新 start 整个 Work 的全部图片；已完成的 scene 完全不动。
      const retried = [];
      try {
        const res = await withRetry(() => listImageTasks(entry.workId), "listImageTasks");
        for (const t of res?.tasks ?? []) {
          if (t.status !== "failed") continue;
          if ((t.retry_count ?? 0) >= IMAGE_TASK_MAX_RETRIES) {
            console.log(`  [${work.index}] ${t.scene_id ?? "(hero)"} 已达最大重试(${t.retry_count})，跳过`);
            continue;
          }
          // 余额不足是外部计费墙，非瞬时错误：不消耗 retry 配额。
          // 但若近 10 分钟内任意任务成功出图（recent_completions>0），说明余额已恢复，
          // 此时 balance 标记为陈旧，放行重试（probe），避免永久跳过。
          const lastErr = t.last_error || t.error || "";
          if (/insufficient balance/i.test(lastErr) && !(res.recent_completions > 0)) {
            console.log(`  [${work.index}] ${t.scene_id ?? "(hero)"} 上游余额不足，暂不重试（等充值）`);
            continue;
          }
          try {
            const r = await withRetry(() => retryImageTask(t.image_task_id), `retry ${t.scene_id ?? "hero"}`);
            retried.push(`${t.scene_id ?? "(hero)"}(#${r.retry_count})`);
          } catch (e) {
            console.log(`  [${work.index}] retry ${t.scene_id ?? "(hero)"} 失败: ${e.message?.slice(0, 80)}`);
          }
        }
      } catch (e) {
        console.log(`  [${work.index}] 拉取 image tasks 失败: ${e.message?.slice(0, 80)}`);
      }
      if (retried.length) console.log(`  [${work.index}] partial_failed: 已显式 retry: ${retried.join(", ")}`);
      // Visual Reconcile：以 image_tasks completed 为真实来源，数据层同步前端
      // （删 failed 快照 + 翻转终态 job 回 queued）。不重新生图、不新建 taskId/key、
      // 不调用 startVisualGeneration；recheck 轮询 GET /api/visual-jobs/{id} 会触发
      // worker 幂等重跑（ready 复用 + 幂等命中已完成 task），job 以真实状态完成。
      try {
        const rec = reconcileWork(entry.workId);
        if (rec.ok && (rec.flippedJobId || rec.reusedJobId)) {
          const newJobId = rec.flippedJobId || rec.reusedJobId;
          if (rec.flippedJobId) {
            console.log(`  [${work.index}] reconcile: 翻转 ${rec.flippedJobId.slice(-12)} 回 queued，删 failed 快照 ${rec.deletedFailedRows} 行`);
          } else {
            console.log(`  [${work.index}] reconcile: 复用非终态 job ${newJobId.slice(-12)}`);
          }
          entry.visualJobId = newJobId;
          entry.status = STATUS.VISUAL_RUNNING; saveState(state);
          console.log(`  [${work.index}] partial_failed，reconcile 已就绪，延迟复查`);
          return { done: false };
        }
      } catch (e) {
        console.log(`  [${work.index}] reconcile 失败: ${e.message?.slice(0, 80)}`);
      }
      entry.status = STATUS.VISUAL_RUNNING; saveState(state);
      console.log(`  [${work.index}] partial_failed，延迟复查`);
      return { done: false };
    }
    await sleep(VISUAL_POLL_INTERVAL_MS);
  }
  // not terminal within short window -> defer
  entry.status = STATUS.VISUAL_RUNNING; saveState(state);
  return { done: false };
}

async function doExport(entry, work, state) {
  if (entry.pdfReady && entry.pdfPath && pdfSize(entry.pdfPath) > 0) return entry.pdfPath;
  entry.status = STATUS.PDF_RUNNING; saveState(state);
  let pdfPath = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      pdfPath = await exportPdf({ workId: entry.workId, index: work.index, title: work.title, author: work.author });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep([2000, 5000, 10000][attempt - 1]);
    }
  }
  if (!pdfPath) throw lastErr || new Error("PDF 导出失败");
  entry.pdfPath = pdfPath; entry.pdfReady = true; entry.status = STATUS.COMPLETED; entry.error = null; saveState(state);
  console.log(`  [${work.index}] PDF: ${pdfPath}`);
  return pdfPath;
}

// ---- per-work driver ----
async function processWork(entry, work, state, deferred) {
  if (entry.pdfPath && pdfSize(entry.pdfPath) > 0) {
    entry.status = STATUS.COMPLETED; entry.error = null; saveState(state);
    return "completed";
  }
  try {
    await ensureCreate(entry, work, state);
    await ensureAnalysis(entry, work, state);
    const vres = await ensureVisual(entry, work, state);
    if (!vres.done) {
      if (!deferred.some((d) => d.index === work.index)) {
        deferred.push({ index: work.index, workId: entry.workId, visualJobId: entry.visualJobId, nextCheckAt: Date.now() + DEFER_WAIT_MS });
      }
      return "deferred";
    }
    await doExport(entry, work, state);
    return "completed";
  } catch (err) {
    const msg = err?.message || String(err);
    entry.status = (entry.status === STATUS.TIMEOUT) ? STATUS.TIMEOUT : STATUS.FAILED;
    entry.error = msg; saveState(state);
    return "failed:" + msg.slice(0, 120);
  }
}

// ---- main loop ----
async function main() {
  const state = loadState();
  const works = parseBatchInput(readBatchInput());
  // 预扫描：把 visualJob 已完成(可立即导出PDF)的作品排到最前，最快拉升 PDF 数
  const prio = new Map();
  for (const work of works) {
    const entry = state[work.index];
    let p = 5;
    if (entry?.visualJobId) {
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
        const r = await fetch(`http://localhost:3000/api/visual-jobs/${encodeURIComponent(entry.visualJobId)}`, { signal: ac.signal });
        clearTimeout(t);
        if (r.ok) { const j = await r.json(); if (["completed", "succeeded"].includes(j.status)) p = 1; else if (j.status === "partial_failed") p = 3; else p = 4; }
      } catch { p = 4; }
    }
    prio.set(work.index, p);
  }
  works.sort((a, b) => (prio.get(a.index) - prio.get(b.index)) || a.index - b.index);
  const deferred = [];
  const countCompleted = () => Object.values(state).filter((e) => e.status === STATUS.COMPLETED && e.pdfPath && pdfSize(e.pdfPath) > 0).length;

  console.log(`HARVEST 启动: 目标 50 PDF。当前 ${countCompleted()} 完成。`);
  let rounds = 0;
  while (countCompleted() < 50) {
    rounds++;
    let progressed = false;
    const startCount = countCompleted();
    for (const work of works) {
      const entry = state[work.index] ?? (state[work.index] = emptyEntry(work));
      if (entry.status === STATUS.COMPLETED && entry.pdfPath && pdfSize(entry.pdfPath) > 0) continue;
      console.log(`\n========== [${work.index}] 《${work.title}》==========`);
      const r = await processWork(entry, work, state, deferred);
      if (r === "completed") { progressed = true; console.log(`  -> 完成 (总 ${countCompleted()}/50)`); }
      else if (r === "deferred") { console.log(`  -> 延迟(visual 生成中)`); }
      else { console.log(`  -> ${r}`); }
    }
    const nowCount = countCompleted();
    console.log(`\n--- 轮次 ${rounds} 结束: 完成 ${nowCount}/50, 本轮新增 ${nowCount - startCount}, 延迟队列 ${deferred.length} ---`);
    if (nowCount >= 50) break;
    if (deferred.length === 0) {
      if (!progressed) { console.log("无 deferred 且无进展，停止。"); break; }
      break; // 一轮完成且无 deferred -> 全部完成或未完成的都失败了
    }
    // wait for earliest deferred, then recheck
    const earliest = Math.min(...deferred.map((d) => d.nextCheckAt));
    const wait = Math.max(0, earliest - Date.now());
    console.log(`等待 ${Math.ceil(wait / 1000)}s 复查 ${deferred.length} 个 deferred visual...`);
    await sleep(Math.min(wait, DEFER_WAIT_MS));
    const batch2 = deferred.splice(0);
    for (const d of batch2) {
      const entry = state[d.index];
      if (!entry) continue;
      const work = works.find((w) => w.index === d.index);
      if (!work) continue;
      console.log(`\n========== [recheck ${d.index}] 《${work.title}》==========`);
      const r = await processWork(entry, work, state, deferred);
      if (r === "completed") console.log(`  -> 完成 (总 ${countCompleted()}/50)`);
      else if (r === "deferred") console.log(`  -> 仍延迟`);
      else console.log(`  -> ${r}`);
    }
  }
  console.log(`\nHARVEST 结束: 完成 ${countCompleted()}/50`);
}

// run only when executed directly (allows importing exportPdf for tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("HARVEST FATAL:", e); process.exit(1); });
}
