/**
 * SDK link verification script (dev only).
 *
 * Proves that a third-party package can drive a full Pi AgentSession via the
 * public SDK (@earendil-works/pi-coding-agent) without modifying Pi:
 *   1. createAgentSession() -> AgentSession
 *   2. bindExtensions() with a minimal no-op Web UI context
 *   3. session.subscribe() -> event stream
 *   4. session.prompt() -> LLM round-trip
 *
 * Run: npm run verify
 */
import { type ExtensionUIContext, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Minimal no-op UI context: logs what extensions would show in the UI.
// The real pi-sdk-web will map these to browser DOM (select/confirm/input/...).
// Note: extensions call ui.theme.fg etc. - real WebUIContext must provide a
// theme object (Pi exports initTheme/Theme utilities for this).
// ---------------------------------------------------------------------------
function createNoopUIContext(): ExtensionUIContext {
  return {
    select: async (title, options) => {
      console.log(`[ui:select] ${title} ${JSON.stringify(options)}`);
      return options[0];
    },
    confirm: async (title, message) => {
      console.log(`[ui:confirm] ${title} ${message}`);
      return true;
    },
    input: async (title, placeholder) => {
      console.log(`[ui:input] ${title} ${placeholder ?? ""}`);
      return undefined;
    },
    notify: (message, type) => {
      console.log(`[ui:notify] ${type ?? "info"}: ${message}`);
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      if (text !== undefined) console.log(`[ui:status] ${key}: ${text}`);
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => console.log(`[ui:title] ${title}`),
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return {} as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

async function main() {
  console.log("=== pi-sdk-web SDK link verification ===");

  // 1. Create an in-memory session (no disk writes) - proves SDK works
  const sessionManager = SessionManager.inMemory();
  console.log("[1] createAgentSession (in-memory)...");
  const { session } = await createAgentSession({ sessionManager });
  console.log(`    OK. model=${session.model?.provider}/${session.model?.id}`);

  // 2. Bind extensions with no-op UI context
  console.log("[2] bindExtensions (no-op UI context)...");
  await session.bindExtensions({ uiContext: createNoopUIContext(), mode: "rpc" });
  console.log("    OK.");

  // 3. Subscribe to the event stream
  const events: string[] = [];
  let settled: (() => void) | undefined;
  const settledPromise = new Promise<void>((resolve) => {
    settled = resolve;
  });
  session.subscribe((event) => {
    const type = (event as { type: string }).type;
    if (!events.includes(type)) events.push(type);
    console.log(`[event] ${type}`);
    if (type === "agent_settled") settled?.();
  });

  // 4. Prompt the model
  console.log("[3] prompt: 'Reply with exactly: SDK-OK'...");
  await session.prompt("Reply with exactly: SDK-OK");
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 120_000));
  await Promise.race([settledPromise, timeout]);

  console.log("\n=== Result ===");
  console.log(`event types seen: ${events.join(", ")}`);
  const ok = events.includes("message_start") && events.includes("message_end") && events.includes("agent_settled");
  if (ok) {
    console.log("✅ SDK LINK VERIFICATION PASSED");
  } else {
    console.log("⚠️  Incomplete event flow - inspect output above");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
