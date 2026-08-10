import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the recitation product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>声图 · 朗诵情感图谱<\/title>/i);
  assert.match(html, /先保存准确正文，再导入本地生成的控制谱/);
  assert.match(html, /保存作品，进入导入/);
  assert.match(html, /完整正文/);
  assert.match(html, /参考音频留在你的电脑/);
  assert.match(html, /用户观看端/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /月光下的中国|demo-recitation|createDemoControlSpec/);
  assert.doesNotMatch(html, /上传完整文稿/);
  assert.doesNotMatch(html, /选择朗诵知识库/);
  assert.doesNotMatch(html, /朗诵导演台/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps one control schema and removes starter preview residue", async () => {
  const [page, layout, schema, packageJson, studio, worker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/recitation-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../components/RecitationStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /RecitationStudio/);
  assert.match(layout, /\/og\.png/);
  assert.match(schema, /interface ControlSpec/);
  assert.match(schema, /"peak" \| "valley" \| "rising" \| "falling"/);
  assert.match(schema, /machinePinyin/);
  assert.match(schema, /displayPinyin/);
  assert.match(schema, /activeSpan/);
  assert.match(schema, /coreZone/);
  assert.match(schema, /referenceAudio/);
  assert.match(schema, /aiDemoAudio/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(studio, /cloneDemoWork|createDemoControlSpec|createDemoAiAudio|demo-recitation/);
  assert.match(studio, /导入控制谱/);
  assert.match(studio, /fetch\("\/api\/works"/);
  assert.doesNotMatch(studio, /reference_audio_file|\/api\/analysis-jobs|type="file"/);
  assert.doesNotMatch(worker, /ANALYSIS_SERVICE_URL|ANALYSIS_CALLBACK_TOKEN|\/api\/analysis-jobs|processing_jobs/);
  assert.match(worker, /url\.pathname === "\/api\/works"/);
  assert.match(worker, /body\.full_text/);
  assert.match(worker, /AUDIO_BUCKET/);
  assert.match(worker, /with-timestamps/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("../analysis-service/app/acoustics/parselmouth_analyzer.py", import.meta.url)));
  await access(new URL("../local-analyzer/analyzer.py", import.meta.url));
  await access(new URL("../local-analyzer/setup.bat", import.meta.url));
  await access(new URL("../local-analyzer/启动朗诵分析.bat", import.meta.url));
  await assert.rejects(access(new URL("../public/demo-recitation.m4a", import.meta.url)));
  await access(new URL("./fixtures/demo-recitation.m4a", import.meta.url));
  await access(new URL("../drizzle/0000_unusual_wendell_rand.sql", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../docs/01-mvp-plan.md", import.meta.url));
  assert.ok(projectRoot);
});
