/**
 * Usage extension integration (independent module).
 *
 * pi-usage-extension's `/usage` command draws a TUI dashboard via
 * ctx.ui.custom() which Web cannot render. However, running the command
 * (through WebUIContext.custom() which now executes the factory) makes the
 * extension collect usage data and write its cache file
 * (`~/.pi/agent/usage-extension-cache.json`). This module reads that cache
 * after the command runs and renders an equivalent summary as Markdown,
 * shown as a titled modal - without coupling into the main server flow.
 *
 * Cache format (v7): { version, names: string[], files: { [sessionFile]: {
 *   size, mtimeMs, sessionId, cwd, parentSession,
 *   messages: 13-tuple[][], toolUsages: 5-tuple[][] } } }
 * message tuple: [provider, model, cost, inputTokens, outputTokens,
 *   cacheReadTokens, cacheWriteTokens, timestampMs, thinkingLevel,
 *   reasoningTokens, afterCompaction(0|1), source(0 assistant|1 auxiliary),
 *   sourceId]
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const USAGE_CACHE_FILE = "usage-extension-cache.json";
const USAGE_CACHE_DIRS = [
  join(process.env.PI_HOME?.replace(/^~/, homedir()) ?? homedir(), ".pi", "agent"),
  join(homedir(), ".pi", "agent"),
];

interface UsageMessage {
  provider: string;
  model: string;
  thinkingLevel?: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: number;
  reasoning: number;
  afterCompaction: boolean;
  source: "assistant" | "auxiliary";
}

interface UsageFile {
  messages: UsageMessage[];
  sessionId: string;
  cwd: string;
  parentSession: string;
}

function findCachePath(): string | null {
  for (const dir of USAGE_CACHE_DIRS) {
    const p = join(dir, USAGE_CACHE_FILE);
    if (existsSync(p)) return p;
  }
  return null;
}

/** mtime of the usage cache file, or null when absent. */
export function usageCacheMtime(): number | null {
  const path = findCachePath();
  if (!path) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Read and normalize the usage cache; null when absent/unreadable. */
export function loadUsageCache(): {
  files: UsageFile[];
  names: string[];
} | null {
  const path = findCachePath();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      names?: string[];
      files?: Record<string, unknown>;
    };
    const names = raw.names ?? [];
    const files: UsageFile[] = [];
    for (const file of Object.values(raw.files ?? {})) {
      const f = file as {
        messages?: unknown;
        sessionId?: string;
        cwd?: string;
        parentSession?: string;
      };
      const messages: UsageMessage[] = [];
      if (Array.isArray(f.messages)) {
        for (const tuple of f.messages) {
          if (!Array.isArray(tuple) || tuple.length !== 13) continue;
          const provider = names[tuple[0] as number];
          const model = names[tuple[1] as number];
          const thinkingLevel = names[tuple[8] as number];
          if (typeof provider !== "string" || typeof model !== "string") continue;
          messages.push({
            provider,
            model,
            thinkingLevel,
            cost: Number(tuple[2]) || 0,
            input: Number(tuple[3]) || 0,
            output: Number(tuple[4]) || 0,
            cacheRead: Number(tuple[5]) || 0,
            cacheWrite: Number(tuple[6]) || 0,
            timestamp: Number(tuple[7]) || 0,
            reasoning: Number(tuple[9]) || 0,
            afterCompaction: tuple[10] === 1,
            source: tuple[11] === 1 ? "auxiliary" : "assistant",
          });
        }
      }
      files.push({
        messages,
        sessionId: f.sessionId ?? "",
        cwd: f.cwd ?? "",
        parentSession: f.parentSession ?? "",
      });
    }
    return { files, names };
  } catch {
    return null;
  }
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts: number): number {
  const d = new Date(ts);
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

interface Totals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  sessions: Set<string>;
}

function emptyTotals(): Totals {
  return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: new Set() };
}

function fmt(n: number): string {
  return n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : `${Math.round(n)}`;
}

function fmtCost(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

/** Render a Markdown usage summary (today / this week / all time). */
export function renderUsageSummary(): string {
  const cache = loadUsageCache();
  if (!cache) {
    return "## Usage\n\nNo usage data found. Run `/usage` in the TUI first to build the usage cache.";
  }
  const now = Date.now();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);

  const today = emptyTotals();
  const week = emptyTotals();
  const all = emptyTotals();
  const byModel = new Map<string, Totals>();

  for (const file of cache.files) {
    for (const m of file.messages) {
      const t = m.timestamp;
      const targets = [all];
      if (t >= todayStart) targets.push(today);
      if (t >= weekStart) targets.push(week);
      for (const target of targets) {
        target.cost += m.cost;
        target.input += m.input;
        target.output += m.output;
        target.cacheRead += m.cacheRead;
        target.cacheWrite += m.cacheWrite;
        target.messages += 1;
        target.sessions.add(file.sessionId);
      }
      const key = `${m.provider}/${m.model}`;
      const byModelEntry = byModel.get(key) ?? emptyTotals();
      byModelEntry.cost += m.cost;
      byModelEntry.input += m.input;
      byModelEntry.output += m.output;
      byModelEntry.cacheRead += m.cacheRead;
      byModelEntry.cacheWrite += m.cacheWrite;
      byModelEntry.messages += 1;
      byModel.set(key, byModelEntry);
    }
  }

  const row = (label: string, t: Totals): string =>
    `| ${label} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheWrite)} | $${t.cost.toFixed(4)} | ${t.messages} | ${t.sessions.size} |`;
  const lines: string[] = [
    "## Usage",
    "",
    "| Period | Input | Output | Cache R | Cache W | Cost | Msgs | Sessions |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    row("Today", today),
    row("This week", week),
    row("All time", all),
  ];

  if (byModel.size > 0) {
    const sorted = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
    lines.push("", "### By model (all time)", "", "| Model | Input | Output | Cost | Msgs |", "| --- | --- | --- | --- | --- |");
    for (const [key, t] of sorted) {
      lines.push(`| ${key} | ${fmt(t.input)} | ${fmt(t.output)} | $${t.cost.toFixed(4)} | ${t.messages} |`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Structured usage data for the web panel (server aggregates, frontend
// renders). Mirrors the extension's UsageData shape (5 time tabs, providers
// with models, totals, insights, hourly graph series) as JSON-safe arrays.
// ---------------------------------------------------------------------------

export interface UsageTokenStats {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageModelStat {
  name: string;
  messages: number;
  cost: number;
  tokens: UsageTokenStats;
  sessions: number;
}

export interface UsageProviderStat {
  name: string;
  messages: number;
  cost: number;
  tokens: UsageTokenStats;
  sessions: number;
  models: UsageModelStat[];
}

export interface UsageInsight {
  kind: "structure" | "alarm";
  stat: string;
  headline: string;
  advice: string;
}

export interface UsagePeriodStat {
  providers: UsageProviderStat[];
  totals: {
    messages: number;
    cost: number;
    tokens: UsageTokenStats;
    sessions: number;
  };
  insights: UsageInsight[];
}

export interface UsageHourBucket {
  /** Hour start timestamp (ms). */
  hour: number;
  cost: number;
  tokens: number;
  messages: number;
}

export interface UsageDataPayload {
  tabs: Record<string, UsagePeriodStat>;
  /** Full hourly series (all providers, with timestamps) - the render side
   * filters/aggregates per tab window (server only provides base data). */
  hourly: UsageHourBucket[];
  /** Time window per tab (ms) as [start, end] - base metadata. */
  tabWindow: Record<string, [number, number]>;
  /** Cache collection time (mtimeMs) so the UI can show data freshness. */
  collectedAt: number | null;
}

const TAB_KEYS = ["today", "thisWeek", "lastWeek", "last30Days", "allTime"] as const;

function emptyTokens(): UsageTokenStats {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(a: UsageTokenStats, b: UsageTokenStats): void {
  a.total += b.total;
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
}

/** Format a cost value the way the extension does (0 -> "-"). */
export function formatUsageCost(cost: number): string {
  if (cost === 0) return "-";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(2)}`;
  if (cost < 10) return `$${cost.toFixed(2)}`;
  if (cost < 100) return `$${cost.toFixed(1)}`;
  return `$${Math.round(cost)}`;
}

/** Format a token count compactly (12.3K, 4.5M, ...). */
export function formatUsageTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function periodStart(key: string, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (key === "today") return d.getTime();
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1; // Monday start
  if (key === "thisWeek") {
    d.setDate(d.getDate() - day);
    return d.getTime();
  }
  if (key === "lastWeek") {
    d.setDate(d.getDate() - day - 7);
    return d.getTime();
  }
  if (key === "last30Days") {
    return d.getTime() - 29 * 24 * 3600 * 1000;
  }
  return 0; // allTime
}

/**
 * Aggregate the cache into the structured payload the web panel renders.
 * Returns null when no cache exists yet.
 */
export function buildUsageData(): UsageDataPayload | null {
  const cache = loadUsageCache();
  if (!cache) return null;
  const now = Date.now();

  // per-tab accumulators
  const tabs: Record<string, {
    providers: Map<string, {
      messages: number; cost: number; tokens: UsageTokenStats; sessions: Set<string>;
      models: Map<string, { messages: number; cost: number; tokens: UsageTokenStats; sessions: Set<string> }>;
    }>;
    totals: { messages: number; cost: number; tokens: UsageTokenStats; sessions: Set<string> };
  }> = {};
  for (const key of TAB_KEYS) {
    tabs[key] = { providers: new Map(), totals: { messages: 0, cost: 0, tokens: emptyTokens(), sessions: new Set() } };
  }

  // hourly buckets (all providers, global) - the render side filters per tab
  const hourly = new Map<number, { cost: number; tokens: number; messages: number }>();
  const hourStart = (ts: number): number => Math.floor(ts / 3600_000) * 3600_000;

  for (const file of cache.files) {
    for (const m of file.messages) {
      const ts = m.timestamp;
      {
        const bucket = hourly.get(hourStart(ts));
        if (bucket) {
          bucket.cost += m.cost;
          bucket.tokens += m.input + m.output + m.cacheRead + m.cacheWrite;
          bucket.messages += 1;
        } else {
          hourly.set(hourStart(ts), { cost: m.cost, tokens: m.input + m.output + m.cacheRead + m.cacheWrite, messages: 1 });
        }
      }
      for (const key of TAB_KEYS) {
        const start = periodStart(key, now);
        if (ts < start) continue;
        const tab = tabs[key];
        tab.totals.messages += 1;
        tab.totals.cost += m.cost;
        addTokens(tab.totals.tokens, {
          total: m.input + m.output + m.cacheRead + m.cacheWrite,
          input: m.input,
          output: m.output,
          cacheRead: m.cacheRead,
          cacheWrite: m.cacheWrite,
        });
        tab.totals.sessions.add(file.sessionId);

        let prov = tab.providers.get(m.provider);
        if (!prov) {
          prov = {
            messages: 0, cost: 0, tokens: emptyTokens(), sessions: new Set(), models: new Map(),
          };
          tab.providers.set(m.provider, prov);
        }
        prov.messages += 1;
        prov.cost += m.cost;
        addTokens(prov.tokens, {
          total: m.input + m.output + m.cacheRead + m.cacheWrite,
          input: m.input,
          output: m.output,
          cacheRead: m.cacheRead,
          cacheWrite: m.cacheWrite,
        });
        prov.sessions.add(file.sessionId);

        let model = prov.models.get(m.model);
        if (!model) {
          model = { messages: 0, cost: 0, tokens: emptyTokens(), sessions: new Set() };
          prov.models.set(m.model, model);
        }
        model.messages += 1;
        model.cost += m.cost;
        addTokens(model.tokens, {
          total: m.input + m.output + m.cacheRead + m.cacheWrite,
          input: m.input,
          output: m.output,
          cacheRead: m.cacheRead,
          cacheWrite: m.cacheWrite,
        });
        model.sessions.add(file.sessionId);
      }
    }
  }

  const payload: UsageDataPayload = { tabs: {}, hourly: [], tabWindow: {}, collectedAt: usageCacheMtime() };
  // Graph x-axis windows per tab: [start, end]. today: midnight->now;
  // thisWeek: monday->now; lastWeek: monday->next Monday; last30Days:
  // start->now; allTime: 0 -> now (frontend clips to first data).
  for (const key of TAB_KEYS) {
    const start = periodStart(key, now);
    let end = now;
    if (key === "lastWeek") {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      const day = d.getDay() === 0 ? 6 : d.getDay() - 1;
      d.setDate(d.getDate() - day);
      end = d.getTime();
    }
    payload.tabWindow[key] = [start, end];
  }
  for (const key of TAB_KEYS) {
    const tab = tabs[key];
    const providers: UsageProviderStat[] = [...tab.providers.entries()]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([name, p]) => ({
        name,
        messages: p.messages,
        cost: p.cost,
        tokens: p.tokens,
        sessions: p.sessions.size,
        models: [...p.models.entries()]
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([mname, m]) => ({
            name: mname,
            messages: m.messages,
            cost: m.cost,
            tokens: m.tokens,
            sessions: m.sessions.size,
          })),
      }));

    // Simple insights: top provider share + largest model cost (alarms
    // when material), plus a structure line for overall usage.
    const insights: UsageInsight[] = [];
    const totalCost = tab.totals.cost;
    const totalTokens = tab.totals.tokens.total;
    if (totalCost > 0 && providers.length > 0) {
      const top = providers[0];
      const share = (top.cost / totalCost) * 100;
      if (share >= 20) {
        insights.push({
          kind: "alarm",
          stat: `${share.toFixed(0)}%`,
          headline: `${top.name} drives ${share.toFixed(0)}% of cost ($${top.cost.toFixed(2)})`,
          advice: "Consider switching cheaper models for routine work.",
        });
      }
      if (top.models.length > 0) {
        const topModel = [...top.models].sort((a, b) => b.cost - a.cost)[0];
        if (topModel.cost / totalCost >= 0.3) {
          insights.push({
            kind: "alarm",
            stat: formatUsageCost(topModel.cost),
            headline: `${topModel.name} is the costliest model (${((topModel.cost / totalCost) * 100).toFixed(0)}% of total)`,
            advice: "Check whether its output quality justifies the price.",
          });
        }
      }
    } else if (tab.totals.messages === 0) {
      insights.push({ kind: "structure", stat: "-", headline: "No usage recorded for this period.", advice: "" });
    }
    if (tab.totals.messages > 0) {
      insights.push({
        kind: "structure",
        stat: formatUsageTokens(totalTokens),
        headline: `${tab.totals.messages.toLocaleString()} messages, ${formatUsageTokens(totalTokens)} tokens total`,
        advice: totalCost > 0 ? `Spent ${formatUsageCost(totalCost)} across ${tab.totals.sessions.size} session(s).` : "",
      });
    }

    payload.tabs[key] = {
      providers,
      totals: {
        messages: tab.totals.messages,
        cost: tab.totals.cost,
        tokens: tab.totals.tokens,
        sessions: tab.totals.sessions.size,
      },
      insights,
    };
  }

  payload.hourly = [...hourly.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, v]) => ({ hour, cost: v.cost, tokens: v.tokens, messages: v.messages }));
  return payload;
}