// CLI for the batch runner. Usage:
//   node batch/index.mjs           -> run batch (all works, or --max N)
//   node batch/index.mjs --status  -> print current progress (no API calls)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBatch } from "./run.mjs";
import { loadState, loadReport, saveReport, STATUS, REPORT_PATH } from "./state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

async function main() {
  if (args.includes("--status")) {
    const state = loadState();
    const report = loadReport();
    const entries = Object.values(state).sort((a, b) => a.index - b.index);
    let completed = 0, failed = 0, running = 0;
    for (const e of entries) {
      if (e.status === STATUS.COMPLETED) completed += 1;
      else if ([STATUS.FAILED, STATUS.SOURCE_CHANGED].includes(e.status)) failed += 1;
      else running += 1;
    }
    console.log("=== batch 当前进度 ===");
    console.log(`已录入作品: ${entries.length}`);
    console.log(`completed: ${completed} | failed: ${failed} | 进行中/待处理: ${running}`);
    for (const e of entries) {
      console.log(`  [${e.index}] 《${e.title}》 ${e.status}${e.error ? " - " + e.error : ""}`);
    }
    if (report) {
      console.log(`\n上次运行报告: total ${report.totalWorks}, completed ${report.completedWorks}, failed ${report.failedWorks}`);
    }
    return;
  }

  const maxArg = args.find((a) => a.startsWith("--max="));
  const maxWorks = maxArg ? Number(maxArg.split("=")[1]) : undefined;

  console.log(`启动 batch runner${maxWorks ? `（前 ${maxWorks} 篇）` : ""}...`);
  const report = await runBatch({ maxWorks });
  saveReport(report);
  console.log("\n==================================");
  console.log(`总作品：${report.totalWorks}`);
  console.log(`完成：${report.completedWorks}`);
  console.log(`失败：${report.failedWorks}`);
  console.log(`总 Sentence：${report.totalSentences}`);
  console.log(`Scene ready：${report.actualSceneReady}`);
  console.log(`PDF：${report.pdfCount}`);
  console.log(`预计图片成本：¥${report.estimatedImageCost.toFixed(2)} 元`);
  if (report.failures.length) {
    console.log("失败：");
    for (const f of report.failures) {
      console.log(`  [${f.index}] ${f.title} - ${f.stage} - ${f.error}`);
    }
  }
  console.log(`\n报告已写入 ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("batch 运行失败:", err.message);
  process.exit(1);
});
