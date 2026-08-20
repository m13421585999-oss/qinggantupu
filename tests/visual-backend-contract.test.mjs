import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0003_overjoyed_sersi.sql", import.meta.url), "utf8");
const provider = await readFile(new URL("../lib/image-generation-provider.ts", import.meta.url), "utf8");
const visualSchema = await readFile(new URL("../lib/visual-schema.ts", import.meta.url), "utf8");
const visualDirector = await readFile(new URL("../lib/visual-director.ts", import.meta.url), "utf8");
const visualPanel = await readFile(new URL("../components/WorkVisualPanel.tsx", import.meta.url), "utf8");
const visualPanelCss = await readFile(new URL("../components/WorkVisualPanel.module.css", import.meta.url), "utf8");

test("visual backend keeps profile, specs and versioned asset metadata in D1", () => {
  assert.match(schema, /export const workVisualProfiles/);
  assert.match(schema, /export const visualSpecs/);
  assert.match(schema, /export const visualAssets/);
  assert.match(migration, /CREATE TABLE `work_visual_profiles`/);
  assert.match(migration, /CREATE TABLE `visual_specs`/);
  assert.match(migration, /CREATE TABLE `visual_assets`/);
  assert.match(migration, /`text_validation_status` text/);
  assert.match(migration, /`is_visible` integer/);
  assert.match(migration, /`is_active` integer/);
});

test("worker exposes independent visual planning, generation and review routes", () => {
  assert.match(worker, /visuals\\\/plan/);
  assert.match(worker, /visuals\\\/generate/);
  assert.match(worker, /visual-assets\\\/upload/);
  assert.match(worker, /visual-assets.*\\\/regenerate/);
  assert.match(worker, /action === "activate"/);
  assert.match(worker, /action === "hide"/);
  assert.match(worker, /requestVisualDirection/);
  assert.match(worker, /works\/\$\{workId\}\/visuals\/hero\/v\$\{version\}/);
  assert.match(worker, /works\/\$\{workId\}\/visuals\/scenes\/\$\{sceneId\}\/v\$\{version\}/);
  assert.match(worker, /generation_status = 'ready'/);
  assert.match(worker, /text_validation_status/);
  assert.match(worker, /IMAGE_OCR_MODEL/);
  assert.match(worker, /const attempts = kind === "hero"/);
  assert.match(worker, /withHeroProductionLayout\(basePrompt, title, author\)/);
  assert.match(worker, /withHeroProductionNegativePrompt\(baseNegativePrompt\)/);
  assert.match(worker, /prompt: productionPrompt/);
  assert.match(worker, /textValidation\.status === "matched"/);
  assert.match(worker, /generationStatus = .*needs_review/);
  assert.match(worker, /ready \? 1 : 0, ready \? 1 : 0/);
  assert.match(worker, /approveHero \? "ready"/);
  assert.match(worker, /approveHero \? "matched"/);
});

test("work deletion enumerates exact visual R2 objects before deleting D1 rows", () => {
  assert.match(worker, /FROM visual_assets va\s+JOIN assets a ON a\.id = va\.asset_id/);
  assert.match(worker, /const exactStorageKeys = \[\.\.\.new Set/);
  assert.match(worker, /DELETE FROM visual_assets WHERE work_id/);
  assert.match(worker, /DELETE FROM visual_specs WHERE work_id/);
  assert.match(worker, /DELETE FROM work_visual_profiles WHERE work_id/);
  assert.match(worker, /AUDIO_BUCKET\.delete\(exactStorageKeys\.slice/);
});

test("failed visual records omit their asset URL instead of exposing an empty URL", () => {
  assert.match(worker, /url: row\.asset_id == null \? undefined/);
  assert.match(worker, /if \(asset\.asset_id == null\).*VISUAL_ASSET_FILE_REQUIRED/);
});

test("image provider is configurable and never exposes an API key in payload", () => {
  assert.match(provider, /class PlaceholderImageProvider/);
  assert.match(provider, /class OpenAiCompatibleImageProvider/);
  assert.match(provider, /b64_json/);
  assert.match(provider, /data\.url/);
  assert.match(provider, /class AnalysisServiceImageProvider/);
  assert.match(provider, /\/v1\/image-tasks/);
  assert.match(provider, /apiEndpoint\(this\.config\.baseUrl, "responses"\)/);
  assert.match(worker, /IMAGE_PROVIDER/);
  assert.match(worker, /IMAGE_MODEL/);
  assert.match(worker, /AI_API_KEY/);
  assert.match(worker, /AI_BASE_URL/);
  assert.match(worker, /IMAGE_API_KEY/);
  assert.doesNotMatch(worker, /apiKey:\s*env\.IMAGE_API_KEY[^\n]*provider:/);
});

test("visual generation is resumable, bounded and reports partial failure", () => {
  const createJob = worker.slice(
    worker.indexOf("async function createVisualGenerationJob"),
    worker.indexOf("async function generateWorkVisuals"),
  );
  const getJob = worker.slice(
    worker.indexOf("async function getVisualGenerationJob"),
    worker.indexOf("async function uploadVisualReplacement"),
  );

  assert.match(worker, /VISUAL_GENERATION_JOB_TYPE = "visual_generation"/);
  assert.match(worker, /VISUAL_SCENE_CONCURRENCY = 3/);
  assert.match(worker, /VISUAL_GENERATION_RETRY_LIMIT = 1/);
  assert.match(worker, /status = 'planning'/);
  assert.doesNotMatch(worker, /"generating_hero"/);
  assert.match(worker, /"generating_scenes"/);
  assert.match(worker, /"uploading"/);
  assert.match(worker, /"completed"/);
  assert.match(worker, /"partial_failed"/);
  assert.match(worker, /visualResultSince/);
  assert.doesNotMatch(worker, /waitUntil\(runVisualGenerationJob/);
  assert.doesNotMatch(createJob, /runVisualGenerationJob/);
  assert.match(createJob, /VALUES \(\?, \?, \?, 'queued', 0/);
  assert.match(createJob, /status: "queued"[\s\S]*?\}, 202\)/);
  assert.match(getJob, /if \(!VISUAL_TERMINAL_STATUSES\.has\(String\(job\.status\)\)\) \{[\s\S]*?await runVisualGenerationJob\(env, jobId\)/);
  assert.match(getJob, /await runVisualGenerationJob\(env, jobId\);[\s\S]*?job = await first<Row>/);
  assert.match(worker, /visual-jobs/);
  assert.match(worker, /createVisualGenerationJob\(env, String\(asset\.work_id\)/);
  assert.match(worker, /generated\.width \?\?/);
  assert.match(worker, /generated\.height \?\?/);
  assert.match(worker, /detectImageDimensions\(generated\.bytes\)/);
  assert.match(worker, /visualDirectorProviderFromResult/);
  assert.match(worker, /activeVisualGenerationJobs/);
  assert.match(worker, /VISUAL_GENERATION_IN_PROGRESS/);
  assert.match(worker, /safeVisualErrorMessage/);
  assert.match(worker, /LEFT JOIN assets a ON a\.id = va\.asset_id/);
  assert.match(worker, /assetMetadata\?\.endpoint/);
  assert.match(worker, /endpoint: generated\.endpoint/);
  assert.match(worker, /director_endpoint: directorEndpoint/);
  assert.match(worker, /directorEndpoint: rawProfile\._meta\?\.director_endpoint/);
  assert.doesNotMatch(worker, /director_model,\s*is_locked[\s\S]{0,120}'deepseek'/);
});

test("visual director fields and Hero production ratio match the current viewer", () => {
  assert.match(visualSchema, /composition_language: string/);
  assert.match(visualSchema, /symbolic_language: string\[\]/);
  assert.match(visualSchema, /scene_meaning: string/);
  assert.match(visualSchema, /size: \{ width: 1500; height: 280 \}/);
  assert.match(visualDirector, /rawProfile\.composition_language \?\? rawProfile\.composition_rule/);
  assert.match(visualDirector, /rawProfile\.symbolic_language \?\? rawProfile\.symbolic_elements/);
  assert.match(visualDirector, /scene\.scene_meaning \?\? scene\.scene_summary/);
  assert.match(worker, /rawProfile\.composition_language \?\? rawProfile\.composition_rule/);
  assert.match(worker, /spec\.scene_meaning \?\? spec\.scene_summary/);
  assert.match(worker, /height: kind === "hero" \? 280 : SCENE_IMAGE_HEIGHT/);
  assert.match(visualPanel, /\[1500, 280\]/);
  assert.match(visualPanel, /1500 × 280 Hero/);
  assert.match(visualPanelCss, /cropFrameHero \{ aspect-ratio: 1500 \/ 280; \}/);
});

test("compact empty visual state can generate the complete work in one action", () => {
  assert.match(visualPanel, /!compactSpec[\s\S]*?generateWorkVisualAssets\(workId, \{ type: "all" \}\)[\s\S]*?作品视觉方案、主视觉和全部意境图已生成/);
  assert.match(visualPanel, /!compactSpec[\s\S]*?一键生成作品视觉/);
  assert.match(visualPanel, /!compactSpec[\s\S]*?uploadLabel\("hero"\)/);
  assert.doesNotMatch(visualPanel, /!compactSpec[\s\S]*?先生成视觉方案[\s\S]*?compactSpec \?/);
});
