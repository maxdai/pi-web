/**
 * pi-sdk-web server: HTTP static files + WebSocket bridge to a Pi AgentSession.
 *
 * The WebSocket protocol mirrors the existing Python bridge (server.py) so the
 * browser client (static/app.js) works unchanged:
 *   - On connect:  {type:"state", data:{...}} then {type:"history", data:{entries,leafId}}
 *   - Pi events:   broadcast verbatim (message_start/update/end, tool_execution_*, ...)
 *   - UI requests: extension_ui_request broadcast (resolved via extension_ui_response)
 *   - Client msgs: prompt/abort/get_stats/bash/cycle_model/set_model/... -> session methods
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelRegistry,
  VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionCommandContext,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { WebSocket, WebSocketServer } from "ws";
import { WebUIContext } from "./ui-context.ts";

const DEFAULT_PORT = 4080;
// Static frontend: prefer the in-package copy (built by `npm run build` for
// global installs), fall back to the repo-root static/ during development.
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Static frontend source:
//  - dev (tsx runs src/server.ts): always the repo-root static/ (live files)
//  - published (dist/server.js): the built copy at dist/static (packaged)
const RUNNING_FROM_SRC = fileURLToPath(import.meta.url).includes(`${sep}src${sep}`);
const STATIC_DIR = RUNNING_FROM_SRC
  ? resolve(PACKAGE_DIR, "..", "static")
  : (() => {
      const built = resolve(PACKAGE_DIR, "dist", "static");
      return existsSync(built) ? built : resolve(PACKAGE_DIR, "..", "static");
    })();

// Our own package version (pi-sdk-web), shown in the header next to Pi's version
const PI_WEB_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
})();

// Events after which footer stats should be refreshed (TUI does this too)
const STATS_REFRESH_EVENTS = new Set([
  "agent_settled",
  "turn_end",
  "tool_execution_end",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

export interface PiWebServerOptions {
  port?: number;
  staticDir?: string;
}

export class PiWebServer {
  readonly session: AgentSession;
  readonly port: number;
  readonly staticDir: string;
  private readonly uiContext: WebUIContext;
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | null = null;

  constructor(session: AgentSession, options: PiWebServerOptions = {}) {
    this.session = session;
    this.port = options.port ?? DEFAULT_PORT;
    this.staticDir = options.staticDir ?? STATIC_DIR;
    this.uiContext = new WebUIContext((obj) => this.broadcast(obj));
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start(): Promise<void> {
    // Bind extensions with the web UI context (replaces the TUI/RPC context)
    await this.session.bindExtensions({
      uiContext: this.uiContext,
      // "rpc" is the closest ExtensionMode: dialog-capable UI (hasUI=true),
      // but not terminal-only UI
      mode: "rpc",
    });

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    // Some components (ws internals, MCP-style extensions) accumulate 'close'
    // listeners on the server; raise the limit to avoid MaxListenersExceededWarning
    this.httpServer.setMaxListeners(50);
    this.wsServer = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wsServer.setMaxListeners(50);
    this.wsServer.on("connection", (ws) => this.handleConnection(ws));

    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(this.port, "127.0.0.1", () => resolvePromise());
    });

    // Forward session events to all browser clients
    this.unsubscribe = this.session.subscribe((event) => {
      this.broadcast(event);
      if (STATS_REFRESH_EVENTS.has((event as { type: string }).type)) {
        this.broadcastStats();
      }
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await new Promise<void>((resolvePromise) => {
      this.wsServer?.close(() => resolvePromise());
      if (!this.wsServer) resolvePromise();
    });
    await new Promise<void>((resolvePromise) => {
      this.httpServer?.close(() => resolvePromise());
      if (!this.httpServer) resolvePromise();
    });
  }

  // ------------------------------------------------------------------
  // Broadcast helpers
  // ------------------------------------------------------------------

  private broadcast(obj: unknown): void {
    if (this.clients.size === 0) return;
    let message: string;
    try {
      message = JSON.stringify(obj);
    } catch {
      return;
    }
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(message);
      } catch {
        // One broken client must not block delivery to the others
        this.clients.delete(client);
      }
    }
  }

  private broadcastStats(): void {
    try {
      const stats: SessionStats = this.session.getSessionStats();
      this.broadcast({ type: "stats", data: stats });
    } catch {
      // stats unavailable - skip
    }
  }

  /** Broadcast the full state (model/thinking/session name) after mutations. */
  private broadcastState(): void {
    try {
      this.broadcast({ type: "state", data: this.buildState() });
    } catch {
      // state unavailable - skip
    }
  }

  // ------------------------------------------------------------------
  // HTTP: static files
  // ------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    let path = (req.url ?? "/").split("?")[0];
    if (path === "/") path = "/index.html";

    const root = resolve(this.staticDir);
    const filePath = resolve(this.staticDir, "." + path);
    // Exact-prefix match (avoid /a/static-evil passing a /a/static check)
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }

    try {
      const data = await readFile(filePath);
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        // Always revalidate: frontend updates must be visible without manual cache clears
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  }

  // ------------------------------------------------------------------
  // WebSocket: connection, initial state, client messages
  // ------------------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    ws.on("message", (data) => this.handleClientMessage(ws, String(data)));

    // Initial state (state + history), mirroring the Python bridge
    this.sendJson(ws, { type: "state", data: this.buildState() });
    this.sendJson(ws, { type: "history", data: this.buildHistory() });
    // Current extension statuses (setStatus may have fired before this client connected)
    const extStatus = this.uiContext.getStatusSnapshot();
    if (Object.keys(extStatus).length > 0) {
      this.sendJson(ws, { type: "ext_status", data: extStatus });
    }
  }

  private sendJson(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  private buildState(): Record<string, unknown> {
    const state: Record<string, unknown> = {
      model: this.session.model,
      thinkingLevel: this.session.thinkingLevel,
      sessionId: this.session.sessionId,
      sessionName: this.session.sessionManager.getSessionName(),
      autoCompactionEnabled: this.session.autoCompactionEnabled,
      messageCount: this.session.messages.length,
      version: VERSION,
      piWebVersion: PI_WEB_VERSION,
      cwd: this.formatCwd(this.session.sessionManager.getCwd()),
      gitBranch: this.getGitBranch(this.session.sessionManager.getCwd()),
      commands: this.getCommands(),
    };
    try {
      state.sessionStats = this.session.getSessionStats();
    } catch {
      // ignore
    }
    return state;
  }

  private buildHistory(): unknown {
    try {
      return {
        // Match TUI's initial rendering: the current context view
        // (compaction collapses older entries into a summary; branch-aware)
        entries: this.session.sessionManager.buildContextEntries(),
        leafId: this.session.sessionManager.getLeafId(),
      };
    } catch {
      return { entries: [], leafId: null };
    }
  }

  private formatCwd(cwd: string): string {
    const home = process.env.HOME ?? "";
    if (home && (cwd === home || cwd.startsWith(home + "/"))) {
      return "~" + cwd.slice(home.length);
    }
    return cwd;
  }

  private gitBranchCache: { cwd: string; branch: string | null; at: number } | null = null;
  private static readonly GIT_CACHE_TTL_MS = 5_000;

  private getGitBranch(cwd: string): string | null {
    const now = Date.now();
    if (this.gitBranchCache && this.gitBranchCache.cwd === cwd && now - this.gitBranchCache.at < PiWebServer.GIT_CACHE_TTL_MS) {
      return this.gitBranchCache.branch;
    }
    let branch: string | null = null;
    try {
      const stdout = execFileSync("git", ["branch", "--show-current"], {
        cwd,
        timeout: 3000,
        encoding: "utf8",
        // execFileSync prints child stderr to our stderr on failure (e.g.
        // "fatal: not a git repository" in non-git dirs) - suppress it
        stdio: ["ignore", "pipe", "ignore"],
      });
      branch = stdout.trim() || null;
    } catch {
      branch = null;
    }
    this.gitBranchCache = { cwd, branch, at: now };
    return branch;
  }

  private getCommands(): unknown[] {
    try {
      // Mirror Pi's get_commands RPC response: extension commands, prompt
      // templates, and skills (source: extension | prompt | skill)
      const commands: unknown[] = [];
      for (const c of this.session.extensionRunner.getRegisteredCommands()) {
        commands.push({ name: c.invocationName, description: c.description, source: "extension", sourceInfo: c.sourceInfo });
      }
      for (const t of this.session.promptTemplates) {
        commands.push({ name: t.name, description: t.description, source: "prompt", sourceInfo: t.sourceInfo });
      }
      for (const s of this.session.resourceLoader.getSkills().skills) {
        commands.push({ name: `skill:${s.name}`, description: s.description, source: "skill", sourceInfo: s.sourceInfo });
      }
      return commands;
    } catch {
      return [];
    }
  }

  private handleClientMessage(ws: WebSocket, raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.sendJson(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    const cmdType = data.type;
    if (typeof cmdType !== "string") {
      this.sendJson(ws, { type: "error", error: "Missing 'type'" });
      return;
    }

    this.dispatch(cmdType, data).catch((err: unknown) => {
      this.sendJson(ws, { type: "error", error: err instanceof Error ? err.message : String(err) });
    });
  }

  private async dispatch(cmdType: string, data: Record<string, unknown>): Promise<void> {
    switch (cmdType) {
      case "prompt": {
        const message = typeof data.message === "string" ? data.message : "";
        if (!message) throw new Error("Missing 'message'");
        await this.session.prompt(message);
        break;
      }
      case "abort":
        await this.session.abort();
        break;
      case "get_stats":
        this.broadcastStats();
        break;
      case "bash": {
        const command = typeof data.command === "string" ? data.command : "";
        if (!command) throw new Error("Missing 'command'");
        const excludeFromContext = data.excludeFromContext === true;
        // Let extensions intercept/enhance the command (same as Pi RPC/TUI):
        // user_bash handlers may provide a result or operations for execution.
        const eventResult = await this.session.extensionRunner.emitUserBash({
          type: "user_bash",
          command,
          excludeFromContext,
          cwd: this.session.sessionManager.getCwd(),
        });
        if (eventResult?.result) {
          this.session.recordBashResult(command, eventResult.result, { excludeFromContext });
          this.broadcast({ type: "bash_result", command, data: eventResult.result });
          break;
        }
        const result = await this.session.executeBash(command, undefined, {
          excludeFromContext,
          operations: eventResult?.operations,
        });
        this.broadcast({ type: "bash_result", command, data: result });
        break;
      }
      case "cycle_model":
        await this.session.cycleModel();
        this.broadcastState();
        break;
      case "set_model": {
        const provider = data.provider as string | undefined;
        const modelId = data.modelId as string | undefined;
        if (!provider || !modelId) throw new Error("Missing 'provider' or 'modelId'");
        const model = this.session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === provider && m.id === modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.session.setModel(model);
        this.broadcastState();
        break;
      }
      case "get_available_models":
        this.broadcast({ type: "models", data: this.session.modelRuntime.getAvailableSnapshot() });
        break;
      case "cycle_thinking_level":
        this.session.cycleThinkingLevel();
        this.broadcastState();
        break;
      case "set_thinking_level": {
        const level = data.level as ThinkingLevel | undefined;
        if (!level) throw new Error("Missing 'level'");
        this.session.setThinkingLevel(level);
        this.broadcastState();
        break;
      }
      case "get_available_thinking_levels":
        this.broadcast({ type: "thinking_levels", data: this.session.getAvailableThinkingLevels() });
        break;
      case "compact":
        await this.session.compact(typeof data.customInstructions === "string" ? data.customInstructions : undefined);
        break;
      case "reload":
        // Align with TUI /reload: refuse while streaming or compacting
        if (!this.session.isIdle) throw new Error("Wait for the current response to finish before reloading.");
        if (this.session.isCompacting) throw new Error("Wait for compaction to finish before reloading.");
        await this.session.reload();
        this.broadcastState();
        break;
      case "export": {
        const path = typeof data.path === "string" && data.path ? data.path : undefined;
        const exportedPath = path?.endsWith(".jsonl")
          ? this.session.exportToJsonl(path)
          : await this.session.exportToHtml(path);
        this.broadcast({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "notify",
          title: "/export",
          message: `Session exported to: ${exportedPath}`,
          notifyType: "info",
        });
        break;
      }
      case "get_scoped_models":
        this.broadcast({
          type: "scoped_models",
          data: {
            scoped: this.session.scopedModels.map((s) => ({
              provider: s.model.provider,
              id: s.model.id,
              thinkingLevel: s.thinkingLevel,
            })),
            available: this.session.modelRuntime.getAvailableSnapshot(),
          },
        });
        break;
      case "set_scoped_models": {
        const models = Array.isArray(data.models) ? (data.models as Array<Record<string, unknown>>) : [];
        const resolved: Array<{ model: unknown; thinkingLevel?: unknown }> = [];
        for (const m of models) {
          const provider = m.provider as string | undefined;
          const modelId = m.modelId as string | undefined;
          if (!provider || !modelId) continue;
          const model = this.session.modelRuntime
            .getAvailableSnapshot()
            .find((x) => x.provider === provider && x.id === modelId);
          if (model) resolved.push({ model, thinkingLevel: m.thinkingLevel });
        }
        this.session.setScopedModels(resolved as never);
        this.broadcastState();
        break;
      }
      case "set_session_name": {
        const name = typeof data.name === "string" ? data.name : "";
        if (!name) throw new Error("Missing 'name'");
        this.session.setSessionName(name);
        this.broadcastState();
        break;
      }
      case "extension_ui_response": {
        const id = typeof data.id === "string" ? data.id : "";
        if (!id) throw new Error("Missing 'id'");
        const extra = Object.fromEntries(
          Object.entries(data).filter(([k]) => k !== "type" && k !== "id"),
        ) as { value?: string; confirmed?: boolean; cancelled?: boolean };
        this.uiContext.respond(id, extra);
        break;
      }
      case "command": {
        const name = typeof data.name === "string" ? data.name : "";
        const args = typeof data.args === "string" ? data.args : "";
        if (!name) throw new Error("Missing 'name'");
        await this.executeCommand(name, args);
        break;
      }
      case "session":
        // Read-only session info (TUI /session equivalent)
        this.broadcastSessionInfo();
        break;
      default:
        throw new Error(`Unsupported command: ${cmdType}`);
    }
  }

  /** TUI /session equivalent: show session info as a modal (read-only). */
  private broadcastSessionInfo(): void {
    try {
      const stats = this.session.getSessionStats();
      const sm = this.session.sessionManager;
      const entries = sm.getEntries();
      const model = this.session.model;

      const lines: string[] = [];
      lines.push("## Session Info", "");
      const name = sm.getSessionName();
      if (name) lines.push(`**Name:** ${name}`);
      lines.push(`**ID:** ${this.session.sessionId}`);
      if (stats.sessionFile) lines.push(`**File:** ${stats.sessionFile}`);
      if (model) lines.push(`**Model:** ${model.provider}/${model.id}`);
      lines.push(`**Thinking:** ${this.session.thinkingLevel}`, "");

      lines.push("### Messages");
      lines.push(`- User: ${stats.userMessages}`);
      lines.push(`- Assistant: ${stats.assistantMessages}`);
      lines.push(`- Tool calls: ${stats.toolCalls}`);
      lines.push(`- Tool results: ${stats.toolResults}`);
      lines.push(`- Total: ${stats.totalMessages}`);
      lines.push(`- Entries: ${entries.length}`, "");

      const t = stats.tokens;
      if (t) {
        lines.push("### Tokens");
        lines.push(`- Input: ${t.input}`);
        lines.push(`- Output: ${t.output}`);
        lines.push(`- Cache read: ${t.cacheRead}`);
        lines.push(`- Cache write: ${t.cacheWrite}`);
        lines.push(`- Total: ${t.total}`, "");
      }

      lines.push("### Cost");
      lines.push(`$${stats.cost.toFixed(4)}`);

      const cu = stats.contextUsage;
      if (cu?.contextWindow) {
        lines.push("", "### Context");
        lines.push(`- ${cu.percent}% / ${cu.contextWindow} tokens`);
      }

      this.broadcast({
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "notify",
        title: "/session",
        message: lines.join("\n"),
        notifyType: "info",
      });
    } catch {
      // session info unavailable - skip
    }
  }

  /**
   * Execute an extension slash command (e.g. /ctx-status) by invoking its
   * registered handler with a command context.
   *
   * The context reports `hasUI: false` so extensions that offer a TUI dialog
   * fall back to text output (e.g. magic-context's /ctx-status writes a custom
   * session entry, which flows to the browser via entry_appended). Custom
   * entries produced by the command are additionally shown as a browser
   * modal (mirroring the TUI dialog behavior).
   */
  private async executeCommand(name: string, args: string): Promise<void> {
    const cmd = this.session.extensionRunner.getCommand(name);
    if (!cmd) throw new Error(`Unknown command: ${name}`);

    // Capture custom entries appended while the command runs
    const captured: Array<{ customType: string; data: unknown }> = [];
    const listener = (event: unknown) => {
      const ev = event as { type: string; entry?: { type: string; customType?: string; data?: unknown } };
      if (ev.type === "entry_appended" && ev.entry?.type === "custom") {
        captured.push({ customType: ev.entry.customType ?? "custom", data: ev.entry.data });
      }
    };
    const unsubscribe = this.session.subscribe(listener);
    try {
      await cmd.handler(args, this.buildCommandContext());
    } finally {
      unsubscribe();
    }

    // Show command output as a modal (TUI-like). The session entry remains
    // for history; the modal is the transient presentation.
    for (const entry of captured) {
      const data = entry.data as { title?: string; text?: string } | undefined;
      const message = data?.text ?? (data !== undefined ? JSON.stringify(data, null, 2) : "");
      this.broadcast({
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "notify",
        title: data?.title ?? `/${name}`,
        message,
        notifyType: "info",
      });
    }
  }

  private buildCommandContext(): ExtensionCommandContext {
    const sm = this.session.sessionManager;
    return {
      ui: this.uiContext,
      // No dialog-capable UI: extension commands fall back to text output
      mode: "print",
      hasUI: false,
      cwd: sm.getCwd(),
      sessionManager: sm,
      modelRegistry: new ModelRegistry(this.session.modelRuntime),
      model: this.session.model,
      scopedModels: this.session.scopedModels,
      thinkingLevel: this.session.thinkingLevel,
      isIdle: () => this.session.isIdle,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {
        void this.session.abort();
      },
      hasPendingMessages: () => this.session.pendingMessageCount > 0,
      shutdown: () => {},
      getContextUsage: () => this.session.getContextUsage(),
      compact: (options) => {
        void this.session.compact(options?.customInstructions);
      },
      getSystemPrompt: () => this.session.systemPrompt,
      getSystemPromptOptions: () => ({} as never),
      waitForIdle: () => this.session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await this.session.reload();
      },
    };
  }
}
