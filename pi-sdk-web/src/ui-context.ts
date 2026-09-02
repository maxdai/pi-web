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
  resolve: (value: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
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

  constructor(sink: UiEventSink) {
    this.sink = sink;
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
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.pending.clear();
    this.statusMap.clear();
  }

  /** Handle a browser `extension_ui_response` message. */
  respond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.cancelled) {
      pending.resolve(undefined);
    } else if (response.confirmed !== undefined) {
      pending.resolve(response.confirmed);
    } else {
      pending.resolve(response.value);
    }
    return true;
  }

  private createDialog<T>(
    request: Record<string, unknown>,
    defaultValue: T,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolve) => {
      const timeoutMs = typeof request.timeout === "number" ? request.timeout : undefined;
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            resolve(defaultValue);
          }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (value) => resolve(parse(value)),
        timer,
      });
      this.sink({ type: "extension_ui_request", id, ...request });
    });
  }

  // ------------------------------------------------------------------
  // Dialogs (browser resolves via extension_ui_response)
  // ------------------------------------------------------------------

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.createDialog(
      { method: "select", title, options, timeout: opts?.timeout },
      undefined,
      (v) => (typeof v === "string" ? v : undefined),
    );
  }

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.createDialog({ method: "confirm", title, message, timeout: opts?.timeout }, false, (v) => v === true);
  }

  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.createDialog(
      { method: "input", title, placeholder, timeout: opts?.timeout },
      undefined,
      (v) => (typeof v === "string" ? v : undefined),
    );
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.createDialog({ method: "editor", title, prefill }, undefined, (v) =>
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
    this.sink({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: Array.isArray(content) ? content : undefined,
      widgetPlacement: options?.placement,
    });
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
    // renderer, so a full component can't be displayed. Same headless stub
    // as Pi's RPC mode (rpc-mode.ts: "Custom UI not supported in RPC mode"):
    // settle immediately so commands awaiting the panel don't hang.
    // Commands whose extensions branch on hasUI (magic-context ctx-status)
    // are routed to their text fallback by executeCommand (hasUI:false);
    // any other custom() caller just gets a no-op close.
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
