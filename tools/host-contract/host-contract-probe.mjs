/**
 * 宿主契约探针 A（tools/host-contract）
 *
 * 在**真实 pi 进程内**探测 pi-web 所依赖的宿主内部约定，把结果以单行 JSON 打到 stderr：
 *   HOST-CONTRACT-REPORT {...}
 *
 * 这些约定是 pi-web「RPC + 注入扩展」方案的立足点（见 pi-web-design.md §16）。
 * 每次 Pi 版本更迭后，跑 `node tools/host-contract/check-host-contract.mjs` 与本仓库的
 * `host-contract.baseline.json` 对比，即可发现偏移。
 *
 * 与 probe B 配对：A 改写 ui.setTitle，B 稍后调用它 —— 用于验证「ctx.ui 是共享可变对象」
 * 这一**最关键**的假设（改写能否被其他扩展看到）。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const report = {};
    const ui = ctx.ui;
    let origSetTitle;

    // ---- 1) 上下文与 UI 对象形态
    report.mode = ctx.mode;
    report.hasUI = ctx.hasUI;
    report.cwdType = typeof ctx.cwd;
    report.uiIsObject = typeof ui === "object" && ui !== null;
    report.uiMethods = Object.keys(ui).sort();
    const themeDesc = Object.getOwnPropertyDescriptor(ui, "theme");
    report.themeDescriptor = {
      configurable: Boolean(themeDesc?.configurable),
      writable: Boolean(themeDesc?.writable),
      kind: themeDesc?.get ? "getter" : typeof themeDesc?.value,
    };
    try {
      report.uiThemeFg = ui.theme.fg("accent", "X");
    } catch (err) {
      report.uiThemeFg = `ERR:${err.message}`;
    }
    report.signatures = Object.fromEntries(
      ["select", "confirm", "input", "editor", "custom", "setWidget", "setStatus", "notify", "setTheme", "setTitle"]
        .map((k) => [k, typeof ui[k]]),
    );

    // ---- 2) 改写可行性 + 跨扩展可见性（B 会调用被改写的 setTitle）
    globalThis.__hostProbeSawSetTitle = false;
    try {
      origSetTitle = ui.setTitle?.bind(ui);
      ui.setTitle = (title) => {
        globalThis.__hostProbeSawSetTitle = true;
        try {
          origSetTitle?.(title);
        } catch {
          /* ignore */
        }
      };
      report.setTitlePatchable = true;
    } catch (err) {
      report.setTitlePatchable = `ERR:${err.message}`;
    }

    // ---- 3) 上下文里的其它依赖
    report.scopedModelsEntryKeys = Object.keys((ctx.scopedModels ?? [])[0] ?? {});
    report.scopedModelsCount = (ctx.scopedModels ?? []).length;
    report.sessionManager = {
      getSessionFile: typeof ctx.sessionManager?.getSessionFile,
      ownKeys: Object.keys(ctx.sessionManager ?? {}).slice(0, 10),
    };

    // ---- 4) ExtensionAPI：命令 / 工具 / 注册
    try {
      const commands = pi.getCommands();
      report.commandCount = commands.length;
      report.commandKeys = commands[0] ? Object.keys(commands[0]).sort() : [];
      report.sourceInfoKeys = commands[0]?.sourceInfo ? Object.keys(commands[0].sourceInfo).sort() : [];
      report.builtinPathCount = commands.filter((c) => String(c.sourceInfo?.path ?? "").startsWith("builtin:")).length;
      report.commandSources = [...new Set(commands.map((c) => c.source))].sort();
    } catch (err) {
      report.commandsError = err.message;
    }
    try {
      const tools = pi.getActiveTools();
      report.activeTools = { type: typeof tools, count: tools.length };
    } catch (err) {
      report.activeToolsError = err.message;
    }
    try {
      pi.registerCommand("host-contract-probe", { description: "probe", handler: async () => {} });
      report.registerCommand = "ok";
    } catch (err) {
      report.registerCommand = `ERR:${err.message}`;
    }

    // ---- 5) 包定位与 Theme 构造（换肤依赖）
    try {
      const argv1 = process.argv[1] ?? "";
      const pkgDir = resolve(dirname(realpathSync(argv1)), "../..");
      report.argv1 = argv1;
      report.pkgDir = pkgDir;
      report.pkgFiles = {
        distIndex: existsSync(join(pkgDir, "dist", "index.js")),
        themeDark: existsSync(join(pkgDir, "dist", "modes", "interactive", "theme", "dark.json")),
        themeLight: existsSync(join(pkgDir, "dist", "modes", "interactive", "theme", "light.json")),
      };
      const mod = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);
      report.themeExport = typeof mod.Theme;
      // scoped models 即时生效（§15.11.1）所依赖的三处事实：
      //  ① 包公开导出解析助手（语义与 TUI 同实现）；② ctx.modelRegistry.runtime 可达；
      //  ③ ctx.scopedModels 是**同一个数组对象**（就地改才等价于 session.setScopedModels）
      report.scopedResolverExport = typeof mod.resolveModelScopeWithDiagnostics === "function";
      report.scopedRegistryRuntime = typeof ctx.modelRegistry?.runtime?.getAvailableSnapshot === "function";
      try {
        const arr = ctx.scopedModels;
        report.scopedSharedArray = Array.isArray(arr) && ctx.scopedModels === arr;
      } catch (err) {
        report.scopedSharedArray = `ERR:${err.message}`;
      }
      const json = JSON.parse(
        readFileSync(join(pkgDir, "dist", "modes", "interactive", "theme", "dark.json"), "utf8"),
      );
      report.themeJsonKeys = Object.keys(json).sort();
      report.themeColorEntrySample = Object.entries(json.colors ?? {}).slice(0, 2);
      // 与 bridge.mjs 同样的构造方式：解析 vars + 按 ThemeBg 集合切分背景/前景
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
      const fg = {};
      const bg = {};
      for (const [key, value] of Object.entries(json.colors ?? {})) {
        const resolved = String(value).startsWith("#") ? value : (json.vars?.[value] ?? value);
        if (BG_KEYS.has(key)) bg[key] = resolved;
        else fg[key] = resolved;
      }
      const built = new mod.Theme(fg, bg, "truecolor", { name: "probe" });
      report.builtThemeFg = built.fg("accent", "X");
      report.builtThemeFgLight = (() => {
        try {
          const lightJson = JSON.parse(
            readFileSync(join(pkgDir, "dist", "modes", "interactive", "theme", "light.json"), "utf8"),
          );
          const lfg = {};
          const lbg = {};
          for (const [key, value] of Object.entries(lightJson.colors ?? {})) {
            const resolved = String(value).startsWith("#") ? value : (lightJson.vars?.[value] ?? value);
            if (BG_KEYS.has(key)) lbg[key] = resolved;
            else lfg[key] = resolved;
          }
          return new mod.Theme(lfg, lbg, "truecolor", { name: "light" }).fg("accent", "X");
        } catch (e) {
          return `ERR:${e.message}`;
        }
      })();
    } catch (err) {
      report.pkgError = err.message;
    }

    // ---- 6) 等 B 调用后汇总
    setTimeout(() => {
      report.crossExtensionUiVisible = globalThis.__hostProbeSawSetTitle === true;
      if (origSetTitle) {
        try {
          ui.setTitle = origSetTitle;
        } catch {
          /* ignore */
        }
      }
      console.error(`HOST-CONTRACT-REPORT ${JSON.stringify(report)}`);
    }, 900);
  });
}
