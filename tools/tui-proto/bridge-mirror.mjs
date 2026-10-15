// 会话镜像原型：把 Pi 事件序列化成"可重画对话"的帧，经侧信道送出
const url = process.env.PI_WEB_PROTO_URL;
const token = process.env.PI_WEB_PROTO_TOKEN;
const post = async (path, body) => {
  try {
    await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-token": token }, body: JSON.stringify(body ?? {}) });
  } catch {}
};
const log = (...a) => console.error("[mirror]", ...a);
const head = (v, n = 80) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? null); return s === undefined ? "" : s.length > n ? `${s.slice(0, n)}…(${s.length})` : s; };

export default function (pi) {
  pi.registerCommand("pi-web-proto:ping", { description: "ping", handler: async () => { await post("/event", { kind: "cmd", name: "ping" }); } });

  // 归一化一条 AgentMessage → 可渲染的块
  const blocks = (msg) => {
    const c = msg?.content;
    if (typeof c === "string") return [{ type: "text", len: c.length, head: head(c) }];
    if (!Array.isArray(c)) return [];
    return c.map((b) => {
      if (b?.type === "text") return { type: "text", len: (b.text ?? "").length, head: head(b.text) };
      if (b?.type === "toolCall" || b?.type === "tool_use") return { type: "toolCall", id: b.id ?? b.toolCallId, name: b.name ?? b.toolName, args: head(b.arguments ?? b.args, 60) };
      if (b?.type === "toolResult" || b?.type === "tool_result") return { type: "toolResult", id: b.toolCallId ?? b.id, isError: Boolean(b.isError), head: head(b.content) };
      if (b?.type === "thinking") return { type: "thinking", len: (b.thinking ?? b.text ?? "").length };
      if (b?.type === "image") return { type: "image" };
      return { type: b?.type ?? "unknown" };
    });
  };

  pi.on("session_start", async (_e, ctx) => {
    // 会话历史读取能力探查（用于浏览器首屏重画）
    const sm = ctx?.sessionManager ?? {};
    const proto = Object.getPrototypeOf(sm) ?? {};
    const methods = Object.getOwnPropertyNames(proto).filter((k) => typeof sm[k] === "function").sort();
    const readCandidates = ["getEntries", "loadEntries", "getMessages", "getSessionEntries", "getTree", "buildContext"];
    const reads = {};
    for (const name of readCandidates) {
      if (typeof sm[name] !== "function") continue;
      try { const v = await sm[name](); reads[name] = Array.isArray(v) ? `array(${v.length})` : typeof v; }
      catch (err) { reads[name] = `ERR:${err.message}`; }
    }
    await post("/event", { kind: "session", mode: ctx?.mode, hasUI: ctx?.hasUI, sessionFile: sm.getSessionFile?.(), smMethods: methods, historyReads: reads });
  });

  const emit = (kind, phase, extra = {}) => post("/event", { kind, phase, ...extra });

  pi.on("agent_start", () => emit("agent", "start"));
  pi.on("agent_end", (e) => emit("agent", "end", { messageCount: e?.messages?.length }));
  pi.on("turn_start", (e) => emit("turn", "start", { turnIndex: e?.turnIndex }));
  pi.on("turn_end", (e) => emit("turn", "end", { turnIndex: e?.turnIndex, toolResults: (e?.toolResults ?? []).length }));
  pi.on("message_start", (e) => emit("msg", "start", { role: e?.message?.role, blocks: blocks(e?.message) }));
  let n = 0;
  pi.on("message_update", (e) => { if (++n % 15 === 0) emit("msg", "update", { role: e?.message?.role, blocks: blocks(e?.message) }); });
  pi.on("message_end", (e) => emit("msg", "end", { role: e?.message?.role, stopReason: e?.message?.stopReason, blocks: blocks(e?.message) }));
  pi.on("tool_execution_start", (e) => emit("tool", "start", { id: e?.toolCallId, name: e?.toolName, args: head(e?.args, 70) }));
  let tn = 0;
  pi.on("tool_execution_update", (e) => { if (++tn % 5 === 0) emit("tool", "update", { id: e?.toolCallId, name: e?.toolName, partial: head(e?.partialResult, 70) }); });
  pi.on("tool_execution_end", (e) => emit("tool", "end", { id: e?.toolCallId, name: e?.toolName, isError: e?.isError, durationMs: e?.durationMs, result: head(e?.result, 120) }));
  pi.on("input", (e) => emit("input", "submit", { text: head(e?.text ?? e?.message, 60) }));

  // 轮询待发消息（同前）
  const poll = async (ctx) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch(`${url}/pending`, { headers: { "x-token": token } });
        if (res.status === 204) continue;
        const data = await res.json();
        if (!data?.message) continue;
        await emit("send", "out", { message: data.message, options: data.options ?? {} });
        await pi.sendUserMessage(data.message, data.options ?? undefined);
      } catch (err) { log("poll:", err.message); }
    }
  };
  pi.on("session_start", (_e, ctx) => { void poll(ctx); });
}
