// reconcile.mjs — Visual Reconcile（Recovery 专用，最小收口机制）
// 事实来源：analysis-service image_tasks 的 completed = 真实生图结果。
// 前端 visual_assets / processing_jobs 是派生快照，可能停留在旧 partial_failed。
//
// 本模块只做两件事（纯数据层，不重新生图）：
//   1. 删除前端 visual_assets 中「image_task 已 completed 的 scene」的 failed 快照行
//      （worker 的 visualResultSince 只认 created_at、不筛 is_active，failed 行必须删掉，
//       否则 generateSpec 会把 failed 当终态直接记 failure、永不重试）。
//   2. 为作品挑一个可重跑的 visual job：
//      - 优先把最新终态 partial_failed/failed job 数据层翻转回 queued
//        （等价于 image task 的 failed→queued 显式 retry，不调用 startVisualGeneration）；
//      - 若无终态 job，则复用已存在的非终态 job。
// 之后 harvest 照常轮询 GET /api/visual-jobs/{id} —— worker 会对非终态 job 内联重跑：
// 已 ready 的 scene 直接复用（visualResultSince），scene 的 image task 幂等命中已 completed
// 任务（POST /v1/image-tasks 返回原 task+asset，不产生上游生图请求），随后 worker 走
// storeGeneratedVisual 写入 R2 + assets + visual_assets，job 以真实状态完成。
//
// 保证：0 次新的上游生图请求、0 个新 taskId、0 个新 scene_request_key、不重建 plan（specs 已存在）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANALYSIS_DB = path.join(ROOT, "analysis-service", "data", "image_tasks.sqlite3");
const D1_DIR = path.join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const TERMINAL = new Set(["completed", "succeeded", "partial_failed", "failed"]);

function findD1Db() {
  const files = fs.readdirSync(D1_DIR).filter((f) => f.endsWith(".sqlite") && !f.includes("metadata"));
  if (!files.length) throw new Error("找不到前端 D1 数据库");
  return path.join(D1_DIR, files[0]);
}

/**
 * 对单个 work 执行 visual reconcile（数据层）。
 * @returns {{ok: boolean, workId: string, completedScenes: number,
 *            deletedFailedRows: number, flippedJobId: string|null,
 *            reusedJobId: string|null, reason?: string}}
 */
export function reconcileWork(workId) {
  // 1) 真实来源：image_tasks 已 completed 的 scene
  const analysis = new DatabaseSync(ANALYSIS_DB, { readOnly: true });
  let completedScenes;
  try {
    completedScenes = analysis
      .prepare("SELECT scene_id FROM image_tasks WHERE work_id = ? AND status = 'completed' AND scene_id IS NOT NULL")
      .all(workId)
      .map((r) => String(r.scene_id));
  } finally {
    analysis.close();
  }
  if (!completedScenes.length) return { ok: false, workId, completedScenes: 0, reason: "no_completed_image_tasks" };

  const d1Path = findD1Db();
  const d1 = new DatabaseSync(d1Path);
  const result = {
    ok: false, workId, completedScenes: completedScenes.length,
    deletedFailedRows: 0, flippedJobId: null, reusedJobId: null, reason: null,
  };
  try {
    d1.exec("PRAGMA busy_timeout = 8000");
    // 2) 清掉已完成 scene 的 failed 快照行
    const ph = completedScenes.map(() => "?").join(",");
    const del = d1.prepare(
      `DELETE FROM visual_assets WHERE work_id = ? AND generation_status = 'failed' AND scene_id IN (${ph})`
    );
    result.deletedFailedRows = Number(del.run(workId, ...completedScenes).changes ?? 0);

    // 3) 挑选可重跑的 job：优先翻转最新终态 partial_failed/failed；否则复用非终态
    const jobs = d1
      .prepare("SELECT id, status FROM processing_jobs WHERE work_id = ? AND type = 'visual_generation' ORDER BY created_at")
      .all(workId);
    const terminalFailed = jobs.filter((j) => j.status === "partial_failed" || j.status === "failed");
    const nonTerminal = jobs.find((j) => !TERMINAL.has(j.status));
    if (terminalFailed.length) {
      const target = terminalFailed[terminalFailed.length - 1];
      const now = new Date().toISOString();
      d1.prepare(
        `UPDATE processing_jobs SET status = 'queued', progress = 0, error_code = NULL,
           error_message = NULL, updated_at = ? WHERE id = ? AND type = 'visual_generation'`
      ).run(now, target.id);
      result.flippedJobId = target.id;
      result.ok = true;
    } else if (nonTerminal) {
      result.reusedJobId = nonTerminal.id;
      result.ok = true;
    } else {
      result.reason = "no_reconciliable_visual_job";
    }
  } finally {
    d1.close();
  }
  return result;
}

// 直接执行：node batch/reconcile.mjs <workId>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workId = process.argv[2];
  if (!workId) { console.error("用法: node batch/reconcile.mjs <workId>"); process.exit(2); }
  const r = reconcileWork(workId);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
