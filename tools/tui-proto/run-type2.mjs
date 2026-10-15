// 定向测试：往 pty 敲真实内置命令（TUI 自己的命令 runner）
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
const PORT = 4096, TOKEN = "proto-token";
let pending = null; const events = []; let pty = "";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");
const server = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {}; const route = (req.url ?? "/").split("?")[0];
    const reply = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (route === "/event") { events.push({ t: Date.now(), ...data }); console.log(`  [event] ${JSON.stringify(data)}`); return reply({ ok: true }); }
    if (route === "/pending") { if (!pending) { res.writeHead(204).end(); return; } const p = pending; pending = null; return reply(p); }
    reply({ ok: true });
  });
});
const T0 = Date.now();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (c) => { pty = (pty + stripAnsi(c.toString())).slice(-6000); });
child.stderr.on("data", (c) => { const s = stripAnsi(c.toString()); if (s.trim()) console.log("  [pty-err]", s.trim().slice(0, 150)); });
const waitFor = (pred, ms) => new Promise((res) => { const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); res(true); } }, 200); const k = setTimeout(() => { clearInterval(t); res(false); }, ms); });
const has = (ty) => events.some((e) => e.type === ty);
const type = (s) => child.stdin.write(s);
await waitFor(() => has("ready"), 30000);
await new Promise((r) => setTimeout(r, 3000));
console.log("ready ✓\n");

for (const cmd of ["/model", "/export /tmp/tui-proto/exp2.jsonl"]) {
  console.log(`=== 敲入 pty: "${cmd}" ===`);
  events.length = 0;
  const before = pty.length;
  type(cmd + "\r");
  const turned = await waitFor(() => has("agent_start") || has("message_start"), 5000);
  await new Promise((r) => setTimeout(r, 2000));
  const delta = pty.slice(before).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  console.log(`  → 触发模型: ${turned ? "是（✗）" : "否（✓ 被当命令）"}`);
  console.log(`  → 事件: ${events.map((e) => e.type).join(",") || "（无）"}`);
  console.log(`  → pty 变化片段: ${JSON.stringify(delta.slice(0, 200))}`);
  // 面板类命令敲 Esc 关掉，避免挡住后续输入
  if (cmd.startsWith("/model")) { type("\x1b"); await new Promise((r) => setTimeout(r, 1200)); }
}
const f = "/tmp/tui-proto/exp2.jsonl";
console.log(`\n=== .jsonl 导出结果 ===`);
console.log(`  ${existsSync(f) ? `✓ 文件已生成，${statSync(f).size} 字节` : "✗ 未生成"}`);
child.kill("SIGKILL"); server.close();
process.exit(0);
