// 最小原型桥接：只做三件事——上报就绪、轮询待发消息、转发事件。
const url = process.env.PI_WEB_PROTO_URL;
const token = process.env.PI_WEB_PROTO_TOKEN;
const post = async (path, body) => {
  try {
    await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token": token },
      body: JSON.stringify(body ?? {}),
    });
  } catch {}
};
const log = (...a) => console.error("[proto-bridge]", ...a);

export default function (pi) {
  log("loaded | stdout.isTTY=", process.stdout.isTTY, "stdin.isTTY=", process.stdin.isTTY);
  pi.registerCommand("pi-web-proto:ping", {
    description: "prototype ping command",
    handler: async (_args, ctx) => {
      log("COMMAND-HANDLER-RAN (pi-web-proto:ping)");
      await post("/event", { type: "command-ran", name: "pi-web-proto:ping", hasUI: ctx?.hasUI });
    },
  });

  const names = [
    "session_start", "agent_start", "agent_end", "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "input", "session_shutdown",
  ];
  for (const name of names) {
    pi.on(name, async (event, ctx) => {
      if (name === "session_start") {
        await post("/event", {
          type: "ready",
          mode: ctx?.mode,
          hasUI: ctx?.hasUI,
          cwd: ctx?.cwd,
          scoped: (ctx?.scopedModels ?? []).length,
          stdoutIsTTY: Boolean(process.stdout.isTTY),
          stdinIsTTY: Boolean(process.stdin.isTTY),
        });
        void poll(ctx);
        return;
      }
      if (name === "message_update") {
        if ((globalThis.__mu = (globalThis.__mu ?? 0) + 1) % 10 === 1) await post("/event", { type: name });
        return;
      }
      if (name === "input") {
        await post("/event", { type: name, text: String(event?.text ?? event?.message ?? "").slice(0, 60) });
        return;
      }
      await post("/event", {
        type: name,
        ...(name.startsWith("tool_execution") ? { tool: event?.toolName ?? event?.name ?? "?" } : {}),
      });
    });
  }

  async function poll(ctx) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch(`${url}/pending`, { headers: { "x-token": token } });
        if (res.status === 204) continue;
        const data = await res.json();
        if (!data?.message) continue;
        log("sendUserMessage:", JSON.stringify(data.message), "options:", JSON.stringify(data.options ?? {}));
        await post("/event", { type: "send", message: data.message, options: data.options ?? {} });
        await pi.sendUserMessage(data.message, data.options ?? undefined);
      } catch (err) {
        log("poll error:", err.message);
      }
    }
  }
}
