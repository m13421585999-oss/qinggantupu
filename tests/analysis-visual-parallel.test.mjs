import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studio = await readFile(
  new URL("../components/RecitationStudio.tsx", import.meta.url),
  "utf8",
);
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("manuscript analysis polls its task, then starts scene visuals without audio prerequisites", () => {
  const handleAnalyze = studio.slice(
    studio.indexOf("const handleAnalyze = async () =>"),
    studio.indexOf("const persistControlSpec = async"),
  );
  assert.match(handleAnalyze, /persistWorkRecord/);
  assert.match(handleAnalyze, /text-recitation-jobs/);
  assert.match(handleAnalyze, /analysis-jobs/);
  assert.match(handleAnalyze, /generateWorkVisualAssets/);
  assert.doesNotMatch(handleAnalyze, /handleAiAnalyze/);
  assert.doesNotMatch(handleAnalyze, /referenceAudio/);
});

test("AI recitation retry reuses a saved work and creates its job before parallel visuals", () => {
  const handleAiAnalyze = studio.slice(
    studio.indexOf("const handleAiAnalyze = async () =>"),
    studio.indexOf("const handleAnalyze = async () =>"),
  );
  const reuseCheck = handleAiAnalyze.indexOf("const canReuseSavedWork =");
  const conditionalSave = handleAiAnalyze.indexOf(
    "const saved = canReuseSavedWork ? work : await persistWorkRecord()",
  );
  const jobCreated = handleAiAnalyze.indexOf(
    "const created = await apiJson<AiTtsJobPayload>(createResponse)",
  );
  const visualStart = handleAiAnalyze.indexOf(
    'void generateWorkVisualAssets(saved.id, { type: "all" })',
  );
  const firstPoll = handleAiAnalyze.indexOf(
    "const response = await fetch(`/api/ai-tts-jobs/${encodeURIComponent(jobId)}`)",
  );

  assert.ok(reuseCheck >= 0, "AI retry must detect an unchanged saved work");
  assert.ok(conditionalSave > reuseCheck, "AI retry must skip a redundant save when safe");
  assert.ok(jobCreated > conditionalSave, "AI job creation must follow the optional save");
  assert.ok(visualStart > jobCreated, "visual generation must not compete with AI job creation");
  assert.ok(firstPoll > visualStart, "visual generation must still run in parallel with AI job polling");
});

test("visual retries remain versioned and never delete the active image on failure", () => {
  const storeGeneratedVisual = worker.slice(
    worker.indexOf("async function storeGeneratedVisual"),
    worker.indexOf("async function recordVisualFailure"),
  );
  const storeFailedVisual = worker.slice(
    worker.indexOf("async function storeFailedVisual"),
    worker.indexOf("async function generateOneVisual"),
  );

  assert.match(storeGeneratedVisual, /INSERT INTO visual_assets/);
  assert.match(storeGeneratedVisual, /UPDATE visual_assets SET is_active = 0/);
  assert.doesNotMatch(storeGeneratedVisual, /DELETE FROM visual_assets/);
  assert.match(storeFailedVisual, /generation_status.*'failed'/s);
  assert.doesNotMatch(storeFailedVisual, /UPDATE visual_assets|DELETE FROM visual_assets/);
});
