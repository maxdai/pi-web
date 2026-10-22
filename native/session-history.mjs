/** 会话文件的**行偏移索引**与分页读取（设计见 pi-web-design.md §20）。
 *
 *  为什么不走 RPC：`get_entries` 的 `since` 是**向前游标**（只取严格晚于该 id 的条目，用于增量补齐），
 *  **不能往回翻页**。而会话文件本身就是 append-only 的条目流（第 1 行是 session header），
 *  自建偏移索引即可取任意页，并避免 Pi 把整份历史序列化成 JSON
 *  （实测 39.7 MB / 15,662 条的会话：全量 `get_entries` + WS 传输要 14.7s，而建索引只扫字节、约 0.2s）。
 *
 *  内存：每条目一个字节偏移（15k 条 ≈ 15k 个数字），不保留解析后的对象。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

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

/** 当前 leafId：文件 append 顺序的最后一个条目（等价于 RPC `get_entries` 的 `leafId`）。 */
export function lastEntryId(filePath, index) {
  const total = countEntries(index);
  if (total === 0) return null;
  return readPage(filePath, index, total - 1, total)[0]?.id ?? null;
}
