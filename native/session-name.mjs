/** 会话显示名解析（cli / server 共用，语义与 `pii`（Python）一致）。
 *
 *  规则：解析 JSONL 每一行，取**最后一条** `session_info` 的 `name`；该条没有 name 时按"无名"处理
 *  （与 pii 的 `name = n.strip() if isinstance(n, str) else ""` 对齐）。
 *
 *  为什么必须取最后一条（2026-10-15 修 bug）：**fork 会把父会话的条目一并带进新文件**，
 *  因此一个文件里可能出现多条 session_info。取第一条会拿到**父会话的名字**——实测
 *  `mv-main`（/root/pi-multi-viewers）是 `pah` 的 fork，文件里有 `name:"pah"`（继承）与
 *  `name:"pmv"`（本会话，较晚），旧的正则取首条 → `pi-web list` 把它显示成 `pah`，
 *  `/resume` 里于是出现两个 `pah`，`--session <名字>` 匹配也会跟着错。
 *
 *  只对含 `session_info` 的行做 JSON.parse（大文件下避免逐行解析开销）。
 */
export function sessionDisplayName(text) {
  let name;
  for (const line of text.split("\n")) {
    if (!line.includes("session_info")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（与 pii 的 json.JSONDecodeError 处理一致）
    }
    if (entry?.type !== "session_info") continue;
    name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : undefined;
  }
  return name;
}
