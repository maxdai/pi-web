/**
 * Usage statistics for the pi-web panel（阶段 E 起为 native/ 自带的运行时模块）。
 *
 * 来源：`pi-sdk-web/src/usage-render.ts` 的编译产物（该模块**零 SDK 依赖**，只用 node 内置模块），
 * 2026-10 阶段 E 迁移至此，使原生引擎自包含、并让包彻底去掉 TypeScript 构建链。
 * 原作者注释见 pi-web-design.md §15.11 / §17。
 */
/**
 * Usage statistics for the pi-web panel (standalone module).
 *
 * Data is collected directly from Pi's own session files
 * (~/.pi/agent/sessions/**\/*.jsonl): each assistant message carries
 * provider/model/timestamp/usage{input,output,cacheRead,cacheWrite,
 * reasoning,cost}, and auxiliary entries (compaction/branch_summary)
 * carry usage too. The collection mirrors the semantics used by the
 * pi-usage-extension (which reads the same session files and normalizes
 * them to a cache) - but this module is independent: it parses the
 * session files itself, so /usage works without the extension installed.
 *
 * The module aggregates the messages into the structured UsageDataPayload
 * (5 time tabs x provider/model x metrics + insights + global hourly
 * series + tab windows); the frontend renders.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const SESSIONS_DIRS = [
    join(process.env.PI_HOME?.replace(/^~/, homedir()) ?? homedir(), ".pi", "agent", "sessions"),
    join(homedir(), ".pi", "agent", "sessions"),
];
function sessionsDir() {
    for (const dir of SESSIONS_DIRS) {
        if (existsSync(dir))
            return dir;
    }
    return null;
}
/** Recursively collect all .jsonl session files under dir (sorted). */
function collectSessionFiles(dir, out) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            collectSessionFiles(p, out);
        else if (e.isFile() && e.name.endsWith(".jsonl"))
            out.push(p);
    }
}
function parseUsageAmount(value) {
    const u = value;
    if (!u || typeof u !== "object")
        return null;
    return {
        cost: Number(u.cost?.total) || 0,
        input: Number(u.input) || 0,
        output: Number(u.output) || 0,
        cacheRead: Number(u.cacheRead) || 0,
        cacheWrite: Number(u.cacheWrite) || 0,
        reasoning: Number(u.reasoning) || 0,
    };
}
function tsOf(messageTimestamp, entryTimestamp) {
    if (typeof messageTimestamp === "number")
        return messageTimestamp;
    if (typeof messageTimestamp === "string") {
        const n = new Date(messageTimestamp).getTime();
        if (!Number.isNaN(n))
            return n;
    }
    if (typeof entryTimestamp === "string") {
        const n = new Date(entryTimestamp).getTime();
        if (!Number.isNaN(n))
            return n;
    }
    return 0;
}
function auxMessage(usage, ts) {
    return {
        provider: "aux",
        model: "auxiliary",
        cost: usage.cost,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        timestamp: ts,
        reasoning: usage.reasoning,
        source: "auxiliary",
    };
}
/**
 * Parse one session jsonl into its usage messages (the same semantics as
 * the pi-usage-extension: assistant messages contribute their own usage,
 * compaction/branch_summary entries contribute auxiliary usage).
 */
function parseSessionFile(path) {
    let sessionId = "";
    let cwd = "";
    let parentSession = "";
    const messages = [];
    let content;
    try {
        content = readFileSync(path, "utf8");
    }
    catch {
        return { sessionId, cwd, parentSession, messages };
    }
    for (const line of content.split("\n")) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue; // malformed line
        }
        switch (entry.type) {
            case "session": {
                if (typeof entry.id === "string")
                    sessionId = entry.id;
                if (typeof entry.cwd === "string")
                    cwd = entry.cwd;
                if (typeof entry.parentSession === "string")
                    parentSession = entry.parentSession;
                break;
            }
            case "thinking_level_change": {
                break;
            }
            case "compaction": {
                const usage = parseUsageAmount(entry.usage);
                if (usage) {
                    const ts = tsOf(undefined, entry.timestamp);
                    // ts===0 means no timestamp was recoverable - skip so it can't
                    // create a 1970 spike in the hourly graph or leak out of all tabs.
                    if (ts > 0)
                        messages.push(auxMessage(usage, ts));
                }
                break;
            }
            case "branch_summary": {
                const usage = parseUsageAmount(entry.usage);
                if (usage) {
                    const ts = tsOf(undefined, entry.timestamp);
                    // ts===0 means no timestamp was recoverable - skip so it can't
                    // create a 1970 spike in the hourly graph or leak out of all tabs.
                    if (ts > 0)
                        messages.push(auxMessage(usage, ts));
                }
                break;
            }
            case "message": {
                const msg = entry.message;
                if (!msg)
                    break;
                if (msg.role === "assistant" && msg.usage && msg.provider && msg.model) {
                    const usage = parseUsageAmount(msg.usage);
                    if (usage) {
                        messages.push({
                            provider: msg.provider,
                            model: msg.model,
                            cost: usage.cost,
                            input: usage.input,
                            output: usage.output,
                            cacheRead: usage.cacheRead,
                            cacheWrite: usage.cacheWrite,
                            timestamp: tsOf(msg.timestamp, entry.timestamp),
                            reasoning: usage.reasoning,
                            source: "assistant",
                        });
                    }
                }
                break;
            }
            default:
                break;
        }
    }
    return { sessionId, cwd, parentSession, messages };
}
/** Collect usage across all session files. Empty array when none found. */
export function collectUsage() {
    const root = sessionsDir();
    if (!root)
        return [];
    const files = [];
    collectSessionFiles(root, files);
    const out = [];
    for (const f of files) {
        const parsed = parseSessionFile(f);
        if (parsed.messages.length > 0 || parsed.sessionId)
            out.push(parsed);
    }
    return out;
}
const TAB_KEYS = ["today", "thisWeek", "lastWeek", "last30Days", "allTime"];
function emptyTokens() {
    return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function addTokens(a, b) {
    a.total += b.total;
    a.input += b.input;
    a.output += b.output;
    a.cacheRead += b.cacheRead;
    a.cacheWrite += b.cacheWrite;
}
/** Format a cost value the way the extension does (0 -> "-"). */
function formatUsageCost(cost) {
    if (cost === 0)
        return "-";
    if (cost < 0.01)
        return `$${cost.toFixed(4)}`;
    if (cost < 1)
        return `$${cost.toFixed(2)}`;
    if (cost < 10)
        return `$${cost.toFixed(2)}`;
    if (cost < 100)
        return `$${cost.toFixed(1)}`;
    return `$${Math.round(cost)}`;
}
/** Format a token count compactly (12.3K, 4.5M, ...). */
function formatUsageTokens(n) {
    if (n >= 1e9)
        return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3)
        return `${(n / 1e3).toFixed(1)}K`;
    return `${Math.round(n)}`;
}
function periodStart(key, now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    if (key === "today")
        return d.getTime();
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
/** Exclusive upper bound of a tab window (see periodStart: lastWeek ends at
 * this Monday 00:00; today/thisWeek/last30Days/allTime end at 'now'). */
function periodEnd(key, now) {
    if (key === "lastWeek") {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        const day = d.getDay() === 0 ? 6 : d.getDay() - 1;
        d.setDate(d.getDate() - day);
        return d.getTime();
    }
    return now;
}
/**
 * Aggregate collected session usage into the structured payload the web
 * panel renders. Returns null when no usage data exists. When sessionId
 * is given, only that session's usage is aggregated (scope: current
 * session); otherwise all sessions.
 */
export function buildUsageData(sessionId) {
    const files = collectUsage();
    const scoped = sessionId ? files.filter((f) => f.sessionId === sessionId) : files;
    if (scoped.length === 0)
        return null;
    const now = Date.now();
    // per-tab accumulators
    const tabs = {};
    for (const key of TAB_KEYS) {
        tabs[key] = { providers: new Map(), totals: { messages: 0, cost: 0, tokens: emptyTokens(), sessions: new Set() } };
    }
    // hourly buckets (all providers, global) - the render side filters per tab
    const hourly = new Map();
    const hourStart = (ts) => Math.floor(ts / 3600_000) * 3600_000;
    for (const file of scoped) {
        for (const m of file.messages) {
            const ts = m.timestamp;
            {
                const bucket = hourly.get(hourStart(ts));
                if (bucket) {
                    bucket.cost += m.cost;
                    bucket.tokens += m.input + m.output + m.cacheRead + m.cacheWrite;
                    bucket.messages += 1;
                }
                else {
                    hourly.set(hourStart(ts), { cost: m.cost, tokens: m.input + m.output + m.cacheRead + m.cacheWrite, messages: 1 });
                }
            }
            for (const key of TAB_KEYS) {
                const start = periodStart(key, now);
                const end = periodEnd(key, now);
                if (ts < start || ts >= end)
                    continue;
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
    const payload = { tabs: {}, hourly: [], tabWindow: {}, collectedAt: Date.now() };
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
        const providers = [...tab.providers.entries()]
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
        const insights = [];
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
                        // Model names can repeat across providers (e.g. deepseek-v4-
                        // flash on several providers) - show provider/model.
                        headline: `${top.name}/${topModel.name} is the costliest model (${((topModel.cost / totalCost) * 100).toFixed(0)}% of total)`,
                        advice: "Check whether its output quality justifies the price.",
                    });
                }
            }
        }
        else if (tab.totals.messages === 0) {
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
