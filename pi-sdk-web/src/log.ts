/**
 * Timestamped logging for pi-web's own diagnostics.
 *
 * pi-web is a long-running server: its warnings (backpressure, memory
 * watermarks, session issues) are read minutes to hours after the fact and
 * mixed with other processes' output, so every line carries a local timestamp
 * (`[2026-09-12 08:15:30] pi-web: …`).
 *
 * Only pi-web's own log lines go through here - command output (session
 * lists, help text) stays plain so it can be piped or copied as-is.
 */

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/** Informational line (startup, status) on stdout. */
export function logInfo(message: string): void {
  console.log(`[${timestamp(new Date())}] ${message}`);
}

/** Diagnostic warning on stderr. */
export function logWarn(message: string): void {
  console.warn(`[${timestamp(new Date())}] ${message}`);
}

/** Error line on stderr. */
export function logError(message: string): void {
  console.error(`[${timestamp(new Date())}] ${message}`);
}
