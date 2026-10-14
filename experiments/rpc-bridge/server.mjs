#!/usr/bin/env node
/**
 * pi-web RPC + bridge 原型服务端（experiments/rpc-bridge）
 *
 * 目标：**不改动前端**地复现 pi-web 的能力——复用仓库 `static/`，沿用同一套 WS 协议，
 * 但引擎换成「spawn 已安装的原生 pi --mode rpc」+ 注入桥接扩展（见 bridge.mjs）。
 *
 * 用法：
 *   node experiments/rpc-bridge/server.mjs --session install [--port 4096]
 *   node experiments/rpc-bridge/server.mjs --session-file /path/to/session.jsonl
 *
 * 然后（另一个终端）：
 *   node tools/smoke.mjs http://127.0.0.1:4096
 *
 * 设计依据：pi-web-design.md §15。本文件是原型，不是发布路径。
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ws 来自 pi-sdk-web 的依赖树（原型不自带依赖）
const require = createRequire("/root/pi-web/pi-sdk-web/package.json");
const { WebSocketServer } = require("ws");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const STATIC_DIR = join(REPO, "static");
const BRIDGE_EXT = join(HERE, "bridge.mjs");
const SESSIONS_ROOT = join(process.env.HOME, ".pi", "agent", "sessions");
const SETTINGS_FILE = join(process.env.HOME, ".pi", "agent", "settings.json");
const TOKEN = randomUUID();
const PI_WEB_VERSION = "0.0.0-rpc-proto";

// ------------------------------------------------------------------ 参数解析
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "4096"));
const SESSION_NAME = arg("session", undefined);
const SESSION_FILE = arg("session-file", undefined);
if (!SESSION_NAME && !SESSION_FILE) {
  console.error("usage: node server.mjs --session <name> [--port 4096] | --session-file <path>");
  process.exit(2);
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

async function resolveSession() {
  if (SESSION_FILE) {
    const text = await readFile(SESSION_FILE, "utf8");
    const header = JSON.parse(text.split("\n")[0]);
    return { path: resolve(SESSION_FILE), cwd: header.cwd ?? process.cwd(), name: header.name };
  }
  const hits = [];
  for (const p of await listSessionFiles()) {
    let text;
    try {
      text = await readFile(p, "utf8");
    } catch {
      continue;
    }
    const nameMatch = text.match(/"type":"session_info"[^}]*"name":"([^"]+)"/);
    if (nameMatch?.[1] !== SESSION_NAME) continue;
    const header = JSON.parse(text.split("\n")[0]);
    const st = await stat(p);
    hits.push({ path: p, cwd: header.cwd ?? process.cwd(), name: SESSION_NAME, mtime: st.mtimeMs });
  }
  if (hits.length === 0) {
    console.error(`No session named '${SESSION_NAME}' under ${SESSIONS_ROOT}`);
    process.exit(1);
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0];
}

const session = await resolveSession();
console.log(`[proto] session: ${session.name ?? "(unnamed)"} → ${session.path}`);
console.log(`[proto] cwd: ${session.cwd}`);

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
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

const pendingRpc = new Map();
let rpcSeq = 0;

function rpc(type, extra = {}, opts = {}) {
  const id = opts.id ?? `c${++rpcSeq}`;
  const payload = JSON.stringify({ id, type, ...extra }) + "\n";
  return new Promise((res, rej) => {
    pendingRpc.set(id, { res, rej });
    setTimeout(() => {
      if (pendingRpc.delete(id)) rej(new Error(`rpc timeout: ${type}`));
    }, 30000);
    child.stdin.write(payload);
  });
}

async function rpcData(type, extra) {
  const response = await rpc(type, extra);
  if (response && response.success === false) throw new Error(response.error ?? `${type} failed`);
  return response?.data;
}

// ------------------------------------------------------------------ WS 广播
const clients = new Set();
const bridgeDialogs = new Map(); // id -> resolve（桥接发起的对话框）
const widgetSnapshot = new Map(); // key -> {widgetKey, widgetLines, widgetPlacement}
let extStatusSnapshot = {};

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(text);
  }
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

async function buildState() {
  let st = {};
  try {
    st = (await rpcData("get_state")) ?? {};
  } catch (err) {
    console.error("[proto] get_state failed:", err.message);
  }
  const cwd = bridgeInfo.cwd ?? session.cwd;
  const state = {
    sessionId: st.sessionId,
    sessionName: st.sessionName ?? session.name,
    model: st.model ? { provider: st.model.provider, id: st.model.id, name: st.model.name } : undefined,
    thinkingLevel: st.thinkingLevel,
    autoCompactionEnabled: st.autoCompactionEnabled,
    messageCount: st.messageCount,
    version: PI_VERSION,
    piWebVersion: PI_WEB_VERSION,
    cwd: displayCwd(cwd),
    gitBranch: gitBranch(cwd),
    commands: bridgeInfo.commands ?? [],
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

async function sendState(target) {
  const state = await buildState();
  const frame = { type: "state", data: state };
  if (target) target.send(JSON.stringify(frame));
  else broadcast(frame);
}

async function sendHistory(target) {
  try {
    const data = await rpcData("get_entries");
    const frame = { type: "history", data: { entries: data?.entries ?? [], leafId: data?.leafId ?? null } };
    if (target) target.send(JSON.stringify(frame));
    else broadcast(frame);
  } catch (err) {
    console.error("[proto] get_entries failed:", err.message);
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

// ------------------------------------------------------------------ RPC stdout
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
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
      // 形状与前端期望一致（我们的 UI context 当年就是照它建模的）：原样转发
      broadcast(ev);
      continue;
    }

    // 会话事件：原样转发给浏览器
    broadcast(ev);
    if (STATS_REFRESH_EVENTS.has(ev.type)) void sendStats();
  }
});

child.stderr.on("data", (c) => process.stderr.write(`[pi] ${c}`));
child.on("exit", (code, signal) => {
  console.error(`[proto] pi exited (code=${code} signal=${signal})`);
  for (const ws of clients) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
});

// ------------------------------------------------------------------ 浏览器命令
async function handleClientMessage(ws, msg) {
  const type = msg.type;
  try {
    switch (type) {
      case "prompt":
        await rpc("prompt", { message: msg.message });
        break;
      case "abort":
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
        const response = await rpc(
          "bash",
          { command: msg.command, excludeFromContext: msg.excludeFromContext },
          { id },
        );
        broadcast({ type: "bash_result", id, command: msg.command, data: response?.data ?? {} });
        break;
      }
      case "get_state":
      case "session":
        await sendState(ws);
        break;
      case "compact":
        await rpc("compact");
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
      case "get_sessions": {
        const sessions = [];
        for (const p of await listSessionFiles()) {
          if (p === session.path) continue;
          try {
            const text = await readFile(p, "utf8");
            const nameMatch = text.match(/"type":"session_info"[^}]*"name":"([^"]+)"/);
            const header = JSON.parse(text.split("\n")[0]);
            sessions.push({
              path: p,
              id: header.id ?? p,
              name: nameMatch?.[1] ?? "(unnamed)",
              cwd: header.cwd ?? "",
            });
          } catch {
            /* ignore */
          }
        }
        ws.send(JSON.stringify({ type: "sessions", data: sessions }));
        break;
      }
      case "resume":
        await rpc("switch_session", { sessionPath: msg.path });
        await sendState();
        await sendHistory();
        break;
      case "command":
        // 扩展命令经 prompt 触发（session.prompt 会先尝试扩展命令）
        await rpc("prompt", { message: `/${msg.name}${msg.args ? " " + msg.args : ""}` });
        break;
      case "reload":
        // RPC 没有 reload 命令：走桥接扩展注册的命令（ExtensionCommandContext.reload）
        await rpc("prompt", { message: "/pi-web:reload" });
        break;
      case "extension_ui_response": {
        const waiter = bridgeDialogs.get(msg.id);
        if (waiter) {
          bridgeDialogs.delete(msg.id);
          waiter(msg);
        } else {
          child.stdin.write(JSON.stringify(msg) + "\n"); // RPC 原生对话框
        }
        break;
      }
      case "set_scoped_models": {
        // 原型：写 settings.json 的 enabledModels（启动时读取，需重启 pi 子进程生效）
        const patterns = (msg.models ?? [])
          .filter((m) => m.provider && m.modelId)
          .map((m) => `${m.provider}/${m.modelId}`);
        const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
        if (patterns.length > 0) settings.enabledModels = patterns;
        else delete settings.enabledModels;
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        console.log(`[proto] enabledModels → ${JSON.stringify(patterns)}（重启本原型后生效）`);
        break;
      }
      case "set_theme":
        // 前端 CSS 立即切换；扩展 ANSI 换肤属后续工作（见 README 已知缺口）
        ws.send(JSON.stringify({ type: "theme_set", data: { name: msg.name } }));
        break;
      case "get_scoped_models": {
        const available = bridgeInfo.scopedModels ?? [];
        const configured = (() => {
          try {
            return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).enabledModels ?? [];
          } catch {
            return [];
          }
        })();
        ws.send(JSON.stringify({ type: "scoped_models", data: { available, configured } }));
        break;
      }
      case "export":
      case "usage":
      case "delete_session":
        console.log(`[proto] command '${type}' not implemented in prototype yet`);
        break;
      default:
        console.log(`[proto] unknown client message: ${type}`);
    }
  } catch (err) {
    console.error(`[proto] ${type} failed: ${err.message}`);
    ws.send(JSON.stringify({ type: "error", error: `${type}: ${err.message}` }));
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
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        /* ignore */
      }
      const route = url.pathname.slice("/side/".length);
      const reply = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj ?? {}));
      };

      if (route === "ready") {
        bridgeInfo = { ...bridgeInfo, ...data };
        console.log(
          `[proto] bridge ready: mode=${data.mode} hasUI=${data.hasUI} cwd=${data.cwd} ` +
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
        // 前端尚无面板模态：记录后返回 undefined（与现状 SDK 宿主行为一致）
        console.log(`[proto] panel requested: ${data.title ?? "(no title)"} lines=${(data.lines ?? []).length}`);
        return reply({ value: undefined });
      }
      if (route === "dialog") {
        const id = `bridge-${randomUUID()}`;
        const answer = await new Promise((resolveAnswer) => {
          const timer = setTimeout(() => {
            bridgeDialogs.delete(id);
            resolveAnswer({ cancelled: true });
          }, 10 * 60 * 1000);
          bridgeDialogs.set(id, (response) => {
            clearTimeout(timer);
            resolveAnswer(response);
          });
          broadcast({ type: "extension_ui_request", id, ...data });
        });
        return reply(answer);
      }
      if (route === "theme") {
        console.log(`[proto] bridge theme → ${data.name}`);
        return reply({ success: true });
      }
      if (route === "event") {
        console.log(`[proto] bridge event: ${JSON.stringify(data)}`);
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
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handleClientMessage(ws, msg);
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
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[proto] http://127.0.0.1:${PORT}/  (pi v${PI_VERSION} · bridge prototype)`);
});
