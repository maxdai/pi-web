// 进程树 + 逐进程 CPU 实测（一轮对话窗口内）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (pred, ms) => new Promise((res) => { const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); res(true); } }, 150); const k = setTimeout(() => { clearInterval(t); res(false); }, ms); });
const matches = () => {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (cmd.includes("bridge.mjs")) out.push({ pid: Number(d), cmd: cmd.slice(0, 90), ticks: cpu(Number(d)) });
    } catch {}
  }
  return out;
};
function cpu(pid) { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); const p = s.slice(s.lastIndexOf(")") + 2).split(" "); return Number(p[11]) + Number(p[12]); } catch { return 0; } }
let bytes = 0;
const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (c) => { bytes += c.length; });
child.stderr.on("data", () => {});
await waitFor(() => frames.some((f) => f.type === "ready"), 30000);
await sleep(2000);
console.log("=== 相关进程（cmdline 含 bridge.mjs）===");
for (const m of matches()) console.log(`  pid=${m.pid}  ${m.cmd}`);
const before = matches();
frames = []; bytes = 0;
const t0 = Date.now();
await fetch(`http://127.0.0.1:${PORT}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Count from 1 to 40, one number per line, nothing else." }) });
await waitFor(() => frames.some((f) => f.type === "agent_end"), 150000);
const secs = (Date.now() - t0) / 1000;
console.log(`\n=== 一轮对话 ${secs.toFixed(1)}s 期间 ===`);
console.log(`  pty 输出: ${bytes} 字节（${(bytes / secs / 1024).toFixed(2)} KB/s）`);
let total = 0;
for (const b of before) {
  const now = cpu(b.pid);
  const pct = ((now - b.ticks) / 100) / secs * 100;
  total += pct;
  console.log(`  pid=${b.pid}  CPU ${pct.toFixed(1)}%（单核）  ${b.cmd.slice(0, 60)}`);
}
console.log(`  合计 CPU: ${total.toFixed(1)}%（单核占比）`);
for (const m of matches()) { try { process.kill(m.pid, "SIGTERM"); } catch {} }
try { process.kill(child.pid, "SIGTERM"); } catch {}
server.close();
process.exit(0);
