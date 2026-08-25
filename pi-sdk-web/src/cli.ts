#!/usr/bin/env node
/**
 * pi-web - browser Web access for Pi via the Pi SDK.
 *
 * Usage:
 *   pi-web r <name> [--port <port>]   Run web mode for a session (default port 4080)
 *   pi-web list                       List all sessions (name, id, cwd), newest first
 *   pi-web help                       Show this help
 */
import {
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { findSessionByName, listSessions, loadBuiltinExtensions } from "./session.ts";
import { PiWebServer } from "./server.ts";

const DEFAULT_PORT = 4080;
const DOC = `pi-web - browser Web access for Pi (via Pi SDK)

Usage:
  pi-web r <name> [--port <port>]   Run web mode for the session (default port ${DEFAULT_PORT})
  pi-web list                       List all sessions (name, id, cwd), newest first
  pi-web help                       Show this help
`;

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value} (must be a number)`);
  const port = parseInt(value, 10);
  if (!(1 <= port && port <= 65535)) throw new Error(`Invalid port: ${port} (must be 1-65535)`);
  return port;
}

async function cmdList(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log("(no sessions)");
    return;
  }
  const width = Math.max(...sessions.map((s) => (s.name ?? "(unnamed)").length));
  for (const s of sessions) {
    console.log(`${(s.name ?? "(unnamed)").padEnd(width)}  ${s.id}  ${s.cwd}`);
  }
}

async function cmdResume(name: string, port: number): Promise<void> {
  const { info, sessionManager } = await findSessionByName(name);
  const cwd = sessionManager.getCwd();
  if (cwd) {
    try {
      process.chdir(cwd);
    } catch {
      // Session cwd no longer exists - keep current directory (same as pii)
      console.error(`Session cwd not found (${cwd}), keeping current directory`);
    }
  }

  // Create services the way Pi's CLI does: extensions (including built-in
  // llama.cpp and packages that register providers like deepinfra) load into
  // the same modelRuntime used below, so scopedModels resolution sees them.
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(sessionManager.getCwd(), agentDir);

  // Runtime factory: re-invoked by AgentSessionRuntime whenever the session is
  // replaced (e.g. /resume switches to another session with a different cwd).
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir: dir, sessionManager: sm, sessionStartEvent }) => {
    const settings = SettingsManager.create(cwd, dir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir: dir,
      settingsManager: settings,
      resourceLoaderOptions: { extensionFactories: await loadBuiltinExtensions() },
    });
    // Resolve enabledModels (settings) into scopedModels, matching Pi's CLI
    const enabledModels = settings.getEnabledModels();
    const scopedModels =
      enabledModels && enabledModels.length > 0
        ? (
            await resolveModelScopeWithDiagnostics(enabledModels, services.modelRuntime, {
              signal: AbortSignal.timeout(15_000),
            })
          ).scopedModels
        : [];
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: sm,
      sessionStartEvent,
      scopedModels,
    });
    return { ...created, services, diagnostics: [] };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  });
  const { session } = runtime;

  const server = new PiWebServer(runtime, { port });
  await server.start();
  console.log(`server at http://127.0.0.1:${port}/ (session: ${info.name ?? info.id})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // Repeated Ctrl+C must not re-enter teardown
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);
    try {
      await server.stop();
    } catch {
      // ignore teardown errors - we still need to exit
    }
    try {
      runtime.dispose();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive (http server handles this naturally)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(DOC);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "list") {
    await cmdList();
    return;
  }

  if (cmd === "r" || cmd === "resume") {
    let name: string | undefined;
    let port: number | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--port") {
        port = parsePort(args[i + 1]);
        i++;
      } else if (arg.startsWith("--port=")) {
        port = parsePort(arg.slice("--port=".length));
      } else if (name === undefined) {
        name = arg;
      } else {
        throw new Error(`unexpected argument: ${arg}\nusage: pi-web r <name> [--port <port>]`);
      }
    }
    if (!name) throw new Error("usage: pi-web r <name> [--port <port>]");
    await cmdResume(name, port ?? DEFAULT_PORT);
    return;
  }

  throw new Error(`unknown command: ${cmd}\n${DOC}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
