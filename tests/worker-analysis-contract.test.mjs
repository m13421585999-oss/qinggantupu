import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../worker/index.ts", import.meta.url);
const envUrl = new URL("../cloudflare-env.d.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);
const migrationUrl = new URL("../drizzle/0000_unusual_wendell_rand.sql", import.meta.url);

test("worker exposes the production reference-analysis contract", async () => {
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
  assert.match(worker, /ANALYSIS_JOB_TIMEOUT_MS/);
  assert.match(worker, /ANALYSIS_SUBMISSION_FAILED/);
  assert.match(worker, /importControlSpec\(rawControlSpec/);
  assert.match(worker, /kind: "reference_audio"/);
  assert.match(worker, /audio_sha256|checksum/);
  assert.match(worker, /status = 'succeeded'/);
  assert.doesNotMatch(worker, /DEMO_CONTROL_SPEC|createDemoControlSpec|月光下的中国/);

  assert.match(env, /ANALYSIS_SERVICE_URL/);
  assert.match(env, /ANALYSIS_SERVICE_TOKEN/);
  assert.match(env, /ANALYSIS_CALLBACK_TOKEN/);
  assert.doesNotMatch(env, /LLM_API_KEY/);
});

test("D1 schema and migration retain the analysis persistence tables", async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(schema, /export const assets/);
  assert.match(schema, /storageKey: text\("storage_key"\)/);
  assert.match(schema, /checksum: text\("checksum"\)/);
  assert.match(schema, /export const processingJobs/);
  assert.match(schema, /outputJson: text\("output_json"\)/);
  assert.match(schema, /export const controlSpecVersions/);
  assert.match(migration, /CREATE TABLE `assets`/);
  assert.match(migration, /CREATE TABLE `processing_jobs`/);
  assert.match(migration, /CREATE TABLE `control_spec_versions`/);
});
