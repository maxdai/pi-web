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
import { basename, dirname, join, relative, resolve } from "node:path";
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
  /** 面板尺寸兜底（浏览器尚未上报时用）；实际渲染宽度取 fetchPanelGeometry()。 */
  const PANEL_ROWS = Number(process.env.PI_WEB_BRIDGE_PANEL_ROWS ?? 40);
  const PANEL_COLS = Number(process.env.PI_WEB_BRIDGE_PANEL_COLS ?? 100);
  let themes = null; // { dark, light }
  let themePoll = null;
  let pkgDirCache = null;
  let builtinNamesCache = null;
  const widgets = new Map(); // key -> { active, component, render }

  /** 运行中的 pi 包目录：node_modules/.bin/pi -> <pkg>/dist/bundle/cli.js */
  function resolvePkgDir() {
    if (pkgDirCache) return pkgDirCache;
    pkgDirCache = resolve(dirname(realpathSync(process.argv[1])), "../..");
    return pkgDirCache;
  }

  /** Pi 内置扩展的权威名单（<pkg>/dist/extensions/index.js 的 builtInExtensions）。
   *  用途：从工具的 sourceInfo 反推扩展时，把 `builtin:bash`/`find`/`ls` 这类**核心内置工具**
   *  与 `builtin:codemode`/`tool-search` 这类**内置扩展**区分开。 */
  async function loadBuiltinNames() {
    if (builtinNamesCache) return builtinNamesCache;
    try {
      const mod = await import(
        pathToFileURL(join(resolvePkgDir(), "dist", "extensions", "index.js")).href
      );
      builtinNamesCache = new Set((mod.builtInExtensions ?? []).map((e) => e.name));
    } catch (err) {
      console.error(`[pi-web-bridge] builtin list unavailable: ${err.message}`);
      builtinNamesCache = new Set();
    }
    return builtinNamesCache;
  }

  async function loadThemes() {
    if (themes) return themes;
    try {
      // 运行中的 pi 入口：node_modules/.bin/pi -> <pkg>/dist/bundle/cli.js
      const pkgDir = resolvePkgDir();
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

  /** 面板可用列/行数：由网页按实际版面量出后经服务端中转（见 app.js sendPanelGeometry）。
   *  组件按这个宽度渲染才不会折行、也不需要横向滚动。取不到时回退到环境变量/默认值。 */
  async function fetchPanelGeometry() {
    const fallback = { cols: PANEL_COLS, rows: PANEL_ROWS };
    try {
      const res = await fetch(`${url}/side/geometry`, { headers: { "x-pi-web-token": token } });
      const data = await res.json().catch(() => undefined);
      const cols = Number(data?.cols);
      const rows = Number(data?.rows);
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 20 && rows >= 5) {
        return { cols: Math.floor(cols), rows: Math.floor(rows) };
      }
    } catch {
      /* 侧信道暂时不可用 */
    }
    return fallback;
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
  /** 本地扩展的展示名——与 SDK 宿主的 describeLocalExtension 同义：
   *  `~/.pi/agent/extensions/refresh-deepinfra/index.ts` → `refresh-deepinfra`
   *  （早先直接用 basename 会得到 `index`） */
  function describeLocalExtension(entryPath, baseDir) {
    const rel = baseDir
      ? relative(baseDir, entryPath).replace(/\\/g, "/")
      : entryPath.replace(/\\/g, "/");
    let name = rel.replace(/^extensions\//, "");
    name = name.replace(/\/index\.[jt]s$/, "").replace(/\.[jt]s$/, "");
    return name || rel;
  }

  async function classifyExtensions() {
    // 候选来源：
    //   · `source === "extension"` 的命令（prompt/skill 的 .md 不算扩展——曾经把它们当扩展，
    //     侧栏就多出一堆 .md 条目）
    //   · 所有工具的 sourceInfo（有些内置扩展只注册工具、不注册命令，如 codemode / tool-search）
    const selfExtension = process.env.PI_WEB_BRIDGE_EXTENSION ?? "";
    const candidates = new Map(); // path -> sourceInfo
    const consider = (p, info) => {
      if (!p || candidates.has(p)) return;
      if (selfExtension && resolve(p) === resolve(selfExtension)) return; // 桥接自身不算扩展
      candidates.set(p, info);
    };
    try {
      for (const cmd of pi.getCommands()) {
        if (cmd.source !== "extension") continue;
        consider(cmd.sourceInfo?.path, cmd.sourceInfo);
      }
    } catch {
      /* ignore */
    }
    try {
      for (const tool of pi.getAllTools()) {
        consider(tool.sourceInfo?.path, tool.sourceInfo);
      }
    } catch {
      /* ignore */
    }

    const builtinNames = await loadBuiltinNames();
    const list = [];
    const seen = new Set();
    for (const [p, info] of candidates) {
      if (p.startsWith("<") && p.endsWith(">")) continue; // inline 虚拟路径：跳过
      if (p.startsWith("builtin:")) {
        const name = p.slice("builtin:".length);
        // 只保留真正的内置**扩展**；核心内置工具（bash/find/ls/read…）不在内置扩展名单里
        if (!builtinNames.has(name)) continue;
        const key = `builtin:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ name, version: "builtin" });
        }
        continue;
      }
      if (info?.origin === "top-level") {
        const name = describeLocalExtension(p, info?.baseDir);
        const key = `local:${p}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ name, version: info.scope ?? "local" });
        }
        continue;
      }
      let dir = dirname(p);
      while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) break;
        dir = dirname(dir);
      }
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const key = pkg.name ?? p;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({
            name: pkg.name ?? key,
            version: info?.scope ? `${pkg.version ?? "?"} · ${info.scope}` : (pkg.version ?? "?"),
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

    // 2) custom()：把扩展的 TUI 组件**渲染成文本行**，交浏览器以只读模态呈现
    //
    //    为什么这里必须真渲染（2026-10 实测，与 SDK 宿主行为不同的根因）：
    //    · Pi 在 RPC 模式**仍然绑定了 UI 上下文** → 扩展看到的 `ctx.hasUI === true`
    //      → 扩展会走「TUI 对话框」分支，例如 magic-context 的 /ctx-status：
    //        `if (ctx.hasUI) { await showStatusDialog(pi, ctx, ...); return; }`（文本兜底在 else 之后）
    //      SDK 宿主之所以显示**文本**，是因为它自己构造 `hasUI:false` 的上下文去调命令 handler
    //      （它能拿到 extensionRunner.getCommand）；我们经 Pi 的 `prompt` 执行命令，拿不到这个杠杆。
    //      所以在原生引擎里 custom() 若不真渲染，用户**什么都看不到**。
    //    · 组件依赖终端尺寸：实测 StatusDialogComponent.render() 读 `tui.terminal.rows`，
    //      缺了会抛 `Cannot read properties of undefined (reading 'rows')`（曾因此得到空面板）。
    //    · 渲染是**只读快照**：组件内的按键交互（滚动/翻页）网页端不支持；组件若自己调
    //      `done(value)` 则采用该结论，否则用户关闭面板即视为取消。
    ui.custom = async (factory, options) => {
      let doneValue;
      let hasDone = false;
      // 按**网页面板实际可用列/行数**渲染（组件在 TUI 下也是按终端宽度排版）；
      // 量不到则回退 PANEL_COLS/PANEL_ROWS，避免装不下而折行折断框图。
      const { cols: panelCols, rows: panelRows } = await fetchPanelGeometry();
      const stubTui = {
        requestRender() {},
        requestLayout() {},
        invalidate() {},
        requestFocus() {},
        terminal: { rows: panelRows, cols: panelCols, width: panelCols, height: panelRows },
      };
      let component;
      try {
        component = await factory(stubTui, ui.theme, {}, (value) => {
          hasDone = true;
          doneValue = value;
        });
      } catch (err) {
        console.error(`[pi-web-bridge] custom() factory failed: ${err.message}`);
        return hasDone ? doneValue : undefined;
      }
      let lines = [];
      try {
        if (component) lines = component.render(panelCols) ?? [];
      } catch (err) {
        console.error(`[pi-web-bridge] custom() render failed: ${err.message}`);
        lines = [`[pi-web] 组件渲染失败：${err.message}`];
      }
      const answer = await post("/side/panel", {
        title: options?.title,
        lines,
        value: hasDone ? doneValue : undefined,
      });
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
    //    tools 形状与 SDK 宿主一致：只列**当前启用**的工具，且是 {name, description} 对象
    //    （前端按 t.name 渲染；早先直接传 getActiveTools() 的字符串数组 → 侧栏 Tools 空白）
    let tools = [];
    try {
      const active = new Set(pi.getActiveTools());
      tools = pi
        .getAllTools()
        .filter((t) => active.has(t.name))
        .map((t) => ({ name: t.name, description: t.description }));
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
      extensions: await classifyExtensions(),
      sessionFile: ctx.sessionManager?.getSessionFile?.(),
      themesLoaded: Boolean(loaded),
    });
  });

  pi.on("session_shutdown", async () => {
    if (themePoll) clearInterval(themePoll);
    themePoll = null;
  });

  // 6) 扩展 RPC 没有的能力：reload（ExtensionCommandContext 才有）
  //
  //    注意：扩展命令在 pi 里是「立即执行、即使正在流式输出」（agent-session.ts:2060 注释），
  //    因此**必须自己加防护**——SDK 宿主的 /reload 会检查 session.isIdle / isCompacting 并拒绝。
  //    ctx.isIdle() 的语义已覆盖 agent run / compaction / branch summary / retry / 排队消息。
  pi.registerCommand("pi-web:reload", {
    description: "Reload extensions and resources (pi-web bridge)",
    handler: async (_args, ctx) => {
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      if (!idle) {
        await post("/side/event", { type: "reload-refused", reason: "busy" });
        return;
      }
      await ctx.reload();
      await post("/side/event", { type: "reloaded", idleBeforeReload: idle });
    },
  });

  // 7) 诊断命令：用于端到端验证桥接的 UI 通道（工厂 widget / 对话框 / 面板）。
  //    默认**不注册**——它们会出现在用户的 `/` 菜单里，与 SDK 版产生可见差异。
  //    需要时用 PI_WEB_BRIDGE_DEMO=1（原型服务端 `--demo`）开启。
  if (process.env.PI_WEB_BRIDGE_DEMO !== "1") return;

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
      // 组件刻意读 tui.terminal.rows —— 与真实扩展组件（StatusDialogComponent）同样的要求
      const picked = await ctx.ui.custom(
        (_tui) => ({
          render: () => [
            "[demo] custom() panel line 1",
            "[demo] line 2 — 由桥接渲染成文本行",
            `[demo] terminal.rows = ${_tui.terminal.rows}`,
          ],
          invalidate: () => {},
        }),
        { title: "pi-web demo panel" },
      );
      await post("/side/event", { type: "demo-panel", value: picked ?? null });
    },
  });
}
