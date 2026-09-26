#!/usr/bin/env node
/**
 * 构建后处理：把非 TS 资源装配进 dist/，并保证这棵树里没有构建/运行期垃圾。
 *
 * 为什么需要 __pycache__ 清扫：Python 桥是在 `dist/pi-bin/server/` 里**运行**的，
 * CPython 会就地生成 `__pycache__/*.pyc`；而 `cpSync` 的 filter 只能挡住「拷贝时」
 * 的 pycache，挡不住之后生成的。于是这些字节码会攒在 dist 里被 npm publish 打进
 * 包（0.5.19 就混进了 rpc_client.cpython-313.pyc）。
 *
 * 注意：靠 `.npmignore` 排不掉——`package.json` 的 `files: ["dist"]` 是白名单，
 * 实测在它存在时 .npmignore 不生效（21 个文件前后不变）；必须在打包前清干净。
 * 发布走 `prepublishOnly → npm run build`，因此本脚本即发布前的最后一道清理。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 路径一律相对本脚本解析：npm script 的 cwd 是包目录，但从仓库根直接跑也应当可用
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PKG_ROOT, "dist");
const at = (...parts) => join(PKG_ROOT, ...parts);

// 1) 静态前端资源
cpSync(at("../static"), at("dist", "static"), { recursive: true });

// 2) pii 启动器：把 tsc 产出的 dist/pii-cli.js 挪到 pi-bin/ 并补执行位
//    （幂等：本步骤单独重跑时源文件已在上次被移走，跳过即可）
mkdirSync(at("dist", "pi-bin"), { recursive: true });
chmodSync(at("dist", "cli.js"), 0o755);
if (existsSync(at("dist", "pii-cli.js"))) {
  renameSync(at("dist", "pii-cli.js"), at("dist", "pi-bin", "pii-cli.js"));
}
chmodSync(at("dist", "pi-bin", "pii-cli.js"), 0o755);
cpSync(at("../pii/pii"), at("dist", "pi-bin", "pii"));

// 3) Python 桥（拷贝时即排除 pycache，双保险）
cpSync(at("../server"), at("dist", "pi-bin", "server"), {
  recursive: true,
  filter: (src) => !src.includes("__pycache__"),
});

// 4) 清扫运行期生成的 __pycache__（递归，含嵌套子目录）
let removed = 0;
function sweepPycache(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "__pycache__") {
      rmSync(path, { recursive: true, force: true });
      removed++;
    } else {
      sweepPycache(path);
    }
  }
}
sweepPycache(DIST);

// 5) 自检：清扫后 dist 里不应再有任何 .pyc
const leftovers = [];
(function findPyc(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findPyc(path);
    else if (entry.name.endsWith(".pyc")) leftovers.push(path);
  }
})(DIST);
if (leftovers.length > 0) {
  console.error(`打包自检失败：dist 中仍有字节码文件\n  ${leftovers.join("\n  ")}`);
  process.exit(1);
}

// 6) 自检：分发用的关键文件必须存在（缺了会让安装后的命令失效）
const required = [
  at("dist", "cli.js"),
  at("dist", "pi-bin", "pii-cli.js"),
  at("dist", "pi-bin", "pii"),
  at("dist", "pi-bin", "server", "server.py"),
  at("dist", "static", "index.html"),
];
const missing = required.filter((p) => {
  try {
    statSync(p);
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  console.error(`打包自检失败：缺少分发文件\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(`dist 装配完成${removed > 0 ? `（清理 __pycache__ ${removed} 处）` : ""}`);
