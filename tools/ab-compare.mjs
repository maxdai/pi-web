#!/usr/bin/env node
/**
 * 两引擎 A/B 对比（阶段 E 前置项，见 pi-web-design.md §15.13 步骤 1）
 *
 * 对两个**已运行**的实例发同一组只读查询，收集可比对的快照并输出差异。
 * 典型用法（同一会话）：
 *   node tools/ab-compare.mjs http://127.0.0.1:4096 http://127.0.0.1:4097 --out tools/ab-report.md
 *
 * 也可分步（**推荐**，避免两个 pi 同时写同一会话文件）：
 *   node tools/ab-compare.mjs --snapshot http://127.0.0.1:4096 --json /tmp/a.json
 *   node tools/ab-compare.mjs --diff /tmp/a.json /tmp/b.json --out tools/ab-report.md
 *
 * 说明：SDK 宿主与原生引擎在「/ctx-status、/aft-status」这类扩展面板上**按设计不同**
 * （原生引擎的桥接扩展能渲染面板；SDK 宿主对这些命令强制 hasUI:false 走文本 fallback），
 * 报告中会把这类差异标为 by-design，其余差异需人工判断。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { WebSocket } = (() => {
  const candidates = [import.meta.url, pathToFileURL(join(HERE, "..", "pi-sdk-web", "package.json")).href];
  for (const base of candidates) {
    try { return createRequire(base)("ws"); } catch { /* next */ }
  }
  throw new Error("cannot resolve dependency 'ws'");
})();

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const outFile = flag("--out");
const jsonOut = flag("--json");
const snapUrl = flag("--snapshot");
const diffIdx = argv.indexOf("--diff");

const SEQUENCE = [
  { type: "get_state" },
  { type: "get_scoped_models" },
  { type: "get_available_models" },
  { type: "get_stats" },
  { type: "get_sessions" },
  { type: "usage", scope: "all" },
  { type: "command", name: "ctx-status", args: "" },
];

/** 连到一个实例，跑固定序列，收集所有帧 → 归一化快照 */
async function snapshot(base) {
  const ws = new WebSocket(`${base.replace(/\/$/, "")}/ws`);
  const frames = [];
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 8000);
  });
  ws.on("message", (raw) => {
    try { frames.push(JSON.parse(raw)); } catch { /* ignore */ }
  });
  for (const msg of SEQUENCE) {
    ws.send(JSON.stringify(msg));
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 1500)); // 等面板/通知回来
  ws.close();

  const byType = (t) => frames.filter((f) => f.type === t);
  const state = byType("state").at(-1)?.data ?? {};
  const stats = byType("stats").at(-1)?.data ?? {};
  const scoped = byType("scoped_models").at(-1)?.data ?? {};
  const available = byType("available_models").at(-1)?.data ?? {};
  const usage = byType("usage_data").at(-1)?.data ?? {};
  const sessions = byType("sessions").at(-1)?.data ?? [];
  const uiReqs = byType("extension_ui_request");
  const ctxStatus =
    uiReqs.find((f) => /ctx-status/i.test(f.title ?? "") || /Magic Context/i.test(f.message ?? "")) ?? uiReqs[0];
  return {
    url: base,
    piWebVersion: state.piWebVersion,
    piVersion: state.version,
    model: state.model?.name ?? state.model,
    thinking: state.thinkingLevel,
    commandCount: (state.commands ?? []).length,
    commandNames: (state.commands ?? []).map((c) => c.name).sort(),
    toolCount: (state.tools ?? []).length,
    toolNames: (state.tools ?? []).map((t) => t.name).sort(),
    extensions: (state.extensions ?? []).map((e) => e.name ?? e).sort(),
    capabilities: { panelGeometry: state.panelGeometry === true },
    scopedCount: (scoped.scoped ?? []).length,
    availableInScopedMsg: (scoped.available ?? []).length,
    availableModelCount: (available.models ?? available.available ?? []).length,
    statsKeys: Object.keys(stats).sort(),
    usageKeys: Object.keys(usage).sort(),
    sessionCount: Array.isArray(sessions) ? sessions.length : Object.keys(sessions).length,
    frameTypes: [...new Set(frames.map((f) => f.type))].sort(),
    ctxStatusEffect: ctxStatus
      ? `${ctxStatus.method}${ctxStatus.method === "panel" ? `(${(ctxStatus.lines ?? []).length} 行)` : `(title=${ctxStatus.title ?? ctxStatus.message ?? "-"})`}`
      : "无 UI 输出",
  };
}

function render(a, b, outFile) {
const rows = [
  ["piWebVersion", a.piWebVersion, b.piWebVersion],
  ["pi 版本", a.piVersion, b.piVersion],
  ["模型", a.model, b.model],
  ["thinking", a.thinking, b.thinking],
  ["命令数", a.commandCount, b.commandCount],
  ["工具数", a.toolCount, b.toolCount],
  ["仅 A 有的工具", a.toolNames.filter((n) => !b.toolNames.includes(n)).join(",") || "（无）", b.toolNames.filter((n) => !a.toolNames.includes(n)).join(",") || "（无）"],
  ["扩展", a.extensions.join(","), b.extensions.join(",")],
  ["panelGeometry 能力位", a.capabilities.panelGeometry, b.capabilities.panelGeometry],
  ["scoped 模型数", a.scopedCount, b.scopedCount],
  ["可选模型数", a.availableModelCount, b.availableModelCount],
  ["stats 字段", a.statsKeys.join(","), b.statsKeys.join(",")],
  ["usage 顶层字段", a.usageKeys.join(","), b.usageKeys.join(",")],
  ["会话数", a.sessionCount, b.sessionCount],
  ["/ctx-status 表现", a.ctxStatusEffect, b.ctxStatusEffect],
  ["收到的帧类型", a.frameTypes.join(","), b.frameTypes.join(",")],
];
const diffs = rows.filter(([, x, y]) => String(x) !== String(y));
const cmdDiff = JSON.stringify(a.commandNames) !== JSON.stringify(b.commandNames);

const md = [];
md.push(`# 两引擎 A/B 记录（${new Date().toISOString().slice(0, 10)}）`);
md.push("");
md.push(`- A = \`${a.url}\`（SDK 宿主）`);
md.push(`- B = \`${b.url}\`（原生引擎）`);
md.push(`- 同一会话、同一组只读查询；由 \`tools/ab-compare.mjs\` 生成`);
md.push("");
md.push("| 项 | A（SDK） | B（native） | 一致 |");
md.push("|---|---|---|---|");
for (const [k, x, y] of rows) md.push(`| ${k} | ${x} | ${y} | ${String(x) === String(y) ? "✅" : "❌"} |`);
md.push("");
md.push(`命令名单差异：${cmdDiff ? "**有**（逐项见下）" : "无"}`);
if (cmdDiff) {
  const onlyA = a.commandNames.filter((n) => !b.commandNames.includes(n));
  const onlyB = b.commandNames.filter((n) => !a.commandNames.includes(n));
  md.push("");
  md.push(`- 仅 A 有：${onlyA.join(", ") || "（无）"}`);
  md.push(`- 仅 B 有：${onlyB.join(", ") || "（无）"}`);
}
md.push("");
md.push("## 差异分类");
md.push("");
md.push("- **by-design**：`/ctx-status`、`/aft-status` 等扩展面板——原生引擎的桥接扩展会渲染面板，SDK 宿主对这些命令强制 `hasUI:false` 走文本 fallback（见 §15.11）。");
md.push("- **需人工判断**：其余差异；若属回归则应先修复再进入阶段 E。");
md.push("");
md.push(`差异项数：${diffs.length} / ${rows.length}`);
const report = md.join("\n");
console.log(report);
if (outFile) { writeFileSync(outFile, report + "\n"); console.log(`\n已写入 ${outFile}`); }
}

// ---- 模式分派
if (snapUrl) {
  const snap = await snapshot(snapUrl);
  const target = jsonOut ?? `/tmp/ab-snapshot-${Date.now()}.json`;
  writeFileSync(target, JSON.stringify(snap, null, 2));
  console.log(`快照已写入 ${target}`);
  console.log(`  piWebVersion=${snap.piWebVersion} 命令=${snap.commandCount} 工具=${snap.toolCount} scoped=${snap.scopedCount} ctx-status=${snap.ctxStatusEffect}`);
} else if (diffIdx >= 0) {
  const [fa, fb] = [argv[diffIdx + 1], argv[diffIdx + 2]];
  if (!fa || !fb) { console.error("usage: --diff <a.json> <b.json> [--out report.md]"); process.exit(2); }
  const { readFileSync } = await import("node:fs");
  render(JSON.parse(readFileSync(fa, "utf8")), JSON.parse(readFileSync(fb, "utf8")), outFile);
} else {
  const urls = argv.filter((a) => a.startsWith("http"));
  if (urls.length !== 2) {
    console.error("usage: node tools/ab-compare.mjs <urlA> <urlB> [--out report.md]");
    console.error("       node tools/ab-compare.mjs --snapshot <url> [--json file]");
    console.error("       node tools/ab-compare.mjs --diff <a.json> <b.json> [--out report.md]");
    process.exit(2);
  }
  render(await snapshot(urls[0]), await snapshot(urls[1]), outFile);
}
