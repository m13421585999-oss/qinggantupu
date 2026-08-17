#!/usr/bin/env node
/**
 * 声图本地一键启动器
 *
 * 在项目根目录执行 `npm run local`，自动完成：
 *   1. 检查运行环境（Node 版本、node_modules）
 *   2. 检查本地服务配置（.dev.vars 与 analysis-service/.env，token 两端核对）
 *   3. 初始化本地 D1（幂等；若 D1 文件尚未创建则留到前端启动后补做）
 *   4. 启动并验证 analysis-service（uvicorn:8000 + /health + GPT 配置检查）
 *   5. 启动前端 Vinext dev server，等待真实 Local URL
 *   6. 自动打开系统默认浏览器
 *   Ctrl+C / SIGINT / SIGTERM 时关闭两个子进程
 *
 * 跨平台：Windows / macOS / Linux。不依赖 Codex / WorkBuddy / IDE。
 *
 * 安全约定：本文件绝不包含、也不打印任何 API Key / token / .env 内容。
 * 配置检查只输出 ✓/✗ 状态，敏感值继续由 .dev.vars / .env / export 提供。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const analysisDir = join(root, "analysis-service");

const ANALYSIS_HOST = "127.0.0.1";
const ANALYSIS_PORT = 8000;
const ANALYSIS_URL = `http://${ANALYSIS_HOST}:${ANALYSIS_PORT}`;
const HEALTH_URL = `${ANALYSIS_URL}/health`;

const NODE_MIN = [22, 13, 0];
const ANALYSIS_READY_TIMEOUT_MS = 45_000;
const FRONTEND_READY_TIMEOUT_MS = 90_000;

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

const log = (line = "") => process.stdout.write(line + "\n");
const logError = (line = "") => process.stderr.write(line + "\n");

/** 解析 Node 版本，低于要求则提示并退出。 */
function checkNodeVersion() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const required = NODE_MIN;
  const ok =
    major > required[0] ||
    (major === required[0] && minor > required[1]) ||
    (major === required[0] && minor === required[1] && patch >= required[2]);
  if (!ok) {
    logError(`当前 Node 版本 ${process.versions.node}，需要 >= ${required.join(".")}。`);
    logError("请先升级 Node.js 后重试。");
    process.exit(1);
  }
}

/** 定位 venv 内的 Python 解释器。 */
function pythonInterpreter() {
  return IS_WIN
    ? join(analysisDir, ".venv", "Scripts", "python.exe")
    : join(analysisDir, ".venv", "bin", "python");
}

/** 解析 KEY=VALUE 格式的 env 文件，返回 { key: value }（忽略注释与空行）。 */
function parseEnvFile(file) {
  const result = {};
  if (!existsSync(file)) return result;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

/** 读取 analysis-service 下的 .env.local / .env（仅用于子进程环境，不打印）。 */
function loadEnvFiles() {
  const env = {};
  const names = [".env.local", ".env"];
  for (const name of names) {
    const file = join(analysisDir, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      // 已由用户 export 的环境变量优先，.env 只做兜底。
      if (process.env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

/** 探测 8000 端口是否已是本项目的 analysis service，并返回 health JSON。 */
async function probeAnalysisService() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { state: "other" };
    const text = await res.text();
    // 本项目 /health 返回含 "configured" 的 JSON；其他程序不会返回该字段。
    if (!text.includes("configured")) return { state: "other" };
    try {
      return { state: "ready", health: JSON.parse(text) };
    } catch {
      return { state: "ready", health: null };
    }
  } catch {
    return { state: "down" };
  }
}

/** 等待 analysis service /health 可用。 */
async function waitForAnalysis() {
  const start = Date.now();
  while (Date.now() - start < ANALYSIS_READY_TIMEOUT_MS) {
    const { state } = await probeAnalysisService();
    if (state === "ready") return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

/** 杀掉进程（Windows 用 taskkill 递归，POSIX 用进程组信号）。 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (IS_WIN) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // 进程已退出则忽略。
  }
}

/** 判断 URL 是否指向本地 analysis service（127.0.0.1 或 localhost，端口 8000）。 */
function isLocalAnalysisUrl(url) {
  try {
    const parsed = new URL(url);
    const hostOk = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const portOk = parsed.port === "8000";
    return hostOk && portOk;
  } catch {
    return false;
  }
}

/**
 * 检查本地服务配置（根目录 .dev.vars 与 analysis-service/.env）。
 * 只打印 ✓/✗ 状态，绝不打印 token / API Key 本身。
 */
function checkLocalConfig() {
  const devVarsPath = join(root, ".dev.vars");
  const envPath = join(analysisDir, ".env");
  const errors = [];

  log("      [.dev.vars]");
  if (!existsSync(devVarsPath)) {
    log("        ✗ 缺少根目录 .dev.vars（请复制 .dev.vars.example 并填写）");
    return { ok: false };
  }
  const devVars = parseEnvFile(devVarsPath);

  const devUrl = devVars.ANALYSIS_SERVICE_URL || "";
  const devToken = devVars.ANALYSIS_SERVICE_TOKEN || "";
  const devCallback = devVars.ANALYSIS_CALLBACK_TOKEN || "";

  log(`        ${devUrl ? "✓" : "✗"} ANALYSIS_SERVICE_URL ${devUrl ? "已配置" : "未配置"}`);
  log(`        ${devToken ? "✓" : "✗"} ANALYSIS_SERVICE_TOKEN ${devToken ? "已配置" : "未配置"}`);
  log(`        ${devCallback ? "✓" : "✗"} ANALYSIS_CALLBACK_TOKEN ${devCallback ? "已配置" : "未配置"}`);

  if (!devUrl) errors.push(".dev.vars 的 ANALYSIS_SERVICE_URL 未配置");
  else if (!isLocalAnalysisUrl(devUrl)) {
    errors.push("ANALYSIS_SERVICE_URL 必须指向本地分析服务 http://127.0.0.1:8000（或 localhost 等价形式）");
  }
  if (!devToken) errors.push(".dev.vars 的 ANALYSIS_SERVICE_TOKEN 未配置");
  if (!devCallback) errors.push(".dev.vars 的 ANALYSIS_CALLBACK_TOKEN 未配置");

  log("      [analysis-service/.env]");
  if (!existsSync(envPath)) {
    log("        ✗ 缺少 analysis-service/.env（请复制 .env.example 并填写）");
    return { ok: false };
  }
  const env = parseEnvFile(envPath);

  const aiKey = env.AI_API_KEY || "";
  const llmModel = env.LLM_MODEL || "";
  const envToken = env.ANALYSIS_SERVICE_TOKEN || "";
  const envCallback = env.ANALYSIS_CALLBACK_TOKEN || "";

  log(`        ${aiKey ? "✓" : "✗"} AI_API_KEY ${aiKey ? "已配置" : "未配置"}`);
  log(`        ${llmModel ? "✓" : "✗"} LLM_MODEL ${llmModel ? "已配置" : "未配置"}`);
  log(`        ${envToken ? "✓" : "✗"} ANALYSIS_SERVICE_TOKEN ${envToken ? "已配置" : "未配置"}`);
  log(`        ${envCallback ? "✓" : "✗"} ANALYSIS_CALLBACK_TOKEN ${envCallback ? "已配置" : "未配置"}`);

  if (!aiKey) errors.push("analysis-service/.env 的 AI_API_KEY 未配置");
  if (!llmModel) errors.push("analysis-service/.env 的 LLM_MODEL 未配置");
  if (!envToken) errors.push("analysis-service/.env 的 ANALYSIS_SERVICE_TOKEN 未配置");
  if (!envCallback) errors.push("analysis-service/.env 的 ANALYSIS_CALLBACK_TOKEN 未配置");

  // 两端 token 核对（只在两边都非空时核对，值本身不打印）。
  log("      [两端核对]");
  if (devToken && envToken) {
    const tokenMatch = devToken === envToken;
    const callbackMatch = devCallback === envCallback;
    log(`        ${tokenMatch ? "✓" : "✗"} ANALYSIS_SERVICE_TOKEN 两端一致`);
    log(`        ${callbackMatch ? "✓" : "✗"} ANALYSIS_CALLBACK_TOKEN 两端一致`);
    if (!tokenMatch) errors.push("ANALYSIS_SERVICE_TOKEN 两端不一致（.dev.vars vs analysis-service/.env）");
    if (!callbackMatch) errors.push("ANALYSIS_CALLBACK_TOKEN 两端不一致（.dev.vars vs analysis-service/.env）");
  } else {
    log("        ✗ 无法核对两端 token（至少一端未配置）");
  }

  if (errors.length) {
    log("");
    for (const error of errors) logError(`  ✗ ${error}`);
    return { ok: false };
  }
  return { ok: true, devVars, env };
}

/** 递归收集 d1 目录下的 .sqlite 文件（排除 metadata.sqlite）。 */
function collectDbFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectDbFiles(full));
    else if (entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite") results.push(full);
  }
  return results;
}

/** 初始化本地 D1（幂等）。返回 "done" | "pending"（D1 文件尚未创建）。 */
function ensureLocalDb() {
  const d1StateDir = join(root, ".wrangler", "state", "v3", "d1");
  const migrationsDir = join(root, "drizzle");
  const dbFiles = collectDbFiles(d1StateDir);
  if (!dbFiles.length) {
    log("      本地 D1 尚未创建，将在前端启动后自动初始化。");
    return "pending";
  }
  let initialized = 0;
  let skipped = 0;
  for (const dbPath of dbFiles) {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'works'",
      ).get();
      if (row) {
        skipped += 1;
        continue;
      }
      const files = readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();
      for (const file of files) {
        const sqlText = readFileSync(join(migrationsDir, file), "utf8");
        for (const raw of sqlText.split("--> statement-breakpoint")) {
          const statement = raw.trim();
          if (statement) db.exec(statement);
        }
      }
      initialized += 1;
    } finally {
      db.close();
    }
  }
  log(`      本地 D1：${initialized ? `已初始化 ${initialized} 个库` : "已就绪"}${skipped ? `（${skipped} 个跳过）` : ""}`);
  return "done";
}

/** 依据 /health 返回判断 GPT-5.6 Sol 文稿分析配置是否完成。 */
function checkHealthLlm(health) {
  const configured = health && typeof health.configured === "object" ? health.configured : null;
  if (!configured) {
    return { ok: false, reason: "无法解析 /health 返回的配置状态。" };
  }
  const missing = [];
  if (!configured.LLM_AUTH) missing.push("AI_API_KEY");
  if (!configured.LLM_MODEL) missing.push("LLM_MODEL");
  if (missing.length) {
    return {
      ok: false,
      reason: `GPT-5.6 Sol 文稿分析配置尚未完成，请检查 analysis-service/.env（缺少：${missing.join("、")}）`,
    };
  }
  return { ok: true };
}

/** 跨平台打开系统默认浏览器。 */
function openBrowser(url) {
  try {
    if (IS_WIN) {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else if (IS_MAC) {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (error) {
    logError(`无法自动打开浏览器（${error.message}），请手动访问：${url}`);
  }
}

/** 从 vinext dev 的 stdout 解析真实 Local URL，解析不到则回退默认端口。 */
function parseFrontendUrl(text) {
  const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/);
  return match ? match[0] : null;
}

/** 启动前端，并从 stdout 捕获真实 URL。 */
function startFrontend() {
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const child = spawn(npm, ["run", "dev"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
    detached: !IS_WIN,
  });

  return new Promise((resolve) => {
    let buffer = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ child, url: null });
      }
    }, FRONTEND_READY_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      buffer += text;
      // 透传 dev server 输出，方便查看编译与错误。
      process.stdout.write(text);
      if (!resolved) {
        const url = parseFrontendUrl(buffer);
        if (url) {
          resolved = true;
          clearTimeout(timer);
          resolve({ child, url });
        }
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ child, url: null, exitCode: code });
      }
    });

    child.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ child, url: null, error });
      }
    });
  });
}

async function main() {
  const children = [];

  const cleanup = (signal) => {
    log(`\n收到 ${signal}，正在关闭全部服务…`);
    for (const child of children) killTree(child);
    // 给子进程一点时间释放端口后退出。
    setTimeout(() => process.exit(0), 400);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // [1/6] 检查运行环境
  log("[1/6] 检查运行环境");
  checkNodeVersion();
  if (!existsSync(join(root, "node_modules"))) {
    logError("node_modules 尚未创建。");
    logError("请先在项目根目录执行：npm install");
    process.exit(1);
  }

  // [2/6] 检查本地服务配置
  log("[2/6] 检查本地服务配置");
  const config = checkLocalConfig();
  if (!config.ok) {
    log("");
    logError("本地服务配置未完成，已停止启动。");
    logError("请补齐 .dev.vars 与 analysis-service/.env 后重试（两边 token 需一致）。");
    process.exit(1);
  }
  log("      本地服务配置检查通过。");

  // [3/6] 初始化本地 D1
  log("[3/6] 初始化本地 D1");
  const dbState = ensureLocalDb();

  // [4/6] 启动并验证分析服务
  log("[4/6] 启动并验证分析服务");

  const py = pythonInterpreter();
  const hasVenv = existsSync(py);

  const analysisProbe = await probeAnalysisService();
  let health = analysisProbe.health ?? null;

  if (analysisProbe.state === "ready") {
    log(`      分析服务已运行，直接复用：${ANALYSIS_URL}`);
  } else if (analysisProbe.state === "other") {
    logError(`端口 ${ANALYSIS_PORT} 已被其他程序占用，且不是本项目分析服务。`);
    logError("请先释放该端口后重试。");
    process.exit(1);
  } else if (hasVenv) {
    const childEnv = { ...loadEnvFiles(), ...process.env };
    // 跨平台设置 PYTHONPATH（不写死 Unix export）。
    childEnv.PYTHONPATH = analysisDir;
    const child = spawn(
      py,
      ["-m", "uvicorn", "app.main:app", "--host", ANALYSIS_HOST, "--port", String(ANALYSIS_PORT)],
      {
        cwd: analysisDir,
        env: childEnv,
        stdio: ["ignore", "inherit", "inherit"],
        detached: !IS_WIN,
      },
    );
    children.push(child);
    log(`      ${ANALYSIS_URL}`);

    if (!(await waitForAnalysis())) {
      logError("分析服务启动失败（/health 未就绪）。");
      logError("请检查上方 uvicorn 输出排查错误。");
      for (const c of children) killTree(c);
      process.exit(1);
    }
    health = (await probeAnalysisService()).health ?? null;
    log("      分析服务已就绪。");
  } else {
    logError("analysis-service/.venv 尚未创建。");
    logError("请先初始化 Python 3.12 虚拟环境：");
    logError("");
    logError("  cd analysis-service");
    logError(IS_WIN ? "  python -m venv .venv" : "  python3.12 -m venv .venv");
    logError(IS_WIN
      ? "  .venv\\Scripts\\python -m pip install -r requirements-dev.txt"
      : "  .venv/bin/python -m pip install -r requirements-dev.txt");
    logError("");
    logError("然后重新运行：npm run local");
    process.exit(1);
  }

  // 依据 /health 判断文稿分析（GPT-5.6 Sol）配置是否完成。
  const llmCheck = checkHealthLlm(health);
  if (!llmCheck.ok) {
    logError(llmCheck.reason);
    logError("已停止启动，未打开浏览器。");
    for (const c of children) killTree(c);
    process.exit(1);
  }
  log("      文稿分析（GPT-5.6 Sol）配置就绪。");

  // [5/6] 启动声图编辑器
  log("[5/6] 启动声图编辑器");

  const { child: frontChild, url: frontUrl } = await startFrontend();
  children.push(frontChild);

  if (!frontUrl || frontChild.exitCode !== null) {
    logError("前端 dev server 启动失败或未在预期时间内就绪。");
    logError("请检查上方输出排查错误。");
    for (const c of children) killTree(c);
    process.exit(1);
  }

  // 前端启动后，D1 文件才会被 Vinext 创建；若 [3/6] 时尚未初始化，现在补做。
  if (dbState === "pending") {
    log("      前端已启动，补做本地 D1 初始化…");
    ensureLocalDb();
  }

  log(`      ${frontUrl}`);

  // [6/6] 打开浏览器
  log("[6/6] 打开浏览器");
  openBrowser(frontUrl);

  log("");
  log("声图本地环境已启动。");
  log("按 Ctrl+C 关闭全部服务。");
}

main().catch((error) => {
  logError(`启动器异常退出：${error?.stack || error}`);
  process.exit(1);
});
