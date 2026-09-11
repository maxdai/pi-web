/**
 * Web UI context for Pi extensions.
 *
 * Maps Pi's ExtensionUIContext (select/confirm/input/editor/notify/...) to the
 * browser via WebSocket: dialogs become pending requests resolved by the
 * browser's `extension_ui_response` messages; fire-and-forget UI events
 * (notify/setStatus/setTitle/setWidget) are broadcast immediately.
 *
 * The wire format matches Pi's RPC extension UI requests so the existing
 * browser client (static/app.js) renders them without changes.
 */
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type UiEventSink = (obj: unknown) => void;

interface PendingDialog {
  /** Settles the dialog promise (parse + cleanup happen in createDialog). */
  resolve: (value: unknown) => void;
  /** Wire payload (with id) so a browser connecting later can be re-sent it. */
  request: Record<string, unknown>;
  /** Timer currently armed for this dialog (extension timeout or fallback). */
  timer?: ReturnType<typeof setTimeout>;
  /** Absolute deadline (epoch ms) when the extension supplied a timeout. */
  deadline?: number;
  /** The extension's own `opts.timeout` - honoured as-is, TUI parity. */
  extensionTimeout?: number;
  /** True while `timer` is the no-browser fallback (cancelled on reconnect). */
  fallbackTimer: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Fallback dialog timeout (pi-web specific guard).
 *
 * TUI and RPC wait for an answer indefinitely - the user is at the terminal,
 * or the RPC client owns the timeout. With a browser attached pi-web does the
 * same: a dialog waits forever, so an answer is never taken away from the user
 * just because they were busy elsewhere.
 *
 * The one case that needs a guard is a browser that is NOT attached (tab
 * closed mid-turn): nobody can answer, and an extension awaiting the dialog
 * would block the agent loop forever. Then - and only then - the dialog
 * settles after this grace period with its default value (confirm -> false,
 * others -> undefined). Reconnecting cancels the fallback, so a user who comes
 * back gets as much time as they need.
 *
 * Extensions that pass their own `timeout` (ms) keep it exactly (that timer is
 * their decision, never cancelled here).
 */
const DIALOG_FALLBACK_TIMEOUT_MS = 10 * 60_000;

export interface WebUIContextOptions {
  /** Override the no-browser fallback timeout (tuning / tests). */
  fallbackTimeoutMs?: number;
}

/**
 * Load a Pi theme (dark.json/light.json colors) so extensions calling
 * ui.theme.fg("accent", text) / .bg(...) get REAL ANSI escapes — identical
 * to TUI (interactive-mode.ts returns the same Theme instance from
 * ctx.ui.theme). The browser renders the escapes as colored spans (see
 * app.js ansiToHtml), acting as the "terminal".
 *
 * The Theme class is exported by the Pi SDK and the theme JSONs ship in the
 * package dist. Constructing the Theme directly keeps us independent of
 * initTheme's global side effects and gives the same result.
 */
function createWebTheme(name: "dark" | "light" = "dark"): Theme {
  try {
    const mainEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const themeJson = JSON.parse(
      readFileSync(join(dirname(mainEntry), "modes", "interactive", "theme", `${name}.json`), "utf8"),
    ) as { vars: Record<string, string>; colors: Record<string, string> };
    const fgColors: Record<string, string> = {};
    const bgColors: Record<string, string> = {};
    // theme colors refer to vars by name (e.g. "accent" -> "#8abeb7")
    // or carry a literal hex. Split background keys from foreground keys by
    // the explicit ThemeBg set (mirrors Pi's createTheme in theme.ts) rather
    // than a "Bg" suffix: scrollbarThumb is a ThemeBg without that suffix.
    const bgKeys = new Set([
      "selectedBg",
      "scrollbarThumb",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ]);
    for (const [key, value] of Object.entries(themeJson.colors)) {
      const resolved = value.startsWith("#") ? value : themeJson.vars[value] ?? value;
      if (bgKeys.has(key)) {
        bgColors[key] = resolved;
      } else {
        fgColors[key] = resolved;
      }
    }
    return new PiTheme(fgColors as never, bgColors as never, "truecolor", { name });
  } catch {
    // Last-resort identity: return the text argument unchanged (no ANSI).
    return new Proxy({} as Theme, {
      get(_target, prop) {
        if (prop === "name") return "dark";
        if (prop === "isDark") return true;
        return (...args: unknown[]) => {
          const textArg = args.length > 1 ? args[1] : args[0];
          return typeof textArg === "string" ? textArg : "";
        };
      },
    });
  }
}

export class WebUIContext implements ExtensionUIContext {
  private readonly pending = new Map<string, PendingDialog>();
  private readonly sink: UiEventSink;
  private webTheme: Theme = createWebTheme();
  /** Latest setStatus values per key, so late-connecting browsers get current state */
  private readonly statusMap = new Map<string, string>();
  /** Latest setWidget lines per key (persistent widgets, e.g. TodoOverlay):
   * replayed to late-connecting browsers like setStatus snapshots. */
  private readonly widgetMap = new Map<string, { lines: string[] | undefined; placement?: string }>();
  private readonly fallbackTimeoutMs: number;
  /** Whether a browser is attached right now (updated by the server). */
  private browserAttached = false;

  /** Current widget snapshot (key -> lines) for new connections. */
  getWidgetSnapshot(): Record<string, { lines: string[] | undefined; placement?: string }> {
    return Object.fromEntries(this.widgetMap);
  }

  constructor(sink: UiEventSink, options: WebUIContextOptions = {}) {
    this.sink = sink;
    this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? DIALOG_FALLBACK_TIMEOUT_MS;
    // Pi's ExtensionRunner wraps the ui context with `{...ui}` (a shallow
    // spread) when building the extension ctx - class prototype members
    // (methods AND the theme getter) would be LOST by that spread (only own
    // enumerable properties survive). Copy prototype methods onto the
    // instance as own bound properties, and expose theme as an own
    // property, so extensions see the same shape as TUI's object-literal
    // UIContext (all methods + theme as own props).
    const proto = Object.getPrototypeOf(this);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.value === "function") {
        (this as unknown as Record<string, unknown>)[name] = desc.value.bind(this);
      }
    }
    // Theme: the prototype getter is not picked up by `{...}` and the own
    // property cannot shadow a getter-only prototype via assignment. Define
    // an own enumerable getter returning webTheme (fresh after setWebTheme).
    Object.defineProperty(this, "theme", {
      configurable: true,
      enumerable: true,
      get: () => this.webTheme,
    });
  }

  /** Current extension status snapshot (key -> text) for new connections. */
  getStatusSnapshot(): Record<string, string> {
    return Object.fromEntries(this.statusMap);
  }

  /** Drop state tied to the previous session (dialogs + status snapshots). */
  clearSessionState(): void {
    // Copy first: settling deletes from the map while we iterate.
    for (const [id, pending] of [...this.pending.entries()]) {
      pending.resolve(undefined);
      // The browser may still show the dialog; close it there too.
      this.dismissDialog(id, "session-switch");
    }
    this.pending.clear();
    this.statusMap.clear();
    this.widgetMap.clear();
  }

  /** Pending dialogs (wire payloads) for replay to a newly connected browser. */
  getPendingDialogs(): Array<Record<string, unknown>> {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** Handle a browser `extension_ui_response` message. */
  respond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    // Cleanup happens inside settle() (timer / abort listener / map entry).
    if (response.cancelled) {
      pending.resolve(undefined);
    } else if (response.confirmed !== undefined) {
      pending.resolve(response.confirmed);
    } else {
      pending.resolve(response.value);
    }
    return true;
  }

  /** Tell the browser to close a dialog that already settled server-side. */
  private dismissDialog(id: string, reason: "timeout" | "aborted" | "session-switch"): void {
    this.sink({ type: "dialog_dismissed", id, reason });
  }

  /**
   * Browser presence changed (WS connect/disconnect). Only dialogs without an
   * extension timeout are affected: while a browser is attached they wait
   * forever (TUI parity - never take an answer away from the user), while no
   * browser is attached a fallback timer keeps a closed tab from blocking the
   * agent loop. Reconnecting cancels the fallback.
   */
  setBrowserAttached(attached: boolean): void {
    if (this.browserAttached === attached) return;
    this.browserAttached = attached;
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.extensionTimeout !== undefined) continue; // extension's own timer
      if (attached) {
        if (entry.fallbackTimer && entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
          entry.fallbackTimer = false;
        }
      } else if (!entry.timer) {
        this.armFallbackTimer(id, entry);
      }
    }
  }

  /** Arm the no-browser fallback (settles with the dialog default). */
  private armFallbackTimer(id: string, entry: PendingDialog): void {
    entry.fallbackTimer = true;
    entry.timer = setTimeout(() => {
      entry.resolve(undefined);
      this.dismissDialog(id, "timeout");
    }, this.fallbackTimeoutMs);
  }

  private createDialog<T>(
    request: Record<string, unknown>,
    opts: ExtensionUIDialogOptions | undefined,
    defaultValue: T,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const id = crypto.randomUUID();
    // Same as Pi's RPC/TUI: an already-aborted dialog settles immediately.
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    return new Promise<T>((resolve) => {
      let settled = false;
      const cleanup = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
        this.pending.delete(id);
      };
      const settle = (value: unknown, useDefault: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(useDefault ? defaultValue : parse(value));
      };
      const onAbort = () => {
        settle(undefined, true);
        this.dismissDialog(id, "aborted");
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      const extensionTimeout =
        typeof opts?.timeout === "number" && opts.timeout > 0 ? opts.timeout : undefined;
      const deadline = extensionTimeout !== undefined ? Date.now() + extensionTimeout : undefined;
      const entry: PendingDialog = {
        resolve: (value) => settle(value, false),
        // `deadline` lets the browser show the same countdown TUI does.
        request: deadline !== undefined ? { ...request, id, deadline } : { ...request, id },
        deadline,
        extensionTimeout,
        fallbackTimer: false,
        signal: opts?.signal,
        onAbort,
      };
      this.pending.set(id, entry);
      if (extensionTimeout !== undefined) {
        // The extension asked for this deadline - honour it exactly (TUI
        // shows the same countdown and auto-dismisses on expiry).
        entry.timer = setTimeout(() => {
          settle(undefined, true);
          this.dismissDialog(id, "timeout");
        }, extensionTimeout);
      } else if (!this.browserAttached) {
        this.armFallbackTimer(id, entry);
      }
      this.sink({ type: "extension_ui_request", id, ...request, ...(deadline !== undefined ? { deadline } : {}) });
    });
  }

  // ------------------------------------------------------------------
  // Dialogs (browser resolves via extension_ui_response)
  // ------------------------------------------------------------------

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.createDialog(
      { method: "select", title, options, timeout: opts?.timeout },
      opts,
      undefined,
      (v) => (typeof v === "string" ? v : undefined),
    );
  }

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.createDialog(
      { method: "confirm", title, message, timeout: opts?.timeout },
      opts,
      false,
      (v) => v === true,
    );
  }

  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.createDialog(
      { method: "input", title, placeholder, timeout: opts?.timeout },
      opts,
      undefined,
      (v) => (typeof v === "string" ? v : undefined),
    );
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.createDialog({ method: "editor", title, prefill }, undefined, undefined, (v) =>
      typeof v === "string" ? v : undefined,
    );
  }

  // ------------------------------------------------------------------
  // Fire-and-forget UI events (broadcast to browser)
  // ------------------------------------------------------------------

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.sink({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType: type });
  }

  setStatus(key: string, text: string | undefined): void {
    if (text === undefined || text === null) {
      this.statusMap.delete(key);
    } else {
      this.statusMap.set(key, text);
    }
    this.sink({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: key, statusText: text });
  }

  setTitle(title: string): void {
    this.sink({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setTitle", title });
  }

  setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    let lines: string[] | undefined;
    if (Array.isArray(content)) {
      lines = content.map((l) => String(l));
    } else if (typeof content === "function") {
      // Some extensions (e.g. magic-context's TodoOverlay) pass a TUI
      // component factory instead of string lines. Web has no TUI renderer,
      // but the factory yields a render(width) -> string[] that we can
      // evaluate with a no-op tui stub and broadcast as text lines - the
      // browser renders them (with ANSI colors) in the widgets panel.
      try {
        const width = 78;
        let component: { render(w: number): string[] } | undefined;
        const stubTui = {
          // TUI semantics: after registration, updates flow through
          // tui.requestRender() -> the component's render() is re-invoked
          // with CURRENT state. Without this a widget is frozen at its
          // first-registration content (magic-context's todos overlay
          // updates via requestRender, never via setWidget, so the browser
          // kept showing the initial todo list).
          requestRender: () => {
            if (!component || typeof component.render !== "function") return;
            let fresh: string[] | undefined;
            try {
              const out = component.render(width);
              if (Array.isArray(out)) fresh = out.map((l) => String(l));
            } catch {
              // A throwing render must not wipe the widget: keep last lines.
              return;
            }
            this.broadcastWidget(key, fresh, options?.placement);
          },
          invalidate: () => {
            // TUI calls invalidate while tearing the widget down; the web
            // host never tears a widget down on its own.
          },
        };
        component = (content as (tui: unknown, theme: Theme) => { render(w: number): string[] })(
          stubTui,
          this.webTheme,
        );
        const render = component && component.render;
        if (typeof render === "function") {
          const out = render(width);
          if (Array.isArray(out)) lines = out.map((l) => String(l));
        }
      } catch {
        // fall through with no lines - widget renders empty
      }
    }
    this.broadcastWidget(key, lines, options?.placement);
  }

  /** Broadcast a widget update and store it as the snapshot for new clients. */
  private broadcastWidget(
    key: string,
    lines: string[] | undefined,
    placement: string | undefined,
  ): void {
    this.sink({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: lines,
      widgetPlacement: placement,
    });
    // Store for late-connecting browsers (replayed on WS connect).
    this.widgetMap.set(key, { lines, placement });
  }

  // ------------------------------------------------------------------
  // Terminal-specific features: no-op in web mode
  // ------------------------------------------------------------------

  onTerminalInput(): () => void {
    return () => {};
  }
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setFooter(): void {}
  setHeader(): void {}
  custom(): Promise<never> {
    // Pi's custom() shows an extension-drawn TUI component. Web has no TUI
    // renderer, so the component can't be displayed - same headless stub as
    // Pi's RPC mode (rpc-mode.ts: "Custom UI not supported in RPC mode"):
    // settle immediately so commands awaiting the panel don't hang. This is
    // now purely internal: /usage (which used to collect data inside the
    // factory) collects natively from Pi session files instead.
    return Promise.resolve(undefined as never);
  }
  pasteToEditor(): void {}
  setEditorText(): void {}
  getEditorText(): string {
    return "";
  }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): undefined {
    return undefined;
  }

  // ------------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------------

  get theme(): Theme {
    return this.webTheme;
  }
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }
  getTheme(): Theme | undefined {
    return undefined;
  }
  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: "Theme switching not supported in web mode" };
  }

  /** Switch the theme used for extension ANSI colors (dark/light). */
  setWebTheme(name: "dark" | "light"): void {
    this.webTheme = createWebTheme(name);
  }

  // ------------------------------------------------------------------
  // Tool output expansion (web always shows expandable blocks)
  // ------------------------------------------------------------------

  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
}
