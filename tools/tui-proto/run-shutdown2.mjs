// ② 修正版：CPU 精确取样 + Ctrl+C 语义（单次/双次）+ SIGTERM
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
const PORT = 4096, TOKEN = "proto-token";
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
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (cmd.includes("bridge.mjs") && !cmd.startsWith("script")) return Number(d);
    } catch {}
  }
  return null;
};
const cpuTicks = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); const p = s.slice(s.lastIndexOf(")") + 2).split(" "); return Number(p[11]) + Number(p[12]); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (pred, ms) => new Promise((res) => { const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); res(true); } }, 150); const k = setTimeout(() => { clearInterval(t); res(false); }, ms); });

let bytes = 0;
const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (c) => { bytes += c.length; });
child.stderr.on("data", () => {});
await waitFor(() => frames.some((f) => f.type === "ready"), 30000);
const piPid = findPiPid();
console.log(`ready ✓  scriptPid=${child.pid}  piPid=${piPid}（已排除 script 包装进程）`);
await sleep(2500);

console.log("\n=== 渲染开销（精确取样 /proc/<piPid>/stat）===");
bytes = 0; let c0 = cpuTicks(piPid);
await sleep(5000);
console.log(`  空闲 5s：pty 输出 ${bytes} 字节（${(bytes / 5 / 1024).toFixed(2)} KB/s）；pi CPU ${(((cpuTicks(piPid) - c0) / 100) / 5 * 100).toFixed(1)}%（单核）`);
frames = []; bytes = 0; c0 = cpuTicks(piPid);
const t0 = Date.now();
await fetch(`http://127.0.0.1:${PORT}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Count from 1 to 30, one number per line, nothing else." }) });
await waitFor(() => frames.some((f) => f.type === "agent_end"), 150000);
const secs = (Date.now() - t0) / 1000;
console.log(`  一轮对话 ${secs.toFixed(1)}s：pty 输出 ${bytes} 字节（${(bytes / secs / 1024).toFixed(2)} KB/s）；pi CPU ${(((cpuTicks(piPid) - c0) / 100) / secs * 100).toFixed(1)}%（单核）`);
await sleep(2000);

console.log("\n=== 关停语义 ===");
frames = [];
const tA = Date.now();
child.stdin.write("\x03");
await sleep(2000);
console.log(`  ① 单次 Ctrl+C（空闲）：pi 存活 = ${alive(piPid) ? "是（未退出，符合 TUI 语义：单次=中断/清行）" : "否"}；session_shutdown=${frames.some((f) => f.type === "session_shutdown")}`);
child.stdin.write("\x03");
const gone2 = await waitFor(() => !alive(piPid), 8000);
console.log(`  ② 再按一次 Ctrl+C：pi 退出 = ${gone2 ? `✓（累计 ${((Date.now() - tA) / 1000).toFixed(1)}s）` : "✗ 仍存活"}；session_shutdown=${frames.some((f) => f.type === "session_shutdown") ? "✓" : "✗"}`);
if (!gone2 && alive(piPid)) {
  const tB = Date.now();
  try { process.kill(piPid, "SIGTERM"); } catch {}
  const gone3 = await waitFor(() => !alive(piPid), 6000);
  await sleep(400);
  console.log(`  ③ SIGTERM 直达 pi：退出 = ${gone3 ? `✓（${((Date.now() - tB) / 1000).toFixed(1)}s）` : "✗"}；session_shutdown=${frames.some((f) => f.type === "session_shutdown") ? "✓" : "✗"}`);
}
if (alive(piPid)) { try { process.kill(piPid, "SIGKILL"); } catch {} }
if (alive(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
server.close();
process.exit(0);
