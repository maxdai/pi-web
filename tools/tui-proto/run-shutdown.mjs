// ② pty 关停与渲染开销实测
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
const PORT = 4096, TOKEN = "proto-token";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");
let pending = null, frames = [];
const server = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {}; const route = (req.url ?? "/").split("?")[0];
    const reply = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (route === "/event") { frames.push(data); return reply({ ok: true }); }
    if (route === "/pending") { if (!pending) { res.writeHead(204).end(); return; } const p = pending; pending = null; return reply(p); }
    if (route === "/send") { pending = { message: data.message, options: data.options }; return reply({ ok: true }); }
    reply({ ok: true });
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const findPiPid = () => {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " "); if (cmd.includes("bridge.mjs") && cmd.includes("pi")) return Number(d); } catch {}
  }
  return null;
};
const cpuTicks = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); const p = s.slice(s.lastIndexOf(")") + 2).split(" "); return Number(p[11]) + Number(p[12]); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (pred, ms) => new Promise((res) => { const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); res(true); } }, 200); const k = setTimeout(() => { clearInterval(t); res(false); }, ms); });

async function startInstance(label) {
  let bytes = 0;
  const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
    { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (c) => { bytes += c.length; });
  child.stderr.on("data", () => {});
  const ready = await waitFor(() => frames.some((f) => f.type === "ready"), 30000);
  console.log(`[${label}] ready=${ready ? "✓" : "✗"} scriptPid=${child.pid} piPid=${findPiPid()}`);
  return { child, bytes: () => bytes, reset: () => { bytes = 0; } };
}

// ---------- 实例 1：开销 + Ctrl+C 关停 ----------
console.log("=== 渲染开销实测 ===");
let inst = await startInstance("A");
await sleep(2500);
const piPid = findPiPid();
inst.reset(); let c0 = cpuTicks(piPid);
await sleep(5000);
const idleBytes = inst.bytes(), c1 = cpuTicks(piPid);
console.log(`  空闲 5s：pty 输出 ${idleBytes} 字节（${(idleBytes / 5 / 1024).toFixed(2)} KB/s）；pi CPU ${(((c1 - c0) / 100) / 5 * 100).toFixed(1)}%（单核占比）`);
frames = [];
inst.reset(); c0 = cpuTicks(piPid);
const t0 = Date.now();
await fetch(`http://127.0.0.1:${PORT}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Say hi in one short sentence." }) });
await waitFor(() => frames.some((f) => f.type === "agent_end"), 150000);
const turnSec = (Date.now() - t0) / 1000, turnBytes = inst.bytes(), c2 = cpuTicks(piPid);
console.log(`  一轮对话 ${turnSec.toFixed(1)}s：pty 输出 ${turnBytes} 字节（${(turnBytes / turnSec / 1024).toFixed(2)} KB/s）；pi CPU ${(((c2 - c0) / 100) / turnSec * 100).toFixed(1)}%`);
await sleep(2000);

console.log("\n=== 关停 A：向 pty 写 \\x03（真 Ctrl+C）===");
frames = [];
const tA = Date.now();
inst.child.stdin.write("\x03");
const piGone = await waitFor(() => !alive(piPid), 10000);
const scriptGone = await waitFor(() => !alive(inst.child.pid), 5000);
await sleep(500);
console.log(`  pi 进程退出: ${piGone ? `✓ ${((Date.now() - tA) / 1000).toFixed(1)}s` : "✗ 仍在"}；script 退出: ${scriptGone ? "✓" : "✗"}`);
console.log(`  收到 session_shutdown: ${frames.some((f) => f.type === "session_shutdown") ? "✓" : "✗"}；frames=${JSON.stringify(frames.map((f) => f.type))}`);
if (alive(piPid)) { console.log("  → 兜底：按 PID 清理"); try { process.kill(piPid, "SIGKILL"); } catch {} }
if (alive(inst.child.pid)) { try { process.kill(inst.child.pid, "SIGKILL"); } catch {} }

// ---------- 实例 2：SIGTERM 到 script（引擎常见关停路径） ----------
console.log("\n=== 关停 B：SIGTERM 到 script（父进程被杀，pi 会不会变孤儿？）===");
frames = [];
inst = await startInstance("B");
await sleep(1500);
const piPid2 = findPiPid();
inst.child.kill("SIGTERM");
await sleep(2500);
const orphan = piPid2 && alive(piPid2);
console.log(`  script 已退出: ${!alive(inst.child.pid) ? "✓" : "✗"}；pi 子进程: ${orphan ? "✗ 仍存活（孤儿）" : "✓ 已随之退出"}`);
if (orphan) { console.log(`  → 结论：需要引擎自己按 PID/进程组清理（piPid=${piPid2}）；现在清理`); try { process.kill(piPid2, "SIGKILL"); } catch {} }
server.close();
process.exit(0);
