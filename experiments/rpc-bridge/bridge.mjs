/**
 * pi-web bridge extension —— 原型（experiments/rpc-bridge）
 *
 * 由 pi-web 以 `--extension` 注入到**原生 pi** 进程内，负责 RPC 模式拿不到的那层：
 *   · 工厂式 widget（RPC 只支持字符串数组，工厂会被静默丢弃）
 *   · custom() 面板（RPC 返回 undefined）
 *   · 对话框（RPC 原生的 stdin 通道在 session_start 期间尚未挂载 → 必死锁）
 *   · setTheme（RPC 原生返回 {success:false}）
 *   · 以及把 pi 内部信息（cwd / scopedModels / commands / tools / extensions）上报给服务端
 *
 * 设计依据见 pi-web-design.md §15。原理：`ctx.ui` 是 runner 的**单一共享可变对象**
 * （runner.ts `get ui() { return runner.uiContext }`），改写它的方法会影响所有扩展。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export default function (pi) {
  const url = process.env.PI_WEB_BRIDGE_URL;
  const token = process.env.PI_WEB_BRIDGE_TOKEN;
  if (!url || !token) {
    console.error("[pi-web-bridge] disabled: PI_WEB_BRIDGE_URL/TOKEN not set");
    return;
  }

  const post = async (path, body) => {
    try {
      const res = await fetch(url + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-web-token": token },
        body: JSON.stringify(body ?? {}),
      });
      return await res.json().catch(() => undefined);
    } catch (err) {
      console.error(`[pi-web-bridge] POST ${path} failed: ${err.message}`);
      return undefined;
    }
  };

  const WIDTH = 78;

  // ---------------------------------------------------------------- 扩展列表
  // 与 pi-sdk-web/src/server.ts 的 getLoadedExtensions 同义：从命令的 sourceInfo
  // 反推「哪些扩展被加载」，内置扩展标注 builtin。
  function classifyExtensions() {
    let commands = [];
    try {
      commands = pi.getCommands();
    } catch {
      return [];
    }
    const byPath = new Map();
    for (const cmd of commands) {
      const info = cmd.sourceInfo;
      const p = info?.path;
      if (!p || byPath.has(p)) continue;
      byPath.set(p, info);
    }

    const list = [];
    const seen = new Set();
    for (const [p, info] of byPath) {
      const isInline = p.startsWith("<") && p.endsWith(">");
      const isBuiltin = p.startsWith("builtin:");
      if (isInline || isBuiltin) {
        const raw = isInline ? p.slice(1, -1) : p.slice("builtin:".length);
        const name = raw.includes(":") ? raw.split(":").pop() : raw;
        const key = `builtin:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ name, version: "builtin" });
        }
        continue;
      }
      if (info.origin === "top-level") {
        // 本地文件扩展：显示文件名 + scope（就近的 package.json 往往是宿主仓库的）
        const name = basename(p).replace(/\.(ts|js|mjs|cjs)$/, "");
        const key = `local:${p}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ name, version: info.scope ?? "local" });
        }
        continue;
      }
      // 包扩展：向上找最近的 package.json
      let dir = dirname(p);
      while (dir !== dirname(dir)) {
        const pkgFile = join(dir, "package.json");
        if (existsSync(pkgFile)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
            const key = pkg.name ?? p;
            if (!seen.has(key)) {
              seen.add(key);
              list.push({
                name: pkg.name ?? key,
                version: info.scope ? `${pkg.version ?? "?"} · ${info.scope}` : (pkg.version ?? "?"),
              });
            }
          } catch {
            /* 读取失败则跳过 */
          }
          break;
        }
        dir = dirname(dir);
      }
    }
    return list;
  }

  pi.on("session_start", async (_event, ctx) => {
    const ui = ctx.ui;

    // 1) 工厂 widget：RPC 会静默丢弃，我们自行渲染并在 requestRender 时重渲染
    //    （magic-context TodoOverlay 的形态：注册一次，之后只靠 requestRender 更新）
    //
    //    注意：TUI 下组件生命周期由 TUI 管理（移除时会 invalidate）。我们接管后必须自己
    //    做同样的事，否则扩展的更新定时器/状态会让 widget「复活」——实测发现：
    //    setWidget(key, undefined) 后组件若仍在 requestRender，面板会重新出现。
    const widgets = new Map(); // key -> { active }
    const origSetWidget = ui.setWidget.bind(ui);
    ui.setWidget = (key, content, options) => {
      if (typeof content !== "function") {
        const entry = widgets.get(key);
        if (entry) {
          entry.active = false; // 之后的 requestRender 一律作废
          widgets.delete(key);
          try {
            entry.component?.invalidate?.();
          } catch {
            /* ignore */
          }
        }
        return origSetWidget(key, content, options);
      }
      let component;
      const entry = { active: true, component: undefined };
      widgets.set(key, entry);
      const render = (update) => {
        if (!entry.active) return; // 已移除：丢弃迟到的更新
        let lines = [];
        try {
          lines = component.render(WIDTH);
        } catch {
          /* 渲染抛错时保持上一次内容 */
          return;
        }
        void post("/side/widget", {
          key,
          lines,
          placement: options?.placement,
          update: Boolean(update),
        });
      };
      const stubTui = {
        requestRender: () => render(true),
        requestLayout: () => render(true),
        invalidate: () => {},
      };
      try {
        component = content(stubTui, ui.theme);
        entry.component = component;
      } catch (err) {
        widgets.delete(key);
        void post("/side/widget", { key, lines: [], error: String(err) });
        return;
      }
      render(false);
    };

    // 2) custom() 面板：把渲染结果交给服务端（前端目前还没有面板 UI，会返回 undefined
    //    ——与现状 SDK 宿主行为一致；将来前端加面板模态即可直接受益）
    ui.custom = async (factory, options) => {
      let component;
      try {
        component = await factory(
          { requestRender() {}, requestLayout() {}, invalidate() {} },
          ui.theme,
          {},
          () => {},
        );
      } catch {
        return undefined;
      }
      let lines = [];
      try {
        if (component) lines = component.render(WIDTH);
      } catch {
        /* ignore */
      }
      const answer = await post("/side/panel", { title: options?.title, lines });
      return answer?.value;
    };

    // 3) 对话框：必须由我们接管——RPC 的 stdin 在 session_start 期间未挂载，原生
    //    转发在此阶段必然死锁（已实测）。侧信道从第一个字节起就可用。
    const ask = async (method, payload, fallback) => {
      const answer = await post("/side/dialog", { method, ...payload });
      if (!answer || answer.cancelled) return fallback;
      if (method === "confirm") return Boolean(answer.confirmed ?? answer.value);
      return answer.value ?? fallback;
    };
    ui.select = (title, options) => ask("select", { title, options }, undefined);
    ui.confirm = (title, message) => ask("confirm", { title, message }, false);
    ui.input = (title, placeholder) => ask("input", { title, placeholder }, undefined);
    ui.editor = (title, prefill) => ask("editor", { title, prefill }, undefined);

    // 4) 主题：RPC 原生返回 {success:false}；记录即可（ANSI 换肤属后续工作）
    ui.setTheme = (name) => {
      void post("/side/theme", { name });
      return { success: true };
    };

    // 5) 上报 pi 内部信息（RPC 的 get_state 不包含这些）
    let tools = [];
    try {
      tools = pi.getActiveTools();
    } catch {
      /* ignore */
    }
    await post("/side/ready", {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      cwd: ctx.cwd,
      scopedModels: (ctx.scopedModels ?? []).map((s) => ({
        provider: s.model?.provider,
        id: s.model?.id,
        name: s.model?.name,
        thinkingLevel: s.thinkingLevel,
      })),
      commands: pi.getCommands(),
      tools,
      extensions: classifyExtensions(),
      sessionFile: ctx.sessionManager?.getSessionFile?.(),
    });
  });

  // 6) 扩展 RPC 没有的能力：reload（ExtensionCommandContext 才有）
  pi.registerCommand("pi-web:reload", {
    description: "Reload extensions and resources (pi-web bridge)",
    handler: async (_args, ctx) => {
      await ctx.reload();
      await post("/side/event", { type: "reloaded" });
    },
  });

  // 7) 诊断命令：用于端到端验证桥接的两条 UI 通道（工厂 widget / 对话框）
  pi.registerCommand("pi-web:demo-widget", {
    description: "Show a demo factory widget rendered through the bridge",
    handler: async (_args, ctx) => {
      let n = 0;
      ctx.ui.setWidget(
        "pi-web-demo",
        (tui) => {
          const timer = setInterval(() => {
            n += 1;
            tui.requestRender(); // 只有 requestRender，不重新注册 —— TodoOverlay 的更新方式
          }, 2000);
          return {
            render: () => [`[demo] factory widget (render #${n})`, "[demo] second line from the bridge"],
            invalidate: () => clearInterval(timer),
          };
        },
        { placement: "aboveEditor" },
      );
      await post("/side/event", { type: "demo-widget" });
    },
  });

  pi.registerCommand("pi-web:demo-clear", {
    description: "Remove the demo widget",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("pi-web-demo", undefined);
      await post("/side/event", { type: "demo-clear" });
    },
  });

  pi.registerCommand("pi-web:demo-dialog", {
    description: "Ask a confirm dialog rendered through the bridge",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("pi-web demo", "Did this dialog reach the browser?");
      await post("/side/event", { type: "demo-dialog", answer: ok });
    },
  });
}
