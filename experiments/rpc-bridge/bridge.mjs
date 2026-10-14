/**
 * pi-web bridge extension —— 原型（experiments/rpc-bridge）
 *
 * 由 pi-web 以 `--extension` 注入到**原生 pi** 进程内，负责 RPC 模式拿不到的那层：
 *   · 工厂式 widget（RPC 只支持字符串数组，工厂会被静默丢弃）+ 组件生命周期
 *   · custom() 面板（RPC 返回 undefined）
 *   · 对话框（RPC 原生的 stdin 通道在 session_start 期间尚未挂载 → 必死锁）
 *   · 主题换肤（RPC 原生返回 {success:false}；扩展的 ANSI 颜色跟随我们的主题对象）
 *   · 上报 pi 内部信息（cwd / scopedModels / commands / tools / extensions）
 *
 * 设计依据见 pi-web-design.md §15。原理：`ctx.ui` 是 runner 的**单一共享可变对象**
 * （runner.ts `get ui() { return runner.uiContext }`），改写它的成员会影响所有扩展。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WIDTH = 78;
const THEME_POLL_MS = 2000;
const BG_KEYS = new Set([
  "selectedBg",
  "scrollbarThumb",
  "searchMatchBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);

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

  // ------------------------------------------------------------- 主题（换肤）
  // 扩展生成的 ANSI（setStatus / widget）取色自 `ctx.ui.theme`。RPC 的 theme 是固定的
  // 且用 256 色，无法切换；我们在桥接里构造 Pi 自己的 Theme（truecolor，与 SDK 宿主一致）
  // 并改写 ui.theme，浏览器切换亮/暗时由服务端经侧信道告知，随后重渲染 widget。
  let themeName = "dark";
  let themes = null; // { dark, light }
  let themePoll = null;
  const widgets = new Map(); // key -> { active, component, render }

  async function loadThemes() {
    if (themes) return themes;
    try {
      // 运行中的 pi 入口：node_modules/.bin/pi -> <pkg>/dist/bundle/cli.js
      const pkgDir = resolve(dirname(realpathSync(process.argv[1])), "../..");
      const mod = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);
      const themeDir = join(pkgDir, "dist", "modes", "interactive", "theme");
      const build = (name) => {
        const json = JSON.parse(readFileSync(join(themeDir, `${name}.json`), "utf8"));
        const fg = {};
        const bg = {};
        for (const [key, value] of Object.entries(json.colors)) {
          const resolved = String(value).startsWith("#") ? value : (json.vars?.[value] ?? value);
          if (BG_KEYS.has(key)) bg[key] = resolved;
          else fg[key] = resolved;
        }
        return new mod.Theme(fg, bg, "truecolor", { name });
      };
      themes = { dark: build("dark"), light: build("light") };
      console.error(`[pi-web-bridge] themes loaded from ${themeDir}`);
    } catch (err) {
      // 取不到就保持宿主主题（功能降级，不影响会话可用性）
      console.error(`[pi-web-bridge] theme load failed, keeping host theme: ${err.message}`);
      themes = null;
    }
    return themes;
  }

  async function pollTheme() {
    try {
      const res = await fetch(`${url}/side/theme`, { headers: { "x-pi-web-token": token } });
      const data = await res.json().catch(() => undefined);
      const next = data?.name === "light" ? "light" : "dark";
      if (next === themeName) return;
      themeName = next;
      for (const entry of widgets.values()) {
        if (entry.active) entry.render(true); // 立即换色
      }
    } catch {
      /* 侧信道暂时不可用：下次再试 */
    }
  }

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
        const name = basename(p).replace(/\.(ts|js|mjs|cjs)$/, "");
        const key = `local:${p}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ name, version: info.scope ?? "local" });
        }
        continue;
      }
      let dir = dirname(p);
      while (dir !== dirname(dir)) {
        const pkgFile = join(dir, "package.json");
        if (existsSync(pkgFile)) break;
        dir = dirname(dir);
      }
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
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
    }
    return list;
  }

  pi.on("session_start", async (_event, ctx) => {
    const ui = ctx.ui;
    const hostTheme = ui.theme;

    // 0) 换肤：theme 取我们构造的 Pi Theme（暗/亮），失败时保持宿主主题
    const loaded = await loadThemes();
    if (loaded) {
      Object.defineProperty(ui, "theme", {
        configurable: true,
        enumerable: true,
        get: () => loaded[themeName] ?? hostTheme,
      });
      themePoll = setInterval(() => void pollTheme(), THEME_POLL_MS);
      themePoll.unref?.();
    }

    // 1) 工厂 widget：RPC 会静默丢弃，我们自行渲染并在 requestRender 时重渲染
    //    （magic-context TodoOverlay 的形态：注册一次，之后只靠 requestRender 更新）
    //
    //    注意：TUI 下组件生命周期由 TUI 管理（移除时会 invalidate）。我们接管后必须自己
    //    做同样的事，否则扩展的更新定时器/状态会让 widget「复活」——实测发现：
    //    setWidget(key, undefined) 后组件若仍在 requestRender，面板会重新出现。
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
      const entry = { active: true, component: undefined, render: undefined };
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
      entry.render = render;
      widgets.set(key, entry);
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

    // 2) custom() 面板：把渲染结果交给服务端在浏览器里以模态呈现
    ui.custom = async (factory, options) => {
      let doneValue;
      let hasDone = false;
      let component;
      try {
        component = await factory(
          { requestRender() {}, requestLayout() {}, invalidate() {} },
          ui.theme,
          {},
          (value) => {
            hasDone = true;
            doneValue = value;
          },
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
      const answer = await post("/side/panel", {
        title: options?.title,
        lines,
        // 组件若已自行给出结论（done(value)），一并带上，服务端据此决定返回值
        value: hasDone ? doneValue : undefined,
      });
      // 用户在网页上关闭面板后，若组件没有自己给结论，则由服务端兜底返回
      return answer && "value" in answer ? answer.value : hasDone ? doneValue : undefined;
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

    // 4) setTheme：RPC 原生返回 {success:false}；记录并接受（真正的换肤见上面）
    ui.setTheme = (name) => {
      themeName = name === "light" ? "light" : "dark";
      void post("/side/theme-ack", { name: themeName });
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
      themesLoaded: Boolean(loaded),
    });
  });

  pi.on("session_shutdown", async () => {
    if (themePoll) clearInterval(themePoll);
    themePoll = null;
  });

  // 6) 扩展 RPC 没有的能力：reload（ExtensionCommandContext 才有）
  pi.registerCommand("pi-web:reload", {
    description: "Reload extensions and resources (pi-web bridge)",
    handler: async (_args, ctx) => {
      await ctx.reload();
      await post("/side/event", { type: "reloaded" });
    },
  });

  // 7) 诊断命令：用于端到端验证桥接的 UI 通道（工厂 widget / 对话框 / 面板）
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
            render: () => [
              `[demo] factory widget (render #${n})`,
              `[demo] accent color: ${ctx.ui.theme.fg("accent", "ACCENT")}`,
            ],
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

  pi.registerCommand("pi-web:demo-panel", {
    description: "Show a custom() panel rendered through the bridge",
    handler: async (_args, ctx) => {
      const picked = await ctx.ui.custom(
        async () => ({
          render: () => ["[demo] custom() panel line 1", "[demo] line 2 — rendered via the bridge"],
          invalidate: () => {},
        }),
        { title: "pi-web demo panel" },
      );
      await post("/side/event", { type: "demo-panel", value: picked ?? null });
    },
  });
}
