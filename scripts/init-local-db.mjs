#!/usr/bin/env node
/**
 * 初始化本地 D1 数据库（一次性 / 幂等）。
 *
 * Vinext dev 用 Miniflare 模拟 D1，把库持久化到 .wrangler/state/v3/d1/ 下的
 * SQLite 文件。刚 clone 或清理 .wrangler 后，这些库是空的，访问会报
 * "no such table: works"。本脚本把 drizzle/ 下的迁移按顺序应用到这些库。
 *
 * 用法：npm run db:init
 * 幂等：已存在 works 表的库会跳过，可安全重复执行。
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const d1StateDir = join(root, ".wrangler", "state", "v3", "d1");
const migrationsDir = join(root, "drizzle");

const log = (line = "") => process.stdout.write(line + "\n");
const logError = (line = "") => process.stderr.write(line + "\n");

/** 递归收集 d1 目录下的 .sqlite 文件（排除 metadata.sqlite）。 */
function collectDbFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDbFiles(full));
    } else if (entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite") {
      results.push(full);
    }
  }
  return results;
}

function tableExists(db, name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  return Boolean(row);
}

function applyMigrations(dbPath) {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  if (!files.length) {
    log(`  ${dbPath}: 没有找到迁移文件，跳过。`);
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    if (tableExists(db, "works")) {
      log(`  ${dbPath}: works 表已存在，跳过。`);
      return;
    }
    for (const file of files) {
      const sqlText = readFileSync(join(migrationsDir, file), "utf8");
      // drizzle-kit 用 --> statement-breakpoint 分隔语句。
      for (const raw of sqlText.split("--> statement-breakpoint")) {
        const statement = raw.trim();
        if (statement) db.exec(statement);
      }
    }
    log(`  ${dbPath}: 已应用 ${files.length} 个迁移。`);
  } finally {
    db.close();
  }
}

function main() {
  log("[db:init] 初始化本地 D1 数据库");

  if (!existsSync(migrationsDir)) {
    logError("未找到 drizzle/ 迁移目录。");
    process.exit(1);
  }

  const dbFiles = collectDbFiles(d1StateDir);
  if (!dbFiles.length) {
    log("未发现本地 D1 数据库文件（.wrangler/state/v3/d1/）。");
    log("请先运行一次 npm run local 让 Vinext 创建本地 D1，然后再执行 npm run db:init。");
    process.exit(0);
  }

  for (const dbPath of dbFiles) applyMigrations(dbPath);

  log("完成。");
}

main();
