import { createClient } from "@libsql/client";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const sourcePath = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Local D1 SQLite path is required");

const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!url || !authToken) throw new Error("Turso environment is not configured");

const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = createClient({ url, authToken });

const tableOrder = [
  "works",
  "control_spec_versions",
  "assets",
  "processing_jobs",
  "work_visual_profiles",
  "visual_specs",
  "visual_assets",
  "audio_versions",
  "publications",
  "d1_migrations",
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const schemaRows = source.prepare(`
  SELECT type, name, sql
    FROM sqlite_master
   WHERE sql IS NOT NULL
     AND name NOT LIKE 'sqlite_%'
     AND name != '_cf_METADATA'
   ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name
`).all();

for (const row of schemaRows.filter((row) => row.type === "table")) {
  await target.execute(String(row.sql).replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS "));
}

for (const table of [...tableOrder].reverse()) {
  await target.execute(`DELETE FROM ${quoteIdentifier(table)}`);
}

for (const table of tableOrder) {
  const columns = source.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .map((column) => String(column.name));
  const rows = source.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
  const insert = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;

  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50).map((row) => ({
      sql: insert,
      args: columns.map((column) => row[column]),
    }));
    if (batch.length) await target.batch(batch, "write");
  }
  const result = await target.execute(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
  const count = Number(result.rows[0]?.count ?? 0);
  if (count !== rows.length) {
    throw new Error(`${table} count mismatch: local=${rows.length} remote=${count}`);
  }
  process.stdout.write(`${table}: ${count}\n`);
}

for (const row of schemaRows.filter((row) => row.type !== "table")) {
  const sql = String(row.sql).replace(/^CREATE (UNIQUE )?INDEX /i, "CREATE $1INDEX IF NOT EXISTS ");
  await target.execute(sql);
}

source.close();
target.close();
