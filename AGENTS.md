# AGENTS.md

本文件为 pi-web 项目的 AI 代理工作指引，供开发此项目的 AI 代理（如 Claude Code、Codex、Coding Agent 等）阅读并遵循。

## 1. 项目概述

pi-web 是给 Pi（一款 AI coding agent 终端工具）提供浏览器 Web 访问方式的项目。核心目标：**不改 Pi 本体代码**，通过 `pii`（Python 启动脚本）编排，让用户在浏览器中访问 Pi，获得与 TUI 接近的使用体验。

### 核心设计

```text
浏览器
  |  HTTP / WebSocket / SSE
  v
Python Web 服务（127.0.0.1:<port>）
  |  JSON line 协议（stdin/stdout）
  v
Pi 后端（pi --session <id> --mode rpc）
  |  AgentSession / Agent 事件
  v
LLM / Provider
```

### 关键技术决策

- **不改 Pi 本体**：所有控制逻辑集中在 `pii` 脚本和 Web 服务。
- **Pi RPC 模式**：Pi 已原生支持 `--mode rpc`（JSON line over stdin/stdout），`pii` 通过子进程方式启动。
- **Web 服务**：Python 实现（MVP 用标准库起步即可）。
- **Web UI 目标**：尽量还原 TUI 的展示结构和配色，而非做成通用聊天界面。

## 2. 命令行接口

```text
pii r <name>                # 默认：进入 TUI（现有行为，不变）
pii r <name> --web          # Web 服务，使用默认端口 4080
pii r <name> --web <port>   # Web 服务，使用指定端口
```

- `--web` 不带值 → 默认端口 `4080`
- `--web <port>` → 指定端口（1–65535）
- 统一绑定 `127.0.0.1`
- 端口非法或占用 → 报错退出（不做自动换端口）

## 3. 开发流程（三阶段，重要）

任何设计或修改都应遵循以下三阶段流程，**顺序不可跳过**：

### 阶段 1：讨论
- 通过讨论确定如何进行设计或修改。
- **此阶段不进行代码的实际修改**。
- 充分沟通目标、方案、边界、不确定性。

### 阶段 2：生成或更新设计文件
- 根据讨论结果，**生成或更新设计文件**。
- **本项目所有设计相关内容统一放在 `pi-web-design.md` 中**。
- 任何涉及设计的修改（新增、变更、撤销设计决策）都必须**同步更新到 `pi-web-design.md`**，把讨论达成的结论以书面形式固化下来。
- 不应在 `pi-web-design.md` 之外另建散落的设计说明文件。

### 阶段 3：开发 / 修改
- **根据讨论结果及设计文件**，进行相应的开发和修改。

> 注意：不要在没有讨论和设计文件的铺垫下直接动手改代码。

## 4. Git 使用原则（重要）

### 基本规则

- **默认分支**：`master`
- **远程仓库**：`https://github.com/maxdai/pi-web.git`（origin）

### 提交流程

- **小的、细碎修改** → 只进行**本地 `git commit`**，不推送。
- **相对阶段性的更新**（如完成一个模块、一个可运行的功能、一次有意义的设计变更）→ 推送到 GitHub（`git push`）。
- **避免频繁的 GitHub 操作**，不要把每笔小 commit 都 push。

> **判断标准（重要）**："小改动只做本地 commit"的初衷，是防止在**调试过程中需要不断修改**时造成 GitHub 频繁更新。所以真正决定 push 与否的，是**这次修改之后还有没有明显的后继操作**：
>
> - 如果修改之后还有一连串后继操作要接着做（处于调试/迭代过程中）→ 先本地 `git commit`，攒到一个阶段性节点再 `push`。
> - 如果这类修改改完就结束、**没有明显的后继操作** → 应当直接 `push` 到 GitHub，不要长期留在本地（下一次提交可能遥遥无期，久了有丢失风险）。
>
> 例如：像"删掉一个死代码笔误"这种独立、无后继操作的修改，改完即可推送到 GitHub。

### 提交规范

- 提交信息应**简洁、描述性**，说明改动内容。
- 一个提交尽量聚焦一个改动点。

## 5. 目录结构（提议，以实际为准）

```text
~/pi-web/
├── AGENTS.md           # 本文档
├── pi-web-design.md    # 设计文档
├── .gitignore
├── pii/                # pii 相关改造（可选）
│   └── ...
├── server/             # Python Web 服务
│   ├── server.py
│   └── ...
├── static/             # 浏览器前端
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## 6. 相关源码位置

- **Pi 源码**：`~/research/pi/`
- **Pi RPC 模式**：`~/research/pi/packages/coding-agent/src/modes/rpc/`
  - `rpc-mode.ts`：RPC 服务端实现（stdin 命令分发、stdout 事件输出）
  - `rpc-client.ts`：TypeScript 版 RPC 客户端（参考用）
  - `rpc-types.ts`：RPC 协议类型定义
  - `jsonl.ts`：JSON line 读写工具
- **Pi TUI 组件**（Web UI 设计参考）：
  - `~/research/pi/packages/coding-agent/src/modes/interactive/components/`
  - 深色主题：`~/research/pi/packages/coding-agent/src/modes/interactive/theme/dark.json`

## 7. RPC 协议速查

- **发送命令（stdin）**：JSON line，`{"id": "...", "type": "prompt", "message": "..."}`
- **接收响应（stdout）**：`{"id": "...", "type": "response", "command": "prompt", "success": true, "data": {...}}`
- **接收事件（stdout）**：`{"type": "message_start", ...}` 等
- **接收扩展 UI 请求**：`{"type": "extension_ui_request", ...}`

### 常用命令

| 命令 | 说明 |
|------|------|
| `prompt` | 发送用户消息，异步，事件跟随 |
| `abort` | 中止当前操作 |
| `get_state` | 获取 session 状态（模型、thinking、消息数等） |
| `get_messages` | 获取所有消息历史 |
| `get_entries` | 获取 session 条目（含消息、模型变更、compaction 等），支持 `since` |
| `get_tree` | 获取会话树 |
| `set_model` / `cycle_model` | 模型操作 |
| `set_thinking_level` / `cycle_thinking_level` | thinking 级别 |
| `compact` | 手动压缩上下文 |
| `switch_session` | 切换 session |
| `fork` / `clone` | 分支 / 克隆 |

## 8. TUI 展示结构参考（Web UI 还原目标）

从上到下布局：

```
header (logo + keybinding hints)
消息列表：
  · 用户消息    → 有背景色块 (userMessageBg #343541)
  · 助手消息    → 无背景，Markdown 渲染
    - 文本      → 正常 markdown
    - thinking  → 斜体灰色 (thinkingText #808080)
    - toolCall  → 独立工具执行块
  · 工具执行块  → 独立背景色块
    - pending: #282832 / success: #283228 / error: #3c2828
    - 工具名加粗 + 参数 JSON + 输出预览
输入框
footer：
  · pwd + git branch · session name
  · token stats (↑input ↓output Rcache Wcache cost 上下文%)
  · model name · thinking level
```

## 9. 编码注意事项

- `pii` 使用 **Python 标准库**（当前实现零第三方依赖，尽量保持）。
- Web 服务 MVP 阶段优先考虑标准库。
- 前端优先还原 TUI 的深色主题和结构，不做花哨样式。
