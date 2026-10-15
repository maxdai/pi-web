# tools/tui-proto —— 「TUI 模式 + 桥接 + pty」最小验证原型（2026-10-15）

设计依据与完整结论见 `pi-web-design.md` §18（尤其 §18.8 实测结果）。**本目录不进发布产物**
（npm 包 `files: ["dist"]`），仅为可复现留档。

## 是什么

验证 pi-vscode 式路线的三个前置问题：**起得来 / 送得进 / 命令通**。

| 文件 | 作用 |
|---|---|
| `bridge.mjs` | 最小桥接扩展：上报就绪（`/event`）、轮询待发消息（`/pending`）、转发事件、注册测试命令 `pi-web-proto:ping` |
| `run.mjs` | 主流程：HTTP 收事件 + `script -q -c "pi --extension bridge.mjs --session /tmp/... " /dev/null` 起 pty；`node run.mjs 1` 只跑步骤 1，`node run.mjs all` 跑全部 |
| `run-type.mjs` | 定向：空闲时往 pty 敲自定义命令（验证「替用户敲」） |
| `run-builtin.mjs` | 定向：内置命令经 `sendUserMessage(expandPromptTemplates)` 的行为 |
| `run-type2.mjs` | 定向：内置命令经 pty 敲键（`/model` 面板渲染、`/export *.jsonl` 落盘 58,503 字节） |

## 运行要点

- 依赖 `script`（util-linux）提供 pty；服务端固定用 **4096** 端口，运行前先 `lsof -ti:4096 | xargs -r kill`；
- 会话文件写在 `/tmp/tui-proto/session.jsonl`（避免污染真实会话）；cwd 用 `/root`（已信任，避免信任提示挡住）；
- 步骤 2 会真调一次模型；`/export` 会写文件到 `/tmp/tui-proto/`。

## 实测结论（摘要）

1. `mode:"tui"` + `hasUI:true` + 双 TTY ✓ —— pty 方案成立；
2. `pi.sendUserMessage(text)` → 完整事件流（`input/agent_start/turn_*/message_*/agent_end`，工具时另有 `tool_execution_*`）✓；
3. **扩展命令**走 `sendUserMessage(cmd, { expandPromptTemplates: true })` ✓（不触发模型）；
4. **内置命令**（`model`/`export`/…）**不走**上述 API（会被识别但不执行）→ 走 **pty 敲键** ✓（`/export x.jsonl` 实测落盘 58,503 字节）；
5. `pi.on("input")` 只对「提交的文本」触发，命令派发不触发。
