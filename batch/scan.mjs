// Recovery Scan — read-only. Classifies each Work 1-50 by REAL stage.
// Sources of truth: batch-state.json fields + live getVisualJob + on-disk PDF.
// No state mutation. No analysis/visual/LLM calls that create work.
import fs from "fs";
import path from "path";

const FRONTEND = "http://localhost:3000";

async function apiGet(p) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(`${FRONTEND}${p}`, { signal: ac.signal });
    const txt = await r.text();
    let b; try { b = JSON.parse(txt); } catch { b = { raw: txt }; }
    return { ok: r.ok, status: r.status, body: b };
  } finally { clearTimeout(t); }
}

function pdfSize(p) {
  if (!p) return 0;
  try { return fs.statSync(p).size; } catch { return 0; }
}

const state = JSON.parse(fs.readFileSync("batch/batch-state.json", "utf8"));
const entries = Object.values(state).sort((a, b) => a.index - b.index);

const cats = {
  COMPLETED: [],        // pdf>0 bytes
  PDF_READY: [],        // visualJob done / assets all ready, pdf missing  -> export PDF now
  VISUAL_PENDING: [],   // visualJob generating/queued, assets incomplete  -> deferred
  SCENE_PARTIAL: [],    // some assets ready, some missing, job ended       -> backfill
  ANALYSIS_FAILED: [],  // no ready visualJob, analysis not ready          -> recover analysis
  MANUAL: [],           // uncertain / cannot auto-classify
  NO_VISUAL_NO_PDF: [], // analysisReady but no visualJobId
};

const details = [];

for (const e of entries) {
  const idx = String(e.index).padStart(2, "0");
  const expected = e.sceneTotal || 0;
  const pdfBytes = pdfSize(e.pdfPath);

  if (pdfBytes > 0) {
    cats.COMPLETED.push(e.index);
    details.push(`[${idx}] ${e.title} | COMPLETED pdf=${pdfBytes}B`);
    continue;
  }

  // No PDF. Determine real visual stage.
  let vj = null;
  if (e.visualJobId) {
    const r = await apiGet(`/api/visual-jobs/${encodeURIComponent(e.visualJobId)}`).catch(() => null);
    if (r && r.ok) vj = r.body;
  }

  const assetCount = vj?.generated_asset_ids?.length ?? 0;
  const vjStatus = vj?.status ?? "none";
  const progress = vj?.progress ?? 0;

  if (e.visualJobId) {
    if (vjStatus === "completed" || assetCount >= expected) {
      cats.PDF_READY.push(e.index);
      details.push(`[${idx}] ${e.title} | PDF_READY vj=${vjStatus} assets=${assetCount}/${expected} -> export PDF`);
    } else if (vjStatus === "generating" || vjStatus === "queued" || vjStatus === "pending" || progress > 0 && progress < 100) {
      cats.VISUAL_PENDING.push(e.index);
      details.push(`[${idx}] ${e.title} | VISUAL_PENDING vj=${vjStatus} assets=${assetCount}/${expected} progress=${progress} -> defer`);
    } else if (assetCount > 0 && assetCount < expected) {
      cats.SCENE_PARTIAL.push(e.index);
      details.push(`[${idx}] ${e.title} | SCENE_PARTIAL vj=${vjStatus} assets=${assetCount}/${expected} -> backfill`);
    } else {
      // visualJob ended/failed with 0 assets, or vj unreachable
      cats.ANALYSIS_FAILED.push(e.index);
      details.push(`[${idx}] ${e.title} | vj ended w/ 0 assets (vj=${vjStatus}) -> analysis/visual recover`);
    }
  } else {
    // No visualJob at all
    if (e.analysisReady) {
      cats.NO_VISUAL_NO_PDF.push(e.index);
      details.push(`[${idx}] ${e.title} | ANALYSIS_READY but no visualJobId -> need visual`);
    } else {
      cats.ANALYSIS_FAILED.push(e.index);
      details.push(`[${idx}] ${e.title} | NO visualJob, analysisReady=${e.analysisReady} err=${e.error?.slice(0,60) || ""} -> analysis recover`);
    }
  }
}

const count = (k) => cats[k].length;
console.log("================ RECOVERY SCAN ================");
console.log(`COMPLETED (pdf>0)        : ${count("COMPLETED")}`);
console.log(`PDF_READY (export now)   : ${count("PDF_READY")}  -> ${cats.PDF_READY.join(",")}`);
console.log(`VISUAL_PENDING (defer)   : ${count("VISUAL_PENDING")}  -> ${cats.VISUAL_PENDING.join(",")}`);
console.log(`SCENE_PARTIAL (backfill) : ${count("SCENE_PARTIAL")}  -> ${cats.SCENE_PARTIAL.join(",")}`);
console.log(`ANALYSIS_FAILED          : ${count("ANALYSIS_FAILED")}  -> ${cats.ANALYSIS_FAILED.join(",")}`);
console.log(`NO_VISUAL_NO_PDF         : ${count("NO_VISUAL_NO_PDF")}  -> ${cats.NO_VISUAL_NO_PDF.join(",")}`);
console.log(`MANUAL                   : ${count("MANUAL")}  -> ${cats.MANUAL.join(",")}`);
console.log(`TOTAL works              : ${entries.length}`);
console.log("------------------------------------------------");
console.log(details.join("\n"));

// Persist classification for the recovery driver
const out = { categories: cats, details, scannedAt: new Date().toISOString() };
fs.writeFileSync("batch/scan-result.json", JSON.stringify(out, null, 2));
console.log("\n[scan] written batch/scan-result.json");
