import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0003_overjoyed_sersi.sql", import.meta.url), "utf8");
const provider = await readFile(new URL("../lib/image-generation-provider.ts", import.meta.url), "utf8");

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
  assert.match(worker, /visual\/\$\{workId\}/);
  assert.match(worker, /generation_status = 'ready'/);
  assert.match(worker, /text_validation_status/);
  assert.match(worker, /IMAGE_OCR_MODEL/);
  assert.match(worker, /attempts = .*\? 3 : 1/);
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
  assert.match(worker, /IMAGE_PROVIDER/);
  assert.match(worker, /IMAGE_MODEL/);
  assert.match(worker, /IMAGE_API_KEY/);
  assert.doesNotMatch(worker, /apiKey:\s*env\.IMAGE_API_KEY[^\n]*provider:/);
});
