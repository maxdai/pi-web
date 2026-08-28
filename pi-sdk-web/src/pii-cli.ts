#!/usr/bin/env node
/**
 * pii - pi session helper (RPC bridge launcher).
 *
 * This is the npm bin wrapper: pi-sdk-web ships the Python launcher
 * (pi-bin/pii) plus the Python bridge (pi-bin/server/*.py, stdlib only).
 * We spawn python3 with the bundled script and forward args/stdin/stdout/
 * stderr, exiting with its code.
 *
 * Usage (same as the original script):
 *   pii list [-l]
 *   pii r <name> [--web [port]]
 *   pii delete <name>
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const piiDir = dirname(fileURLToPath(import.meta.url)); // dist/pi-bin
const piiScript = join(piiDir, "pii");

if (!existsSync(piiScript)) {
  console.error(`pii: bundled launcher not found at ${piiScript}`);
  process.exit(1);
}

// Locate the Python interpreter (same resolution the original shell
// used: python3 on PATH; fall back to the `python` alias).
const pyCandidates = ["python3", "python"];
let python = undefined;
for (const candidate of pyCandidates) {
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    python = candidate;
    break;
  }
}
if (!python) {
  console.error("pii: python3 not found on PATH (required to run the RPC bridge)");
  process.exit(1);
}

// The bundled launcher resolves its project root via script location:
// dist/pi-bin/pi-bin/pii -> parent resolves to dist/pi-bin, whose parent
// is dist/ (no server/ there). The bridge lives at dist/pi-bin/server/,
// so export PI_WEB_DIR pointing at pi-bin so _resolve_project_root() picks
// the right server/ directory (its env_dir branch).
const result = spawnSync(
  python,
  [piiScript, ...process.argv.slice(2)],
  {
    env: { ...process.env, PI_WEB_DIR: piiDir },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
