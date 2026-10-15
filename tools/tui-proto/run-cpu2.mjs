// 用 PPID 链定位真正的 pi 进程并测 CPU（pi 会改写 argv，cmdline 不可靠）
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
const procs = () => {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = readFileSync(`/proc/${d}/stat`, "utf8");
      const p = s.slice(s.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(d), ppid: Number(p[1]), ticks: Number(p[11]) + Number(p[12]), comm: readFileSync(`/proc/${d}/comm`, "utf8").trim() });
    } catch {}
  }
  return out;
};
const descendants = (rootPid) => {
  const all = procs(); const keep = new Set([rootPid]); let grew = true;
  while (grew) { grew = false; for (const p of all) if (keep.has(p.ppid) && !keep.has(p.pid)) { keep.add(p.pid); grew = true; } }
  return all.filter((p) => keep.has(p.pid));
};
let bytes = 0;
const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (c) => { bytes += c.length; });
child.stderr.on("data", () => {});
await waitFor(() => frames.some((f) => f.type === "ready"), 30000);
await sleep(2500);
console.log("=== script 的进程子树 ===");
for (const p of descendants(child.pid)) console.log(`  pid=${p.pid} ppid=${p.ppid} comm=${p.comm} cmd=${readFileSync(`/proc/${p.pid}/cmdline`, "utf8").replace(/\0/g, " ").trim().slice(0, 70)}`);
const before = descendants(child.pid).filter((p) => p.pid !== child.pid);
frames = []; bytes = 0;
const t0 = Date.now();
await fetch(`http://127.0.0.1:${PORT}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Count from 1 to 40, one number per line, nothing else." }) });
await waitFor(() => frames.some((f) => f.type === "agent_end"), 150000);
const secs = (Date.now() - t0) / 1000;
console.log(`\n=== 一轮 ${secs.toFixed(1)}s 期间 ===`);
console.log(`  pty 输出 ${bytes} 字节（${(bytes / secs / 1024).toFixed(2)} KB/s）`);
let total = 0;
const after = descendants(child.pid);
for (const b of before) {
  const a = after.find((x) => x.pid === b.pid);
  if (!a) continue;
  const pct = ((a.ticks - b.ticks) / 100) / secs * 100;
  total += pct;
  console.log(`  pid=${b.pid} comm=${b.comm}  CPU ${pct.toFixed(1)}%`);
}
console.log(`  合计 CPU ${total.toFixed(1)}%（单核占比）`);
for (const p of descendants(child.pid)) { try { process.kill(p.pid, "SIGTERM"); } catch {} }
server.close();
process.exit(0);
