#!/usr/bin/env node
/**
 * pi-web 原生引擎服务端（bin: `pi-web-native`；设计见 pi-web-design.md §15/§17）
 *
 * 目标：**不改动前端**地复现 pi-web 的能力——复用仓库 `static/`，沿用同一套 WS 协议，
 * 但引擎换成「spawn 已安装的原生 pi --mode rpc」+ 注入桥接扩展（见 bridge.mjs）。
 * 由 `pii r <会话名> --web [端口]` 调用（契约：`<session-id> [cwd] --port <n>`）。
 *
 * 用法：
 *   pi-web-native <session-id> [cwd] [--port 4080]      # pii 的调用方式
 *   pi-web-native --session <name> --port 4096          # 按会话名
 *   pi-web-native --session-file /path/to/session.jsonl --port 4096
 *
 * 然后（另一个终端）：
 *   node tools/smoke.mjs http://127.0.0.1:4096
 *
 * 设计依据：pi-web-design.md §15。本文件是原型，不是发布路径。
 */
import { createServer } from "node:http";
import { sessionDisplayName } from "./session-name.mjs";
import { buildIndex, countEntries, lastEntryId, readPage } from "./session-history.mjs";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// 静态前端：仓库里是 <repo>/native → <repo>/static；发布后是 <pkg>/dist/native → <pkg>/dist/static
const STATIC_DIR = resolve(HERE, "..", "static");

/** 解析 ws：本包依赖，发布后从 dist/native 往上层 node_modules 即可找到；
 *  仓库内开发时 native/ 下没有 node_modules，回退到同级的 pi-sdk-web 依赖树。
 *  （不要写死绝对路径 —— 那是原型阶段的权宜做法，发布后必然失效。） */
const { WebSocketServer } = (() => {
  const candidates = [import.meta.url, pathToFileURL(join(HERE, "..", "pi-sdk-web", "package.json")).href];
  for (const base of candidates) {
    try {
      return createRequire(base)("ws");
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error("cannot resolve dependency 'ws' (expected next to this package or under node_modules)");
})();
const BRIDGE_EXT = join(HERE, "bridge.mjs");
// 与 Pi 自身一致：尊重 PI_CODING_AGENT_DIR（默认 ~/.pi/agent）。
// 曾硬编码 $HOME/.pi/agent —— 自定义配置目录下会读错 settings / 扫错 sessions。
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi", "agent");
const SESSIONS_ROOT = join(AGENT_DIR, "sessions");
/** 首屏只发最近这么多条历史（其余按需加载，见 §20）；可用环境变量覆盖。 */
const HISTORY_TAIL = Math.max(20, Number(process.env.PI_WEB_HISTORY_TAIL ?? 300) || 300);
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");
const TOKEN = randomUUID();
/** 本次运行的唯一 id：注入 pi 子进程环境，用于把「自己这棵树」与「另一个实例」区分开。
 *  否则 pi 子进程派生的助手进程（aft bridge、LSP、bash…）会继承会话标记而被误判成
 *  "另一个 web 实例"（2026-10-14 实测误报：同一实例被报成 3 个 PID）。 */
const RUN_ID = randomUUID();
/** pi-web 版本 = 本包 package.json 的 version（与 SDK 宿主同口径，header 直接显示）。
 *  两种布局都要能找到：发布后 HERE=<pkg>/dist/native → <pkg>/package.json；
 *  仓库内 HERE=<repo>/native → <repo>/pi-sdk-web/package.json。 */
const PI_WEB_VERSION = (() => {
  const candidates = [
    join(HERE, "..", "..", "package.json"),
    join(HERE, "..", "pi-sdk-web", "package.json"),
    join(HERE, "..", "package.json"),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const version = JSON.parse(readFileSync(file, "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch {
      /* 试下一个 */
    }
  }
  return "dev";
})();

// ------------------------------------------------------------------ 参数解析
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 服务端自身的诊断日志：统一带本地时间戳（便于事后对照；命令/扩展输出保持原样不加）。
 *  取自 pi-web 既有约定：自身的日志行（背压、生命周期、几何上报…）都要有时间。 */
function log(message) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  console.log(`[${stamp}] ${message}`);
}
function logErr(message) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  console.error(`[${stamp}] ${message}`);
}

// 位置参数（与 pii 调用 Python 服务端的契约同形）：pi-web-native <session-id> <cwd> --port <n>
const POSITIONAL = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
// 两种入口语义不同，不能混：位置参数按**会话 id** 匹配（pii 的调用契约），
// `--session <name>` 按**显示名**匹配（含 "(unnamed)"）。曾把二者合并且都按 id 匹配 → --session 失效。
const SESSION_NAME = arg("session", undefined);
const POS_SESSION_ID = POSITIONAL[0] ?? undefined;
const POS_CWD = arg("cwd", undefined) ?? POSITIONAL[1] ?? undefined;
const SESSION_FILE = arg("session-file", undefined);
const PORT = Number(arg("port", "4080"));

// 端口与 cwd 校验：与 Python 服务端一致的报错行为（不自动换端口）
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  logErr(`Invalid port: ${arg("port", "")}`);
  process.exit(1);
}
if (!POS_SESSION_ID && !SESSION_NAME && !SESSION_FILE) {
  logErr("usage: pi-web-native <session-id> [cwd] [--port 4080]");
  logErr("       pi-web-native --session <name> --port 4080");
  logErr("       pi-web-native --session-file <path> --port 4080");
  process.exit(2);
}
if (POS_CWD && !existsSync(POS_CWD)) {
  logErr(`Working directory not found: ${POS_CWD}`);
  process.exit(1);
}

// ------------------------------------------------------------------ 会话解析
async function listSessionFiles() {
  const out = [];
  let dirs = [];
  try {
    dirs = await readdir(SESSIONS_ROOT);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const full = join(SESSIONS_ROOT, dir);
    let files = [];
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      files = await readdir(full);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) out.push(join(full, f));
    }
  }
  return out;
}

/** 会话解析：三种入口
 *  ① --session-file <path>                    直接指定
 *  ② <session-id> [cwd]（pii 的调用契约）      按 header `id` 匹配
 *  ③ --session <name>                        按 session_info 名字匹配（"(unnamed)" 表示无名会话）
 *  cwd 优先取位置参数（pii 已 chdir，与 Python 服务端行为一致）。 */
async function resolveSession() {
  const withCwd = (row) => ({ ...row, cwd: POS_CWD ?? row.cwd });
  if (SESSION_FILE) {
    const text = await readFile(SESSION_FILE, "utf8");
    const header = JSON.parse(text.split("\n")[0]);
    return withCwd({ path: resolve(SESSION_FILE), cwd: header.cwd ?? process.cwd(), name: header.name });
  }
  // 位置参数如果本身就是路径，直接当会话文件用
  if (POS_SESSION_ID && POS_SESSION_ID.endsWith(".jsonl") && existsSync(POS_SESSION_ID)) {
    const text = await readFile(POS_SESSION_ID, "utf8");
    const header = JSON.parse(text.split("\n")[0]);
    return withCwd({ path: resolve(POS_SESSION_ID), cwd: header.cwd ?? process.cwd(), name: header.name });
  }
  const hits = [];
  for (const p of await listSessionFiles()) {
    let text;
    try {
      text = await readFile(p, "utf8");
    } catch {
      continue;
    }
    // "(unnamed)" 是 pi-web 对未命名会话的展示名（与 pii 一致），匹配没有 name 的会话
    const sessionName = sessionDisplayName(text) ?? "(unnamed)";
    const header = JSON.parse(text.split("\n")[0]);
    const matched = SESSION_NAME ? sessionName === SESSION_NAME : header.id === POS_SESSION_ID;
    if (!matched) continue;
    const st = await stat(p);
    hits.push({ path: p, cwd: header.cwd ?? process.cwd(), name: sessionName, mtime: st.mtimeMs });
  }
  if (hits.length === 0) {
    logErr(
      SESSION_NAME
        ? `No session named '${SESSION_NAME}' under ${SESSIONS_ROOT}`
        : `No session with id '${POS_SESSION_ID}' under ${SESSIONS_ROOT}`,
    );
    process.exit(1);
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return withCwd(hits[0]);
}

const session = await resolveSession();
log(`[pi-web] session: ${session.name ?? "(unnamed)"} → ${session.path}`);
log(`[pi-web] cwd: ${session.cwd}`);

// ------------------------------------------------------------------ Pi 版本
const PI_VERSION = (() => {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

// ------------------------------------------------------------------ RPC 客户端
const child = spawn(
  "pi",
  ["--session", session.path, "--mode", "rpc", "--extension", BRIDGE_EXT],
  {
    cwd: session.cwd,
    env: {
      ...process.env,
      PI_WEB_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
      PI_WEB_BRIDGE_TOKEN: TOKEN,
      // 桥接自身路径：让它把自己从「已加载扩展」列表里排除（那是基础设施，不是用户扩展）
      PI_WEB_BRIDGE_EXTENSION: BRIDGE_EXT,
      // 会话文件路径：让**其它**原生实例能检测出"同一会话被多个 web 实例打开"
      // （pi 会覆写 process.title，argv 被 NUL 填充盖住，所以不能靠 cmdline 匹配）
      PI_WEB_BRIDGE_SESSION: session.path,
      PI_WEB_BRIDGE_RUN: RUN_ID,
      // 诊断命令（/pi-web:demo-*）默认关闭：它们会污染用户的 `/` 菜单
      ...(argv.includes("--demo") ? { PI_WEB_BRIDGE_DEMO: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

/** agent 是否在跑（由 Pi 的 agent_start / agent_end|agent_settled 维护）。
 *  刷新页面会丢掉这些事件 → 前端靠 state 快照恢复"Working…"指示器（2026-10-20 用户实测 ✗）。 */
let agentActive = false;

const pendingRpc = new Map();
let rpcSeq = 0;

/** 普通命令的 RPC 超时；长任务用 RPC_LONG_TIMEOUT_MS，bash 不设超时（见 rpc 的 opts.timeoutMs）。 */
const RPC_TIMEOUT_MS = 30000;
/** 长任务：压缩、导出 HTML、读全量条目（大会话下可能远超 30s，但不能无限等）。 */
const RPC_LONG_TIMEOUT_MS = 10 * 60 * 1000;

function rpc(type, extra = {}, opts = {}) {
  const id = opts.id ?? `c${++rpcSeq}`;
  const payload = JSON.stringify({ id, type, ...extra }) + "\n";
  // 子进程已死时立刻失败：destroyed stdin 上的 write 既不抛也不 emit error（只有回调能拿到
  // ERR_STREAM_DESTROYED），早先会被静默丢弃 → 普通 RPC 等满 30s、bash（无超时）永不结算 ✗。
  // 2026-10-20 审计修复。
  if (childExited || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    return Promise.reject(new Error("pi child exited"));
  }
  return new Promise((res, rej) => {
    pendingRpc.set(id, { res, rej });
    // opts.timeoutMs：未指定 = 默认 30s；0 = **不超时**（bash 命令可以跑任意久）；
    // 长任务显式传 RPC_LONG_TIMEOUT_MS。
    const timeoutMs = opts.timeoutMs === undefined ? RPC_TIMEOUT_MS : opts.timeoutMs;
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pendingRpc.delete(id)) rej(new Error(`rpc timeout: ${type}`));
      }, timeoutMs);
    }
    child.stdin.write(payload, (err) => {
      if (err && pendingRpc.delete(id)) rej(err);
    });
  });
}

async function rpcData(type, extra) {
  const response = await rpc(type, extra);
  if (response && response.success === false) throw new Error(response.error ?? `${type} failed`);
  return response?.data;
}

// ------------------------------------------------------------------ WS 广播
const clients = new Set();
let lastScopedNoticeAt = 0; // scoped-models 提示去抖（避免每次勾选都刷一行）
let historyIndex = null; // 会话文件行偏移索引（惰性建立，见 §20）
let pendingScopedPatterns = null; // 待桥接即时应用的 scoped 模式（侧信道一次性交接）
let scopedApplyResolve = null; // 等待桥接回传应用结果
let scopedApplyTimer = null; // 上面那个等待者的超时句柄（并发时要能取消）
let scopedApplyTimeoutMs = 5000;
/** 面板可用列/行数，由前端按实际版面量出后上报；桥接据此决定组件渲染宽度。
 *  默认值只在浏览器还没上报时兜底（例如扩展在页面连上之前就弹面板）。 */
let panelGeometry = { cols: 100, rows: 40 };
/** **无浏览器时**的对话框兜底超时（pi-web 自己的保护，不是扩展的 timeout）：
 *  有浏览器连接时对话框**无限等待**（与 TUI/SDK 宿主一致，绝不抢走用户的作答权）；
 *  只有浏览器不在（标签页关了）才用这个兜底，避免扩展永远挂住 agent 循环；重连即撤销。 */
const DIALOG_FALLBACK_TIMEOUT_MS = Number(process.env.PI_WEB_BRIDGE_DIALOG_TIMEOUT_MS ?? 10 * 60 * 1000);
/** 当前正在执行的扩展命令名（用于把命令期间的 notify 标题改写为 `/<命令名>`，
 *  与 SDK 宿主的 executeCommand 一致 —— 前端据此把命令输出渲染成模态而非行内状态行）。 */
let runningCommand = null;
const widgetSnapshot = new Map(); // key -> {widgetKey, widgetLines, widgetPlacement}
let extStatusSnapshot = {};
let themeName = "dark"; // 浏览器主题：桥接经 GET /side/theme 取用（扩展 ANSI 换肤）
let lastSessionId = ""; // 供 /usage 取本会话统计

/** 背压阈值（与 SDK 宿主同量级）：客户端积压超过高水位就跳过**流式增量**，
 *  回落到低水位后恢复 —— 否则长会话/大输出会把内存顶上去。 */
const BACKPRESSURE_HIGH = Number(process.env.PI_WEB_BACKPRESSURE_HIGH ?? 8 * 1024 * 1024);
const BACKPRESSURE_LOW = Number(process.env.PI_WEB_BACKPRESSURE_LOW ?? 2 * 1024 * 1024);
const laggingClients = new WeakSet();
/** 只有流式增量可丢：它们的后续帧会补齐最终状态；其余帧（state/history/stats/
 *  bash_result/entry_appended/extension_ui_request…）一律不能丢。 */
function isDroppableDelta(obj) {
  return obj && (obj.type === "message_update" || obj.type === "bash_execution_update");
}

function broadcast(obj) {
  const text = JSON.stringify(obj);
  const droppable = isDroppableDelta(obj);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    const queued = ws.bufferedAmount ?? 0;
    if (queued > BACKPRESSURE_HIGH && !laggingClients.has(ws)) {
      laggingClients.add(ws);
      log(`client is behind (${(queued / 1048576).toFixed(1)}MB queued) - skipping stream deltas until it catches up`);
    } else if (laggingClients.has(ws) && queued < BACKPRESSURE_LOW) {
      laggingClients.delete(ws);
      log("client caught up - stream deltas resumed");
    }
    if (droppable && laggingClients.has(ws)) continue; // 只丢流式增量
    ws.send(text);
  }
}

/** 前端「notify」提示（与现有服务端同形：extension_ui_request + method=notify） */
function notify(title, message, notifyType = "info") {
  broadcast({ type: "extension_ui_request", id: randomUUID(), method: "notify", title, message, notifyType });
}

const STATS_REFRESH_EVENTS = new Set([
  "agent_settled",
  "turn_end",
  "tool_execution_end",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
]);

/** pi-web 自带命令（不来自任何扩展）——与 SDK 宿主 getCommands() 的注入保持一致，
 *  否则 `/` 菜单里会缺 `usage`（原生实现，见 sendUsage）。 */
const NATIVE_COMMANDS = [
  {
    name: "usage",
    description: "Show usage statistics (tokens/cost, all sessions)",
    source: "maxdai",
    sourceInfo: { path: "pi-sdk-web", source: "maxdai", scope: "global", origin: "cli" },
  },
];

function withNativeCommands(commands) {
  const names = new Set(commands.map((c) => c?.name));
  return [...commands, ...NATIVE_COMMANDS.filter((c) => !names.has(c.name))];
}

// ------------------------------------------------------------------ 状态构建
let bridgeInfo = {};

function gitBranch(cwd) {
  try {
    return (
      execFileSync("git", ["branch", "--show-current"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"], // 非 git 目录的 stderr 不要泄漏到日志
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function displayCwd(cwd) {
  const home = process.env.HOME ?? "";
  if (cwd === home) return "~";
  if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/** 读会话文件头部的 cwd（只读前 8KB；大文件下避免整份读入）。 */
function readHeaderCwd(file) {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(8192);
      const n = readSync(fd, buf, 0, 8192, 0);
      const line = buf.subarray(0, n).toString("utf8").split("\n")[0];
      const header = JSON.parse(line);
      return typeof header.cwd === "string" ? header.cwd : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** 同步"当前会话文件"。`session` 是启动时解析的常量，而 `/resume`、`/new`、`/fork`、`/clone`
 *  都会换文件——不刷新会出两个问题（2026-10-15 用户实测）：
 *  ① `get_sessions` 用 `p === session.path` 排除"当前会话"，排除的其实是**原会话** →
 *     切走以后原会话从 /resume 列表里消失，切不回去；
 *  ② 基于会话文件的 history（§20）会继续读**旧文件** → 切到新会话后显示的还是旧会话内容。
 *  返回是否发生变化。 */
function applySessionFile(file) {
  if (!file || file === session.path) return false;
  session.path = file;
  session.name = undefined; // 名字随文件重新解析（见 get_sessions）
  session.cwd = readHeaderCwd(file) ?? session.cwd;
  historyIndex = null; // 索引属于旧文件，必须重建（§20）
  log(`[pi-web] session switched → ${session.path}`);
  return true;
}

/** 主动向 Pi 询问当前会话文件并同步（用于 get_sessions 等未走 buildState 的路径）。 */
async function syncSessionFile() {
  try {
    const st = (await rpcData("get_state")) ?? {};
    return applySessionFile(st.sessionFile);
  } catch (err) {
    logErr(`[pi-web] sync session failed: ${err.message}`);
    return false;
  }
}

async function buildState() {
  let st = {};
  try {
    st = (await rpcData("get_state")) ?? {};
  } catch (err) {
    logErr(`[pi-web] get_state failed: ${err.message}`);
  }
  // 会话切换后当前会话文件会变（见 applySessionFile）
  applySessionFile(st.sessionFile);
  const cwd = bridgeInfo.cwd ?? session.cwd;
  if (st.sessionId) lastSessionId = String(st.sessionId);
  const state = {
    sessionId: st.sessionId,
    sessionName: st.sessionName ?? session.name,
    model: st.model ? { provider: st.model.provider, id: st.model.id, name: st.model.name } : undefined,
    thinkingLevel: st.thinkingLevel,
    autoCompactionEnabled: st.autoCompactionEnabled,
    messageCount: st.messageCount,
    // 运行态（见 agentActive）：前端据此恢复"Working…"指示器（2026-10-20）
    agentActive,
    version: PI_VERSION,
    piWebVersion: PI_WEB_VERSION,
    // 能力位：本引擎支持 {type:'panel_geometry'}（前端据此决定是否上报面板尺寸）。
    // SDK 宿主不懂这个消息且会回 error 帧，所以前端必须按能力位来决定发不发。
    panelGeometry: true,
    cwd: displayCwd(cwd),
    gitBranch: gitBranch(cwd),
    commands: withNativeCommands(bridgeInfo.commands ?? []),
    tools: bridgeInfo.tools ?? [],
    extensions: bridgeInfo.extensions ?? [],
    scopedModels: bridgeInfo.scopedModels ?? [],
  };
  try {
    state.sessionStats = await rpcData("get_session_stats");
  } catch {
    /* 统计失败不影响首屏 */
  }
  return state;
}

/** 让桥接扩展在会话内**即时**应用 scoped models（设计见 pi-web-design.md §15.11.1）。
 *  流程：登记待应用模式 → 经 RPC prompt 触发桥接命令 → 等桥接经侧信道回传结果。
 *  失败/超时返回 {ok:false}，调用方退回"写 settings + 提示需重启"的旧行为。 */
async function applyScopedInSession(patterns) {
  pendingScopedPatterns = patterns;
  // 前端每勾选一次就发一条 set_scoped_models，天然并发 ✗：早先单槽 scopedApplyResolve 会被覆盖，
  // 被覆盖那次既不 resolve 也不超时（超时回调里有 === 判断）→ 永久 pending、请求永不返回。
  // 进入时先把上一个等待者结算掉。2026-10-20 审计修复。
  if (scopedApplyResolve) {
    const prev = scopedApplyResolve;
    scopedApplyResolve = null;
    try {
      prev({ ok: false, error: "superseded" });
    } catch {
      /* ignore */
    }
  }
  if (scopedApplyTimer) {
    clearTimeout(scopedApplyTimer);
    scopedApplyTimer = null;
  }
  const done = new Promise((resolve) => {
    scopedApplyResolve = resolve;
    scopedApplyTimer = setTimeout(() => {
      if (scopedApplyResolve === resolve) {
        scopedApplyResolve = null;
        scopedApplyTimer = null;
        resolve({ ok: false, error: "timeout" });
      }
    }, scopedApplyTimeoutMs);
  });
  try {
    await rpc("prompt", { message: "/pi-web:set-scoped-models" });
  } catch (err) {
    // 失败早退时也要把等待者与定时器收掉，别留悬空状态
    if (scopedApplyResolve) {
      const pending = scopedApplyResolve;
      scopedApplyResolve = null;
      try {
        pending({ ok: false, error: `rpc: ${err.message}` });
      } catch {
        /* ignore */
      }
    }
    if (scopedApplyTimer) {
      clearTimeout(scopedApplyTimer);
      scopedApplyTimer = null;
    }
    return { ok: false, error: `rpc: ${err.message}` };
  }
  return done;
}

async function sendState(target) {
  const state = await buildState();
  const frame = { type: "state", data: state };
  if (target) target.send(JSON.stringify(frame));
  else broadcast(frame);
}

/** 会话文件的行偏移索引（惰性建立；文件增长则增量扩展，变小则重建）。 */
function ensureHistoryIndex() {
  const file = session?.path;
  if (!file) return null;
  try {
    if (!historyIndex) historyIndex = buildIndex(file);
    else {
      const size = statSync(file).size;
      if (size > historyIndex.size) historyIndex = buildIndex(file, historyIndex);
      else if (size < historyIndex.size) historyIndex = buildIndex(file);
    }
  } catch (err) {
    logErr(`[pi-web] history index failed: ${err.message}`);
    return null;
  }
  return historyIndex;
}

async function sendHistory(target) {
  const file = session?.path;
  const index = file ? ensureHistoryIndex() : null;
  if (file && index) {
    // 尾部优先：只解析并发送最近 HISTORY_TAIL 条（§20）
    const total = countEntries(index);
    const from = Math.max(0, total - HISTORY_TAIL);
    const entries = readPage(file, index, from, total);
    const frame = {
      type: "history",
      data: { entries, from, total, hasMore: from > 0, leafId: lastEntryId(file, index) },
    };
    log(`[pi-web] history: ${entries.length}/${total} 条（from=${from}${from > 0 ? "，可继续往前加载" : ""}）`);
    if (target) target.send(JSON.stringify(frame));
    else broadcast(frame);
    return;
  }
  // 退化路径：拿不到会话文件时仍走 RPC 全量（旧行为）
  try {
    const data = await rpc("get_entries", {}, { timeoutMs: RPC_LONG_TIMEOUT_MS }).then((r) => r?.data);
    const entries = data?.entries ?? [];
    const frame = { type: "history", data: { entries, from: 0, total: entries.length, hasMore: false, leafId: data?.leafId ?? null } };
    if (target) target.send(JSON.stringify(frame));
    else broadcast(frame);
  } catch (err) {
    logErr(`[pi-web] get_entries failed: ${err.message}`);
  }
}

async function sendStats() {
  try {
    const stats = await rpcData("get_session_stats");
    broadcast({ type: "stats", data: stats });
  } catch {
    /* ignore */
  }
}

/** TUI `/session` 等价物：只读信息模态（与 SDK 宿主 broadcastSessionInfo 同形同内容）。 */
async function sendSessionInfo() {
  try {
    const st = (await rpcData("get_state")) ?? {};
    const stats = (await rpcData("get_session_stats")) ?? {};
    // 条目数用本地行偏移索引（原先额外调一次全量 get_entries，大会话下要十几秒，§20）
    let entryCount = 0;
    try {
      const index = ensureHistoryIndex();
      if (index) entryCount = countEntries(index);
    } catch {
      /* ignore */
    }
    const n = (v) => (typeof v === "number" ? v : 0);
    const lines = ["## Session Info", ""];
    if (st.sessionName) lines.push(`**Name:** ${st.sessionName}`);
    lines.push(`**ID:** ${st.sessionId ?? ""}`);
    if (stats.sessionFile) lines.push(`**File:** ${stats.sessionFile}`);
    if (st.model) lines.push(`**Model:** ${st.model.provider}/${st.model.id}`);
    lines.push(`**Thinking:** ${st.thinkingLevel ?? "off"}`, "");
    lines.push("### Messages");
    lines.push(`- User: ${n(stats.userMessages)}`);
    lines.push(`- Assistant: ${n(stats.assistantMessages)}`);
    lines.push(`- Tool calls: ${n(stats.toolCalls)}`);
    lines.push(`- Tool results: ${n(stats.toolResults)}`);
    lines.push(`- Total: ${n(stats.totalMessages)}`);
    lines.push(`- Entries: ${entryCount}`, "");
    const t = stats.tokens;
    if (t) {
      lines.push("### Tokens");
      lines.push(`- Input: ${n(t.input)}`);
      lines.push(`- Output: ${n(t.output)}`);
      lines.push(`- Cache read: ${n(t.cacheRead)}`);
      lines.push(`- Cache write: ${n(t.cacheWrite)}`);
      lines.push(`- Total: ${n(t.total)}`, "");
    }
    if (typeof stats.cost === "number") {
      lines.push("### Cost");
      lines.push(`$${stats.cost.toFixed(4)}`);
    }
    const cu = stats.contextUsage;
    if (cu?.contextWindow) {
      lines.push("", "### Context");
      lines.push(`- ${cu.percent ?? "?"}% / ${cu.contextWindow} tokens`);
    }
    broadcast({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "notify",
      title: "/session",
      message: lines.join("\n"),
      notifyType: "info",
    });
  } catch (err) {
    notify("/session", `session info unavailable: ${err.message}`, "warning");
  }
}

/** `/usage`：复用 pi-web 既有的 usage-render（读 session 文件，不依赖 SDK）。
 *  原型阶段 import pi-sdk-web 的构建产物；正式迁移时该模块并入原生服务端源码。 */
/** usage-render 模块路径：阶段 E 起与引擎**同目录**（native/usage-render.mjs）。
 *  历史教训：曾用已删除的 REPO 常量拼接、又曾跨目录 import SDK 构建产物 →
 *  `/usage` 报 "REPO is not defined"（0.7.0~0.7.5）。同目录是最终形态。 */
function usageRenderPath() {
  const file = join(HERE, "usage-render.mjs");
  if (existsSync(file)) return file;
  throw new Error(`usage-render.mjs not found next to the server（${file}）`);
}

async function sendUsage(scope, target) {
  try {
    const mod = await import(pathToFileURL(usageRenderPath()).href);
    const data = mod.buildUsageData(scope === "all" ? undefined : lastSessionId || undefined);
    if (data) {
      const frame = { type: "usage_data", data };
      if (target) target.send(JSON.stringify(frame));
      else broadcast(frame);
    } else {
      notify(
        "/usage",
        scope === "all" ? "No usage data found yet." : "No usage data for this session yet.",
        "info",
      );
    }
  } catch (err) {
    notify("/usage", `usage unavailable: ${err.message}`, "warning");
  }
}

// ------------------------------------------------------------------ RPC stdout
let stdoutBuf = "";
// 必须用 StringDecoder：chunk 边界不与字符边界对齐，逐块 toString() 会把跨界的 3 字节汉字
// 解成 U+FFFD（仍是合法 JSON，静默污染正文 ✗）。2026-10-20 审计修复。
const stdoutDecoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += stdoutDecoder.write(chunk);
  let i;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    if (ev.type === "response") {
      const waiter = ev.id ? pendingRpc.get(ev.id) : undefined;
      if (waiter) {
        pendingRpc.delete(ev.id);
        waiter.res(ev);
      }
      continue;
    }

    if (ev.type === "extension_ui_request") {
      const method = ev.method;
      if (method === "setWidget") {
        if (ev.widgetLines === undefined) widgetSnapshot.delete(ev.widgetKey);
        else
          widgetSnapshot.set(ev.widgetKey, {
            widgetKey: ev.widgetKey,
            widgetLines: ev.widgetLines,
            widgetPlacement: ev.widgetPlacement,
          });
      } else if (method === "setStatus") {
        if (ev.statusText === undefined || ev.statusText === null) delete extStatusSnapshot[ev.statusKey];
        else extStatusSnapshot[ev.statusKey] = ev.statusText;
      }
      // 命令运行期间的 notify：标题改写为 `/<命令名>`（与 SDK 宿主 executeCommand 一致），
      // 前端据此把命令输出渲染成**模态**而不是行内状态行。
      if (method === "notify" && runningCommand) {
        broadcast({ ...ev, title: `/${runningCommand}` });
        continue;
      }
      // 形状与前端期望一致（我们的 UI context 当年就是照它建模的）：原样转发
      broadcast(ev);
      continue;
    }

    // 会话事件：原样转发给浏览器
    // 运行态必须在这里记账：晚连/刷新的客户端拿不到 agent_start，只能靠快照恢复指示器
    if (ev.type === "agent_start") agentActive = true;
    else if (ev.type === "agent_end" || ev.type === "agent_settled") agentActive = false;
    broadcast(ev);
    if (STATS_REFRESH_EVENTS.has(ev.type)) void sendStats();
  }
});

child.stderr.on("data", (c) => process.stderr.write(`[pi] ${c}`));

/** 是否处于主动关停（区分「用户 Ctrl+C 退出」与「子进程意外死亡」）。 */
let shuttingDown = false;
let childExited = false;

// 启动期 spawn 失败（例如 PATH 上没有 pi）：明确报错并退出，不要静默
child.on("error", (err) => {
  logErr(`[pi-web] 无法启动 pi 子进程：${err.message}`);
  logErr("[pi-web] 请确认 `pi` 在 PATH 上可执行（pi --version）");
  process.exit(1);
});

child.on("exit", (code, signal) => {
  childExited = true;
  // 子进程退出后，挂起的 RPC 永远不会有结果 —— 必须显式失败（否则"不超时"的 bash 调用会永远挂着）
  for (const [, pending] of pendingRpc) pending.rej(new Error("pi child exited"));
  pendingRpc.clear();
  // 运行态也要复位：agent_end/agent_settled 不会再来，否则 state 快照会一直报 agentActive:true，
  // 刷新后页脚永久显示 Working…（2026-10-20 审计修复）。
  agentActive = false;
  if (shuttingDown) {
    log(`[pi-web] pi 子进程已随服务端退出 (code=${code} signal=${signal})`);
    return;
  }
  logErr(`[pi-web] pi 子进程意外退出 (code=${code} signal=${signal})`);
  // 让页面看到原因（不直接断开 WS，否则前端会自动重连并刷新页面，反而看不到提示）
  broadcast({
    type: "error",
    error: `pi 子进程已退出（code=${code ?? "-"} signal=${signal ?? "-"}）。本页已不可用，请重启服务端。`,
  });
  notify("pi 子进程退出", `code=${code ?? "-"} signal=${signal ?? "-"}；请重启服务端（会话历史已保存在磁盘）`, "error");
});

/** 关停：先请子进程退出，超时再强杀；然后关闭 WS/HTTP，不遗留孤儿进程。 */
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[pi-web] 关停（${reason}）…`);
  if (!childExited) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (!childExited) {
      logErr("[pi-web] pi 子进程未在 1.5s 内退出，发送 SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  for (const ws of clients) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  try {
    wss.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// 兜底：进程无论如何退出都不留孤儿 pi
process.on("exit", () => {
  if (!childExited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
});

/**
 * 并发写保护（尽力而为，不阻断）：找出**另一个原生 web 实例**是否在用同一个会话。
 *
 * 检测手段与其边界（2026-10 实测）：
 *  · 每个原生实例都把 `PI_WEB_BRIDGE_SESSION=<会话文件>` 注入 pi 子进程的环境 → 扫
 *    `/proc/<pid>/environ` 即可**可靠**发现"同一会话的另一个原生 web 实例"。
 *  · **TUI 无法可靠检测**：pi 用 `process.title` 覆写 argv（`/proc/<pid>/cmdline` 只剩标题 +
 *    NUL 填充），会话文件写完即关（`/proc/<pid>/fd` 抓不到），Pi 自身也没有任何锁机制。
 *    为了不误报，这里不对 TUI 做猜测；仅在设计文档中记录该边界。
 */
async function detectSessionSharers() {
  const byRun = new Map(); // 对方 run id（或 pid）→ 该实例里最小的 PID
  const marker = `PI_WEB_BRIDGE_SESSION=${session.path}`;
  const ownRun = `PI_WEB_BRIDGE_RUN=${RUN_ID}`;
  try {
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      if (Number(entry) === child.pid) continue; // 我们自己的 pi 子进程
      let vars;
      try {
        vars = (await readFile(`/proc/${entry}/environ`)).toString().split("\0");
      } catch {
        continue;
      }
      if (!vars.includes(marker)) continue;
      // 自己这棵树（子进程 + 它派生的助手进程）都带自己的 RUN_ID → 排除，避免误报
      if (vars.includes(ownRun)) continue;
      const foreignRun = vars.find((v) => v.startsWith("PI_WEB_BRIDGE_RUN=")) ?? `pid:${entry}`;
      const pid = Number(entry);
      const prev = byRun.get(foreignRun);
      if (prev === undefined || pid < prev) byRun.set(foreignRun, pid);
    }
  } catch {
    /* 非 Linux 或 /proc 不可读：跳过这项尽力而为的检查 */
  }
  return [...byRun.values()].sort((a, b) => a - b).map((pid) => ({ pid }));
}

let sharersWarned = false;
async function checkSessionSharers() {
  if (shuttingDown || childExited) return;
  const found = await detectSessionSharers();
  if (found.length === 0) {
    sharersWarned = false;
    return;
  }
  if (sharersWarned) return; // 同一批只提示一次，避免刷屏
  sharersWarned = true;
  const pids = found.map((f) => f.pid).join(", ");
  logErr(`[pi-web] 警告：同一会话已被另一个原生 web 实例打开（PID ${pids}）——并发写入可能互相干扰`);
  notify(
    "会话并发写入风险",
    `同一会话正被另一个原生 web 实例打开（PID ${pids}）。两个宿主同时写入可能互相干扰，建议只保留一个。`,
    "warning",
  );
}

// ------------------------------------------------------------------ 浏览器命令
async function handleClientMessage(ws, msg) {
  // 取值必须在 try 内且可空：早先 `const type = msg.type` 在 try 外，收到一帧 `null`
  // 就抛 TypeError → async 函数变成 rejected promise → void 丢掉 → 进程退出（已复现 ✗）。
  let type = "(invalid)";
  try {
    type = msg && typeof msg === "object" ? String(msg.type ?? "(missing)") : "(invalid)";
    switch (type) {
      case "prompt":
        await rpc("prompt", { message: msg.message });
        break;
      case "abort":
        // 中止时撤销挂起的对话框（桥接的 handler 会拿到 cancelled）——否则网页模态残留
        dismissDialogs("aborted");
        await rpc("abort");
        break;
      case "abort_bash":
        await rpc("abort_bash");
        break;
      case "bash": {
        // 前端用自己生成的 `bash-<ts>` 关联流式块；RPC 的 bash 用**命令信封 id**
        // 作为执行 id（会出现在 bash_execution_update 事件里），所以这里把两者对齐，
        // 否则前端匹配不到流式块，会再新建一个。
        const id = typeof msg.id === "string" && msg.id ? msg.id : `bash-${Date.now()}`;
        // bash 可以跑任意久（!!npm run dev / 长构建…），**不设超时**：靠 bash_execution_update
        // 流式输出保持界面活性；用户可用中止按钮；子进程退出时由 child.on("exit") 统一失败挂起调用。
        const response = await rpc(
          "bash",
          { command: msg.command, excludeFromContext: msg.excludeFromContext },
          { id, timeoutMs: 0 },
        );
        broadcast({ type: "bash_result", id, command: msg.command, data: response?.data ?? {} });
        break;
      }
      case "get_state":
        await sendState(ws);
        break;
      case "panel_geometry": {
        // 前端量出的面板可用列/行数（见 app.js sendPanelGeometry）
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 20 && rows >= 5) {
          panelGeometry = { cols: Math.floor(cols), rows: Math.floor(rows) };
          const charW = Number(msg.charW);
          const boxW = Number(msg.boxW);
          let extra =
            Number.isFinite(charW) && Number.isFinite(Number(msg.contentW))
              ? `（= 内容区 ${msg.contentW}px ÷ 单字符 ${charW}px）`
              : "";
          // 框图字符明显更宽 = 字体缺制表符、回退到全角字体 —— 这会直接导致横框折行，必须点出来
          if (Number.isFinite(charW) && Number.isFinite(boxW) && boxW > charW * 1.15) {
            extra += `；⚠️ 框图字符 ${boxW}px 是数字的 ${(boxW / charW).toFixed(1)} 倍（字体缺制表符 U+2500 → 回退全角），面板已按框图宽度计算容量`;
          }
          log(`[pi-web] panel geometry ← ${panelGeometry.cols}×${panelGeometry.rows}${extra}`);
          const longest = Number(msg.longest);
          const fits = Number(msg.fits);
          if (Number.isFinite(longest) && Number.isFinite(fits) && longest > fits) {
            // 真实画布也容不下 → 真会折行（正常不应出现；出现即兜底层生效）
            log(
              `[pi-web] 面板内容过宽：最长行 ${longest} 列 > 画布 ${fits} 列` +
                `（已缩至 ${msg.shrunkTo}px${msg.overflow ? "，仍放不下 → 该面板横向滚动" : ""}）`,
            );
          } else if (Number.isFinite(longest) && longest > panelGeometry.cols) {
            // 组件比下发的列数多画了：画布容得下，不会折行，仅记录（便于对照组件行为）
            log(
              `[pi-web] 组件实际渲染 ${longest} 列 > 下发 ${panelGeometry.cols} 列` +
                `（画布可容 ${fits} 列，不折行）；下次按 ${panelGeometry.cols} 列渲染`,
            );
          }
        }
        break;
      }
      case "get_stats":
        // SDK 宿主也有这个命令（前端当前不发，保留同形接口）
        await sendStats();
        break;
      case "session":
        // TUI /session 等价物：只读信息模态（与 SDK 宿主 broadcastSessionInfo 同形同内容）
        await sendSessionInfo();
        break;
      case "compact":
        await rpc("compact", {}, { timeoutMs: RPC_LONG_TIMEOUT_MS });
        await sendState();
        break;
      case "set_model":
        await rpc("set_model", { provider: msg.provider, modelId: msg.modelId });
        await sendState();
        break;
      case "cycle_model":
        await rpc("cycle_model");
        await sendState();
        break;
      case "get_available_models": {
        const data = await rpcData("get_available_models");
        ws.send(JSON.stringify({ type: "models", data: data?.models ?? [] }));
        break;
      }
      case "set_thinking_level":
        await rpc("set_thinking_level", { level: msg.level });
        await sendState();
        break;
      case "cycle_thinking_level":
        await rpc("cycle_thinking_level");
        await sendState();
        break;
      case "get_available_thinking_levels": {
        const data = await rpcData("get_available_thinking_levels");
        ws.send(JSON.stringify({ type: "thinking_levels", data: data?.levels ?? [] }));
        break;
      }
      case "set_session_name":
        await rpc("set_session_name", { name: msg.name });
        await sendState();
        break;
      case "history_page": {
        // 按需加载更早的一页（§20）：只解析该页，不经过 Pi
        const file = session?.path;
        const index = file ? ensureHistoryIndex() : null;
        if (!file || !index) {
          ws.send(JSON.stringify({ type: "history_page", data: { entries: [], from: 0, hasMore: false } }));
          break;
        }
        const total = countEntries(index);
        const before = Math.max(0, Math.min(Number(msg.before ?? total) || total, total));
        const limit = Math.max(1, Math.min(Number(msg.limit ?? HISTORY_TAIL) || HISTORY_TAIL, 2000));
        const from = Math.max(0, before - limit);
        const entries = readPage(file, index, from, before);
        log(`[pi-web] history_page: ${entries.length} 条（${from}..${before}/${total}）`);
        ws.send(JSON.stringify({ type: "history_page", data: { entries, from, hasMore: from > 0 } }));
        break;
      }
      case "get_sessions": {
        await syncSessionFile(); // 保证"当前会话"是最新的，否则原会话会从列表里漏掉
        const sessions = [];
        for (const p of await listSessionFiles()) {
          if (p === session.path) continue;
          try {
            const text = await readFile(p, "utf8");
            const header = JSON.parse(text.split("\n")[0]);
            sessions.push({
              path: p,
              id: header.id ?? p,
              name: sessionDisplayName(text) ?? "(unnamed)",
              cwd: header.cwd ?? "",
              // 最后活动时间（TUI 用同一个口径排序：session-manager.ts:756 的 mtimeMs）
              mtime: statSync(p).mtimeMs,
            });
          } catch {
            /* ignore */
          }
        }
        // 与 TUI 对齐：最近活动的排在前面（TUI: sortSessionInfos → b.modified - a.modified）。
        // 原先不排序，顺序就是 readdir 的原始顺序，看起来是乱的（见设计文档 §22）。
        sessions.sort((a, b) => b.mtime - a.mtime);
        ws.send(JSON.stringify({ type: "sessions", data: sessions }));
        break;
      }
      case "resume":
        // 会话切换：旧会话上挂起的对话框必须撤销（与 SDK 宿主的 session-switch 一致）
        dismissDialogs("session-switch");
        await rpc("switch_session", { sessionPath: msg.path });
        await sendState();
        await sendHistory();
        break;
      case "command":
        // /usage 是 pi-web 原生功能（读 session 文件），优先级高于扩展命令——
        // 与 SDK 宿主的 executeCommand 一致
        if (msg.name === "usage") {
          await sendUsage(msg.scope === "all" ? "all" : "session", ws);
          break;
        }
        // 其余扩展命令经 prompt 触发（session.prompt 会先尝试扩展命令）。
        // 命令执行期间置 runningCommand：期间产生的 notify 会被改写成 `/<命令名>` 标题，
        // 前端就按「/ 开头」把它渲染成模态（与 SDK 宿主的行为一致）。
        runningCommand = msg.name;
        try {
          await rpc("prompt", { message: `/${msg.name}${msg.args ? " " + msg.args : ""}` });
        } finally {
          runningCommand = null;
        }
        break;
      case "reload":
        // RPC 没有 reload 命令：走桥接扩展注册的命令（ExtensionCommandContext.reload）
        runningCommand = "pi-web:reload";
        try {
          await rpc("prompt", { message: "/pi-web:reload" });
        } finally {
          runningCommand = null;
        }
        break;
      case "extension_ui_response": {
        // 命中桥接自建的对话框（用户作答，无需再通知前端关模态）；否则转发给 RPC 原生对话框
        if (!settleDialog(msg.id, msg, null)) {
          child.stdin.write(JSON.stringify(msg) + "\n");
        }
        break;
      }
      case "set_scoped_models": {
        // 语义与 TUI/SDK 对齐：**只有 persist=true 才写 settings.json**
        // （TUI 的 onChange 是仅内存生效，Ctrl+S/保存才持久化；前端每次勾选发 persist=false）
        const patterns = (msg.models ?? [])
          .filter((m) => m.provider && m.modelId)
          .map((m) => `${m.provider}/${m.modelId}`);
        if (msg.persist === true) {
          // 只有保存动作写 settings（与 TUI 的 Ctrl+S 对齐）；勾选仅内存生效
          const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
          if (patterns.length > 0) settings.enabledModels = patterns;
          else delete settings.enabledModels;
          writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
          log(`[pi-web] enabledModels → ${JSON.stringify(patterns)}（已写入 settings）`);
        }
        // 会话内即时应用（§15.11.1）：改的是 session 内部数组本身，勾选即生效、无需重启
        const applied = await applyScopedInSession(patterns);
        if (applied.ok) {
          bridgeInfo = { ...bridgeInfo, scopedModels: applied.scopedModels ?? [] };
          log(
            `[pi-web] scoped models 即时生效 → ${(applied.scopedModels ?? []).length} 个` +
              (applied.diagnostics?.length ? `（诊断：${applied.diagnostics.join(",")}）` : ""),
          );
          sendState();
          if (msg.persist === true) notify("scoped-models", `已保存 ${patterns.length} 个 scoped models，已即时生效`, "info");
          break;
        }
        // 兜底：即时应用不可用（Pi 改了内部实现 / 超时）→ 退回旧行为并明确告知
        const now = Date.now();
        if (now - lastScopedNoticeAt > 30_000) {
          lastScopedNoticeAt = now;
          notify(
            "scoped-models",
            `未能即时生效（${applied.error}）：${
              msg.persist === true ? "已写入 settings，需重启 pi 子进程后生效" : "保存后会写入 settings，需重启 pi 子进程生效"
            }`,
            "warning",
          );
        }
        break;
      }
      case "set_theme":
        // 浏览器主题：CSS 由前端立即切换；扩展 ANSI 的取色主题由桥接经 GET /side/theme
        // 轮询后热切换（见 bridge.mjs 的 pollTheme）
        themeName = msg.name === "light" ? "light" : "dark";
        ws.send(JSON.stringify({ type: "theme_set", data: { name: themeName } }));
        break;
      case "get_scoped_models": {
        // available = **完整模型目录**（不是当前已 scoped 的列表！）
        // TUI/SDK 用的是 modelRuntime.getAvailableSnapshot()；RPC 的等价物就是
        // get_available_models（实测两边同为 162 条、集合一致）。曾把 scoped 列表当
        // available 传过去，导致弹窗里只有已选中的 11 个、无法添加新模型。
        let available = [];
        try {
          const catalog = await rpcData("get_available_models");
          available = catalog?.models ?? [];
        } catch {
          /* ignore */
        }
        const configured = (() => {
          try {
            return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).enabledModels ?? [];
          } catch {
            return [];
          }
        })();
        ws.send(
          JSON.stringify({
            type: "scoped_models",
            data: {
              // 前端用 scoped 预勾选多选项（SDK 宿主也有这个字段）
              scoped: bridgeInfo.scopedModels ?? [],
              available,
              configured,
            },
          }),
        );
        break;
      }
      case "export": {
        const outputPath = typeof msg.path === "string" && msg.path ? msg.path : undefined;
        if (outputPath?.endsWith(".jsonl")) {
          // RPC 只有 export_html（SDK 宿主的 exportToJsonl 在原生引擎里没有对应命令）
          notify("/export", "jsonl 导出在原生引擎下暂不支持（RPC 仅提供 export_html）", "warning");
          break;
        }
        const data = await rpc("export_html", { outputPath }, { timeoutMs: RPC_LONG_TIMEOUT_MS }).then((r) => r?.data);
        notify("/export", `Session exported to: ${data?.path ?? "(unknown)"}`, "info");
        break;
      }
      case "usage": {
        await sendUsage(msg.scope === "all" ? "all" : "session", ws);
        break;
      }
      case "delete_session": {
        const target = typeof msg.path === "string" ? msg.path : "";
        if (!target) throw new Error("Missing 'path'");
        const known = (await listSessionFiles()).includes(target);
        if (!known) throw new Error("Not a known session file");
        if (target === session.path) throw new Error("Cannot delete the currently active session");
        unlinkSync(target);
        log(`[pi-web] deleted session file ${target}`);
        break;
      }
      default:
        log(`[pi-web] unknown client message: ${type}`);
    }
  } catch (err) {
    logErr(`[pi-web] ${type} failed: ${err.message}`);
    ws.send(JSON.stringify({ type: "error", error: `${type}: ${err.message}` }));
  }
}

/** 会话切换/中止时撤销挂起的对话框：resolve 为 cancelled 并让浏览器关掉模态。
 *  与 SDK 宿主的 dismissDialog(id, "session-switch" | "aborted") 对齐。 */
/** 挂起中的对话框/面板：id -> {resolve, extensionTimeout, timer, fallback} */
const pendingDialogs = new Map();

function clearDialogTimer(entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}

/** 无浏览器连接时的兜底计时器（有浏览器时不应该存在这个计时器）。 */
function armDialogFallback(id, entry) {
  entry.fallback = true;
  entry.timer = setTimeout(() => {
    log(`[pi-web] dialog ${id}: 无浏览器应答，${DIALOG_FALLBACK_TIMEOUT_MS}ms 后按默认值结算`);
    settleDialog(id, { cancelled: true }, "timeout");
  }, DIALOG_FALLBACK_TIMEOUT_MS);
}

/** 浏览器上下线：按 SDK 宿主语义调整所有挂起对话框的计时器。
 *  有浏览器 → 无限等待（撤销兜底）；无浏览器 → 给未自带 timeout 的对话框启兜底。 */
function onBrowserPresenceChanged() {
  const attached = clients.size > 0;
  for (const [id, entry] of pendingDialogs) {
    if (entry.extensionTimeout !== undefined) continue; // 扩展自己的 timeout，永远不动
    if (attached) {
      if (entry.fallback) {
        clearDialogTimer(entry);
        entry.fallback = false;
      }
    } else if (!entry.timer) {
      armDialogFallback(id, entry);
    }
  }
}

/** 打开一个对话框/面板：注册等待者、按 SDK 语义设置计时器、把请求帧发给浏览器。
 *  语义（对齐 SDK 宿主 ui-context.ts）：① 扩展给了 timeout 就原样遵守，并下发 deadline
 *  供前端显示倒计时；② 否则**有浏览器连接时无限等待**（绝不抢走用户的作答权）；
 *  ③ 只有没有浏览器（标签页关了）才启兜底超时；④ 重连即撤销兜底。 */
function openDialog(id, frame, extensionTimeout) {
  return new Promise((resolve) => {
    const entry = { resolve, frame, extensionTimeout, timer: undefined, fallback: false };
    pendingDialogs.set(id, entry);
    if (extensionTimeout !== undefined) {
      entry.timer = setTimeout(() => settleDialog(id, { cancelled: true }, "timeout"), extensionTimeout);
    } else if (clients.size === 0) {
      armDialogFallback(id, entry);
    }
    broadcast(frame);
  });
}

/** 结算并清理一个对话框；reason 非空时通知前端关闭模态。返回是否命中。 */
function settleDialog(id, response, reason) {
  const entry = pendingDialogs.get(id);
  if (!entry) return false;
  pendingDialogs.delete(id);
  clearDialogTimer(entry);
  try {
    entry.resolve(response);
  } catch {
    /* ignore */
  }
  if (reason) broadcast({ type: "dialog_dismissed", id, reason });
  return true;
}

/** 会话切换/中止时撤销所有挂起的对话框（与 SDK 宿主的 dismissDialog 对齐）。 */
function dismissDialogs(reason) {
  for (const id of [...pendingDialogs.keys()]) {
    settleDialog(id, { cancelled: true }, reason);
  }
}

// ------------------------------------------------------------------ HTTP / WS
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  // ---- 桥接扩展的侧信道（token 鉴权，仅本机）
  if (url.pathname.startsWith("/side/")) {
    if (req.headers["x-pi-web-token"] !== TOKEN) {
      res.writeHead(403).end("{}");
      return;
    }
    // 用 Buffer 拼接后整体解码（`body += chunk` 会在多字节字符跨界时产生 U+FFFD ✗）；
    // 坏 JSON 直接 400，早先当成 {} 继续执行路由会造出幽灵 widget/对话框。
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let data = {};
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad json" }));
        return;
      }
      const route = url.pathname.slice("/side/".length);
      const reply = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj ?? {}));
      };

      if (route === "theme") {
        // 桥接轮询用（GET）：返回浏览器当前主题，供扩展 ANSI 取色
        return reply({ name: themeName });
      }
      if (route === "geometry") {
        // 桥接 render 前取用：按面板实际宽度渲染扩展组件，避免折行
        return reply(panelGeometry);
      }
      if (route === "scoped-pending") {
        // 桥接取用待应用的 scoped 模式（一次性；无待办返回 204）
        const payload = pendingScopedPatterns ? { patterns: pendingScopedPatterns } : null;
        pendingScopedPatterns = null;
        if (!payload) {
          res.writeHead(204).end();
          return;
        }
        return reply(payload);
      }
      if (route === "scoped-applied") {
        // 桥接回报应用结果（成功/失败），唤醒等待中的 set_scoped_models
        const resolve = scopedApplyResolve;
        scopedApplyResolve = null;
        if (resolve) resolve(data ?? { ok: false, error: "empty result" });
        return reply({ ok: true });
      }
      if (route === "theme-ack") {
        log(`[pi-web] bridge set theme → ${data.name}`);
        return reply({ ok: true });
      }
      if (route === "ready") {
        bridgeInfo = { ...bridgeInfo, ...data };
        log(
          `[pi-web] bridge ready: mode=${data.mode} hasUI=${data.hasUI} cwd=${data.cwd} ` +
            `commands=${(data.commands ?? []).length} tools=${(data.tools ?? []).length} ` +
            `extensions=${(data.extensions ?? []).length} scoped=${(data.scopedModels ?? []).length}`,
        );
        void sendState();
        return reply({ ok: true });
      }
      if (route === "widget") {
        if (data.lines === undefined) widgetSnapshot.delete(data.key);
        else
          widgetSnapshot.set(data.key, {
            widgetKey: data.key,
            widgetLines: data.lines,
            widgetPlacement: data.placement,
          });
        broadcast({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: data.key,
          widgetLines: data.lines,
          widgetPlacement: data.placement,
        });
        return reply({ ok: true });
      }
      if (route === "panel") {
        // custom()：桥接把扩展 TUI 组件渲染出的文本行送来，浏览器以**只读**模态呈现；
        // 用户关闭后回传结论（组件自己 done(value) 过则采用该值）。
        const id =
          typeof data.token === "string" && data.token ? data.token : `panel-${randomUUID()}`;
        // 面板没有「扩展 timeout」概念 → 有浏览器就无限等待，无浏览器才兜底
        const answer = await openDialog(id, {
          type: "extension_ui_request",
          id,
          method: "panel",
          title: data.title,
          lines: data.lines ?? [],
          value: data.value,
        });
        const value = answer && "value" in answer && answer.value !== undefined ? answer.value : data.value;
        return reply(value === undefined ? {} : { value });
      }
      if (route === "dialog") {
        // 桥接可带 token（用于 opts.signal 中止时认领同一个对话框）
        const id = typeof data.token === "string" && data.token ? data.token : `bridge-${randomUUID()}`;
        const extensionTimeout =
          typeof data.timeout === "number" && data.timeout > 0 ? data.timeout : undefined;
        const { token: _token, timeout: _timeout, ...frame } = data;
        const answer = await openDialog(
          id,
          {
            type: "extension_ui_request",
            id,
            ...frame,
            // 只有扩展自己给了 timeout 才下发 deadline（前端据此才显示倒计时）
            ...(extensionTimeout !== undefined ? { deadline: Date.now() + extensionTimeout } : {}),
          },
          extensionTimeout,
        );
        return reply(answer);
      }
      if (route === "panel-update") {
        // 组件的 requestRender → 就地刷新已打开的面板（前端按 update 标记替换内容，不重开模态）
        const id = String(data.token ?? "");
        if (!pendingDialogs.has(id)) return reply({ ok: false });
        broadcast({
          type: "extension_ui_request",
          id,
          method: "panel",
          update: true,
          lines: data.lines ?? [],
        });
        return reply({ ok: true });
      }
      if (route === "cancel-dialog") {
        // 扩展的 AbortSignal 中止：按默认值结算并让前端关掉模态
        const ok = settleDialog(String(data.token ?? ""), { cancelled: true }, "aborted");
        return reply({ ok });
      }
      if (route === "event") {
        log(`[pi-web] bridge event: ${JSON.stringify(data)}`);
        // 忙时拒绝 reload：与 SDK 宿主的报错口径一致（前端 case 'error' → appendError）
        if (data.type === "reload-refused") {
          broadcast({ type: "error", error: "Wait for the current response to finish before reloading." });
        }
        return reply({ ok: true });
      }
      return reply({ ok: false, error: `unknown side route: ${route}` });
    });
    return;
  }

  // ---- 静态资源（仓库 static/，与发布版本同源）
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path === "/favicon.ico") path = "/pi-logo.svg"; // favicon 兼容（index.html 引用 svg）
  const file = join(STATIC_DIR, path);
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (ws) => {
  clients.add(ws);
  onBrowserPresenceChanged();
  // ws 在协议错误（如未 MASK 的帧）或发送到已关闭 socket 时会 emit('error')；
  // EventEmitter 无监听者即抛出 → 进程退出（已复现 ✗）。这里必须兜住。
  ws.on("error", (err) => {
    logErr(`[pi-web] ws error: ${err?.code ?? err?.message ?? err}`);
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  });
  ws.on("close", () => {
    clients.delete(ws);
    onBrowserPresenceChanged();
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handleClientMessage(ws, msg).catch((err) => {
      logErr(`[pi-web] handleClientMessage failed: ${err?.message ?? err}`);
    });
  });

  // 连接即快照重放：state → history → ext_status → widgets（与现有服务端同序）
  await sendState(ws);
  await sendHistory(ws);
  if (Object.keys(extStatusSnapshot).length > 0) {
    ws.send(JSON.stringify({ type: "ext_status", data: extStatusSnapshot }));
  }
  for (const widget of widgetSnapshot.values()) {
    ws.send(JSON.stringify({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", ...widget }));
  }

  // 未决对话框/面板必须随快照重放：否则刷新后模态消失、而浏览器一上线就撤销了兜底超时，
  // 扩展的 await ctx.ui.confirm/select/custom 永久挂住（2026-10-20 审计修复）。
  for (const [, dialog] of pendingDialogs) {
    if (dialog.frame) ws.send(JSON.stringify(dialog.frame));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`[pi-web] http://127.0.0.1:${PORT}/  (pi v${PI_VERSION} · native engine)`);
  // 并发写检查：启动后一次 + 每 5 分钟复查（尽力而为，不阻断）
  setTimeout(() => void checkSessionSharers(), 1500);
  setInterval(() => void checkSessionSharers(), 5 * 60 * 1000).unref?.();
});
