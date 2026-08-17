#!/usr/bin/env node
/**
 * 声图本地一键启动器
 *
 * 在项目根目录执行 `npm run local`，自动完成：
 *   1. 检查运行环境（Node 版本、node_modules、Python venv）
 *   2. 启动 analysis-service（uvicorn，端口 8000）
 *   3. 启动前端 Vinext dev server
 *   4. 等待两个服务真正可用
 *   5. 自动打开系统默认浏览器
 *   6. 收到 Ctrl+C / SIGINT / SIGTERM 时关闭两个子进程
 *
 * 跨平台：Windows / macOS / Linux。不依赖 Codex / WorkBuddy / IDE。
 *
 * 安全约定：本文件绝不包含、也不打印任何 API Key / token / .env 内容。
 * 敏感值继续由现有环境配置（export 或 analysis-service/.env*）提供。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

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

/** 读取 analysis-service 下的 .env.local / .env（仅用于子进程环境，不打印）。 */
function loadEnvFiles() {
  const env = {};
  const names = [".env.local", ".env"];
  for (const name of names) {
    const file = join(analysisDir, name);
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      const value = match[2].replace(/^["']|["']$/g, "").trim();
      // 已由用户 export 的环境变量优先，.env 只做兜底。
      if (process.env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

/** 探测 8000 端口是否已是本项目的 analysis service。 */
async function probeAnalysisService() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return "other";
    const text = await res.text();
    // 本项目 /health 返回含 "configured" 的 JSON；其他程序不会返回该字段。
    return text.includes("configured") ? "ready" : "other";
  } catch {
    return "down";
  }
}

/** 等待 analysis service /health 可用。 */
async function waitForAnalysis() {
  const start = Date.now();
  while (Date.now() - start < ANALYSIS_READY_TIMEOUT_MS) {
    if ((await probeAnalysisService()) === "ready") return true;
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
  log("[1/4] 检查环境");

  checkNodeVersion();

  if (!existsSync(join(root, "node_modules"))) {
    logError("node_modules 尚未创建。");
    logError("请先在项目根目录执行：npm install");
    process.exit(1);
  }

  const py = pythonInterpreter();
  const hasVenv = existsSync(py);
  const children = [];

  const cleanup = (signal) => {
    log(`\n收到 ${signal}，正在关闭全部服务…`);
    for (const child of children) killTree(child);
    // 给子进程一点时间释放端口后退出。
    setTimeout(() => process.exit(0), 400);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  log("[2/4] 启动分析服务");

  const analysisState = await probeAnalysisService();
  if (analysisState === "ready") {
    log(`      分析服务已运行，直接复用：${ANALYSIS_URL}`);
  } else if (analysisState === "other") {
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
    log("      分析服务已就绪。");
  } else {
    logError("analysis-service/.venv 尚未创建。");
    logError("请先初始化 Python 3.12 虚拟环境：");
    logError("");
    logError("  cd analysis-service");
    logError(IS_WIN
      ? "  python -m venv .venv"
      : "  python3.12 -m venv .venv");
    logError(IS_WIN
      ? "  .venv\\Scripts\\python -m pip install -r requirements-dev.txt"
      : "  .venv/bin/python -m pip install -r requirements-dev.txt");
    logError("");
    logError("然后重新运行：npm run local");
    process.exit(1);
  }

  log("[3/4] 启动声图编辑器");

  const { child: frontChild, url: frontUrl } = await startFrontend();
  children.push(frontChild);

  if (!frontUrl || frontChild.exitCode !== null) {
    logError("前端 dev server 启动失败或未在预期时间内就绪。");
    logError("请检查上方输出排查错误。");
    for (const c of children) killTree(c);
    process.exit(1);
  }

  log(`      ${frontUrl}`);
  log("[4/4] 已打开浏览器");
  openBrowser(frontUrl);

  log("");
  log("声图本地环境已启动。");
  log("按 Ctrl+C 关闭全部服务。");
}

main().catch((error) => {
  logError(`启动器异常退出：${error?.stack || error}`);
  process.exit(1);
});
