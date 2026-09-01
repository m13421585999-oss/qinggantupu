import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sameVisualGenerationTarget } from "../lib/visual-job-target.ts";

const worker = await readFile(new URL("../worker/api.ts", import.meta.url), "utf8");

test("an active visual job is reused when only includePlan changed", () => {
  assert.equal(
    sameVisualGenerationTarget(
      { type: "all", includePlan: true },
      { type: "all", includePlan: false },
    ),
    true,
  );
  assert.equal(
    sameVisualGenerationTarget(
      { type: "scene", sceneId: "scene-2", includePlan: true },
      { type: "scene", sceneId: "scene-3", includePlan: true },
    ),
    false,
  );
  assert.equal(
    sameVisualGenerationTarget(
      { type: "hero", includePlan: false },
      { type: "all", includePlan: false },
    ),
    false,
  );
});

test("interrupted visual jobs reclaim their lease and skip persisted results", () => {
  const runner = worker.slice(
    worker.indexOf("async function runVisualGenerationJob"),
    worker.indexOf("async function createVisualGenerationJob"),
  );
  const creator = worker.slice(
    worker.indexOf("async function createVisualGenerationJob"),
    worker.indexOf("async function generateWorkVisuals"),
  );

  assert.match(runner, /const leaseExpired = [\s\S]*?VISUAL_JOB_LEASE_MS/);
  assert.match(runner, /status = 'planning'[\s\S]*?status = \?[\s\S]*?updated_at = \?/);
  assert.match(
    runner,
    /const existing = await visualResultSince[\s\S]*?if \(existing\)[\s\S]*?return;[\s\S]*?for \(let attempt = 1/,
  );
  assert.match(
    worker,
    /generation_status IN \('ready', 'needs_review', 'failed'\)/,
  );
  assert.match(creator, /sameVisualGenerationTarget\(input, normalizedTarget\)/);
});
