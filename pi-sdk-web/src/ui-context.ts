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

export type UiEventSink = (obj: unknown) => void;

interface PendingDialog {
  resolve: (value: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Identity theme: extensions call ui.theme.fg(...) / ui.theme.bg(...) to get
 * ANSI-colored strings. The browser renders with CSS, so we return text
 * unchanged (color codes are meaningless in the DOM). Keeps extensions from
 * crashing on theme access; real colors can be added later.
 */
function createIdentityTheme(): Theme {
  return new Proxy({} as Theme, {
    get(_target, prop) {
      // theme.name / theme.isDark etc. may be accessed as properties
      if (prop === "name") return "dark";
      if (prop === "isDark") return true;
      // Everything else is a color function (fg/bg/...): return identity
      return (text: unknown) => (typeof text === "string" ? text : "");
    },
  });
}

export class WebUIContext implements ExtensionUIContext {
  private readonly pending = new Map<string, PendingDialog>();
  private readonly sink: UiEventSink;
  private readonly identityTheme: Theme = createIdentityTheme();
  /** Latest setStatus values per key, so late-connecting browsers get current state */
  private readonly statusMap = new Map<string, string>();

  constructor(sink: UiEventSink) {
    this.sink = sink;
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
    return this.identityTheme;
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

  // ------------------------------------------------------------------
  // Tool output expansion (web always shows expandable blocks)
  // ------------------------------------------------------------------

  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
}
