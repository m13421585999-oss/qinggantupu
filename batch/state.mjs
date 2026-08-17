// batch/state.mjs
// Checkpoint + report persistence for the batch runner.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const batchDir = dirname(fileURLToPath(import.meta.url));
export const STATE_PATH = join(batchDir, "batch-state.json");
export const REPORT_PATH = join(batchDir, "batch-report.json");
export const OUTPUT_DIR = join(batchDir, "output");

export const STATUS = {
  PENDING: "pending",
  WORK_CREATED: "work_created",
  ANALYSIS_RUNNING: "analysis_running",
  ANALYSIS_READY: "analysis_ready",
  VISUAL_RUNNING: "visual_running",
  VISUAL_READY: "visual_ready",
  PDF_RUNNING: "pdf_running",
  COMPLETED: "completed",
  FAILED: "failed",
  SOURCE_CHANGED: "source_changed",
  TIMEOUT: "timeout",
};

export function emptyEntry(work) {
  return {
    index: work.index,
    title: work.title,
    author: work.author || "",
    sourceHash: work.sourceHash,
    sourceText: work.sourceText,
    sentenceCount: work.sentenceCount,
    workId: null,
    status: STATUS.PENDING,
    analysisJobId: null,
    analysisReady: false,
    visualJobId: null,
    sceneTotal: 0,
    sceneReady: 0,
    pdfReady: false,
    pdfPath: null,
    error: null,
  };
}

export function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state) {
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function loadReport() {
  if (!existsSync(REPORT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function saveReport(report) {
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
}
