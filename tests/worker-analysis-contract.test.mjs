import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../worker/api.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);
const migrationUrl = new URL("../drizzle/0000_unusual_wendell_rand.sql", import.meta.url);
const promptTraceMigrationUrl = new URL("../drizzle/0001_long_agent_brand.sql", import.meta.url);
const standardAudioMigrationUrl = new URL("../drizzle/0002_loud_toad.sql", import.meta.url);
const audioSourceMigrationUrl = new URL("../drizzle/0004_pink_kree.sql", import.meta.url);

test("worker exposes the production standard-audio analysis contract", async () => {
  const worker = await readFile(workerUrl, "utf8");

  assert.match(worker, /const uploadMatch = .*reference-audio/);
  assert.match(worker, /const createJobMatch = .*analysis-jobs/);
  assert.match(worker, /const jobMatch = .*analysis-jobs/);
  assert.match(worker, /const inputMatch = .*analysis-jobs.*input/);
  assert.match(worker, /const analysisAudioMatch = .*analysis-jobs.*audio/);
  assert.match(worker, /const callbackMatch = .*analysis-jobs.*callback/);
  assert.match(worker, /handoffSignature/);
  assert.match(worker, /verifyHandoff/);
  assert.match(worker, /await dispatchAnalysisJob\(env, origin, jobId\)/);
  assert.doesNotMatch(worker, /waitUntil\(dispatchAnalysisJob/);
  assert.match(worker, /response\.status === 524/);
  assert.match(worker, /ANALYSIS_JOB_TIMEOUT_MS/);
  assert.match(worker, /ANALYSIS_SUBMISSION_FAILED/);
  assert.match(worker, /importControlSpec\(\s*rawControlSpec/);
  assert.match(worker, /kind: "reference_audio"/);
  assert.match(worker, /\/v1\/speech-to-speech\/\$\{encodeURIComponent\(env\.ELEVENLABS_VOICE_ID\)\}/);
  assert.match(worker, /eleven_multilingual_sts_v2/);
  assert.match(worker, /kind = 'standard_ai_audio'/);
  assert.match(worker, /'standard_audio_analysis'/);
  assert.match(worker, /standardAudioAssetId/);
  assert.match(worker, /referenceAudioAssetId/);
  assert.match(worker, /audio_sync_status = \?/);
  assert.match(worker, /analyzedAudioRole/);
  assert.match(worker, /audio_sha256|checksum/);
  assert.match(worker, /status = 'succeeded'/);
  assert.doesNotMatch(worker, /ai-demo-prompt|eleven_tts_request|final_eleven_text/);
  assert.match(worker, /\/v1\/text-to-speech\//);
  assert.match(worker, /ELEVEN_TTS_MODEL_ID = "eleven_v3"/);
  assert.match(worker, /AI_TTS_GENERATION_JOB_TYPE/);
  assert.match(worker, /AI_TTS_ANALYSIS_JOB_TYPE/);
  assert.match(worker, /validateTtsText/);
  assert.match(worker, /tts_plan_generating/);
  assert.match(worker, /tts_audio_ready/);
  assert.match(worker, /audio_analyzing/);
  assert.match(worker, /graph_ready/);
  assert.match(worker, /retry-audio/);
  assert.match(worker, /retry-analysis/);
  assert.match(worker, /retry-interpretation/);
  assert.match(worker, /\/v1\/interpretation-jobs/);
  assert.doesNotMatch(worker, /DEMO_CONTROL_SPEC|createDemoControlSpec|月光下的中国/);

  const envDeclaration = await readFile(
    new URL("../worker-configuration.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(envDeclaration, /interface Env/);
  assert.match(envDeclaration, /ANALYSIS_SERVICE_URL/);
  assert.match(envDeclaration, /ANALYSIS_SERVICE_TOKEN/);
  assert.match(envDeclaration, /ANALYSIS_CALLBACK_TOKEN/);
  assert.doesNotMatch(envDeclaration, /LLM_API_KEY/);
});

test("text-recitation job normalizes the service control_spec via importControlSpec", async () => {
  const worker = await readFile(workerUrl, "utf8");
  assert.match(worker, /\/v1\/text-recitation-tasks/);
  assert.match(worker, /text_recitation_task_id/);
  assert.match(worker, /refreshTextRecitationJob/);
  assert.match(worker, /const rawControlSpec = result\.control_spec/);
  assert.match(worker, /importControlSpec\(\s*rawControlSpec/);
  assert.match(worker, /String\(work\.source_text\),\s*workId,/);
  assert.match(worker, /const updated = \{ \.\.\.normalizedSpec, id: specId, workId, version \}/);
  assert.match(worker, /control_spec 无法导入/);
});

test("worker exposes a searchable work library with optimistic concurrency", async () => {
  const worker = await readFile(workerUrl, "utf8");

  assert.match(worker, /request\.method === "GET"\) return listWorks/);
  assert.match(worker, /ORDER BY w\.updated_at DESC/);
  assert.match(worker, /w\.title LIKE \? ESCAPE/);
  assert.match(worker, /COALESCE\(w\.author, ''\) LIKE \? ESCAPE/);
  assert.match(worker, /expected_updated_at/);
  assert.match(worker, /WORK_VERSION_CONFLICT/);
  assert.match(worker, /status:\s*409|409,\s*"WORK_VERSION_CONFLICT"/);
  assert.match(worker, /request\.method === "DELETE"\) return deleteReferenceAudio/);
  assert.match(worker, /request\.method === "DELETE"\) return deleteWork/);
  assert.match(worker, /WORK_VERSION_REQUIRED/);
  assert.match(worker, /DELETE FROM publications WHERE work_id/);
  assert.match(worker, /DELETE FROM audio_versions WHERE work_id/);
  assert.match(worker, /DELETE FROM processing_jobs WHERE work_id/);
  assert.match(worker, /DELETE FROM control_spec_versions WHERE work_id/);
  assert.match(worker, /DELETE FROM assets WHERE work_id/);
  assert.match(worker, /AUDIO_BUCKET\.delete\((?:exactStorageKeys|storageKeys)/);
});

test("D1 schema and migrations retain both reference-audio production paths", async () => {
  const [schema, migration, promptTraceMigration, standardAudioMigration, audioSourceMigration] = await Promise.all([
    readFile(schemaUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
    readFile(promptTraceMigrationUrl, "utf8"),
    readFile(standardAudioMigrationUrl, "utf8"),
    readFile(audioSourceMigrationUrl, "utf8"),
  ]);

  assert.match(schema, /export const assets/);
  assert.match(schema, /storageKey: text\("storage_key"\)/);
  assert.match(schema, /checksum: text\("checksum"\)/);
  assert.match(schema, /export const processingJobs/);
  assert.match(schema, /outputJson: text\("output_json"\)/);
  assert.match(schema, /export const controlSpecVersions/);
  assert.match(schema, /promptTraceJson: text\("prompt_trace_json"\)/);
  assert.match(schema, /audioSyncStatus: text\("audio_sync_status"\)/);
  assert.match(schema, /audioSourceType: text\("audio_source_type"\)/);
  assert.match(schema, /sourceAssetId: text\("source_asset_id"\)/);
  assert.match(schema, /metadataJson: text\("metadata_json"\)/);
  assert.match(migration, /CREATE TABLE `assets`/);
  assert.match(migration, /CREATE TABLE `processing_jobs`/);
  assert.match(migration, /CREATE TABLE `control_spec_versions`/);
  assert.match(promptTraceMigration, /ALTER TABLE `audio_versions` ADD `prompt_trace_json` text/);
  assert.match(standardAudioMigration, /ALTER TABLE `assets` ADD `source_asset_id` text/);
  assert.match(standardAudioMigration, /ALTER TABLE `assets` ADD `metadata_json` text/);
  assert.match(standardAudioMigration, /ALTER TABLE `works` ADD `audio_sync_status` text/);
  assert.match(audioSourceMigration, /ALTER TABLE `works` ADD `audio_source_type` text/);
});
