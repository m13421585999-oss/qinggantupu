import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studio = await readFile(
  new URL("../components/RecitationStudio.tsx", import.meta.url),
  "utf8",
);
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("standard voice analysis starts versioned visual generation without waiting for analysis", () => {
  const handleAnalyze = studio.slice(
    studio.indexOf("const handleAnalyze = async () =>"),
    studio.indexOf("const persistControlSpec = async"),
  );
  const visualStart = handleAnalyze.indexOf(
    'void generateWorkVisualAssets(saved.id, { type: "all" })',
  );
  const analysisStart = handleAnalyze.indexOf(
    "const created = await apiJson<AnalysisJobPayload>",
  );

  assert.ok(visualStart >= 0, "analysis action must launch the existing visual job flow");
  assert.ok(analysisStart >= 0, "analysis action must still launch standard-audio analysis");
  assert.ok(visualStart < analysisStart, "visual generation must begin before analysis is awaited");
  assert.match(handleAnalyze.slice(visualStart, analysisStart), /\.catch\(\(visualError\) =>/);
  assert.doesNotMatch(
    handleAnalyze.slice(visualStart, analysisStart),
    /setAnalysisJobStatus\("failed"\)|throw visualError/,
  );
  assert.match(
    handleAnalyze.slice(visualStart, analysisStart),
    /current\.id === saved\.id \? \{ \.\.\.current, visuals \} : current/,
  );
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
