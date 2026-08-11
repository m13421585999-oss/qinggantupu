import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../worker/index.ts", import.meta.url);
const envUrl = new URL("../cloudflare-env.d.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);
const migrationUrl = new URL("../drizzle/0000_unusual_wendell_rand.sql", import.meta.url);
const promptTraceMigrationUrl = new URL("../drizzle/0001_long_agent_brand.sql", import.meta.url);
const standardAudioMigrationUrl = new URL("../drizzle/0002_loud_toad.sql", import.meta.url);

test("worker exposes the production standard-audio analysis contract", async () => {
  const [worker, env] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(envUrl, "utf8"),
  ]);

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
  assert.match(worker, /ai-demo-prompt/);
  assert.match(worker, /eleven_tts_request/);
  assert.match(worker, /final_eleven_text/);
  assert.match(worker, /prompt_control_trace/);
  assert.match(worker, /source_control_refs/);
  assert.match(worker, /prompt_trace_json/);
  assert.match(worker, /JSON\.stringify\(persistedPromptTrace\)/);
  assert.match(worker, /prompt_control_trace: lastSentPromptTrace \?\? null/);
  assert.doesNotMatch(worker, /voice_settings: \{ stability: 0\.5, similarity_boost/);
  assert.doesNotMatch(worker, /DEMO_CONTROL_SPEC|createDemoControlSpec|月光下的中国/);

  assert.match(env, /ANALYSIS_SERVICE_URL/);
  assert.match(env, /ANALYSIS_SERVICE_TOKEN/);
  assert.match(env, /ANALYSIS_CALLBACK_TOKEN/);
  assert.doesNotMatch(env, /LLM_API_KEY/);
});

test("D1 schema and migrations retain analysis data and exact TTS prompt traces", async () => {
  const [schema, migration, promptTraceMigration, standardAudioMigration] = await Promise.all([
    readFile(schemaUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
    readFile(promptTraceMigrationUrl, "utf8"),
    readFile(standardAudioMigrationUrl, "utf8"),
  ]);

  assert.match(schema, /export const assets/);
  assert.match(schema, /storageKey: text\("storage_key"\)/);
  assert.match(schema, /checksum: text\("checksum"\)/);
  assert.match(schema, /export const processingJobs/);
  assert.match(schema, /outputJson: text\("output_json"\)/);
  assert.match(schema, /export const controlSpecVersions/);
  assert.match(schema, /promptTraceJson: text\("prompt_trace_json"\)/);
  assert.match(schema, /audioSyncStatus: text\("audio_sync_status"\)/);
  assert.match(schema, /sourceAssetId: text\("source_asset_id"\)/);
  assert.match(schema, /metadataJson: text\("metadata_json"\)/);
  assert.match(migration, /CREATE TABLE `assets`/);
  assert.match(migration, /CREATE TABLE `processing_jobs`/);
  assert.match(migration, /CREATE TABLE `control_spec_versions`/);
  assert.match(promptTraceMigration, /ALTER TABLE `audio_versions` ADD `prompt_trace_json` text/);
  assert.match(standardAudioMigration, /ALTER TABLE `assets` ADD `source_asset_id` text/);
  assert.match(standardAudioMigration, /ALTER TABLE `assets` ADD `metadata_json` text/);
  assert.match(standardAudioMigration, /ALTER TABLE `works` ADD `audio_sync_status` text/);
});
