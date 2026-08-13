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
  assert.match(html, /把一段好朗诵，变成一张能听的声音地图/);
  assert.match(html, /生成标准 AI 声音并解析/);
  assert.match(html, /完整正文/);
  assert.match(html, /声音与图谱同源/);
  assert.match(html, /用户观看端/);
  assert.match(html, /作品库/);
  assert.match(html, /保存作品/);
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
  assert.match(schema, /standardAiAudio/);
  assert.match(schema, /audioSyncStatus/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(studio, /cloneDemoWork|createDemoControlSpec|createDemoAiAudio|demo-recitation/);
  assert.match(studio, /title: "编辑图谱"/);
  assert.match(studio, /title: "预览发布"/);
  assert.doesNotMatch(studio, /导入控制谱|JSON 兜底|核对示范|ControlImportStage|AudioStage/);
  assert.match(studio, /fetch\("\/api\/works"/);
  assert.match(studio, /reference_audio_file/);
  assert.match(studio, /beforeunload/);
  assert.match(studio, /当前修改还没有保存/);
  assert.match(studio, /保存并打开/);
  assert.match(studio, /删除作品/);
  assert.match(studio, /永久删除/);
  assert.match(studio, /method: "DELETE"/);
  assert.doesNotMatch(studio, /三层情感图谱/);
  assert.doesNotMatch(studio, /跟着红字、停顿和声音曲线来听/);
  assert.doesNotMatch(studio, /个图谱句/);
  assert.doesNotMatch(studio, /朗诵作品/);
  assert.doesNotMatch(studio, /抒情朗诵 · 舒缓 · 克制/);
  assert.match(studio, /导出本页图片/);
  assert.match(studio, /import\("html-to-image"\)/);
  assert.match(studio, /朗诵图谱\.png/);
  assert.match(studio, /data-export-exclude="true"/);
  assert.match(studio, /WORK_VERSION_CONFLICT|expected_updated_at/);
  assert.match(studio, /mode === "studio" \? \(\s*<WorkLibrary/);
  assert.match(studio, /\/reference-audio/);
  assert.match(studio, /\/api\/analysis-jobs/);
  assert.match(studio, /type="file"/);
  assert.match(worker, /ANALYSIS_SERVICE_URL/);
  assert.match(worker, /ANALYSIS_CALLBACK_TOKEN/);
  assert.match(worker, /\/api\/analysis-jobs/);
  assert.match(worker, /processing_jobs/);
  assert.match(worker, /reference-audio/);
  assert.match(worker, /url\.pathname === "\/api\/works"/);
  assert.match(worker, /body\.full_text/);
  assert.match(worker, /AUDIO_BUCKET/);
  assert.match(worker, /speech-to-speech/);
  assert.match(worker, /standard_ai_audio/);
  assert.doesNotMatch(worker, /with-timestamps|ai-demo-prompt|\/v1\/text-to-speech\//);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../analysis-service/app/acoustics/parselmouth_analyzer.py", import.meta.url));
  await access(new URL("../analysis-service/app/providers/eleven_alignment.py", import.meta.url));
  await access(new URL("../analysis-service/app/interpretation/llm_interpreter.py", import.meta.url));
  await access(new URL("../analysis-service/app/rules/recitation_expression_v1.md", import.meta.url));
  await assert.rejects(access(new URL("../public/demo-recitation.m4a", import.meta.url)));
  await assert.rejects(access(new URL("../local-analyzer/analyzer.py", import.meta.url)));
  await access(new URL("../drizzle/0000_unusual_wendell_rand.sql", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../docs/01-mvp-plan.md", import.meta.url));
  assert.ok(projectRoot);
});
