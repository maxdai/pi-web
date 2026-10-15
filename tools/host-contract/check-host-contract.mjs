#!/usr/bin/env node
/**
 * 宿主契约核对器（experiments/rpc-bridge）
 *
 * 用途：**Pi 版本更迭后**跑一次，看 pi-web 依赖的宿主约定有没有变。
 *
 *   node tools/host-contract/check-host-contract.mjs            # 与基线对比
 *   node tools/host-contract/check-host-contract.mjs --update   # 记录/更新基线
 *   node tools/host-contract/check-host-contract.mjs --json      # 只输出当前快照
 *
 * 依赖清单与每项失效后果见 pi-web-design.md §16。判定：
 *   PASS  与基线一致
 *   DRIFT 与基线不同（需人工判断是否影响我们）
 *   FAIL  关键项缺失/行为异常（例如改写不可见）
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "host-contract.baseline.json");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const JSON_ONLY = args.includes("--json");

// ---------------------------------------------------------------- 进程内探针
function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--extension",
        join(HERE, "host-contract-probe.mjs"),
        "--extension",
        join(HERE, "host-contract-probe-b.mjs"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let err = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      fn(value);
    };
    child.stderr.on("data", (c) => {
      err += c.toString();
      const line = err.split("\n").find((l) => l.startsWith("HOST-CONTRACT-REPORT "));
      if (line) {
        try {
          finish(resolve, JSON.parse(line.slice("HOST-CONTRACT-REPORT ".length)));
        } catch (e) {
          finish(reject, new Error(`probe report not JSON: ${e.message}`));
        }
      }
    });
    // pi 启动到 session_start 需要 1–2s，**不要提前关闭 stdin**（否则会触发关停）
    const timer = setTimeout(() => {
      finish(reject, new Error(`probe timeout (25s).\nstderr:\n${err.slice(0, 800)}`));
    }, 25000);
    child.on("exit", () => {
      if (!settled) finish(reject, new Error(`probe produced no report.\nstderr:\n${err.slice(0, 800)}`));
    });
  });
}

// ------------------------------------------------- 宿主侧（不经 pi 进程）检查
function piVersion() {
  try {
    return spawnSyncVersion();
  } catch {
    return "unknown";
  }
}
function spawnSyncVersion() {
  const { execFileSync } = require("node:child_process");
  return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** 会话文件格式（我们直接解析 jsonl：header.cwd + session_info.name） */
function sessionFileContract() {
  const out = { files: 0, headerKeys: [], sessionInfoKeys: [], namedCount: 0, unnamedCount: 0, error: null };
  try {
    for (const dir of readdirSync(SESSIONS_DIR)) {
      const full = join(SESSIONS_DIR, dir);
      let files = [];
      try {
        files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        out.files += 1;
        let text;
        try {
          text = readFileSync(join(full, f), "utf8");
        } catch {
          continue;
        }
        const firstLine = text.split("\n")[0];
        try {
          const header = JSON.parse(firstLine);
          if (out.headerKeys.length === 0) out.headerKeys = Object.keys(header).sort();
          if (typeof header.cwd !== "string") out.error = "session header has no string cwd";
        } catch {
          out.error = "session header is not JSON";
        }
        const m = text.match(/\{"type":"session_info"[^\n]*\}/);
        if (m) {
          out.namedCount += 1;
          if (out.sessionInfoKeys.length === 0) {
            try {
              out.sessionInfoKeys = Object.keys(JSON.parse(m[0])).sort();
            } catch {
              /* ignore */
            }
          }
        } else {
          out.unnamedCount += 1;
        }
      }
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** settings.json 里 scoped models 的键（我们读写它） */
function settingsContract() {
  const file = join(AGENT_DIR, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    return {
      exists: true,
      hasEnabledModels: "enabledModels" in settings,
      enabledModelsType: Array.isArray(settings.enabledModels) ? "array" : typeof settings.enabledModels,
      keyCount: Object.keys(settings).length,
    };
  } catch (err) {
    return { exists: existsSync(file), error: err.message };
  }
}

/** RPC 协议抽查：bash 事件与响应（我们靠它合成 bash_result） */
function rpcContract() {
  return new Promise((resolve) => {
    const child = spawn("pi", ["--mode", "rpc", "--no-session"], { stdio: ["pipe", "pipe", "pipe"] });
    const seen = { bashExecutionUpdate: 0, response: null, bashResultEvent: 0, errorFrames: 0 };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "bash_execution_update") seen.bashExecutionUpdate += 1;
        if (ev.type === "bash_result") seen.bashResultEvent += 1;
        if (ev.type === "response" && ev.command === "bash") seen.response = { success: ev.success, hasData: ev.data !== undefined };
        if (ev.type === "response" && ev.success === false) seen.errorFrames += 1;
      }
    });
    child.stdin.write(JSON.stringify({ id: "hc-bash", type: "bash", command: "echo host-contract" }) + "\n");
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(seen);
    }, 5000);
  });
}

// ---------------------------------------------------------------------- 主流程
const probe = await runProbe();
const snapshot = {
  checkedAt: new Date().toISOString(),
  piVersion: piVersion(),
  node: process.version,
  probe,
  host: {
    sessionFiles: sessionFileContract(),
    settings: settingsContract(),
    rpc: await rpcContract(),
  },
};

if (JSON_ONLY) {
  console.log(JSON.stringify(snapshot, null, 1));
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;

/** 关键项（缺失即 FAIL，而不是 DRIFT） */
const CRITICAL = [
  ["probe.uiIsObject", (s) => s.probe.uiIsObject === true],
  ["probe.setTitlePatchable", (s) => s.probe.setTitlePatchable === true],
  ["probe.crossExtensionUiVisible", (s) => s.probe.crossExtensionUiVisible === true],
  ["probe.themeDescriptor.configurable", (s) => s.probe.themeDescriptor?.configurable === true],
  ["probe.mode === 'rpc'", (s) => s.probe.mode === "rpc"],
  ["probe.hasUI === true", (s) => s.probe.hasUI === true],
  ["probe.pkgFiles.distIndex", (s) => s.probe.pkgFiles?.distIndex === true],
  ["probe.pkgFiles.themeDark", (s) => s.probe.pkgFiles?.themeDark === true],
  ["probe.pkgFiles.themeLight", (s) => s.probe.pkgFiles?.themeLight === true],
  ["probe.themeExport === 'function'", (s) => s.probe.themeExport === "function"],
  ["probe.registerCommand === 'ok'", (s) => s.probe.registerCommand === "ok"],
  ["host.rpc.response.success", (s) => s.host.rpc.response?.success === true],
  ["host.rpc.bashExecutionUpdate > 0", (s) => s.host.rpc.bashExecutionUpdate > 0],
  ["host.sessionFiles.headerKeys 含 cwd", (s) => (s.host.sessionFiles.headerKeys ?? []).includes("cwd")],
];

console.log(`pi-web 宿主契约核对 —— pi ${snapshot.piVersion} / node ${snapshot.node}`);
console.log(baseline ? `基线：${baseline.piVersion}（${baseline.checkedAt}）\n` : "基线：尚无（用 --update 记录）\n");

let failures = 0;
for (const [name, check] of CRITICAL) {
  const ok = check(snapshot);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  关键项 ${name}`);
}

if (baseline) {
  const diffs = [];
  const walk = (a, b, path = "") => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    diffs.push({ path, before: a, after: b });
  };
  // 只看结构性字段（时间戳/版本单独展示）
  for (const key of ["probe", "host"]) walk(baseline[key], snapshot[key], key);
  diffs.filter((d) => !d.path.endsWith("checkedAt"));

  const uiMethodsBefore = baseline.probe?.uiMethods ?? [];
  const uiMethodsAfter = snapshot.probe?.uiMethods ?? [];
  const added = uiMethodsAfter.filter((m) => !uiMethodsBefore.includes(m));
  const removed = uiMethodsBefore.filter((m) => !uiMethodsAfter.includes(m));

  console.log(`\nUI 方法：${uiMethodsAfter.length} 个${added.length ? `（新增 ${added.join(", ")}）` : ""}${removed.length ? `（**移除 ${removed.join(", ")}**）` : ""}`);
  if (baseline.piVersion !== snapshot.piVersion) console.log(`Pi 版本变化：${baseline.piVersion} → ${snapshot.piVersion}`);

  // 环境相关量：取决于**用户自己的配置**（装了哪些 prompt/扩展、勾选了哪些 scoped models），
  // 不属于宿主契约 → 只展示、不参与漂移判定。
  // 教训（2026-10-14）：① 用户删/增 `~/.pi/agent/prompts/*.md` 让 commandCount 26↔23；
  // ② 用户在页面上多勾一个模型让 scopedModelsCount 11→12 —— 两次都被误判为 DRIFT。
  const ENV_DEPENDENT = ["probe.commandCount", "probe.scopedModelsCount"];
  for (const path of ENV_DEPENDENT) {
    const get = (o) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
    const before = get(baseline);
    const after = get(snapshot);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      console.log(
        `ℹ️ ${path}：${JSON.stringify(before)} → ${JSON.stringify(after)}` +
          `（环境相关：用户 prompt/扩展数量，不参与漂移判定）`,
      );
    }
  }
  const meaningful = diffs.filter(
    (d) =>
      !d.path.endsWith("checkedAt") &&
      !d.path.endsWith("piVersion") &&
      !d.path.endsWith("node") &&
      !ENV_DEPENDENT.includes(d.path),
  );
  if (meaningful.length === 0) {
    console.log("\n✅ 与基线无结构性差异（宿主契约未变）");
  } else {
    console.log(`\n⚠️ 与基线有 ${meaningful.length} 处差异（需人工判断是否影响我们）：`);
    for (const d of meaningful.slice(0, 40)) {
      const short = (v) => {
        const s = JSON.stringify(v);
        return s && s.length > 120 ? `${s.slice(0, 117)}...` : s;
      };
      console.log(`  - ${d.path}\n      基线: ${short(d.before)}\n      当前: ${short(d.after)}`);
    }
    if (meaningful.length > 40) console.log(`  ... 其余 ${meaningful.length - 40} 处省略`);
  }
}

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 1) + "\n");
  console.log(`\n基线已写入 ${BASELINE}`);
}

console.log(`\n${failures === 0 ? "✅ 关键项全部满足" : `❌ ${failures} 个关键项不满足`}`);
process.exit(failures === 0 ? 0 : 1);
