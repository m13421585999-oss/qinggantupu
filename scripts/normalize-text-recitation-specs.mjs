// One-off recovery: re-normalize control specs that were persisted verbatim from
// the text-recitation service before the worker routed them through
// importControlSpec. Those raw payloads stored `sentences[].rhythm` as a nested
// object ({ type: "..." }) and omitted per-sentence ids/tokens/documentProfile,
// which crashed the compact editor's `Array.from(RHYTHM_LABELS[rhythm])`.
//
// This script detects such raw specs (rhythm is not a string) and rewrites them
// through the canonical importer, preserving the spec id/workId/version so
// works.current_spec_version_id keeps pointing at the same row.
//
// Usage: node scripts/normalize-text-recitation-specs.mjs <path/to/d1.sqlite>

import { DatabaseSync } from "node:sqlite";
import { importControlSpec } from "../lib/control-spec-import.ts";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("用法: node scripts/normalize-text-recitation-specs.mjs <d1.sqlite路径>");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const workRows = db.prepare("SELECT id, source_text FROM works").all();
const sourceTextById = new Map(workRows.map((row) => [row.id, row.source_text]));

const specRows = db
  .prepare("SELECT id, work_id, version, spec_json FROM control_spec_versions ORDER BY created_at")
  .all();

let migrated = 0;
let skipped = 0;
for (const row of specRows) {
  const spec = JSON.parse(row.spec_json);
  const sentences = Array.isArray(spec.sentences) ? spec.sentences : [];
  const hasNestedRhythm = sentences.some((sentence) => {
    const rhythm = sentence?.rhythm;
    return rhythm !== undefined && rhythm !== null && typeof rhythm !== "string";
  });
  if (!hasNestedRhythm) {
    skipped += 1;
    continue;
  }

  const sourceText = sourceTextById.get(row.work_id);
  if (sourceText === undefined) {
    console.error(`!! spec ${row.id} 关联的作品 ${row.work_id} 不存在，跳过。`);
    process.exitCode = 1;
    continue;
  }

  let normalized;
  try {
    normalized = importControlSpec(spec, sourceText, row.work_id);
  } catch (error) {
    console.error(`!! 无法迁移 spec ${row.id}（work ${row.work_id}）：${error.message}`);
    process.exitCode = 1;
    continue;
  }
  normalized.id = row.id;
  normalized.workId = row.work_id;
  normalized.version = row.version;

  db.prepare("UPDATE control_spec_versions SET spec_json = ? WHERE id = ?")
    .run(JSON.stringify(normalized), row.id);
  migrated += 1;
  console.log(`✓ 已迁移 spec ${row.id}（work ${row.work_id} v${row.version}）`);
}

console.log(`完成：迁移 ${migrated} 个，跳过 ${skipped} 个。`);
