#!/usr/bin/env node
/**
 * 部署就绪核对（AGENTS.md §7 规则 11）
 *
 * 只回答一个问题：**用户现在实际运行的那份代码，是不是我刚改的那份？**
 * 2026-11-04 的教训：发版把全局安装换成了 registry 副本，之后又改了仓库代码却只让用户刷新页面，
 * 用户看到的是旧文件、白折腾一轮。这个脚本把那次的判断过程固化成一次点击。
 *
 * 检查项：
 *   ① 全局安装形态（registry 目录 / 仓库软链）与版本号；
 *   ② 全局 dist 与仓库 dist 的逐文件 md5（列出第一处差异）；
 *   ③ 若本机实例可达（默认 127.0.0.1:4080，可用参数覆盖）：服务端提供的静态文件 vs 仓库源文件。
 *
 * 用法：
 *   node tools/check-deploy.mjs                 # 默认检查 4080
 *   node tools/check-deploy.mjs http://127.0.0.1:4096
 *   node tools/check-deploy.mjs --no-instance   # 只看安装态
 *
 * 退出码：0 = 全一致；1 = 有差异（此时不要让用户测试）。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const REPO_DIST = join(REPO, "pi-sdk-web", "dist");
const PKG = "@maxdai/pi-web";

const args = process.argv.slice(2);
const checkInstance = !args.includes("--no-instance");
const instanceUrl = (args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4080").replace(/\/$/, "");

const md5 = (file) => createHash("md5").update(readFileSync(file)).digest("hex");
const short = (hash) => hash.slice(0, 8);

let failures = 0;
const ok = (label, detail = "") => console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 递归列出 dist 下的文件（相对路径），用于逐文件比对。 */
function listDist(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

// ---------------------------------------------------------------- ① 全局安装
let globalRoot = null;
try {
  globalRoot = join(execSync("npm root -g", { encoding: "utf8" }).trim(), PKG);
} catch {
  bad("读取 npm 全局目录失败");
}

let globalVersion = null;
let globalIsSymlink = false;
if (globalRoot && existsSync(globalRoot)) {
  const lst = execSync(`ls -ld ${JSON.stringify(globalRoot)}`, { encoding: "utf8" });
  globalIsSymlink = lst.trim().startsWith("l");
  const real = globalIsSymlink ? execSync(`readlink -f ${JSON.stringify(globalRoot)}`, { encoding: "utf8" }).trim() : globalRoot;
  try {
    globalVersion = JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version;
  } catch {
    bad("读取全局 package.json 失败");
  }
  console.log(`全局安装：${real}`);
  console.log(`  形态：${globalIsSymlink ? "仓库软链（开发态，改完跑 npm run build 即生效）" : "registry 副本（发布态，仓库改动不会自动生效）"}`);
  console.log(`  版本：${globalVersion ?? "?"}`);
  if (globalIsSymlink && resolve(real) !== resolve(join(REPO, "pi-sdk-web"))) {
    bad("软链指向的不是本仓库", real);
  }
} else {
  bad("找不到全局安装", globalRoot ?? "");
}

// ---------------------------------------------------------------- ② 全局 dist vs 仓库 dist
if (globalRoot && existsSync(globalRoot)) {
  const real = globalIsSymlink ? execSync(`readlink -f ${JSON.stringify(globalRoot)}`, { encoding: "utf8" }).trim() : globalRoot;
  const globalDist = join(real, "dist");
  const repoFiles = listDist(REPO_DIST);
  const diffs = [];
  for (const rel of repoFiles) {
    const a = join(REPO_DIST, rel);
    const b = join(globalDist, rel);
    if (!existsSync(b)) diffs.push(`${rel}（全局缺失）`);
    else if (md5(a) !== md5(b)) diffs.push(`${rel}（${short(md5(a))} ≠ ${short(md5(b))}）`);
  }
  if (diffs.length === 0) {
    ok("全局 dist 与仓库 dist 逐文件一致", `${repoFiles.length} 个文件`);
  } else {
    bad("全局 dist 与仓库 dist 有差异（用户测不到你的改动）", `${diffs.length} 处，例如 ${diffs.slice(0, 3).join("；")}`);
    console.log("      处理：npm run build && npm install -g /root/pi-web/pi-sdk-web（装回软链），或直接发版");
  }
}

// ---------------------------------------------------------------- ③ 运行中实例提供的文件
const SERVED = [
  ["/app.js", "static/app.js"],
  ["/style.css", "static/style.css"],
  ["/index.html", "static/index.html"],
  ["/files.js", "static/files.js"],
  ["/files.css", "static/files.css"],
  ["/files.html", "static/files.html"],
];

if (checkInstance) {
  let reachable = false;
  try {
    const res = await fetch(instanceUrl, { signal: AbortSignal.timeout(2000) });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.log(`实例 ${instanceUrl}：未运行（跳过服务端文件比对；要验"用户实际拿到的文件"，请先起实例）`);
  } else {
    for (const [served, local] of SERVED) {
      const res = await fetch(`${instanceUrl}${served}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!res || !res.ok) {
        bad(`实例 ${served} 不可访问`, res ? `status=${res.status}` : "fetch failed");
        continue;
      }
      const remote = Buffer.from(await res.arrayBuffer());
      const remoteHash = createHash("md5").update(remote).digest("hex");
      const localHash = md5(join(REPO, local));
      if (remoteHash === localHash) ok(`实例 ${served} 与仓库 ${local} 一致`, short(localHash));
      else bad(`实例 ${served} 与仓库 ${local} 不一致`, `${short(remoteHash)} ≠ ${short(localHash)}；改完没重启/没重新安装？`);
    }
  }
}

console.log("");
if (failures === 0) {
  console.log("✅ 就绪：可以交给用户测试（上面每一项都对得上）。");
  process.exit(0);
}
console.log(`❌ 未就绪（${failures} 项）：先按上面的提示修好，再让用户测试/刷新。`);
process.exit(1);
