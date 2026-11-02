/** 会话文件的**行偏移索引**与分页读取（设计见 pi-web-design.md §20）。
 *
 *  为什么不走 RPC：`get_entries` 的 `since` 是**向前游标**（只取严格晚于该 id 的条目，用于增量补齐），
 *  **不能往回翻页**。而会话文件本身就是 append-only 的条目流（第 1 行是 session header），
 *  自建偏移索引即可取任意页，并避免 Pi 把整份历史序列化成 JSON
 *  （实测 39.7 MB / 15,662 条的会话：全量 `get_entries` + WS 传输要 14.7s，而建索引只扫字节、约 0.2s）。
 *
 *  内存：每条目一个字节偏移（15k 条 ≈ 15k 个数字），不保留解析后的对象。
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

const CHUNK = 4 * 1024 * 1024;

/**
 * 建立或**增量扩展**行偏移索引。
 * - 首次：从头扫，跳过第 1 行（session header）与空行；
 * - 扩展：从上次最后一个完整行末尾继续扫（文件只会 append）；
 * - 调用方在文件变小时传 prev=null 重建。
 * 返回 `{ offsets, size, completeEnd }`：`offsets[i]` 是第 i 个条目的起始字节偏移，
 * `completeEnd` 是最后一个完整行的末尾（尾部未写完的半行不会被计入）。
 */
export function buildIndex(filePath, prev = null) {
  const size = statSync(filePath).size;
  const extend = Boolean(prev) && prev.completeEnd <= size;
  const offsets = extend ? prev.offsets.slice() : [];
  // header 是否已跳过必须**跨次记住**：首建时文件可能还是空的/只写了半行（Pi 先 openSync 再写），
  // 早先只用一个局部变量 → 之后走 extend 就一律把 header 当成第 0 条目，total 永久 +1 ✗
  let headerEnd = extend ? (prev.headerEnd ?? -1) : -1;
  let firstLine = headerEnd < 0; // 首次建索引、或上轮还没见到 header 换行 → 第 1 行仍算 header
  let lineStart = extend ? prev.completeEnd : 0;
  let completeEnd = lineStart;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = lineStart;
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 0x0a) continue;
        const lineEnd = pos + i;
        if (firstLine) {
          firstLine = false;
          headerEnd = lineEnd + 1; // 第一条条目从这里开始
        }
        else if (lineEnd > lineStart) offsets.push(lineStart); // 非空行才记
        lineStart = lineEnd + 1;
        completeEnd = lineStart;
      }
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
  return { offsets, size, completeEnd, headerEnd };
}

/** 读取 `[from, to)` 区间的条目（**只解析这一页**）。 */
export function readPage(filePath, index, from, to) {
  const total = index.offsets.length;
  const lo = Math.max(0, Math.min(from, total));
  const hi = Math.max(lo, Math.min(to, total));
  if (hi <= lo) return [];
  const start = index.offsets[lo];
  const end = hi < total ? index.offsets[hi] : index.completeEnd;
  if (!(end > start)) return [];
  const len = end - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(filePath, "r");
  let filled = 0;
  try {
    // 读满为止；stat 与 read 之间文件可能被 Pi 截断重写（openSync(path,'w')）→ 短读时
    // 早先会拿 allocUnsafe 的残留内存当内容（parse 失败被静默吞掉 → 条目凭空消失 ✗）
    while (filled < len) {
      const n = readSync(fd, buf, filled, len - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
  } finally {
    closeSync(fd);
  }
  if (filled < len) throw new Error("session file changed while reading");
  const out = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过（与 pii 的处理一致） */
    }
  }
  return out;
}

/** 条目总数（= 索引长度）。 */
export function countEntries(index) {
  return index.offsets.length;
}

/** 当前 leafId：文件 append 顺序的最后一个条目（等价于 RPC `get_entries` 的 `leafId`）。
 *
 *  ⚠️ 这个等价关系**只在从未做过树导航时成立**：`navigateTree` 不带摘要时只移动内存叶指针、
 *  **不追加任何条目**（core/session-manager.ts:1579/1591），此后文件最后一条 ≠ 当前叶。
 *  二期做 `/tree` 导航时必须改由桥接上报 `ctx.sessionManager.getLeafId()`（设计 §26.4）。
 */
export function lastEntryId(filePath, index) {
  const total = countEntries(index);
  if (total === 0) return null;
  return readPage(filePath, index, total - 1, total)[0]?.id ?? null;
}

// ---------------------------------------------------------------- `/tree` 元数据

/** 把任意 content（字符串 / 内容块数组）压成纯文本。 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join(" ");
}

/** 压成一行并截断（树里每条只占一行，正文不进 payload）。 */
function oneLine(value, max = 200) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function argsPreview(args) {
  if (args === undefined || args === null) return "";
  try {
    return oneLine(typeof args === "string" ? args : JSON.stringify(args), 60);
  } catch {
    return "";
  }
}

/** 一条 entry 的单行摘要（对齐 TUI `TreeSelectorComponent.getEntryDisplayText`）。 */
function entryText(entry, toolCalls) {
  switch (entry.type) {
    case "message": {
      const msg = entry.message ?? {};
      const role = msg.role;
      const text = oneLine(contentText(msg.content));
      if (role === "user") return `user: ${text}`;
      if (role === "assistant") {
        if (text) return `assistant: ${text}`;
        if (msg.stopReason === "aborted") return "assistant: (aborted)";
        if (msg.errorMessage) return `assistant: ${oneLine(msg.errorMessage, 80)}`;
        return "assistant: (no content)";
      }
      if (role === "toolResult") {
        const call = msg.toolCallId ? toolCalls.get(msg.toolCallId) : null;
        return call ? `[${call}]` : `[${msg.toolName ?? "tool"}]`;
      }
      if (role === "bashExecution") return `[bash]: ${oneLine(msg.command, 120)}`;
      return `[${role ?? "message"}]`;
    }
    case "custom_message": {
      const text = typeof entry.content === "string" ? entry.content : contentText(entry.content);
      return `[${entry.customType ?? "custom"}]: ${oneLine(text)}`;
    }
    case "compaction":
      return `[compaction: ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens]`;
    case "branch_summary":
      return `[branch summary]: ${oneLine(entry.summary)}`;
    case "model_change":
      return `model: ${entry.modelId ?? ""}`;
    case "thinking_level_change":
      return `thinking: ${entry.thinkingLevel ?? ""}`;
    case "custom":
      return `custom: ${entry.customType ?? ""}`;
    case "context_edit":
      return `context edit: ${entry.replacement === null ? "omit" : "replace"} ${entry.targetId ?? ""}`;
    case "session_info":
      return `title: ${entry.name ?? ""}`;
    case "label":
      return `label: ${entry.label ?? ""}`;
    default:
      return `[${entry.type}]`;
  }
}

/**
 * `/tree` 的轻量元数据（设计 §26）：只保留 `id/parentId/类型/role/时间/一行摘要/标签`，丢弃正文。
 *
 * 为什么不用 RPC `get_tree`：它返回**完整 entry**（含消息体），大会话下正是 §20 实测 14.7 s 的老路。
 * 整份读取 + 解析实测（41 MB / 15,663 条）约 330 ms，可接受；调用方按文件大小做缓存。
 */
export function buildTreeMeta(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const nodes = [];
  const labels = new Map(); // targetId → { label, ts }
  const toolCalls = new Map(); // toolCallId → "name(args)"

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（与 pii 的处理一致）
    }
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.type) continue; // header / 坏行
    if (entry.type === "session") continue; // 第 1 行的 session header（不是树里的条目）
    // label / usage 也**保留为节点**（默认 filter 会隐藏）：它们是真实的树条目，
    // 叶指针可能正好落在它们上面；丢掉会让"叶 → 根"的父链断掉、当前分支高亮全丢（实测 ✗）。
    if (entry.type === "label") labels.set(entry.targetId, { label: entry.label, ts: entry.timestamp ?? null });
    // 先记下工具调用 → 后面的 toolResult 行显示 "name(args)"（与 TUI 的 toolCallMap 同思路）
    if (entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block && block.type === "toolCall" && typeof block.id === "string") {
          toolCalls.set(block.id, `${block.name}(${argsPreview(block.arguments)})`);
        }
      }
    }
    const node = {
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type: entry.type,
      ts: typeof entry.timestamp === "string" ? entry.timestamp : null,
      text: entryText(entry, toolCalls),
    };
    if (entry.type === "message") node.role = entry.message?.role ?? null;
    nodes.push(node);
  }

  for (const node of nodes) {
    const hit = labels.get(node.id);
    if (hit && hit.label) {
      node.label = hit.label;
      node.labelTs = hit.ts;
    }
  }
  return nodes;
}
