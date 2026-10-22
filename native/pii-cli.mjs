#!/usr/bin/env node
/**
 * pii - pi session helper (npm bin wrapper).
 *
 * 阶段 E 起为 `native/pii-cli.mjs`：spawn python3 跑同目录的 `pii` 启动器并转发 args/stdio，
 * 退出码原样透传。来源：`pi-sdk-web/src/pii-cli.ts` 的编译产物。
 */
/**
 * pii - pi session helper (RPC bridge launcher).
 *
 * This is the npm bin wrapper: the package ships the Python launcher
 * (`pii`, stdlib only) next to this file. We spawn python3 with it and
 * forward args/stdin/stdout/stderr, exiting with its code.
 *
 * Usage (same as the original script):
 *   pii list [-l]
 *   pii r <name> [--web [port]]
 *   pii delete <name>
 *   pii delete "(unnamed)"
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const piiDir = dirname(fileURLToPath(import.meta.url)); // dist/pi-bin
const piiScript = join(piiDir, "pii");
if (!existsSync(piiScript)) {
    console.error(`pii: bundled launcher not found at ${piiScript}`);
    process.exit(1);
}
// Locate the Python interpreter (same resolution the original shell
// used: python3 on PATH; fall back to the `python` alias).
const pyCandidates = ["python3", "python"];
let python = undefined;
for (const candidate of pyCandidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) {
        python = candidate;
        break;
    }
}
if (!python) {
    console.error("pii: python3 not found on PATH (required to run the RPC bridge)");
    process.exit(1);
}
// The bundled launcher resolves its project root via script location;
// export PI_WEB_DIR pointing at this directory (dist/native) so
// _resolve_project_root() picks it directly — the native engine lives in
// the same directory.
// Ctrl+C 会送到整个前台进程组（包装器 + Python 启动器 + 原生服务端 + pi 子进程）。
// 真正的收尾由 Python 启动器负责：它会**等**原生服务端优雅关停（杀 pi 子进程、关 socket、
// 打印收尾日志）。若这里放任 Node 默认的 SIGINT 行为立刻杀掉包装器，bash 会在收尾完成前
// 打印提示符，服务端的收尾日志就落到提示符之后（现象：提示符后又多一行，2026-10-14 逐字节定位）。
// 因此这里忽略这两个信号，等 spawnSync 自然返回（Python 侧有 5s 上限，不会永久卡住）。
const ignoreSignal = () => { };
process.on("SIGINT", ignoreSignal);
process.on("SIGTERM", ignoreSignal);
const result = spawnSync(python, [piiScript, ...process.argv.slice(2)], {
    env: { ...process.env, PI_WEB_DIR: piiDir },
    stdio: "inherit",
});
if (result.error) {
    console.error(`pii: failed to start launcher: ${result.error.message}`);
    process.exit(1);
}
if (result.signal) {
    console.error(`pii: launcher terminated by ${result.signal}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
