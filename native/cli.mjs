#!/usr/bin/env node
/**
 * pi-web 薄壳（阶段 E 起 `pi-web` 命令的实现）
 *
 * 只做三件事：
 *   ① `pi-web r <name> [--port <port>]` → 交给原生引擎 `--session <name> --port <port>`
 *   ② `pi-web list` → 列出会话（name/id/cwd，新→旧；读 session 文件，不依赖 SDK）
 *   ③ `pi-web help`
 * 并保留原 SDK CLI 的**堆上限处理**：长会话 + 进程内扩展可能撑爆 Node 默认 old-space，
 * 因此启动引擎前按需给**引擎子进程**加 `--max-old-space-size`（`PI_WEB_MAX_OLD_SPACE_MB` 可覆盖）。
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.mjs");
const DEFAULT_PORT = 4080;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SESSIONS_ROOT = join(AGENT_DIR, "sessions");
const DEFAULT_MAX_OLD_SPACE_MB = 4096;

const DOC = `pi-web - browser Web access for Pi (native engine)

Usage:
  pi-web r <name> [--port <port>]   Run web mode for the session (default port ${DEFAULT_PORT})
  pi-web list                       List all sessions (name, id, cwd), newest first
  pi-web help                       Show this help
`;

const logInfo = (m) => console.log(m);
const logError = (m) => console.error(m);

/** 会话列表：扫 sessions/<dir>/*.jsonl，取首行 header 的 id/cwd 与 session_info 的名字，按 mtime 新→旧。 */
function listSessions() {
  const rows = [];
  let dirs = [];
  try {
    dirs = readdirSync(SESSIONS_ROOT);
  } catch {
    return rows;
  }
  for (const dir of dirs) {
    const full = join(SESSIONS_ROOT, dir);
    let files = [];
    try {
      if (!statSync(full).isDirectory()) continue;
      files = readdirSync(full);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(full, file);
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      let header = {};
      try {
        header = JSON.parse(text.split("\n")[0]);
      } catch {
        continue;
      }
      const nameMatch = text.match(/"type":"session_info"[^}]*"name":"([^"]+)"/);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        /* ignore */
      }
      rows.push({
        name: nameMatch?.[1] ?? "(unnamed)",
        id: header.id ?? "",
        cwd: header.cwd ?? "",
        mtime,
      });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

// ---------------------------------------------------------------- 堆上限
function heapLimitMb() {
  return getHeapStatistics().heap_size_limit / (1024 * 1024);
}
function requestedHeapMb() {
  const raw = Number(process.env.PI_WEB_MAX_OLD_SPACE_MB);
  if (Number.isFinite(raw) && raw >= 512 && raw <= 32_768) return Math.floor(raw);
  return DEFAULT_MAX_OLD_SPACE_MB;
}
function hasExplicitHeapFlag() {
  const fromEnv = (process.env.NODE_OPTIONS ?? "").split(/\s+/);
  return [...process.execArgv, ...fromEnv].some((a) => /^--max[-_]old[-_]space[-_]size(=|$)/.test(a));
}
/** 需要时返回给引擎子进程的 node 参数（否则空数组），并说明原因。 */
function heapFlags() {
  if (hasExplicitHeapFlag()) return [];
  const target = requestedHeapMb();
  if (heapLimitMb() >= target * 0.95) return [];
  const totalMb = totalmem() / (1024 * 1024);
  if (totalMb < target * 2) {
    logInfo(
      `heap: keeping the default limit (${heapLimitMb().toFixed(0)}MB) - ` +
        `raising it to ${target}MB needs ~${target * 2}MB of RAM, host has ${totalMb.toFixed(0)}MB`,
    );
    return [];
  }
  logInfo(
    `heap: starting native engine with --max-old-space-size=${target} ` +
      `(current limit ${heapLimitMb().toFixed(0)}MB)`,
  );
  return [`--max-old-space-size=${target}`];
}

// ---------------------------------------------------------------- 命令
function parsePort(value) {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value} (must be a number)`);
  const port = parseInt(value, 10);
  if (!(1 <= port && port <= 65535)) throw new Error(`Invalid port: ${port} (must be 1-65535)`);
  return port;
}

function cmdResume(name, port) {
  const child = spawn(
    process.execPath,
    [...heapFlags(), SERVER, "--session", name, "--port", String(port)],
    { stdio: "inherit" },
  );
  // Ctrl+C 会送到整个前台进程组；真正的收尾由引擎完成（杀 pi 子进程、关 socket、打日志）。
  // 这里只等它结束再退出——若抢先退出，bash 的提示符会插到引擎收尾日志之前（§17.4）。
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  child.on("error", (err) => {
    logError(`failed to start the native engine: ${err.message}`);
    process.exit(1);
  });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "r" || cmd === "resume") {
    let name;
    let port;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--port") port = parsePort(rest[++i]);
      else if (arg.startsWith("--port=")) port = parsePort(arg.slice("--port=".length));
      else if (name === undefined) name = arg;
      else throw new Error(`unexpected argument: ${arg}\nusage: pi-web r <name> [--port <port>]`);
    }
    if (!name) throw new Error("usage: pi-web r <name> [--port <port>]");
    cmdResume(name, port ?? DEFAULT_PORT);
    return;
  }
  if (cmd === "list") {
    const rows = listSessions();
    if (rows.length === 0) {
      console.log("(no sessions)");
      return;
    }
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.id}  ${r.cwd}`);
    return;
  }
  if (cmd === "help" || cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(DOC);
    return;
  }
  throw new Error(`unknown command: ${cmd}\n${DOC}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
