// 原型驱动：HTTP 服务（收事件/发指令）+ 用 script 起 pty 跑 interactive 模式的 pi
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const STEPS = process.argv[2] ?? "1";
const PORT = 4096;
const TOKEN = "proto-token";
let pending = null;
const events = [];
let ptyTail = "";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const route = (req.url ?? "/").split("?")[0];
    const reply = (o, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (route === "/event") {
      events.push({ t: Date.now(), ...data });
      console.log(`[event +${((Date.now() - T0) / 1000).toFixed(1)}s] ${JSON.stringify(data)}`);
      return reply({ ok: true });
    }
    if (route === "/pending") {
      if (!pending) { res.writeHead(204).end(); return; }
      const p = pending; pending = null;
      return reply(p);
    }
    if (route === "/send") {
      pending = { message: data.message, options: data.options };
      console.log(`[queue] ${JSON.stringify(pending)}`);
      return reply({ ok: true });
    }
    reply({ ok: true });
  });
});

const T0 = Date.now();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`[proto] server on ${PORT}; steps=${STEPS}`);

const child = spawn(
  "script",
  ["-q", "-c", `pi --extension /tmp/tui-proto/bridge.mjs --session /tmp/tui-proto/session.jsonl`, "/dev/null"],
  {
    cwd: "/root",
    env: { ...process.env, PI_WEB_PROTO_URL: `http://127.0.0.1:${PORT}`, PI_WEB_PROTO_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stdout.on("data", (c) => { ptyTail = (ptyTail + stripAnsi(c.toString())).slice(-4000); });
child.stderr.on("data", (c) => { const s = stripAnsi(c.toString()); if (s.trim()) console.log("[pty-err]", s.trim().slice(0, 200)); });
child.on("exit", (code, sig) => console.log(`[proto] pi exited code=${code} sig=${sig}`));

const waitFor = (pred, ms, label) =>
  new Promise((resolve) => {
    const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(k); resolve(true); } }, 250);
    const k = setTimeout(() => { clearInterval(t); resolve(false); }, ms);
  });
const has = (type) => events.some((e) => e.type === type);

// 第 1 步：起得来
const ready = await waitFor(() => has("ready"), 30000, "ready");
const r = events.find((e) => e.type === "ready");
console.log(`\n=== 步骤 1（起得来）: ${ready ? "✓ 桥接在 interactive 模式下上报就绪" : "✗ 超时"} ===`);
console.log("   ready:", JSON.stringify(r ?? null));
if (STEPS === "1" || !ready) {
  child.kill("SIGKILL");
  server.close();
  writeFileSync("/tmp/tui-proto/pty-step1.txt", ptyTail);
  console.log("   pty 输出尾部（去 ANSI，前 300 字）:", JSON.stringify(ptyTail.slice(0, 300)));
  process.exit(ready ? 0 : 1);
}

// 第 2 步：送得进（普通消息 → 应跑完整一轮）
console.log(`\n=== 步骤 2（送得进）===`);
await fetch(`http://127.0.0.1:${PORT}/send`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Reply with exactly: PONG" }),
});
const turnDone = await waitFor(() => has("agent_end"), 120000, "agent_end");
const seq = events.filter((e) => ["send","message_start","message_update","message_end","agent_end"].includes(e.type)).map((e) => e.type);
console.log(`   ${turnDone ? "✓ 完整一轮事件" : "✗ 未在 120s 内完成"}：${seq.join(" → ")}`);

// 第 3a 步：扩展命令（expandPromptTemplates: true）
console.log(`\n=== 步骤 3a（扩展命令经 sendUserMessage）===`);
events.length = 0;
await fetch(`http://127.0.0.1:${PORT}/send`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "/pi-web-proto:ping", options: { expandPromptTemplates: true } }),
});
const cmdRan = await waitFor(() => has("command-ran"), 15000, "command-ran");
const startedTurn = await waitFor(() => has("agent_start") || has("message_start"), 3000, "turn");
console.log(`   命令处理器运行: ${cmdRan ? "✓" : "✗"}；同时是否被当成文本发给模型: ${startedTurn ? "是（✗ 走了模型）" : "否（✓ 未走模型）"}`);

// 第 3b 步：内置命令 /help
console.log(`\n=== 步骤 3b（内置命令 /help）===`);
events.length = 0;
const ptyBefore = ptyTail.length;
await fetch(`http://127.0.0.1:${PORT}/send`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "/help", options: { expandPromptTemplates: true } }),
});
const helpTurn = await waitFor(() => has("agent_start") || has("message_start"), 6000, "turn");
const helpText = /help|commands|keybind/i.test(ptyTail.slice(ptyBefore));
console.log(`   /help 被当成文本发给模型: ${helpTurn ? "是（✗）" : "否（✓）"}；pty 出现帮助文本: ${helpText ? "✓" : "✗"}`);

// 第 3c 步：兜底——直接往 pty 里"替用户敲"
if (!helpText) {
  console.log(`\n=== 步骤 3c（写 pty stdin 兜底）===`);
  events.length = 0;
  const before2 = ptyTail.length;
  child.stdin.write("/help\r");
  const typed = await waitFor(() => /help|commands|keybind/i.test(ptyTail.slice(before2)), 8000, "typed");
  console.log(`   写 pty 后出现帮助文本: ${typed ? "✓" : "✗"}`);
}

child.kill("SIGKILL");
server.close();
writeFileSync("/tmp/tui-proto/pty-full.txt", ptyTail);
console.log("\n=== 事件总数:", events.length, "（pty 尾部已存 /tmp/tui-proto/pty-full.txt）===");
process.exit(0);
