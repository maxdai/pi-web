// 定向测试：空闲时"替用户敲"进 pty，看 TUI 是否照常派发命令
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const PORT = 4096, TOKEN = "proto-token";
let pending = null; const events = []; let pty = "";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");
const server = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {}; const route = (req.url ?? "/").split("?")[0];
    const reply = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (route === "/event") { events.push({ t: Date.now(), ...data }); console.log(`[event +${((Date.now()-T0)/1000).toFixed(1)}s] ${JSON.stringify(data)}`); return reply({ ok: true }); }
    if (route === "/pending") { if (!pending) { res.writeHead(204).end(); return; } const p = pending; pending = null; return reply(p); }
    reply({ ok: true });
  });
});
const T0 = Date.now();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (c) => { pty = (pty + stripAnsi(c.toString())).slice(-8000); });
child.stderr.on("data", (c) => { const s = stripAnsi(c.toString()); if (s.trim()) console.log("[pty-err]", s.trim().slice(0, 160)); });
const waitFor = (pred, ms) => new Promise((res) => { const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); res(true); } }, 250); const k = setTimeout(() => { clearInterval(t); res(false); }, ms); });
const has = (ty) => events.some((e) => e.type === ty);
await waitFor(() => has("ready"), 30000);
console.log("ready ✓，等 3s 让它完全空闲…");
await new Promise((r) => setTimeout(r, 3000));

console.log("\n=== 3c-1：空闲时往 pty 敲 /pi-web-proto:ping ===");
events.length = 0;
child.stdin.write("/pi-web-proto:ping\r");
const ran = await waitFor(() => has("command-ran"), 12000);
const turned = has("agent_start") || has("message_start");
console.log(`   命令派发: ${ran ? "✓（pty 输入被 TUI 当作命令执行）" : "✗"}；是否触发模型: ${turned ? "是" : "否"}`);
console.log(`   收到的 input 事件: ${JSON.stringify(events.filter((e) => e.type === "input").map((e) => e.text))}`);

console.log("\n=== 3c-2：空闲时往 pty 敲内置命令 /help ===");
events.length = 0;
const before = pty.length;
child.stdin.write("/help\r");
const anyTurn = await waitFor(() => has("agent_start") || has("message_start"), 8000);
await new Promise((r) => setTimeout(r, 1500));
const delta = pty.slice(before);
console.log(`   是否触发模型: ${anyTurn ? "是（✗ 被当文本）" : "否（✓ 被当命令）"}`);
console.log(`   pty 新增输出 ${delta.length} 字，片段: ${JSON.stringify(delta.slice(0, 220))}`);
writeFileSync("/tmp/tui-proto/pty-type.txt", pty);
child.kill("SIGKILL"); server.close();
process.exit(0);
