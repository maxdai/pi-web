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
| `bridge-mirror.mjs` + `run-mirror.mjs` | **会话镜像**：把事件归一化为可重画的帧，验证一轮含工具调用的对话能否完整重画（§18.9 ①） |
| `run-shutdown.mjs` / `run-shutdown2.mjs` | **关停语义**：Ctrl+C（单/双次）、`SIGTERM`→pi、`SIGTERM`→script 包装进程（§18.9 ②） |
| `run-cpu.mjs` / `run-cpu2.mjs` | **开销**：pty 输出量与 pi CPU（`run-cpu2.mjs` 用 PPID 链定位 pi，因为 pi 会改写 argv） |

## 运行要点

- 依赖 `script`（util-linux）提供 pty；服务端固定用 **4096** 端口，运行前先 `lsof -ti:4096 | xargs -r kill`；
- 会话文件写在 `/tmp/tui-proto/session.jsonl`（避免污染真实会话）；cwd 用 `/root`（已信任，避免信任提示挡住）；
- 步骤 2 会真调一次模型；`/export` 会写文件到 `/tmp/tui-proto/`。

## 实测结论（摘要）

1. `mode:"tui"` + `hasUI:true` + 双 TTY ✓ —— pty 方案成立；
2. `pi.sendUserMessage(text)` → 完整事件流（`input/agent_start/turn_*/message_*/agent_end`，工具时另有 `tool_execution_*`）✓；
3. **扩展命令**走 `sendUserMessage(cmd, { expandPromptTemplates: true })` ✓（不触发模型）；
4. **内置命令**（`model`/`export`/…）**不走**上述 API（会被识别但不执行）→ 走 **pty 敲键** ✓（`/export x.jsonl` 实测落盘 58,503 字节）；
5. `pi.on("input")` 只对「提交的文本」触发，命令派发不触发；
6. **会话镜像**：`message_*` 事件带完整消息、`tool_execution_*` 带 args/result/isError/durationMs → 序列化即可重画；
   首屏历史用 `ctx.sessionManager.getEntries()`（实测 array(10)）；
7. **开销**：空闲 0 B/s、CPU≈0；一轮 5.3–7.2 KB/s、CPU 12.8%（单核）；
8. **关停**：TUI 的 Ctrl+C 是应用按键（不退出）；`SIGTERM` 0.6s 退出且不留孤儿，但都不触发 `session_shutdown`；
9. pi 会改写自身 argv（`comm=pi`）→ 子进程识别要用进程树/PID/环境标记。
