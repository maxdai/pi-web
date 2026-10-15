// 驱动：跑一轮"用 bash 工具"的对话，检查能否从事件帧完整重画
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const PORT = 4096, TOKEN = "proto-token";
let pending = null; const frames = [];
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");
const server = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {}; const route = (req.url ?? "/").split("?")[0];
    const reply = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (route === "/event") { frames.push(data); return reply({ ok: true }); }
    if (route === "/pending") { if (!pending) { res.writeHead(204).end(); return; } const p = pending; pending = null; return reply(p); }
    if (route === "/send") { pending = { message: data.message, options: data.options }; console.log(`[queue] ${JSON.stringify(pending)}`); return reply({ ok: true }); }
    reply({ ok: true });
  });
});
const T0 = Date.now();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const child = spawn("script", ["-q", "-c", `pi --extension /tmp/tui-proto/bridge-mirror.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  { cwd: "/root", env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", () => {}); child.stderr.on("data", (c) => { const s = stripAnsi(c.toString()); if (s.trim()) console.log("[pty]", s.trim().slice(0, 160)); });
const waitFor = (pred, ms) => new Promise((res) => { const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); res(true); } }, 250); const k = setTimeout(() => { clearInterval(t); res(false); }, ms); });
await waitFor(() => frames.some((f) => f.kind === "session"), 30000);
const sess = frames.find((f) => f.kind === "session");
console.log("=== 会话能力探查 ===");
console.log("  sessionFile:", sess?.sessionFile);
console.log("  sessionManager 方法:", (sess?.smMethods ?? []).join(", ").slice(0, 300));
console.log("  历史读取尝试:", JSON.stringify(sess?.historyReads));
console.log("\n=== 发一轮会用到 bash 工具的对话 ===");
await fetch(`http://127.0.0.1:${PORT}/send`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Run this with the bash tool: echo MIRROR-TEST-123. Then reply with just the output." }) });
const done = await waitFor(() => frames.some((f) => f.kind === "agent" && f.phase === "end"), 150000);
console.log(`  ${done ? "✓ 一轮完成" : "✗ 超时"}\n`);
console.log("=== 镜像帧序列（浏览器据此重画）===");
for (const f of frames.filter((x) => x.kind !== "session")) {
  const bits = [];
  if (f.role) bits.push(`role=${f.role}`);
  if (f.blocks) bits.push(`blocks=[${f.blocks.map((b) => b.type + (b.name ? `:${b.name}` : "") + (b.len !== undefined ? `(${b.len})` : "")).join(" ")}]`);
  if (f.name) bits.push(`tool=${f.name}`);
  if (f.args) bits.push(`args=${JSON.stringify(f.args).slice(0, 50)}`);
  if (f.result !== undefined) bits.push(`result=${JSON.stringify(f.result).slice(0, 90)}`);
  if (f.isError !== undefined) bits.push(`isError=${f.isError}`);
  if (f.durationMs !== undefined) bits.push(`dur=${f.durationMs}ms`);
  if (f.text) bits.push(`text=${JSON.stringify(f.text).slice(0, 40)}`);
  if (f.message) bits.push(`msg=${JSON.stringify(f.message).slice(0, 40)}`);
  console.log(`  ${String(f.kind).padEnd(6)} ${String(f.phase).padEnd(7)} ${bits.join("  ")}`);
}
const bashEnd = frames.find((f) => f.kind === "tool" && f.phase === "end" && f.name === "bash");
const finalText = frames.filter((f) => f.kind === "msg" && f.phase === "end" && f.role === "assistant").at(-1);
console.log("\n=== 可重画性判定 ===");
console.log(`  用户消息: ${frames.some((f) => f.kind === "msg" && f.role === "user") ? "✓" : "✗"}   助手文本: ${finalText ? "✓" : "✗"}   工具块: ${bashEnd ? "✓" : "✗"}   工具输出含 MIRROR-TEST-123: ${/MIRROR-TEST-123/.test(JSON.stringify(bashEnd?.result ?? "")) ? "✓" : "✗"}   流式增量帧: ${frames.some((f) => f.kind === "msg" && f.phase === "update") ? "✓" : "✗"}`);
child.kill("SIGKILL"); server.close();
process.exit(0);
