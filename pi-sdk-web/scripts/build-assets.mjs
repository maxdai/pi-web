#!/usr/bin/env node
/**
 * 装配 dist/ —— 阶段 E 起**没有 TypeScript 构建**，全部是拷贝：
 *
 *   dist/static/*        ← ../static（浏览器前端）
 *   dist/native/*.mjs    ← ../native（引擎 server/bridge、usage-render、薄壳 cli、pii 包装器）
 *   dist/native/pii      ← ../pii/pii（Python 启动器，与包装器同目录）
 *
 * 先清空 dist，避免残留上一代的 SDK 产物（cli.js/server.js/pi-bin/…）。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = (...p) => resolve(HERE, "..", ...p); // <pkg>/…（输出：dist）
const repo = (...p) => resolve(HERE, "..", "..", ...p); // <repo>/…（输入：static / native / pii）

// 0) 清空 dist
rmSync(pkg("dist"), { recursive: true, force: true });
mkdirSync(pkg("dist", "native"), { recursive: true });

// 1) 前端
cpSync(repo("static"), pkg("dist", "static"), { recursive: true });

// 2) 原生引擎（含薄壳与 pii 包装器），bin 需要执行位
for (const file of readdirSync(repo("native"))) {
  if (!file.endsWith(".mjs")) continue;
  cpSync(repo("native", file), pkg("dist", "native", file));
  chmodSync(pkg("dist", "native", file), 0o755);
}

// 3) Python 启动器：与 pii 包装器同目录（包装器按自身目录找它）
cpSync(repo("pii", "pii"), pkg("dist", "native", "pii"));
chmodSync(pkg("dist", "native", "pii"), 0o755);

// 4) 自检：缺件即失败
const required = [
  "static/index.html",
  "static/app.js",
  "native/server.mjs",
  "native/bridge.mjs",
  "native/usage-render.mjs",
  "native/cli.mjs",
  "native/pii-cli.mjs",
  "native/pii",
];
const missing = required.filter((rel) => !existsSync(pkg("dist", rel)));
if (missing.length > 0) {
  console.error(`dist 装配失败，缺少：${missing.join(", ")}`);
  process.exit(1);
}
console.log("dist 装配完成");
