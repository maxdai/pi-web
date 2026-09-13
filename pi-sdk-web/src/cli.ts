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
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { dirname, join } from "node:path";
import { findSessionByName, listSessions, loadBuiltinExtensions } from "./session.ts";
import { PiWebServer } from "./server.ts";

// ---------------------------------------------------------------------------
// Pretend to be Pi for in-process extensions.
//
// Extensions loaded into this process (magic-context historian/dreamer, etc.)
// derive "how to spawn a Pi subagent" from process.argv[1] — the host entry
// script (resolvePiInvocation reuses it when it exists on disk). pi-web's own
// bin is NOT Pi, so without this a subagent would re-exec the web server.
// Point argv[1] at the real Pi CLI that pi-sdk-web depends on: extension
// subagents then spawn Pi exactly as they would from a TUI Pi host.
//
// Safe because: pi-sdk-web parses its own args via process.argv.slice(2);
// Pi's core modules never read argv[1] (only Pi's own CLI entries do, which
// pi-web never invokes); magic-context's createRequire(argv[1]) module
// resolution still finds @earendil-works/pi-coding-agent (it sits inside
// pi-sdk-web/node_modules).
// ---------------------------------------------------------------------------
const PI_CLI_ENTRY = (() => {
  try {
    const mainEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const candidate = join(dirname(mainEntry), "cli.js");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
})();
if (PI_CLI_ENTRY && process.argv[1] !== PI_CLI_ENTRY) {
  process.argv[1] = PI_CLI_ENTRY;
}

const DEFAULT_PORT = 4080;

// ---------------------------------------------------------------------------
// Heap headroom for long sessions.
//
// A large session plus in-process extensions (magic-context's local embedding
// model, historians, indexes) can outgrow Node's default old-space limit -
// ~2.2GB on a 15GB host - and abort the server mid-turn with
// "FATAL ERROR: Reached heap limit". pi-web therefore restarts itself once
// with a larger --max-old-space-size, but only for the long-running `r`
// command and only when the host has memory to spare.
//
// Override the target with PI_WEB_MAX_OLD_SPACE_MB=<mb>. An explicit
// --max-old-space-size in NODE_OPTIONS / argv is always respected untouched,
// and the restart happens at most once (PI_WEB_HEAP_REEXEC guard).
// ---------------------------------------------------------------------------
const DEFAULT_MAX_OLD_SPACE_MB = 4096;

/** Current V8 old-space limit in MB (what the crash log calls the heap limit). */
function heapLimitMb(): number {
  return getHeapStatistics().heap_size_limit / (1024 * 1024);
}

function requestedHeapMb(): number {
  const raw = Number(process.env.PI_WEB_MAX_OLD_SPACE_MB);
  if (Number.isFinite(raw) && raw >= 512 && raw <= 32_768) return Math.floor(raw);
  return DEFAULT_MAX_OLD_SPACE_MB;
}

/** Did the user (or a wrapper) already choose a heap size themselves? */
function hasExplicitHeapFlag(): boolean {
  const fromEnv = (process.env.NODE_OPTIONS ?? "").split(/\s+/);
  return [...process.execArgv, ...fromEnv].some((arg) =>
    /^--max[-_]old[-_]space[-_]size(=|$)/.test(arg),
  );
}

/**
 * Re-exec with a larger heap when needed. Returns true when a child has been
 * started (the caller must stop: this process only waits for it).
 */
function ensureHeapHeadroom(): boolean {
  if (process.env.PI_WEB_HEAP_REEXEC === "1") return false; // already restarted
  if (hasExplicitHeapFlag()) return false; // user decided - leave it alone
  const target = requestedHeapMb();
  if (heapLimitMb() >= target * 0.95) return false; // close enough already
  const totalMb = totalmem() / (1024 * 1024);
  if (totalMb < target * 2) {
    console.log(
      `heap: keeping the default limit (${heapLimitMb().toFixed(0)}MB) - ` +
        `raising it to ${target}MB needs ~${target * 2}MB of RAM, host has ${totalMb.toFixed(0)}MB`,
    );
    return false;
  }
  console.log(
    `heap: restarting with --max-old-space-size=${target} (current limit ${heapLimitMb().toFixed(0)}MB)`,
  );
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${target}`, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, PI_WEB_HEAP_REEXEC: "1" } },
  );
  // Stay alive without acting on the signal ourselves: the child is in the
  // same process group and runs its own graceful shutdown, and we exit with
  // its status once it is done.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  child.on("error", (err: Error) => {
    console.error(`heap: failed to restart with a larger heap: ${err.message}`);
    process.exit(1);
  });
  return true;
}

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
  console.log(`heap limit: ${heapLimitMb().toFixed(0)}MB`);

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
    // Before anything heavy (session open, extensions): make sure this process
    // has enough heap. A restart here means the child takes over the command.
    if (ensureHeapHeadroom()) return;
    await cmdResume(name, port ?? DEFAULT_PORT);
    return;
  }

  throw new Error(`unknown command: ${cmd}\n${DOC}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
