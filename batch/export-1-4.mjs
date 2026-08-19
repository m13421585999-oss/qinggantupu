// batch/export-1-4.mjs
// 重新导出 Work 1-4 的 Full PDF（复用现有 exportPdf 逻辑，图片完全复用）。
// 用法: node batch/export-1-4.mjs
import { loadState } from "./state.mjs";

const WORKS = [1, 2, 3, 4];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exportPdf({ workId, index, title, author }) {
  const { createRequire } = await import("node:module");
  const pwPath = "/Users/mcf/.workbuddy/binaries/node/workspace/node_modules/playwright";
  const playwright = createRequire(import.meta.url)(pwPath);
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
    const safe = author ? `${String(index).padStart(3, "0")}-${title}-${author}.pdf` : `${String(index).padStart(3, "0")}-${title}.pdf`;
    const filename = safe.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
    const outPath = `/Users/mcf/WorkBuddy/WrokBuddy/qinggantupu/batch/output/${filename}`;
    await download.saveAs(outPath);
    return outPath;
  } finally {
    await browser.close();
  }
}

async function main() {
  const state = loadState();
  for (const index of WORKS) {
    const entry = state[index];
    const { title, author, workId } = entry;
    console.log(`导出 [${index}] 《${title}》…`);
    const outPath = await exportPdf({ workId, index, title, author });
    console.log(`PDF: ${outPath}`);
  }
  console.log("\nWork 1-4 PDF 重新导出完成。");
}

main().catch((err) => {
  console.error("PDF 导出失败:", err.message);
  process.exit(1);
});
