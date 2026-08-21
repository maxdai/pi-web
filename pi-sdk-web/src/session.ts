/**
 * Session lookup helpers for the pi-web CLI.
 *
 * `pi-web r <name>` semantics match pii: match by session display name
 * (session_info entry), and if several sessions share the name, pick the
 * most recently modified one.
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  getAgentDir,
  type InlineExtension,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

export interface FoundSession {
  info: SessionInfo;
  sessionManager: SessionManager;
}

/** List all sessions, newest first. */
export async function listSessions(): Promise<SessionInfo[]> {
  return SessionManager.listAll();
}

/**
 * Find a session by display name and open it.
 * Throws with available names when no match is found.
 */
export async function findSessionByName(name: string): Promise<FoundSession> {
  const all = await listSessions();
  const hits = all
    .filter((s) => s.name === name)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  if (hits.length === 0) {
    const names = [...new Set(all.map((s) => s.name).filter(Boolean))].sort();
    const available = names.length > 0 ? `\nAvailable names: ${names.join(", ")}` : "";
    throw new Error(`No session named '${name}'${available}`);
  }

  const info = hits[0];
  return { info, sessionManager: SessionManager.open(info.path) };
}

/**
 * Pi's built-in extensions (e.g. llama.cpp) are not exported from the SDK
 * entry point, but they live in the published package at dist/extensions/.
 * Node's "exports" field only constrains package-name imports, not absolute
 * path imports, so we locate the package physically and load them directly.
 *
 * Falls back to an empty list if the path changes in a future Pi version.
 */
export async function loadBuiltinExtensions(): Promise<InlineExtension[]> {
  try {
    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entryPath = fileURLToPath(entryUrl); // .../dist/index.js
    const extPath = join(dirname(entryPath), "extensions", "index.js");
    const mod = (await import(pathToFileURL(extPath).href)) as { builtInExtensions?: InlineExtension[] };
    return mod.builtInExtensions ?? [];
  } catch {
    return [];
  }
}

/** Build a resource loader including Pi's built-in extensions. */
export async function createResourceLoader(cwd: string): Promise<DefaultResourceLoader> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: await loadBuiltinExtensions(),
  });
  await resourceLoader.reload();
  return resourceLoader;
}
