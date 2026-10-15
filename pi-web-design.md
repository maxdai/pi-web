# pi-web Design

给 Pi 提供浏览器 Web 访问方式，不改 Pi 本体，通过 `pii` 启动脚本集成。

## 1. 背景与目标

### 1.1 现状问题

- 通过 SSH 连接 Pi 时，TUI 存在一些问题：
  - `regular` 模式：终端原生复制可用，但偶发闪烁/反复跳行，难以使用。
  - `fullscreen` 模式：屏幕不闪，但 Pi 内部接管鼠标选择，原生复制长句困难（即使按 Shift 也不行）。
  - fullscreen 下鼠标滚轮上下滚动时明显变慢，且向上滚可能触发重绘风暴导致终端软件卡死。
- 希望有一种稳定、不依赖终端渲染的访问方式。

### 1.2 目标

- 提供浏览器 Web 访问方式。
- 单用户使用，只监听 `127.0.0.1`。
- 通过命令行选择运行方式：
  - 默认进入 TUI。
  - 加参数后只提供 Web 访问。
- 不改 Pi 本体代码。

### 1.3 使用者启动方式

用户实际通过 `/usr/local/bin/pii` 这个 Python 脚本启动 Pi 的 session，日常用法：

```text
pii r <name>
```

`pii` 会解析 session 名称，`cd` 到对应项目目录后调用：

```text
pi --session <id>
```

### 1.4 结论

- 不改 Pi，所有控制逻辑集中在 `pii` 脚本。
- Web 访问作为 `pii r <name>` 的一个可选后端参数提供。

## 2. 命令行接口

### 2.1 语法

```text
pii r <name>                # 默认：进入 TUI
pii r <name> --web          # Web 服务，使用默认端口 4080
pii r <name> --web <port>   # Web 服务，使用指定端口
```

### 2.2 端口语义

- `--web` 不带值 → 使用默认端口 `4080`
- `--web <port>` → 使用指定端口（例如 `12345`）
- 统一绑定在 `127.0.0.1`

### 2.3 端口解析规则

- `--web` 后如果紧跟一个数值参数，则作为端口。
- 否则使用默认端口 `4080`。
- 端口必须是合法整数，例如 1–65535。
- 端口非法（非数字、越界）→ 报错退出。
- 端口被占用 → 报错退出（可预期、稳定，暂不做自动换端口）。

### 2.4 参数冲突

- `pii r <name> --web foo` → 认为非法端口，报错退出。

## 3. 生命周期

### 3.1 TUI 模式（现有行为，不变）

```text
pii r <name>
  -> 解析 name -> session id + cwd
  -> cd 到 cwd
  -> exec pi --session <id>
  -> 等待 Pi TUI 进程结束
  -> pii 正常退出
```

### 3.2 Web 模式

```text
pii r <name> --web [port]
  -> 解析 name -> session id + cwd
  -> cd 到 cwd
  -> 启动 Pi 后端子进程：pi --session <id> --mode rpc
  -> 启动本地 Web 服务：Python HTTP + WebSocket/SSE，监听 127.0.0.1:<port>
  -> 打印：server at http://127.0.0.1:<port>/
  -> pii 保持常驻等待
  -> 直到用户 Ctrl+C 或 kill：
       - 关闭 Web 服务
       - 关闭 Pi 后端
       - pii 退出
```

### 3.3 异常处理

- 端口被占用 → 立即报错退出。
- Pi 后端意外退出 → 打印错误并退出（暂不做自动重启）。
- Web 服务绑定失败 → 报错退出。
- 正常情况：常驻等待，直到信号退出。

### 3.4 浏览器断线

- 浏览器刷新、断线、关闭，不影响 Pi 后端运行。
- 重新打开页面应能重新连上同一个 session。

## 4. 总体架构

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
LLM / Provider（pi-ai）
```

关键点：

- Pi 本体零修改。
- `pii` 负责编排 Pi 后端与 Web 服务。
- Web 服务可以是 `pii` 脚本内嵌的 Python 服务，也可以是 `pii` 启动的独立进程。

## 5. Pi 后端：`--mode rpc`

### 5.1 为什么用 RPC 模式

- RPC 模式通过 stdin/stdout 传 JSON line，适合被外部程序嵌入。
- 不需要 TUI，不依赖终端渲染。
- 与 `pii`（Python）通信自然。

### 5.2 启动方式

```text
pi --session <id> --mode rpc
```

### 5.3 协议

- `pii` 以子进程方式启动 Pi RPC。
- 通过 `stdin` 发送 JSON 命令。
- 通过 `stdout` 接收 JSON 响应和事件。
- 需要处理：
  - 命令请求 / 响应关联
  - 事件流订阅
  - stdout 行缓冲
  - 背压 / 大批量事件

### 5.4 需要覆盖的命令（MVP 参考）

- 创建 / 打开 session
- 恢复已有 session（`--session <id>`）
- 发送用户消息（prompt）
- 订阅 Agent 事件
- 读取 session 历史 / 上下文
- 关闭 / 退出 session
- 可选：模型、thinking、abort 等

## 6. Web 服务（Python）
> **状态（2026-10-14，阶段 E 已完成）**：本节描述的实现在阶段 E 已被**移除**（Python RPC 服务 `server/` 被删除；SDK 宿主 `src/` 与 `pi-agent-core`/`pi-coding-agent` 依赖被删除），当前唯一引擎为「RPC + 注入桥接扩展」（§15 / §15.13 / §17）。本节保留为历史设计与对照。


### 6.1 实现语言

- 因为 `pii` 已经是 Python，Web 服务优先用 Python 实现（标准库即可起步）。
- 后续如需更强能力，可以引入第三方依赖。

### 6.2 职责

- 绑定 `127.0.0.1:<port>` 提供 HTTP。
- 提供静态页面（HTML/CSS/JS）。
- 提供浏览器与 Pi 之间的实时通道：**WebSocket（双向）**。
- 转播 Pi 的 Agent 事件给浏览器（**方案 A：事件中转**）。
- 把浏览器用户输入转成 RPC 命令发送给 Pi。

### 6.3 实时通道：WebSocket（已确认）

- 使用 **WebSocket** 作为浏览器与 Web 服务之间的双向实时通道。
- 与 Pi RPC 的全双工特性（stdin 输入命令 + stdout 输出事件）天然匹配。
- MVP 阶段可用 Python 标准库手写简单 WebSocket，或引入轻量实现；以简单可行为准。

### 6.4 事件处理：方案 A（事件中转，已确认）

- **Web 服务只负责事件中转**：把 Pi RPC 输出的事件（`message_start` / `message_update` / `message_end` / `tool_execution_*` / `agent_settled` 等）**原样通过 WebSocket 推送给浏览器**。
- **前端 JS 负责渲染**：把事件翻译成 TUI 风格的界面（用户消息色块、助手消息、thinking、工具执行块等）。
- 优点：服务端逻辑简单、灵活，前端能更逼真地复刻 TUI 的交互与展示效果。
- 若后续发现 A 方案效果不佳，再评估转向 B（服务端整理数据）。

### 6.5 历史加载

- 浏览器首次打开时：Web 服务向 Pi 发 `get_entries`，返回 session 全部历史（含 user / assistant / tool 消息）。
- 随后订阅实时事件增量。
- 目标：**与 TUI fullscreen 的消息流布局同等效果**（关闭时保留 transcript、重新打开完整还原历史 + 继续增量）。

### 6.6 MVP 页面功能与交互

- 消息列表（还原 TUI fullscreen 展示）：
  - 用户消息：带背景色块（`userMessageBg #343541`）
  - 助手消息：无背景，Markdown 渲染
    - 文本：正常 markdown
    - thinking：灰色斜体（`thinkingText #808080`）
  - 工具执行块：独立背景色块（pending `#282832` / success `#283228` / error `#3c2828`）
- 输入框 + 发送按钮（多行、回车发送）
- 加载已有 session 历史
- 连接状态显示（Connected / Disconnected）
- 页面刷新后重连同一个 session
- **支持的操作**：
  - `prompt`：发送用户消息
  - `abort`：中止当前操作
  - 模型切换（`set_model` / `cycle_model` / `get_available_models`）
  - thinking 切换（`set_thinking_level` / `cycle_thinking_level`）

### 6.7 前端 Markdown 渲染（已确认）

- 使用 **marked** 渲染 Markdown（与 TUI 使用的渲染库一致）。
- 库文件放在本地 `static/vendor/`，**不依赖 CDN**（本地服务可能无外网）。
- 具体方案：
  - 复制 `marked.umd.js` 到 `static/vendor/marked.min.js`。
  - 前端通过 `<script>` 引入。
  - 用户消息、助手文本、thinking 等 Markdown 内容都用 marked 渲染。
- **XSS 安全**：LLM 生成内容不可信，需要 sanitize（白名单过滤或禁用原始 HTML）。
- **流式渲染**：`message_update` 时 Markdown 内容可能不完整，marked 应能容忍部分 Markdown 并持续更新。
- 代码高亮（highlight.js）暂不做，后续需要再加。

### 6.8 工具执行块展示（已确认，尽量仿照 TUI）

- **区分 bash 和其他工具**：
  - bash：显示 `$ command`（加粗、绿色 `bashMode`），输出预览 5 行。
  - 其他工具：显示工具名（加粗）+ 参数 JSON，输出预览 10 行。
- **背景色状态**：
  - pending：`#282832`
  - success：`#283228`
  - error：`#3c2828`
- **输出预览 + 展开/收起**：
  - 默认截断预览，超出行数时显示 `... (N more lines, to expand)`。
  - 点击工具块可展开/收起完整输出。
- **耗时显示**：
  - 从 `tool_execution_start` 开始计时。
  - 完成时显示 `Took X.Xs`，进行中显示 `Elapsed X.Xs`。
- **截断警告**：
  - 若 result.details 中有 `truncation` / `fullOutputPath`，显示 `[Truncated: ...]` 和 `Full output: path`。
- **数据来源**：
  - `tool_execution_start`（toolName、args）→ 创建工具块、开始计时。
  - `tool_execution_update`（partialResult）→ 更新输出。
  - `tool_execution_end`（result、isError）→ 完成状态、最终输出、耗时、截断警告。
  - 历史加载：assistant 消息中的 toolCall 创建工具块，toolResult 消息更新结果。

### 6.9 Status 指示器（已确认，四种都做）

- 在消息流与输入框之间显示状态指示区域。
- **Working**：`agent_start` / `turn_start` 时显示，`agent_settled` / `agent_end` 时隐藏。带 spinner 动画。
- **Retry**：`auto_retry_start` 时显示 `Retrying (attempt/maxAttempts) in Xs... (to cancel)`，`auto_retry_end` 时隐藏。
- **Compaction**：`compaction_start` 时显示 `Auto-compacting...` / `Compacting context...`，`compaction_end` 时隐藏。
- **Branch Summary**：`summarization_retry_attempt_start`（source=branchSummary）时显示 `Summarizing branch...`，`summarization_retry_finished` 时隐藏。
- 样式：spinner 用 CSS 动画，文字灰色。

### 6.10 Pending Messages（已确认，仿照 TUI）

- 显示在消息流与状态指示器之间（`#pending` 区域）。
- 数据来源：Pi RPC 的 `queue_update` 事件（`steering: string[]` / `followUp: string[]`）。
- 显示内容：
  - `Steering: <message>`（灰色）
  - `Follow-up: <message>`（灰色）
  - 无队列时隐藏区域。
- 当前 Web 版暂不提供编辑队列的快捷键（后续可加）。

### 6.11 特殊消息展示（已确认，仿照 TUI）

- 在历史加载和实时事件中处理非 message 的 session entry：
  - `branch_summary` → `[branch]` 标签 + 紫色背景 + summary（可展开）
  - `compaction` → `[compaction]` 标签 + 紫色背景 + token 数 + summary（可展开）
  - `custom` / `custom_message` → `[customType]` 标签 + 紫色背景 + 内容
- 紫色背景：`customMessageBg #2d2838`，标签色 `customMessageLabel #9575cd`，文字色 `customMessageText`。
- 支持点击展开/收起（长内容默认收起）。

### 6.12 Header / Loaded Resources（已确认，简化版）

- **Header**：
  - 显示 `pi v<version>`（版本号）。
  - 不显示终端快捷键提示（Web 端不适用）。
  - 当前 session 名称/模型已由 footer 展示，header 保持简洁。
- **Loaded Resources**（可展开/收起区域，位于消息流上方）：
  - 数据来源：`get_commands` 命令。
  - Skills：`source=skill` 的项。
  - Prompts：`source=prompt` 的项。
  - Extensions：`source=extension` 的项。
  - Context 文件列表 / Themes 暂不做（无 RPC 命令）。
- 默认收起，点击展开显示列表。

### 6.13 编辑器快捷键（已确认，MVP）

- **`!` 开头直接执行 bash**：
  - 输入以 `!` 开头（如 `!ls -la`），发送 `bash` 命令给服务端。
  - 服务端调用 Pi RPC `bash` 命令，返回结果。
  - 前端把结果显示为 bash 工具块。
- **`/` 斜杠命令提示**：
  - 输入以 `/` 开头时，显示可用命令下拉列表（来自 `get_commands`）。
  - 用户可选择命令插入输入框。
  - MVP 先只做提示/选择，暂不执行斜杠命令（后续再加）。

### 6.14 内置斜杠命令支持（已确认）

- `/` 菜单数据源 = `get_commands` 返回的扩展/prompt/skill 命令 + **内置命令列表**（前端内置）。
- **可执行的内置命令**：
  - `/model` → 打开模型选择面板（等同点击 footer 的 model）。
  - `/thinking` → 打开 thinking 选择面板（等同点击 footer 的 thinking）。
  - `/compact` → 发送 `compact` RPC 命令。
  - `/name` → 提示输入名称并发送 `set_session_name`。
- **暂不支持的内置命令**（如 `/login`、`/logout`、`/settings` 等）：在菜单中显示但标记"暂不支持"或隐藏。
- 点击 footer 的 model / thinking 文字也打开对应选择面板。

### 6.15 通用弹窗 UI 机制（已确认）

- 处理 Pi RPC 的 `extension_ui_request` 事件，把 TUI 原本弹窗显示的内容在 Web 端以模态框呈现。
- 支持类型：
  - `select` → 弹窗选项列表，用户选择后发送 `extension_ui_response`（value）。
  - `confirm` → 弹窗确认/取消，回传 `confirmed` 或 `cancelled`。
  - `input` → 弹窗输入框，回传 `value` 或 `cancelled`。
  - `editor` → 弹窗多行编辑器，回传 `value` 或 `cancelled`。
  - `notify` → 通知弹窗（可手动关闭）。
  - `setWidget` → 组件面板（侧边栏或弹窗显示）。
  - `setStatus` → 状态栏显示（已有，保持）。
- 服务端：增加 `extension_ui_response` 命令，把浏览器响应转发给 Pi RPC。
- 前端：扩展现有 modal 组件，支持多种交互类型。

### 6.16 待完善事项（暂不做，后续可加）

#### RPC 模式限制导致的无法显示项

Pi RPC 模式不支持「工厂函数 / 自定义组件」类 UI，导致以下 TUI 内容无法在 Web 端显示：

- **`/ctx-status` 自定义弹窗**（magic-context）
  - TUI 中通过 `ctx.ui.custom()` 显示 `StatusDialogComponent` 居中弹窗。
  - RPC 模式 `custom()` 是 no-op，且 `hasUI` 误判为 true，导致内容既不弹窗也不走 fallback，完全丢失。
- **`/todos` 常驻面板**（magic-context TodoOverlay）
  - TUI 中通过 `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })` 显示常驻 todos 面板。
  - RPC 模式 `setWidget` 只支持字符串数组，工厂函数被忽略，不发出任何事件。
  - 注意：`/todos` 命令的一次性 notify 弹窗是正常支持的。

> 解决方向：需 Pi 或 magic-context 支持在 RPC 模式下序列化这些自定义组件内容（例如让 `hasUI` 正确为 false 以走 fallback，或让 `custom()`/`setWidget()` 输出渲染文本）。

> **2026-10 更新（见 §15）**：上述两项限制**已在 pi-web 侧解决，无需 Pi 或 magic-context 改动**。做法是随 `--extension` 注入一个桥接扩展，改写 `ctx.ui` 的方法自行渲染——`ctx.ui` 是 runner 的共享可变对象，实测能拦截其他扩展的调用。`setWidget(工厂)`、`custom()`、`setTheme` 与对话框均已实测可用。

#### 其他暂不做

- `/login`、`/logout` 等认证命令（RPC 不支持，需在 TUI 中操作）
- Context 文件列表 / Themes 展示
- 多用户 / 鉴权
- TUI 组件复用（TUI 是终端渲染，不能直接复用）

## 7. 数据流

### 7.1 用户输入

```text
浏览器输入
  -> WebSocket / HTTP POST
  -> Python Web 服务
  -> JSON line 发送给 pi --mode rpc
  -> AgentSession.prompt()
  -> Agent / LLM / tools
```

### 7.2 事件回流

```text
Agent 事件（message_start / message_update / message_end / tool_execution_* / turn_* / agent_*）
  -> Pi RPC stdout（JSON line）
  -> Python Web 服务
  -> WebSocket / SSE
  -> 浏览器渲染
```

### 7.3 页面打开时

```text
浏览器请求页面
  -> 建立 WebSocket
  -> Web 服务向 Pi RPC 请求该 session 的当前历史
  -> 服务端把历史推给浏览器
  -> 之后持续转播增量事件
```

## 8. 稳定性设计要点

1. **长连接**：WebSocket 或 SSE 保持浏览器与 Web 服务的连接。
2. **断线重连**：
   - 浏览器刷新/断线后自动重连。
   - 重连后重新加载历史并继续接收增量。
3. **事件顺序**：
   - 先加载历史，再订阅增量。
   - 避免重复或乱序渲染。
4. **Pi 常驻**：
   - 浏览器断线不影响 Pi 后端。
   - `pii` 常驻直到 Ctrl+C / kill。
5. **本机安全**：
   - 只监听 `127.0.0.1`。
   - 暂不做鉴权（单用户本机）。

## 9. `pii` 脚本改造（设计层面）

### 9.1 现状

`pii` 已有命令：

```text
pii list
pii r <name>
pii delete <name>
pii delete "(unnamed)"   # 删除所有无显示名（unnamed）会话，2026-09 新增
```

### 9.2 改造点

- `cmd_resume` 增加 `--web [port]` 解析。
- **不影响原有功能**：
  - 无 `--web`：严格保持现有 `pi --session <id>` 行为（TUI 模式，原样不变）。
  - 有 `--web`：新增 Web 分支，启动 Pi RPC 后端 + Python Web 服务，常驻等待信号。
- 所有改动必须在**保留原有 TUI 功能完全不受影响**的前提下进行。

### 9.3 实现细节（已确认）

- pii 脚本放在项目 `pii/pii`（受 Git 管理），可软链/复制到 `/usr/local/bin`。
- **项目路径解析规则**（按优先级）：
  1. 环境变量 `PI_WEB_DIR`（若设置，则使用该路径）。
  2. 脚本位于项目内（`<项目>/pii/pii`，父目录含 `server/`）→ 推导为父目录。
  3. 全局安装时 fallback 到 `~/pi-web`（若存在 `server/`）。
- Web 模式：pii 解析出 session_id + cwd 后，通过 `subprocess.call([python, server.py, session_id, cwd, "--port", port])` 启动 Web 服务。
- server.py 路径：`<项目根>/server/server.py`。
- pii 常驻等待 server.py 退出；Ctrl+C 时向子进程转发信号。

### 9.4 安装方式

- 项目内：直接运行 `python3 pii/pii ...`。
- 全局安装：复制/软链到 `/usr/local/bin/pii`。
- 全局安装时依赖路径解析规则（`PI_WEB_DIR` 或 `~/pi-web` fallback）。

### 9.5 参数解析规则（已确认）

```text
pii r <name> --web [port]
```

- 找到 `--web`。
- 若其后紧跟数字 → 作为端口。
- 否则 → 默认 4080。
- 端口必须是 1–65535，非法 → 报错退出。

## 10. 目录结构（提议）

```text
~/pi-web/
├── pi-web-design.md     # 本文档
├── pii/                 # pii 相关改造（可选）
│   └── ...
├── server/              # Python Web 服务
│   ├── server.py
│   └── ...
├── static/              # 浏览器前端
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

以上是开发前的目录设想，具体以实际需要为准。

## 11. 后续待细化 & 开放问题

1. Python Web 服务的 WebSocket 实现方式：
   - 用标准库手写简单 WebSocket，还是引轻量第三方库？
   - 当前倾向：MVP 先用标准库手写（依赖少、可控）。
2. 浏览器前端渲染 Markdown 的具体方案（是否引 marked/highlight.js 等，或自实现简化版）。
3. `pii` 与 Pi RPC 的事件订阅如何关联请求 ID（前端发起命令时如何匹配响应与事件流）。
4. `pii web` 退出时如何干净地杀掉 Pi RPC 子进程？
   - 建议：先发关闭命令，再 `terminate()`，最后兜底 `kill()`。
5. Web 服务在 `pii` 内嵌入运行，还是作为独立进程由 `pii` 启动？

## 12. 已确认的设计决策（摘要）

| 项 | 决策 |
|----|------|
| 是否改 Pi | 不改，控制逻辑在 `pii` |
| 启动方式 | 通过 `pii r <name>` 增加 `--web` |
| pii 改造原则 | 不影响原有 TUI 功能（无 `--web` 时保持原样） |
| pii 脚本位置 | 项目 `pii/pii`（受 Git 管理），可复制/软链到 `/usr/local/bin` |
| pii 项目路径解析 | `PI_WEB_DIR` 环境变量 → 项目内推导 → `~/pi-web` fallback |
| pii Web 启动 | 解析 session 后调用 `server.py <session_id> <cwd> --port <port>` |
| 默认 UI | TUI（`pii r <name>`） |
| Web 语法 | `pii r <name> --web [port]` |
| 默认端口 | `4080` |
| 绑定地址 | `127.0.0.1` |
| 生命周期 | Web 模式常驻，直到 Ctrl+C / kill |
| Pi 后端 | `pi --session <id> --mode rpc` |
| Web 服务 | Python 实现 |
| 实时通道 | **WebSocket（双向）** |
| 事件处理 | **方案 A：事件中转**（Web 服务只中转事件，前端负责渲染） |
| 历史加载 | 首次打开用 `get_entries` 加载历史，随后订阅增量 |
| 前端效果 | **尽量复刻 TUI fullscreen 的消息流布局**（用户色块、工具块、thinking 等） |
| 支持操作 | prompt、abort、模型切换、thinking 切换 |
| 浏览器断线 | 不影响 Pi，可重连 |
| 端口占用/非法 | 报错退出 |
| 开发顺序 | 先实现 Web 服务（不依赖 pii），再在保留原有功能基础上改造 pii |

## 13. 下一步建议

按顺序推进：

1. **先实现 Web 服务**（Python，独立可运行），暂不改 `pii`。
2. 让 Web 服务能真正接通 Pi RPC，浏览器可对话。
3. 前端按 TUI fullscreen 风格渲染（方案 A）。
4. 验证效果后，再在不影响原有 TUI 功能基础上改造 `pii` 接入 Web 模式。

## 14. 备选方案：独立 pi-web 模块（SDK 客户端，主推）
> **状态（2026-10-14，阶段 E 已完成）**：本节描述的实现在阶段 E 已被**移除**（Python RPC 服务 `server/` 被删除；SDK 宿主 `src/` 与 `pi-agent-core`/`pi-coding-agent` 依赖被删除），当前唯一引擎为「RPC + 注入桥接扩展」（§15 / §15.13 / §17）。本节保留为历史设计与对照。



> 本节是 2025-08 的讨论结论，记录为**备选方案**，尚未决定实施。当前已实现并运行的仍是 RPC 桥接方案（§6）。
>
> **方案演进**：本节初稿记录的是「Pi 内置 WebMode」（改 Pi 源码）。后续调研发现 Pi 以**公开 npm 包 + SDK**形式发布，因此主推方案调整为「**独立 pi-web npm 包（SDK 客户端）**」——不改 Pi 本体，安装 pi-web 后接管 TUI 场景的职责。「改 Pi 内置 WebMode」降为次选（见 §14.5）。
>
> **2026-10 再演进（见 §15）**：实测发现「原生 pi + 注入桥接扩展」可在**不并行 SDK 副本**的前提下拿到等价 UI 能力，因此 SDK 宿主不再是唯一主推；它在迁移完成前仍是**在运行的实现**。

### 14.1 动机

当前 RPC 桥接方案的根因限制（见 §6.16）：Pi RPC 模式对「工厂函数 / 自定义组件」类 UI 不支持，导致 `custom()`、`setWidget(factory)` 等扩展 UI 无法在 Web 端呈现。这些限制的根源是 **JSON line 序列化边界**——事件和 UI 请求必须可序列化，且 RPC 模式刻意移除了 TUI 相关的 UI 能力。

> **2026-10 修正（见 §15）**：本节的根因分析只对「纯 RPC」成立。注入桥接扩展后，`ctx.ui` 的方法可在 pi 进程内被改写，`custom()`、`setWidget(factory)`、`setTheme` 均已实测可用——**「序列化边界」不再是必须内嵌 SDK 的理由**。本节因此从「唯一主推」变为「并存的参照实现」。

### 14.2 概念澄清（重要）

"pi-tui 模块"容易混淆，实际指两个不同东西：

| 名字 | 实际是什么 | 是否需要替代 |
|------|-----------|-------------|
| `@earendil-works/pi-tui`（`packages/tui/`） | 终端 UI **组件库**（terminal/layout/markdown/editor 等渲染原语） | 不需要，只是工具库 |
| `InteractiveMode`（`packages/coding-agent/src/modes/interactive/interactive-mode.ts`，约 6500 行） | 把 TUI 组件 + AgentSession 组装成完整交互体验的**模式** | 这才是要替代/并列的对象 |

**关键补充**：Pi 的插件（extension）机制**不能**接管主 UI。`ExtensionUIContext` 只提供弹窗/widget/status/title/editor 文本等**局部** UI 能力；消息流、输入框、footer 是 `InteractiveMode` 硬编码的。因此「通过 Pi 插件机制接管 pi-tui」在技术上不成立；正确的形态是 **pi-web 作为 SDK 客户端，自己实现完整的 UI 宿主层**，与 `InteractiveMode` 平级——用户安装 pi-web 后用它作为入口，`pi` 命令原样保留。

### 14.3 关键事实：Pi 以公开 npm 包 + SDK 形式发布（源码 + registry 核实）

- `@earendil-works/pi-coding-agent` **0.84.2 已发布到 npm registry**（非 private），官方入口 `index.ts` 导出**完整 SDK**：
  - `createAgentSession()` / `createAgentSessionRuntime()` / `createAgentSessionServices()` —— 编程式创建会话
  - `AgentSession` / `AgentSessionRuntime` —— 会话对象（`subscribe` / `prompt` / `abort` / `setModel` / `bindExtensions` / `sessionManager.getEntries()` / `getSessionStats()` 等全部公开）
  - `ExtensionRunner` / `ExtensionUIContext` / `ExtensionFactory` —— 完整扩展系统
  - 甚至 `runRpcMode` / `InteractiveMode` 也导出
- `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 均为独立发布的公开包。

**结论**：任何第三方包都可以像 Pi 自己一样，用 SDK 创建并驱动一个完整的 AgentSession，只替换 UI 层。pi-web 模块方案由此成立。

### 14.4 独立模块方案（主推）

```text
pi-sdk-web（独立 npm 包，位于 pi-web 仓库 pi-sdk-web/ 子目录）
  ├── 依赖: @earendil-works/pi-coding-agent（SDK）、@earendil-works/pi-ai
  ├── 不依赖: @earendil-works/pi-tui        ← 关键：UI 层完全自实现
  ├── bin: pi-web                            ← 用户入口，替代 TUI 场景
  ├── 内部:
  │     createAgentSessionRuntime()          → 复用 Pi 全部核心
  │     session.subscribe(event)             → WS 推给浏览器（对象直接透传）
  │     浏览器输入                            → session.prompt/abort/setModel/...
  │     bindExtensions({ uiContext: WebUIContext })  → 扩展 UI 直接映射浏览器 DOM
  └── static/ 前端（复用仓库根 static/，构建时打包进包内，保证独立发布）
```

关键点：

- **零修改 Pi**：纯 npm 依赖，不 fork、不 patch，完全符合项目核心原则。
- **无 JSON line 序列化边界**：消息对象、工具结果、事件原样透传；§6.16 的 RPC 限制天然消失（`/ctx-status` 弹窗、`/todos` 常驻面板可正常显示）。
- **Web UI context**：`select/confirm/input/editor/notify/setWidget/custom` 直接映射浏览器 DOM。
- **单进程**：不需要 Python 服务 + Pi 子进程两套编排。
- **同步能力**：浏览器请求可直接读 `session.model`、`session.thinkingLevel` 等内部状态，无需 `get_state` 往返。

### 14.5 与「改 Pi 内置 WebMode」对比（次选）

两方案能力接近（都直接持有 session），差异在**修改边界与维护方式**：

| 维度 | 改 Pi 内置 WebMode（次选） | 独立 SDK 客户端模块（主推） |
|------|---------------------------|---------------------------|
| Pi 本体 | **必须改**（新增 mode + args + 分派） | **零修改**（纯依赖公开 SDK） |
| 安装方式 | 需重装/重建 Pi | `npm install -g` 即可 |
| 升级维护 | 跟随 Pi 源码演进，需持续 patch | 跟随公开 npm 包版本，SDK 契约内适配 |
| CLI 层复用 | 复用 main.ts 的 session 选择/信任流程 | 需自建（session 选择、信任提示等，见 §14.8） |
| 回退 | 需还原 Pi 源码 | 卸载 pi-web 即回退 |

### 14.6 与当前 RPC 桥接方案对比

> 最终关系：**两方案并存，用户按需选择**。pii（RPC 桥接）保留不动，pi-sdk-web（SDK 客户端）为并行方案。

| 维度 | 现状（RPC 桥接，pii） | 独立 SDK 客户端模块（pi-sdk-web） |
|------|-----------------|---------------------------|
| 改 Pi 本体 | 不改 | 不改 |
| 扩展 UI 完整性 | 受 RPC 序列化限制（§6.16）→ **2026-10 起由注入桥接扩展补齐（§15）** | 完整（Web UI context） |
| 事件/数据开销 | JSON line 编解码 + partial 剥离 | 零序列化，对象直接透传 |
| 进程模型 | pii 编排 Python 服务 + Pi 子进程 | 单进程（pi-sdk-web 内部） |
| Web 服务语言 | Python（标准库） | TypeScript（与 Pi SDK 同语言） |
| 前端 static/ | 复用 | 复用（构建时打包进包） |
| server.py/rpc_client.py/websocket.py | 核心 | 不涉及 |
| pii 脚本 | 编排两个进程 | 不涉及（平级，互不影响） |
| 维护成本 | 跟随 RPC 协议演进 | 跟随 pi-coding-agent SDK 版本 |

### 14.7 已确认的设计决策（尚未实施）

1. **独立模块方案**：pi-sdk-web 作为独立 npm 包，位于当前 pi-web 仓库的 `pi-sdk-web/` 子目录；接管 TUI 场景的 UI 职责；Pi 本体零修改，`pi` 命令原样保留。
2. **包名**：`pi-sdk-web`（npm 包名），bin 命令名 `pi-web`。
3. **CLI 形态**：`pi-web r <name> [--port]`，与 `pii` 并列；默认端口 `4080`（与 pii 一致，两方案不会同时跑）。
4. **pii 保留**：原有 RPC 桥接方案（pii + server/）功能保留、不动；两种方式并存，用户最终可选择用哪种来跑。
5. **实现语言 TypeScript**：Web 服务在 pi-sdk-web 包内实现（Node 内置 http + 轻量 WebSocket），与 Pi SDK 同语言，不做跨语言桥接。
6. **前端复用**：仓库根 `static/` 为唯一前端源，pi-sdk-web 构建时打包进包内，保证独立发布（避免两份前端漂移）。
7. **session 解析**：`pi-web r <name>` 用 SDK 的 `SessionManager.list/open` 实现，不依赖 pii 的 Python 逻辑。
8. **开发顺序**：pi-sdk-web 作为独立新模块先跑通；现有 RPC 方案保持不动作为对照。

### 14.8 开放问题决策（已确认）

1. **CLI 层逻辑：MVP 简化**——不做 trust 弹窗/首次设置，默认信任加载（与本机单用户场景匹配，与 pii 现状一致）；`pi-web r <name>` 用 `SessionManager.list` 按名字匹配（与 pii 逻辑一致）。注：SDK 未导出 `resolveProjectTrusted`/`createProjectTrustContext`（CLI 内部实现），但 `ProjectTrustStore`、`hasTrustRequiringProjectResources` 已导出，未来需要完整 trust 流程时可自建。
2. **session 管理命令**：MVP 提供 `pi-web r` + `pi-web list`（`SessionManager.listAll` 公开可用）；**`delete` 不做**（破坏性操作，由 pii 负责，职责划分清晰）。
3. **WebSocket 实现**：**`ws` 包**——Node 无内置 WebSocket 服务端（内置是客户端），`ws` 是事实标准、成熟、零原生依赖；不手写。
4. **SDK 版本策略**：**`^0.84.2`**——npm 对 0.x 的 `^` 语义自动锁定 minor（等效 `~`）；SDK 演进时手动验证后升版本，流程为「Pi 升级 → 验证 SDK API → 升版本」。
5. **发布/安装路径**：**MVP 不发布 npm**——开发期 `npm link` / 本地安装（`npm install -g ./pi-sdk-web`）；功能稳定后再视需要发布（`pi-sdk-web` 包名已确认可用，未被占用）。

### 14.9 实现状态与补充决策（2025-08，已落地）

pi-sdk-web 已实现并通过浏览器验收（本地提交，随本设计一起推送）。**架构与协议**：

- **模块结构**：`pi-sdk-web/src/`（`cli.ts` 命令入口、`session.ts` 查找、`server.ts` HTTP+WS 桥接、`ui-context.ts` WebUIContext、`pii-cli.ts` pii bin 包装器）+ `verify-sdk.ts` 验证脚本。
- **pii 随 npm 包分发（补充决策）**：pii（RPC 桥启动器 + 桥）此前仅存于 GitHub 仓库（`pii/pii` + `server/*.py`，Python 标准库），无安装包。现随 `pi-sdk-web` 一起分发：build 时把 `pii/pii` 与 `server/*.py`（排除 `__pycache__`）复制进 `dist/pi-bin/`；npm bin 新增 `pii` → `dist/pi-bin/pii-cli.js`（Node 包装器，定位 `python3` 后 `spawnSync` 执行内嵌 `pii`，透传参数/stdin/stdio，设置 `PI_WEB_DIR=dist/pi-bin` 让 pii 解析到同目录 `server/server.py`）。安装 `pi-sdk-web` 后 `pii` 立即可用（需机器有 python3，与原脚本要求一致）；GitHub 仓库的 `pii/pii` 仍保留为开发入口。 **打包卫生（2026-09 修）**：拷贝时的 `__pycache__` 过滤挡不住**运行期**产物——Python 桥在 `dist/pi-bin/server/` 里运行时就地生成 `__pycache__/*.pyc`，于是被打进包（0.5.19 的 tarball 含 `rpc_client.cpython-313.pyc` 等 3 个文件）。**`.npmignore` 排不掉**：实测 `files: ["dist"]` 白名单存在时它不生效（文件数前后不变）。修法：build 的后处理抽为 `pi-sdk-web/scripts/build-assets.mjs`（幂等、路径相对脚本解析），装配资源后**递归清扫 `__pycache__`** 并做两项自检——① dist 中不得残留 `.pyc`（否则退出码 1）、② 分发关键文件齐全（`dist/cli.js`、`pi-bin/pii-cli.js`、`pi-bin/pii`、`server/server.py`、`static/index.html`）。发布走 `prepublishOnly → npm run build`，故打包前必过此清扫。
- **WebSocket 协议**：与现有 Python 桥接（server.py）**完全一致**——连接时发 `state`+`history`，Pi 事件原样广播，客户端消息 `prompt/abort/bash/set_model/...`，前端 `static/` 零修改复用。
- **扩展 UI**：`WebUIContext` 实现 `ExtensionUIContext`，select/confirm/input/editor 通过 `extension_ui_response` 由浏览器 resolve；notify/setStatus/setTitle/setWidget 直接广播；theme 返回**官方 Pi Theme 实例**（与 TUI 一致，见下）；`bindExtensions` 的 mode 用 `"rpc"`（ExtensionMode 无 web 值；rpc = dialog 可用、非终端 UI）。
- **注入对象的"自有属性"约定（重要，事故教训）**：Pi 的 `ExtensionRunner.wrapUIPromptContext` 构造扩展 ctx 时会对 uiContext 做 **`{...ui}` 浅展开**（用于包装 select/confirm/input/editor/custom 对话框方法）。**class 实例的方法在 prototype 上，浅展开会全部丢失**——`pi-deepinfra` 的 `onSessionStart` 调 `ctx.ui.setStatus` 崩溃实证（0.4.4 修复）。因此 **WebUIContext 构造时必须把原型方法复制为实例自有绑定属性 + theme 用 `Object.defineProperty` 自有可枚举 getter**（对齐 TUI 对象字面量形态：方法即自有属性）。通用原则：**传给 Pi 的对象优先用对象字面量，或用 class 时确保自有属性完整**；新写实现 `ExtensionUIContext`/`ExtensionCommandContext` 的类必须遵循。
- **theme 与 ANSI 颜色（对齐 TUI，补充决策）**：对齐 TUI 的做法——TUI 中 `ctx.ui.theme` 返回官方 Theme 实例（`interactive-mode.ts` 的 `get theme() { return theme; }`），扩展调用 `theme.fg("accent", text)` 等得到**真实 ANSI 转义串**，由终端解析渲染。pi-web 的浏览器没有终端，因此：
  - **服务端**：`WebUIContext.theme` 返回官方 Pi Theme 实例（`initTheme()` + `Theme` 类，色值来自包内 dark.json；与 TUI 同构），扩展拿到的 ANSI 串与 TUI 完全一致。
  - **前端**：移植 Pi `core/export-html/ansi-to-html.ts` 的 `ansiToHtml`（纯函数，支持 SGR 30-37/90-97/38;5/38;2/40-47/48;5/48;2/1/2/3/4/0 及重置，含 HTML 转义防注入）到 `app.js`，在浏览器渲染前把 ANSI 串转成带内联样式的 `<span>`——浏览器承担"终端"的 ANSI 渲染职责。应用范围：ext-status 状态行、widget 行、notify 内容、工具输出块；**markdown 消息文本不处理**（LLM 输出不含 ANSI，保持渲染路径不变）。
  - **边界**：TUI 的 footer 对扩展状态行是原样透传策略（`footer.ts:233-241` `sanitizeStatusText` 后直接拼接），pi-web 同义——扩展自带的 ANSI 颜色原样保留；notify 的 info/warning/error 分流在浏览器以不同样式呈现（浏览器无终端瞬态，属 pi-web 独特设计，保留）。
- **扩展命令执行**（`/ctx-status` 等，新增决策）：前端 `/cmd` 输入发送 `command` 消息 → 服务端 `extensionRunner.getCommand(name)` 取 `RegisteredCommand.handler`（公开字段）→ 调用时构造 `ExtensionCommandContext` 并传 **`hasUI: false`** → 扩展走文本 fallback（magic-context 的 ctx-status 用 `pi.appendEntry` 写 session custom entry）→ `entry_appended` 事件回传。**根因**：Pi 的 `ExtensionRunner.hasUI()` 实现是 `uiContext !== noOpUIContext`，提供任何 uiContext 即 hasUI=true（§6.16 的"误判"）；命令上下文是自构造对象，其 `hasUI` 是普通字段可覆盖。
- **命令输出弹窗**（新增决策，对齐 TUI）：服务端执行命令时订阅捕获期间产生的 custom entry，转为 `extension_ui_request`（method `notify`，title `/<命令名>`，message 为 Markdown 文本）弹窗广播；前端 notify 弹窗以 Markdown 渲染（sanitize 白名单复用）。session 历史中的 custom 块保留（默认收起，可回看）。
- **custom entry 按 `data.text` 区分呈现**（补充决策）：命令执行捕获的 **`type:"custom"`** entry 仅当 `data.text` 为非空字符串时才转弹窗；无 `data.text` 的 entry（如 minimode-status 的 `{mode,tools}` 状态轨迹）不弹窗、不回显为消息块，只在 session 文件/事件流留痕——与 TUI 一致（TUI 对无 renderer 的 custom entry 不渲染）。`custom_message`（有 `content`）不受此规则影响，仍按内容渲染。
- **流式期间的用户消息默认 steer**（补充决策，对齐 TUI）：会话运行中提交 user message 时，服务端 `prompt` 命令透传 `streamingBehavior: "steer"`（`prompt(text, { streamingBehavior: "steer" })`），与 interactive-mode.ts 默认行为一致（TUI 流式期间提交消息即用 steer 排队，`app.message.followUp` 仅是扩展键）。不传该选项时 Pi 抛「Agent is already processing...」错误。前端 `queue_update` 事件驱动 Steering pending 展示已有支持（对齐 Python 桥接协议），无需改动。
- **宿主进程伪装为 Pi（`argv[1]` 改写，补充决策）**：pi-web 是**进程内嵌入** SDK 的宿主（`createAgentSessionServices` + `createAgentSessionFromServices` 在自身进程创建 `AgentSession`，从不 spawn `pi` 命令），入口是自身 bin `pi-sdk-web/dist/cli.js`。magic-context 等进程内扩展用 `resolvePiInvocation()` 派生子 pi 时最信任 `process.argv[1]`（源码注释：*"extensions load in-process, so argv[1] is the host cli.js"*），在 pi-web 宿主下该值指向 pi-web 自身 → historian/dreamer 子进程会 re-exec web server（上游 magic-context issue #177 "host re-invoke"、PR-350 评审已记录）。**修复**：cli.ts 启动时把 `process.argv[1]` 改写为 pi-sdk-web 依赖的 `@earendil-works/pi-coding-agent/dist/cli.js`（`import.meta.resolve` 定位，不依赖 exports 子路径），使扩展派生的子 pi 命中真 Pi CLI。副作用核查：pi-sdk-web 自身用 `process.argv.slice(2)` 解析参数（不受影响）；Pi 核心模块不读 `argv[1]`（仅 Pi 自身 CLI 入口读，pi-web 从不调用）；magic-context `createRequire(argv[1])` 的 CJS 解析在改写前后行为一致（该路径因 ESM-only exports 限制本来就走不通，实际成功路径是 Bare import）。`process.title` 不改（Pi 设置 process.title=APP_NAME 仅 ps 显示用途，与 resolvePiInvocation 判定无关）。
- **主题切换（dark/light 对齐 TUI，补充决策）**：命名对齐 TUI——前端主题为 **dark / light**（原 bright 更名；CSS 色值本来就对齐 Pi light.json，`body.theme-light` 类名）。切换闭环：前端点主题按钮 → CSS 变量**即时切换**（等价 TUI 的 `onThemeChange → requestRender` 界面重绘）→ 发 `set_theme` WS 消息 → 服务端 `WebUIContext.setWebTheme(name)` 换 Theme 实例（加载对应 `dark.json`/`light.json` 色值，扩展后续 `setStatus`/`setWidget` 用新色）。**不做页面刷新**：与 TUI 一致——状态行文本在 setStatus 时固化，主题只重绘界面框架，扩展状态行颜色在下次事件更新时变新色。
- **bash 输入：`!cmd` / `!!cmd`（对齐 TUI，补充决策）**：前端输入框以 `!` 开头即执行 bash（与 TUI 一致）。`!cmd` 的输出进入 LLM 上下文；`!!cmd` 走排除上下文（`excludeFromContext: true`，TUI 同义——命令照常执行、界面显示结果，但输出不发送给 LLM，避免无关输出污染上下文/token）。服务端 `bash` 命令已支持 `excludeFromContext` 参数透传。
- **侧边栏 Extensions 框（Web 增强，补充决策）**：Loaded Resources 与 Tools 框下方新增第三个折叠框「Extensions」，列出**当前已加载扩展**的名称与版本号（如 `pi-magic-context 0.41.1`）。数据来源：服务端 `resourceLoader.getExtensions()`（公开 API）取已加载扩展的 `path`，向上定位最近 `package.json` 读 `name`+`version`；随 `state` 广播（`extensions: [{name, version}]`）。**仅列已加载扩展**（不列子依赖如 subc-client/aft-linux-x64）。TUI 无此列表（TUI 无侧边栏概念），属 Web 增强，与 Tools 框同先例。
- **Extensions 框：本地文件扩展的显示（补充决策，修正误示）**：walk-up 找 `package.json` 的方案对**包来源扩展**（`sourceInfo.origin="package"`，npm/@scope 或本地路径包）正确；但对**本地文件扩展**（`sourceInfo.origin="top-level"`，即 `~/.pi/agent/extensions/*.ts` 或项目 `.pi/extensions/*.ts`）会误读到**宿主仓库根 package.json**——实测 Pi 源码仓（cwd=`/root/research/pi`）的项目级扩展（import-repro/prompt-url-widget/redraws/tps）全部显示为 `pi-monorepo 0.0.3`（monorepo 根包名），让用户误以为装了一个叫 pi-monorepo 的插件。**修正决策**：扩展展示按 `sourceInfo` 分两类——① `origin="package"`：维持 walk-up 取 `name`+`version`，并在版本后**追加安装范围**（`sourceInfo.scope`，如 `0.41.2 · user`、`· project`）；② `origin="top-level"`：显示**相对 baseDir 的扩展名**（`.pi/extensions/*` 去掉 `extensions/` 前缀与 `.ts/.js`、`/index` 之后的部分，如 `import-repro`、`refresh-deepinfra`）+ 来源范围作版本列（`project`/`user`）。**内联扩展**（`path` 为 `<inline:...>`，如 Pi 内置 llama.cpp，`hidden:true`）跳过不列（虚拟实体，无磁盘/package.json）。`sourceInfo` 为 Pi SDK 在扩展对象上附加的公开字段（`extension.sourceInfo`：path/source/scope/origin/baseDir），无需自行拼接。
- **扩展命令的 hasUI 按扩展分流（补充决策）**：Pi 的 `hasUI()` = 绑定了 uiContext 即 true（RPC/TUI 同），扩展用它判断"能否 UI 输出"。但扩展对它的用法分两类：**notify 类**（mcp-adapter：`showStatus` 在 hasUI=false 时静默 return、true 时 `ctx.ui.notify` 输出）与 **custom 类**（magic-context ctx-status：hasUI=true 时走 `ctx.ui.custom()` 自绘 TUI 面板——Web 无法渲染；false 时走 appendEntry 文本 fallback）。Web 无 TUI 渲染器，`custom()` 只能静默 resolve（与 Pi RPC 的 headless stub 一致，RPC 下 /ctx-status 本就静默）。**决策**：`executeCommand` 按命令来源 `sourceInfo.path` 分流——含 `pi-magic-context` 的命令 `hasUI:false`（保留其文本 fallback → appendEntry → modal 弹框），其余命令 `hasUI:true`（notify 生效）。同时命令执行期间 `WebUIContext.sink` 临时包装：把 `notify` 广播附加 `title: "/<命令名>"` → 前端走 titled modal（彩色、Markdown 渲染），对齐 TUI 的 showStatus 常驻文本语义（notify(info) 在 TUI 是 chatContainer 追加灰色行，非弹窗；pi-web 用 modal 呈现更醒目，用户 2026-09-01 认可）。**notify 的改前形态**：前端 notify 曾走右上角自动消失的 toast（与 TUI 常驻语义不符），已改为命令标题 modal + 非命令 notify 追加为聊天流常驻行（`.notify-line`）。
  - **custom 名单扩充到 aft-pi（2026-09，补充）**：aft-pi 的唯一命令 `/aft-status` 在 hasUI=true 时同样走 `ctx.ui.custom()` 自绘面板（AftStatusDialogComponent），pi-web 无法渲染 → 表现为"命令无反应"。已把 `aft-pi` 加入 hasUI:false 名单（正则 `/pi-magic-context|magic-context|aft-pi/`），/aft-status 降级走 `ui.notify` 文本。判定原则统一为：**命令在 hasUI=true 分支走 `custom()` 的扩展**都应进此名单。
  - **命令 notify 的 sink 包装（2026-09 恢复，补充）**：上述"命令执行期间 sink 临时包装 notify 加 title → modal"机制曾于 widget 提交（41112f5）被顺带移除（commit 未说明原因，设计文档未同步），导致命令期间 notify 落回无 title 常驻行——/ctx-status（appendEntry 路径）仍弹 modal、/aft-status（notify 路径）却只显示常驻行，同属状态报告的两命令呈现不一致。已恢复 sink 包装（cb5a0cc）：命令执行期间所有 `notify` 广播附加 `title: "/<命令名>"`，前端 `title.startsWith("/")` → titled modal，全命令统一。
- **usage 命令的专用数据面板（Web 增强，补充决策）**：`/usage` 在 pi-web 是**原生功能**（2026-09-02 从读取扩展产物演进为直读 Pi 会话文件）。数据收集：usage-render.ts 独立模块**直接扫描 `~/.pi/agent/sessions/**/*.jsonl`**（Pi 会话条目里的 assistant 消息自带 `provider/model/timestamp/usage{input,output,cacheRead,cacheWrite,reasoning,cost}`；compaction/branch_summary 条目带辅助 usage），解析语义与 pi-usage-extension 一致（已验证全量 + 按 provider/model 分组 0 差异——3372 条消息/$13.9 完全一致），**不依赖该扩展**（可卸载）。服务端聚合出结构化数据（5 个时间段 × provider/model × 7 指标 + 简版 insights + 全局 hourly 序列 + tabWindow 时间窗口元数据）→ 广播 `usage_data`（**非 notify 文本**）→ 前端 **独立大面板**（非普通 modal）渲染：时间段 tab、Table 视图（provider 行可展开模型明细 + totals）、Insights 视图、Graph 视图（CSS 柱状图——hourly 趋势 + provider 占比）。**职责划分原则**：服务端只提供**基础数据**（聚合统计 + 全局时间序列 + tab 窗口元数据），**一切渲染适配在前端完成**——按 tab 过滤 hourly、补 0 连续时间轴（轴起点规则：全局最早数据早于段起点则整段展示、在段内则从首个数据小时开始）、聚合列数、坐标标签等都不进服务端。**/usage 命令处理**：executeCommand 特判直接聚合广播（不执行扩展命令）。
- **浏览器标签栏图标（Web 增强，补充决策）**：`index.html` 加 `<link rel="icon" type="image/svg+xml" href="pi-logo.svg">`，favicon 用 **Pi 官方 logo**（`static/pi-logo.svg`，取自官网 `https://pi.dev/logo-auto.svg`，618B 官方矢量，P+i 几何形；内含 `prefers-color-scheme` 媒体查询，系统暗色自动反白）。服务端 MIME 表原已含 `.svg`（`image/svg+xml`），零服务端改动；`pi-logo.svg` 随 `static/` 一起进包。使用官方资源而非自制，符合「不改 Pi 本体、纯前端增强」约束。
- **扩展对话框的断线加固（补充决策，2026-09）**：Pi 的 TUI/RPC 在对话框上无限等待（用户在终端前 / RPC 客户端自带超时），而浏览器标签页可能在 agent loop 运行中被关闭——此时 `select/confirm/input/editor` 的请求广播给零个客户端、promise 永不 settle，**整个 loop 卡死**（例：aft 的宿主机执行确认）。加固原则：**浏览器在线时永不超时（对齐 TUI，"用户可能正在忙"不能成为替他取消的理由），只有在确实无人可答时才兜底**：
  - **超时只在无浏览器时兜底**：扩展自带 `opts.timeout`（毫秒）优先并原样尊重；否则**有浏览器连接 = 不超时**（等多久都行），**无浏览器连接 = 10 分钟兜底**（关掉标签页不该永久堵塞 loop，同时给重连留足宽限）。兜底以对话框默认值 settle（confirm→false，其余→undefined）。
  - **连接状态驱动（动态）**：`WebUIContext.setBrowserAttached(bool)`（server 在 WS connect / 最后一个客户端离开 / broadcast 清理失效客户端时调用）——重新连上**立即取消**兜底计时（用户回来即恢复无限等待，修掉"重连后只剩几秒就超时"）；断开则对仍挂起的对话框**重新武装**兜底。
  - **重连重放未决对话框**：`WebUIContext` 保存每个未决对话框的完整线上载荷（含 id），WS 连接时（`handleConnection`）随 state/history/ext_status/widget 之后一并重放——关掉浏览器再打开即可继续回答，`id` 不变故响应能正确 settle。
  - **倒计时显示（对齐 TUI）**：扩展设定 timeout 时请求附绝对 `deadline`（epoch ms），前端在弹窗标题显示 `(Ns)` 倒数（TUI 的 `CountdownTimer` 同义），超时不再是"静默发生"；无 deadline 的对话框不显示倒计时也不自动结束。
  - **`opts.signal` 支持（对齐 Pi RPC/TUI）**：此前被忽略；现按 Pi 语义处理——已 aborted 的对话框立即以默认值 settle，未决期间 abort 亦 settle（即 abort 能解开卡住的确认框）。
  - **浏览器侧同步关闭**：服务端 settle（超时/abort/会话切换）后广播 `dialog_dismissed`（id+reason），前端关闭对应 modal 并追加一条警告行（`.notify-line`），避免留下可点击但已失效的弹窗；`clearSessionState` 亦广播（会话切换时 `clearContent()` 不会关弹窗）。兜底时长可由 `WebUIContextOptions.fallbackTimeoutMs` 覆盖（测试与调优用）。
  - **演进记录**：初版曾对"有浏览器"也给 10 分钟超时、无浏览器 60 秒且重连不重置计时——用户指出"我需要花 2 分钟做别的事，不该被默认取消"，遂改为上述按连接状态动态判定（在线不超时 + 重连取消兜底 + 倒计时可见）。
- **WS 广播背压保护（补充决策，2026-09，OOM 加固）**：线上出现 `FATAL ERROR: Reached heap limit`（~70 分钟后，V8 堆约 2.1GB 触顶）——`ws.send()` 在客户端读得慢（后台标签页被节流）时**在进程内存里无界排队**，长回合的 LLM delta 或 `!! … --follow` 长流式会一路堆积。**每个客户端两级阈值**：**软限 8MB** 起跳过「自愈型」delta 事件（`message_update` / `tool_execution_update`——下一个事件携带完整载荷、`message_end` / `tool_execution_end` / `bash_result` 给终态，故丢弃不丢信息）；**硬限 64MB** 视为客户端已死，`terminate()` 断开（前端自动重连并 `location.reload()` 重取历史，状态不丢，内存有界）。`sendJson`（初始 state/history 快照，单次最大载荷）同样受硬限约束。另加**内存水位诊断日志**（`src/log.ts`，所有 pi-web 自身日志行统一带本地时间戳 `[YYYY-MM-DD HH:MM:SS]`，便于事后对照；命令输出如 session 列表/帮助文本不加，保持可直接复制）：RSS 每越过 512/1024/1536/2048MB 各打一行（含 heap 与每客户端排队字节，30 秒节流），供下次 OOM 直接定位增长来源。**诚实标注**：已验证「保护生效」（真实 ws 客户端不读时队列在 8MB 冻结、64MB 断开、进程 RSS 有界），但**尚未证明 ws 排队就是本次 OOM 的根因**（受控对照仅证明启动期扩展占约 128MB；1.2GB 增长来源仍未定），该日志即为下一步取证手段。
- **堆上限自动提升（补充决策，2026-09，OOM 缓解）**：Node 在本机（15GB RAM）默认 old-space 上限 **2240MB**，而"大会话 + 进程内扩展"的实际占用可超过它（实测崩溃时 V8 堆触顶 ~2126MB）。决策：`pi-web r` 启动时若 `v8.getHeapStatistics().heap_size_limit` 低于目标（默认 **4096MB**），**自动以 `--max-old-space-size` 重启自身一次**（只针对长驻的 `r`/`resume`，`list`/`help` 不重启；在任何重量工作之前执行，父进程只等待并以子进程退出码结束，SIGINT/SIGTERM 由同进程组的子进程自行优雅处理）。边界：① 用户已通过 argv 或 `NODE_OPTIONS` 指定过 `--max-old-space-size` → **完全尊重，不调整**；② `PI_WEB_MAX_OLD_SPACE_MB` 可覆盖目标（512–32768）；③ 宿主总内存 < 目标×2 → 保持默认并说明原因；④ `PI_WEB_HEAP_REEXEC=1` 防重入（至多重启一次）。终端打印 `heap limit: <n>MB` 便于确认生效（启动/关停等日志同样带时间戳）。**定位说明**：这是**缓解**而非根因修复——若增长属真泄漏，只是把崩溃从 ~70 分钟推迟到 ~2.5 小时；配合上面的内存水位日志可区分「泄漏（持续涨到上限）」与「大而有限的常驻工作集（稳在 2GB 附近）」。
- **custom_message（`pi.sendMessage`）渲染对齐 TUI（补充决策，2026-09）**：两处缺口，均已修：
  - **实时路径缺失**：Pi 的 `sendCustomMessage`（agent-session.js:1068）在不触发 turn 的分支**直接 emit `message_start` + `message_end`**（appMessage `{role:"custom", customType, content, display}`），触发 turn / steer / followUp 的变体则经 `_handleAgentEvent`→`_emit`（line 366）转发；而 `entry_appended` **只对 `appendEntry`（type: custom）发射**（line 1866-1871），`custom_message` 不走它。前端 `onMessageStart` 原先只处理 `user`/`assistant` → **实时完全不可见，须刷新页面才出现**。修法：`onMessageStart` 增加 `role === 'custom'` → `renderCustom(message)`。
  - **缺 `display` 判据**：TUI 的判据是 **`if (message.display)`**（interactive-mode.js `case "custom"`），**实时与历史加载共用 `addMessageToChat`**，即 `display` 为假的消息 TUI 完全隐藏；pi-web 原先无此判据 → 把 `display:false` 的内部消息当紫色块渲染出来。实测数据：本机会话 63 条 `custom_message` 中 **62 条是 `display=false`**（magic-context 的 `ceiling-nudge` 内部 `<system-reminder>`，且确实在 leaf 路径上、会进 history）。修法：`renderCustom` 开头对 custom message 加 `!display → return`。判据用 **truthiness**（非 `=== true`）——mcp-adapter 传字符串 `display: "💬 UI Prompt: …"`（truthy），TUI 同样渲染。
  - **薄适配层（必需）**：实时是 appMessage（`role:"custom"`，**无 `type`**），历史是 session entry（`type:"custom_message"`）——判据需同时识别两种形态：`entry.type === 'custom_message' || (entry.type === undefined && entry.role === 'custom')`。（初版只判 `type` 导致实时 `display:false` 漏网，playwright 复验时发现并修正。）
  - **验证**：playwright 对真实客户端方法覆盖 7 条路径——live display=true→渲染、live display=false→静默、history display=false→静默、history display=true→渲染、history display=字符串→渲染、appendEntry 无 data.text→静默（原规则）、appendEntry 有 data.text→渲染（原规则），另校验标签与正文，无 pageerror。
- **Modal 键盘导航（补充决策，2026-09）**：TUI 的对话框/选择器是全键盘的（`tui.select.up/down/pageUp/pageDown/confirm/cancel` + 搜索框），pi-web 此前只有斜杠命令菜单支持 ↑↓，`/resume`、模型选择等**纯鼠标**。**判据是「单选 vs 多选」而非对话框类型**（用户指出）：
  - **单选**（`/resume`、模型、thinking、扩展 `select`）→ **Enter = 选中光标项**；
  - **多选**（scoped-models）→ **Enter = 切换勾选**（TUI `scoped-models-selector.js:253` 注释原文 "Toggle on Enter"）；
  - **confirm 也是单选**：TUI 的 `confirm` 就是 `["Yes","No"]` 单选列表（`showExtensionConfirm` → `showExtensionSelector`），故 pi-web 的 Confirm/Cancel 两按钮套用同一光标机制——光标**初始在第一项（Confirm）**，与 TUI 默认 index 0 = Yes 一致。
  - **按键**：↑↓ 循环移动（与站内命令菜单同款取模）、PageUp/PageDown 跳 10、Enter 激活、Esc 关闭；搜索框保持焦点，↑↓ 被接管而 ←→ 仍可用于编辑。
  - **实现**：共享 modal 路径上的 `modalCursor` + `.modal-item.cursor`（与 scoped-models 表示"已勾选"的 `.selected` **相互独立**，一个条目可同时处于两种状态）；Enter 复用各自既有点击逻辑（`el.click()`），故单/多选语义由调用方决定、无重复分支。
  - **顺带修掉两个既有问题**：① `modalSearch` 可见性原先由各调用方分别设置，`model`/`thinking`/`scoped-models` 未设置会**继承上一个 modal 的状态**（例如先开过 confirm 就再也看不到搜索框）——改为 `openModal` 按形态集中决定（`SEARCHABLE_MODAL_MODES`）；② 对话框打开时焦点落在**隐藏的搜索框**上（按键被看不见的输入框吞掉）——非搜索型 modal 改为聚焦 `#modal` 容器（已加 `tabindex="-1"`）。
  - **验证**：冒烟测试新增 6 项（列表光标初始/↓/循环/PageDown、Enter 选中、confirm 光标与激活、多选 Enter 切换、搜索框可见性、非搜索型焦点位置），共 34 项全通过；另以真实 `/resume`（11 个会话）实测光标移动、循环、Esc 关闭均正常。
- **页脚 model 链接 = scoped 列表点选（补充决策，2026-09）**：页脚当前模型标签原先与 `/model` 一样打开**全量目录**（189 个可用模型），与紧邻的 `>>`（轮换）语义不搭。现状与目标：`/model` 保持全量目录不变；`>>` 保持直接轮换不变；**页脚 model 链接改为只列 scoped models**（与 `>>` 轮换的同一集合，见 `agent-session.js` `cycleModel`：有 scoped 就在 scoped 内循环、否则遍历全部可用），**选中即切换**（`set_model`），当前模型标注 `(current)`。
  - **数据来源**：`state` 新增紧凑字段 `scopedModels: [{provider, id, name, thinkingLevel}]`（`buildState`）——`set_scoped_models` 之后服务端本就会 `broadcastState()`，故改完即时可见，点击时无需再往返 `get_scoped_models`（那条路径会触发模型目录 refresh 的网络等待，不适合点选场景）。
  - **空 scope 的处理**：给一条常驻提示（"未配置 scoped models —— 用 /scoped-models 选几个模型"），**不弹空框**、也不回退成全量目录（否则就变成第二个 `/model`，违背区分两个入口的初衷）。用户 2026-09-25 确认此选择。
  - **列表形态**：新增 modal 形态 `model-scoped`（短列表，不显示搜索框），纳入 `CURSOR_MODAL_MODES` 因而自动获得 ↑↓/PageUp/PageDown/Enter/Esc 键盘导航。
  - **验证**：冒烟测试新增 3 项（只列 scoped 且当前项标注正确、选中发出正确 `set_model`、空 scope 提示且不弹框），共 37 项全通过；另以**新实例**端到端实测——`state.scopedModels` 9 项、点击页脚弹出 9 项（非全量 189）、当前项标注 1 处、↓ 移动光标、Esc 关闭。注意此为**服务端 + 前端双侧改动，需重启 pi-web 后生效**（旧进程的 state 不含该字段，点击会走"未配置"提示分支）。
- **SDK 升级 0.84 → 1.0（Pi 1.0.0 跟随，2026-09）**：Pi 官方发布 1.0.0（新增内置扩展 `codemode`/`tool-search`/`mcp`，加上原有 `llama.cpp` 共 4 个），pi-sdk-web 的内嵌 SDK 依赖从 `^0.84.2` 升至 `^1.0.0`（`pi-agent-core` 同步 `^1.0.0`）。**探针结论**：tsc 零错误、`verify-sdk` 全链路通过（magic-context 0.44.4 / aft-pi 0.58.2 / multi-viewers 0.10.3 在 1.0.0 下正常加载运行）、冒烟 37 项通过——**pi-web 用到的 SDK API 面在 1.0.0 完全兼容**。唯一适配点：1.0.0 的内置扩展路径从 `<inline:name>` 改为 **`builtin:<name>`**（`hidden=true`，mcp/codemode/tool-search 另有 `replaceable=true`），旧的 `<...>` 跳过规则会漏放——Extensions 框的处理经两轮演进：先改为按 **`hidden === true`** 跳过（TUI 的扩展列表同样过滤 `!hidden`，interactive-mode.js:1347），随后**用户拍板改为显示**——内置扩展确实被加载并提供工具，静默丢弃会让侧栏失真；最终形态：以 **`builtin`** 标注列出（名称去前缀，如 `llama.cpp`/`codemode`/`tool-search`/`mcp`），与本地扩展的 `project`/`user` 标注同列。实测 1.0.0 实例 Extensions 框列出 9 项（5 真实 + 4 内置标注），冒烟测试同步断言「无前缀泄漏 + 内置标注存在」（38 项）。另：1.0.0 默认 TUI 全屏（`tuiMode`）等变化仅影响 TUI，与 pi-web 无关；changelog 无 SDK 层 breaking 记录。
- **SDK 升级 1.0 → 1.1（Pi 1.1.0 跟随，2026-10）**：Pi 官方发布 1.1.0（含 1.0.1–1.0.4 patch），pi-sdk-web 内嵌 SDK 依赖从 `^1.0.0` 升至 `^1.1.0`（`pi-agent-core` 同步 `^1.1.0`）。**探针结论**：tsc 零错误、`npm ci` 从新 lockfile 干净重装 + 重建通过、`verify-sdk` 全链路通过、本地新实例冒烟 38 项全通过——**pi-web 用到的 SDK API 面在 1.1.0 完全兼容，零代码改动**。区间内唯一 breaking 是 1.0.3 的 Azure provider 改名（`azure-openai-responses` → `azure`，只影响用户 `auth.json`/`models.json`/`settings.json` 配置项命名，与 pi-web 代码无关，本机未用 Azure 不受影响）。与我们相关的增强（随 SDK 自动受益，暂未消费）：`agent_settled` 事件新增 `aborted` 标志（可区分中止与正常结束）、`tool_execution_end` 新增 `durationMs`（TUI 的 "Took" 展示，web 工具块可作为后续增强）、MCP OAuth 多项修复与多行字符串语法高亮修复。
- **工具块 "Took" 用 SDK 记录的执行时长（2026-10）**：Pi 1.1.0 起 `tool_execution_end` 事件与落盘的 `toolResult` 消息均携带 `durationMs`（agent-loop 单调钟测量 `execute()` 耗时；工具未运行时缺失，1.1.0 前的会话记录无此字段）。此前 web 端 Took/Elapsed 基于前端墙钟（`Date.now()` 差值，可被 NTP 校时/休眠跳变影响），且**历史重放路径完全不显示 Took**。改进：① `onToolEnd` 优先用事件的 `durationMs`（服务端原样转发，`session.subscribe → broadcast`），无字段时退回墙钟（abort 等场景）；② `renderHistoryToolResult` 读消息顶层 `durationMs` 渲染，旧记录无字段则不显示（同 TUI 行为）；③ 格式化对齐 TUI（`bash.ts` `formatDuration`）：`<60s → "X.Xs"` 一位小数、`<1h → "Xm Ys"`、`≥1h → "Xh Ym Zs"`，live Elapsed 同步改用该格式；④ **保持全部工具块显示**（web 端通用工具块此前就全工具显示时长，`durationMs` 亦是 agent-loop 通用字段；TUI 仅 bash/powershell 显示是其 renderer 实现细节，非语义意图）。live "Elapsed" 进行中计时保留墙钟（与 TUI 的 renderer 时钟 fallback 同理）。冒烟测试 +2（实时 Took 用注入事件断言 `durationMs:1500 → "Took 1.5s"`；历史路径断言 `durationMs:125000 → "Took 2m 5s"`），前端改动刷新生效。
- **user message 显示发送时间戳（2026-10）**：用户提出「每个 user message 是否有时间戳，方便看出来什么时候发的」。**数据来源核实**（需读源码确认，不能假定）：Pi 给每条 user message 打 `timestamp`（epoch ms）——实时路径在 `agent-session.ts` 构造（`prompt()` 主路径 + `steer`/`followUp` 均 `timestamp: Date.now()`），历史路径 session 文件里的 user message 同样带 `timestamp`（entry 另有 ISO 的 `entry.timestamp`），且我们的 WS 事件/历史均原样透传，故前端**无需服务端改动**。实现：`appendUserMessage`（实时与历史共同入口）在 `You` 标签后追加 `.msg-time` 元素——**今天显示 `HH:MM`，更早显示 `MM-DD HH:MM`**（聊天惯例，兼顾跨天浏览），`title` 悬停给出完整 `YYYY-MM-DD HH:MM:SS`；样式为 dim + 0.75 透明度，读作元数据而非内容。无 `timestamp` 的异常载荷静默不显示（同 `durationMs` 的容错原则）。**范围**：只做 user message（用户明确要求）；assistant/toolResult 若需要可同法扩展。冒烟 +2（今天 HH:MM 与更早 MM-DD HH:MM 两种格式断言）+ 清理断言扩展到注入消息。
- **SDK 升级 1.1 → 1.2（Pi 1.2.0 跟随，2026-10）**：Pi 官方发布 1.2.0，pi-sdk-web 内嵌 SDK 依赖从 `^1.1.0` 升至 `^1.2.0`（`pi-agent-core` 同步）。**探针结论**：tsc 零错误、`npm ci` 从新 lockfile 干净重装 + 重建通过、`verify-sdk` 全链路通过、本地实例冒烟 42 项全通过、Extensions 框分类不变（5 真实 + 4 内置）——**零代码改动**。verify 两次运行均先出现上游 provider 瞬态错误并 `auto_retry` 1–3 次后成功（最终 `agent_settled`），正是 1.2.0 新增的「upstream provider returned an error」按瞬态重试路径在起作用，非 SDK 兼容问题。**1.2.0 的 breaking 项与我们代码的关系（逐条核对）**：① 主题 schema 迁到 `pi.dev/schemas/*` 且启动期即校验——只影响自定义主题文件，本机用内置 `dark`、无 `$schema` 引用，不受影响；② `before_agent_start` 现在也会为扩展触发的运行（`sendMessage(..., {triggerTurn:true})`）触发，事件按 `messageType` 变成联合类型——面向扩展作者的 API，pi-sdk-web 不 hook 该事件（实测本地扩展在 1.2.0 下加载无告警）；③ 会话在启动期即计为 busy（`ctx.isIdle()` 为 false、`pi.sendUserMessage()` 需 `deliverAs`）——我们用 `session.prompt`，且 `session.isIdle` 在 1.2.0 仍是 **getter 属性**（已核对 `.d.ts`，`() => this.session.isIdle` 的用法无需改）；④ `pi mcp list --json` 的 resources 字段变化仅 CLI。相关增益：`serializeConversation()` 省略 thinking（压缩请求更小，避免超过被压缩的上下文）、OpenRouter 按 key 只列可用模型（模型列表/价格更准，并修掉 `-$1,000,000` 占位价）、codemode 行显示 elapsed/total 时间（与我们 0.6.3 的 Took 同向）、codemode 输出拼接线性化（修掉长输出阻塞）、`~` 在 settings 资源模式中展开、MCP 结构化内容与 OAuth 多项修复。
- **已知限制**：扩展命令的新会话操作（newSession/fork/switchSession 等）在命令上下文中返回 `{cancelled:true}` 占位；trust 流程简化（默认信任）；`session.dispose` 退出清理。
- **可复用冒烟测试（维护者工具，2026-09）**：`tools/smoke.mjs` 对**已在运行**的实例做只读、零 token 的确定性回归（28 项）——部署一致性（服务端 `app.js`/`style.css` 与仓库源文件哈希比对，专治「改了没生效/忘了重启/全局是旧版」）、页面加载无 pageerror、WS 连接即收到 state/history 与 widget 快照重放、渲染路径（markdown／代码块 pre-wrap 无横滚／widget＋ANSI→HTML／tool block／ext-status／扩展消息 display 判据含实时与历史两种形态）、交互（dialog 倒计时与清理、confirm 回传 payload、滚动门控含「上滚不被拽下」）。注入节点按 `smoke` 标签精确清理，不污染视图；退出码 0/1/2 分别表示通过/有失败/依赖缺失或服务不可达。依赖 `playwright-core`（pi-sdk-web devDependency）+ `~/.cache/ms-playwright` 的 Chromium（`PI_WEB_CHROMIUM` 可覆盖）。负向验证：人为改 `static/app.js` 后该检查 FAIL 并打印两侧哈希；服务不可达时干净退出码 2。
- **验证记录**：`npm run verify` 全链路通过（createAgentSession → bindExtensions → subscribe → prompt → 事件流）；`pi-web list`/`r` 正常；`/ctx-status` 弹窗实测成功；`check-argv` 模拟 resolvePiInvocation 验证 spawn real Pi CLI（0.3.9 发布）；`check-spawn` 端到端验证子进程产出标准 JSON 协议输出（0.3.9 发布前）。

### 14.10 会话切换（/resume，2025-08 设计，待实施）

**动机**：`/resume` 是 TUI 的会话切换命令（选择器列出 session → 切换当前会话）。当前 pi-sdk-web 架构为固定 session（`createAgentSessionFromServices`），需升级以支持会话替换。

**架构升级**：
- `cli.ts`：services/scopedModels 创建逻辑包装为 **createRuntime 工厂**（对齐 Pi main.ts），用 `createAgentSessionRuntime(createRuntime, {cwd, agentDir, sessionManager})` 创建 runtime。
- `PiWebServer`：持有 **runtime**（非固定 session）；内部统一 `this.runtime.session` 动态取值（约 20 处 `this.session` 引用改造）。
- `start()` 的初始 bindExtensions+subscribe 逻辑抽为公共方法 `bindCurrentSession()`；`runtime.setRebindSession(bindCurrentSession)` 注册回调（session 替换后 Pi 自动调用）。

**切换链路**（`/resume`）：
1. 前端 `/resume` → `get_sessions` → 服务端 `SessionManager.listAll()`（**过滤当前 session**）→ 弹窗列出（名称/id/cwd）→ 用户选择 → 发 `resume {path}`
2. 服务端 `runtime.switchSession(path)`（SDK 内置：扩展 `beforeSessionSwitch` 可取消、目标 cwd 存在性断言）
3. **执行前先退订旧订阅**（避免 teardown/dispose 期间旧事件广播）
4. rebindSession 回调：重新 `bindExtensions`（WebUIContext 保留实例，清空 pending 对话框 + 状态快照）→ 重新 `subscribe` → `process.chdir(目标cwd)`（try/catch 警告）→ 广播新 `state` + `history`
5. 前端 `renderHistory`（clearContent）时**顺带清空旧 session 残留**：widgets/pending/status/ext-status（等新快照到达）

**边界处理**：
- 目标 session cwd 不存在 → SDK 断言拒绝，前端错误提示（toast）；不做 TUI 的 cwd 选择补救交互（MVP 简化）
- **trust 简化**：沿用默认信任（不传 projectTrustContextFactory，与启动一致；TUI 会做新 cwd 信任评估——差异明示）
- 切换时未完成的扩展对话框（select 等）→ 作废清除
- 正在运行的 agent 操作会被切换中断（TUI 同样行为）
- 切换失败 → 当前会话不受影响

**联动自动生效**：footer cwd/git branch（缓存按 cwd 区分）、bash 执行目录（显式 sessionManager.getCwd()）、模型/thinking（工厂恢复逻辑）均随新 session 自动更新。

**影响面**：cli.ts（runtime 工厂）、server.ts（runtime 化 + 切换命令 + rebind 回调）、app.js（/resume 弹窗 + 重载清理）、ui-context.ts（pending/status 清空方法）。

### 14.11 进程模型与宿主兼容性（2025-08 讨论结论）

**讨论**：能否让 pi-web 通过调用 `pi` 命令的方式启动（即让 `argv[1]` 天然正确，消除宿主伪装）？结论：**SDK 模式下结构性不可能，且无配置项可启用 pi-sdk-web**。

**为什么不能通过 pi 命令启动（SDK 模式）**：
- SDK 模式本质是 **pi-web 进程 = 宿主 = Pi 运行时**（`createAgentSession*` 在 pi-web 进程内创建 AgentSession，UI 层由 pi-web 实现，与 `InteractiveMode` 平级）。宿主进程必须有入口，即 pi-web 自身 bin。
- 若入口换成 pi 命令：`pi`（TUI）→ 消息流/输入框/footer 是 `InteractiveMode` 硬编码，pi-web 无法接管 UI，失去存在意义；`pi --mode rpc` → 回到 RPC 模式，序列化边界兼容性问题全部重现（setWidget 工厂函数丢弃、custom() no-op），且用户明确不采用。
  > **2026-10 修正（见 §15）**：后半句的两个具体限制**不再成立**——随 `--extension` 注入的桥接扩展可在 pi 进程内改写 `ctx.ui`，实测拿到 `setWidget(工厂)`、`custom()`、`setTheme` 与对话框。「进程是 pi 的则 UI 归不了 pi-web」的结论因此被推翻：进程可以是 pi 的，UI 方法层仍归我们（代价是依赖共享可变 `ctx.ui` 这一未公开约定）。
- 因此「SDK 模式 + 通过 pi 命令启动」自相矛盾：进程是 pi 的则 UI 归不了 pi-web；进程是 pi-web 的则 `argv[1]` 是 pi-web。

**为什么没有配置项可启用 pi-sdk-web**：
- Pi 模式分派硬编码在 `main.ts: resolveAppMode` + `AppMode = "interactive" | "print" | "json" | "rpc"`（源码核实）。
- CLI 参数只接受 `--mode text|json|rpc`、`--tui-mode regular|fullscreen`（TUI 内部布局），无 `--mode web`/第三方 UI 宿主口。
- 要让 `pi` 命令启用 pi-sdk-web，唯一途径是**改 Pi 本体**（新增 mode + main.ts 分派分支），即 §14.5 次选方案「Pi 内置 WebMode」，因违反「不改 Pi」核心原则被排除。
- 若 Pi 未来开放「第三方注册模式/UI 宿主」扩展点，pi-sdk-web 可变为 `pi --mode web` 直接使用——但目前不存在。

**当前产品线**：`pi`（TUI/print/json/rpc，Pi 本体）与 `pi-web r <name>`（SDK 独立嵌入宿主）是**两条独立入口**；`pii --web`（RPC 桥接）并存保留。宿主伪装（§14.9 `argv[1]` 改写）则是 SDK 模式下「使扩展宿主假设成立」的最优近似：效果上让 pi-web 进程看起来像 pi 启动，且 historian 派生的子进程确实是「通过调用 pi 命令（`node .../pi-coding-agent/dist/cli.js --print ...`）」启动的。

**进一步消除伪装依赖的方向**（待上游，非本项目可定）：
1. magic-context 上游 `resolvePiInvocation` 修复（PR-350：仅当 `argv[1]` 匹配 `pi-coding-agent/dist/cli.js` 才复用为宿主 CLI）——合入后任何嵌入宿主不再被误判，pi-web 伪装可退役。
2. magic-context 开放 `piBinary` 配置（`PiSubagentRunner` 构造函数已有 `options.piBinary`，仅缺配置入口）。

## 15. 路线升级：原生 pi + 注入桥接扩展（RPC 通道 + 侧信道，2026-10 验证）

> 本节记录一次方向性变更的讨论与**实测**结论。它直接修正 §6.16、§14.11 中「RPC 模式做不到完整 UI，因此必须内嵌 SDK」的前提——该前提在 Pi 1.2.0 上被实验推翻。§14（SDK 宿主）在迁移完成前仍是**已发布的运行形态**。

### 15.1 动机

**历史脉络与设计意图（2026-10 用户确认）**——这是理解本节为何存在的关键：

1. **最早是 RPC 桥接**（`pii --web` + `server/*.py`）。它在「工厂函数 / 自定义组件」类扩展 UI 上撞墙（§6.16：`custom()` no-op、`setWidget(工厂)` 静默丢弃），**当时判断为 RPC 的固有缺陷**（记录见 §14.1）。
2. **因此改投 SDK 宿主**（§14）：由 pi-web 自己实现 `ExtensionUIContext`，功能完整性不再受限。
3. **SDK 随后暴露版本漂移**：引擎版本被我们的依赖钉住，Pi 升级后 pi-web 必须跟随发版（0.6.2 / 0.6.5 即为此）；且内嵌副本与用户实际安装的 pi 可能不一致，而扩展与会话是由后者写入的——**当时没有好解法**。
4. **观察 pi-vscode 得到的启发**：把 pi 进程当作引擎来驱动，并**在其内部注入我们自己的扩展**。
5. **实测修正了第 1 步的判断**：RPC 的缺陷不在协议本身，而在**UI 方法层**——而该层可以在 pi 进程内由我们注入的扩展接管（`ctx.ui` 是 runner 的单一共享可变对象，见 §15.5）。

**因此本节的意图是**：若该模式通过验证，则**放弃 SDK 宿主模式，转为「RPC + 注入扩展」作为唯一实现**——同时拿到功能完整性与版本同步。这不是「两套并存」的提案（迁移期措辞见 §15.9）。

| 维度 | §14 SDK 宿主（现状） | 纯 RPC（§6，已弃） | 本节方案（原生 pi + 注入扩展） |
|---|---|---|---|
| 引擎来源 | 包内 `node_modules` 的 pi-coding-agent（**并行副本**） | 已安装 `pi` 二进制 | 已安装 `pi` 二进制 |
| 版本一致性 | 由我们的依赖决定 → Pi 升级后需**跟随发版**（0.6.2 / 0.6.5 即为此） | 天然同步 | 天然同步 |
| 磁盘开销 | +51MB 副本 | 0 | 0 |
| UI 能力 | 完整（我们就是 UI 层） | 受 RPC 固定接口限制 | **完整**（不完整的那部分由我们注入的扩展接管） |
| 官方支持度 | ✅ 文档化的 SDK 嵌入路径 | ✅ `--mode rpc` 是对外契约 | ⚠️ 扩展 API 官方；**改写 `ctx.ui` 依赖未公开约定** |

用户诉求明确：**直接调用原生 pi，不再并行一个不同版本的 pi-coding-agent**。而「RPC 接口固定、无法扩展」这一顾虑，恰好被「我们可以在 pi 进程内注入自己的扩展」化解——因为 `ctx.ui` 是 **runner 的单一共享可变对象**，扩展可以改写它的方法，于是**接口由我们定义**。

> **关于 pi-vscode 的定位（避免误读）**：pi-vscode 本身**并没有**用插件做「远程显示/操作」——它的插件是**工具桥**（把 IDE 能力喂给 pi，方向相反），显示靠 PTY 跑真 TUI，聊天走 RPC 且只渲染文本、**对话框一律自动取消**。本节方案是**从该观察出发的变体**：额外把 UI 方法层也接管。因此新模式的能力上限不是 pi-vscode 的上限，而是 §15.2 实测出来的上限。

### 15.2 实测证据（Pi 1.2.0，原型见 §15.10）

原型：`pi --mode rpc --no-session --extension bridge.mjs --extension fake.mjs`，桥接扩展经 HTTP 侧信道（带 token）与 pi-web 侧通讯；`fake.mjs` 复刻 magic-context `TodoOverlay` 的**原版调用形态**（工厂只注册一次、后续靠 `tui.requestRender()` 更新、`placement:"aboveEditor"`）。**9/9 全通过**：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | RPC 通道存活（事件到达） | PASS |
| 2 | bash 事件面经 RPC 到达（零 token，`bash_execution_*`） | PASS |
| 3 | 对话框可用（桥接侧信道接管） | PASS |
| 4 | **工厂 widget 被拦截并渲染** | PASS `[ ] task-1 (78) \| [ ] task-2 (78)` |
| 5 | **`requestRender()` 触发再渲染**（更新到达） | PASS `… \| [ ] task-3 (78)` |
| 6 | **`custom()` 面板被接管**，宿主返回值回传给调用方 | PASS `"HOST-PICKED-VALUE"` |
| 7 | 扩展命令可执行（`prompt "/cmd args"`） | PASS `disposition:"handled"` |
| 8 | `setTheme` 接管（RPC 原生返回 `{success:false}`） | PASS |
| 9 | `mode`/`hasUI` 与现状一致（`rpc`/`true`，28 个 UI 方法） | PASS |

**三个额外发现**：

1. **RPC 的一个真实缺陷，且本方案能修**：RPC 模式下 stdin 在 `session_start` **之后**才挂载（`rpc-mode.ts:319` 绑定扩展 → `:806-813` 挂载 stdin），因此**在 `session_start` 内 await 对话框必然死锁**。对照实验：无桥接时 harness 已在 stdin 上作答，扩展侧仍 6 秒未 resolve；桥接接管对话框（走侧信道）后，同一场景 `confirm resolved = true`。→ 对话框必须由桥接接管，这既是保平，也是**修好**。
2. **scoped models 缺口有解**：CLI 在**启动时**由 `parsed.models ?? settingsManager.getEnabledModels()` 解析 scoped 列表（`main.ts:813-817`）。用配置副本实测：`enabledModels` 改为 2 项 → 启动时 `ctx.scopedModels` 精确为那 2 项。→ 「改 scoped models」= 写 `settings.json` + **重启 pi 子进程**（对我们是廉价操作）。
3. **与真实扩展共存无冲突**：同一次运行加载了用户全部真实扩展（命令表含 `ctx-status`/`ctx-flush`/`aft-status`/`multi-viewers`/…，25 个工具），scoped 列表正确读出用户 11 个模型，桥接与其并存无报错。

**端到端原型（2026-10，已提升为 `native/`，见 §15.10）**——机制验证之后又做了一次「**不改前端**」的整体验证：服务端改为「spawn 原生 pi + 桥接扩展」，复用仓库 `static/` 与同一套 WS 协议：

| 验证项 | 结果 |
|---|---|
| **既有冒烟套件 42 项**（含静态文件一致性、state/history 快照、Extensions builtin 标注） | **42/42 通过** |
| bash：UI → WS → RPC → 事件 → 渲染 | 通过（`tool-block success` + 输出） |
| 工厂 widget：「扩展 → 侧信道 → 服务端 → 浏览器」渲染 | 通过 |
| `requestRender()` 增量更新（TodoOverlay 的更新方式） | 通过（render #1 → #2） |
| 对话框：浏览器点击 → 服务端 → 桥接 → `ctx.ui.confirm()` 返回值 | 通过（桥接收到 `answer: true`） |
| `setWidget(key, undefined)` 移除 widget | 通过（修复生命周期后，见下） |
| 页面错误 | 0 |

**原型暴露的两个必须处理的机制点**：

- **widget 生命周期要由桥接接管**：TUI 下组件由 TUI 管理（移除时 `invalidate()`）。我们改写 `setWidget` 后若不自己管，扩展的更新定时器会让面板「复活」——实测：`setWidget(key, undefined)` 之后组件仍在 `requestRender()`，面板重新出现。修法：按 key 记录 active 状态，移除时置 inactive 并调用 `invalidate?.()`，丢弃迟到的更新。
- **`bash` 的 id 对齐**：RPC 用**命令信封 id** 作为 `executeBash` 的 id（出现在 `bash_execution_update` 事件里），而前端用自己生成的 `bash-<ts>` 关联流式块；服务端须把两者对齐。且 RPC **不发** `bash_result` 事件，需服务端合成。

**缺口补齐（2026-10，逐项实测，目标：native 功能面不低于 SDK 宿主）**：

| 能力 | 实现要点 | 验证 |
|---|---|---|
| **扩展 ANSI 换肤** | 桥接从**运行中的 pi 包目录**（`realpath(process.argv[1])/../..`）动态 import Pi 的 `Theme` 类，用 `dark.json`/`light.json` 构造主题（truecolor，与 SDK 宿主一致），并改写 `ui.theme`（实测该属性可配置且**对其他扩展生效**）；服务端暴露 `GET /side/theme`，桥接每 2s 轮询、变化时强制重渲染全部 widget | 切 Light 后 widget ANSI 立即换色 |
| **`custom()` 面板** | 桥接用**带 `terminal: {rows, cols}` 的 stub TUI** 调 factory，把 `render(width)` 的文本行经侧信道交给服务端 → 前端以**只读模态** `extension-panel` 呈现，关闭时回传结论（组件已 `done(value)` 则采用之）。RPC 下扩展看到 `hasUI=true`、会走 TUI 对话框分支，所以这里**必须真渲染**（SDK 宿主走的是它自建 `hasUI:false` 上下文的文本路径，见 §15.11） | `/ctx-status` 面板 40 行真实内容；demo panel 3 行；开关/回传均通过 |
| **`/usage`** | 服务端原生拦截（`command` 名为 `usage` 时优先于扩展命令，与 SDK 宿主 `executeCommand` 一致），复用既有 `usage-render`——**0 处 SDK 依赖**，证明该功能与引擎无关 | `usage_data` 帧 + 面板打开 |
| **`export`** | RPC `export_html`（接受 `outputPath`）→ notify 路径 | 通知含导出路径 |
| **`delete_session`** | 校验「已知会话 + 非当前会话」后 `unlink` | 三个分支全通过 |
| **`(unnamed)` 解析** | 无 `session_info` 名字的会话按 `(unnamed)` 匹配（与 `pii` 一致） | 合成未命名会话可被解析 |
| **`reload`** | RPC 命令表无 reload；桥接注册 `pi-web:reload`，处理器调用 `ExtensionCommandContext.reload()`，并**自加忙时防护**（`ctx.isIdle()`，语义覆盖 agent run/compaction/retry/排队；拒绝时按 SDK 宿主口径报 `Wait for the current response to finish before reloading.`）——因为**扩展命令会被立即执行、即使正在流式输出**（`agent-session.ts:2060`） | 两条入口（`/reload` 前端内置 → `{type:'reload'}`，与直接输入 `/pi-web:reload`）实测走同一条 `prompt` 链路、行为一致；空闲时 `idleBeforeReload: true`、reload 后桥接重新安装补丁且 `get_state` 正常 |

**仍存的缺口（明确记录，迁移时降级或补齐）**：`.jsonl` 导出（RPC 仅 `export_html`）、scoped models 需写 settings + 重启子进程、面板**按键交互**不支持（只读）、TUI-only 项（`setWorkingIndicator`/`setFooter`/`setHeader` 等，宿主与 RPC 下本就 no-op）、自定义 session 目录（`PI_SESSION_DIR` 等）未覆盖。

### 15.3 架构分工

```text
浏览器 ←─WS（协议不变）─→ pi-web server
                              │  ├─ HTTP/WS + token（侧信道）─→ [桥接扩展：在 pi 进程内接管 UI 方法层]
                              │  └─ stdin/stdout JSON line（RPC）─→ [原生 pi 子进程 --mode rpc --session <id>]
```

| 通道 | 负责 | 依据 |
|---|---|---|
| **RPC**（stdin/stdout） | 命令：`prompt` / `abort` / `abort_bash` / `bash` / `compact` / `cycle_*` / `set_model` / `set_thinking_level` / `get_state` / `get_entries` / `get_messages` / `set_session_name` / `switch_session` / `new_session` / `fork` / `clone` / `export_html` / `get_commands` / `get_session_stats` …（dispatch 实测 **33 项**，另有 `extension_ui_response` 在 dispatch 之前单独处理） | `rpc-mode.ts` dispatch |
| | **全部 session 事件**：`session.subscribe(event => output(toJsonEvent(event)))`（与我们今天 SDK 宿主订阅的是**同一个流**） | `rpc-mode.ts:355-356` |
| **桥接扩展**（侧信道） | RPC 丢掉或需接管的 UI 方法：`setWidget(工厂)`、`custom()`、`setTheme`、对话框 `select/confirm/input/editor`（并修掉启动期死锁） | 实测 |
| | 我们自定义的命令/工具/渲染器（`registerCommand` / `registerTool` / `registerMessageRenderer` / `registerEntryRenderer` / `registerToolRenderer`） | `ExtensionAPI` |

**环境变量与注入方式**（照抄 pi-vscode 的范式，方向相反）：`--extension <bridge.js>` + `PI_WEB_BRIDGE_URL` + `PI_WEB_BRIDGE_TOKEN`。

### 15.4 能力对照（现状 SDK 宿主 vs 本节方案）

| 能力 | SDK 宿主（现状） | RPC 原生 | 本节方案 |
|---|---|---|---|
| 消息/工具块/thinking 事件流 | ✅ | ✅（全量转发） | ✅ |
| 对话框 select/confirm/input/editor | ✅ | ✅（**启动期死锁**） | ✅（桥接接管，含启动期） |
| ext-status / notify / 字符串 widget | ✅ | ✅ | ✅ |
| **工厂 widget（`/todos` 等）** | ✅ | ❌ 静默丢弃 | ✅ **改写 setWidget** |
| **`custom()` 面板** | ❌（返回 undefined，扩展转走文本路径） | ❌ 返回 undefined（扩展转走文本路径） | ✅ **改写 custom()：stub TUI（含 `terminal`）+ 渲染文本行 + 前端只读模态**。差异：扩展在 RPC 下 `hasUI=true` 走对话框分支，故原生走「渲染组件」而非 SDK 的「文本兜底」（详见 §15.11） |
| **theme 切换** | ✅（自有 UI context） | ❌ `{success:false}` | ✅ **改写 `ui.theme`**（自有 Pi Theme，暗/亮热切换，已实测对其他扩展生效） |
| `/usage`（pi-web 原生） | ✅（读 session 文件） | ❌ 无命令 | ✅ 服务端原生拦截 + 复用同模块（0 处 SDK 依赖） |
| `export` / `delete_session` | ✅ | ⚠️ 仅 `export_html` | ✅（`.jsonl` 导出降级） |
| 扩展命令（`/aft-status` 等） | ✅ 直调 `extensionRunner.getCommand` | ✅ 经 `prompt "/cmd"`（`agent-session.ts:2060-2063`） | ✅ |
| 会话操作 new/fork/switch/reload | ✅ | ✅（`commandContextActions` 已绑定） | ✅ |
| 模型/thinking | ✅ | ✅ `set_model` / `set_thinking_level` | ✅ |
| **scoped models 点选** | ✅ `session.setScopedModels`（`agent-session.ts:1671`） | ❌ 无命令 | ⚠️ 写 `settings.json`（`enabledModels`）+ 重启子进程 |
| TUI-only no-op 项（`setWorkingIndicator`/`setFooter`/`setHeader`/`getEditorText`/`setEditorComponent`…） | ❌ 现状也是 no-op | ❌ no-op | ⭕ 可选增强（按需接管） |
| 引擎版本 | 跟依赖走（需发版） | 跟已安装 pi 走 | 跟已安装 pi 走 |
| 并行副本 | 51MB | 0 | 0 |

### 15.5 关键机制与源码依据

| 机制 | 依据 | 说明 |
|---|---|---|
| `ctx.ui` 是共享可变对象 | `runner.ts:890-893`（`get ui() { return runner.uiContext }`） | 拦截/改写能影响**所有**扩展；这是本方案成立的根基 |
| 扩展**不能**替换整个 UI context | `ExtensionAPI` 无 `bindUI`/`setUIContext` | 只能逐方法改写，不是官方扩展点 |
| `hasUI` 语义 | `runner.ts:628-630`（`uiContext !== noOpUIContext`） | RPC 下为 `true`，与现状一致 |
| `mode` 取值 | `types.ts:323`：`"tui" \| "rpc" \| "json" \| "print"` | 现状我们报 `"rpc"`（`server.ts:219`）→ **零语义回归** |
| 扩展命令经 prompt 可达 | `agent-session.ts:2058-2063` | 文本以 `/` 开头时先尝试扩展命令 |
| 会话控制可用 | `ExtensionCommandContext`：`newSession`/`fork`/`navigateTree`/`switchSession`/`reload`/`waitForIdle`；RPC 已绑定 `commandContextActions` | |
| 事件瘦身 | `json-event.ts`：`toJsonEvent` 剥掉 delta 的 `partial` 字段（`toolcall_start` 保留 `id`/`toolName`） | ✅ **已核对（2026-10）**：前端只用 `ev.partialResult`（`tool_execution_update` 的字段，不受影响）与 `assistantMessageEvent.delta`，**不依赖 `partial`** → 无需桥接补发 |
| widget 生命周期 | TUI 负责组件 `invalidate()`；桥接接管后须自行处理，否则移除后会被 `requestRender()` 复活 | 原型实测发现（见 §15.2） |
| `bash_result` | RPC 不发送该事件；前端靠它定稿 bash 块（`id` 关联） | 服务端合成（原型已验证） |
| scoped models 来源 | `main.ts:813-817` + `agent-session.ts:489/1671` | 启动时解析，运行时仅 SDK 可改 |

### 15.6 已确认的设计决策

1. **目标方向（终态为替换，非并存）**：pi-web 的引擎改为 **spawn 已安装的 `pi --mode rpc` + 注入桥接扩展**；验证通过后**放弃 SDK 宿主模式**，内嵌 SDK 依赖与实现一并移除（消除并行副本与版本漂移）。前提与回退见 §15.9。
2. **注入桥接扩展**（`--extension`）承担 RPC 缺失的 UI 方法层，侧信道鉴权用 token（localhost）。
3. **对话框由桥接接管**（而非复用 RPC 原生转发）——因为 RPC 原生在 `session_start` 期间必死锁。
4. **RPC 仍作为命令与事件通道**，不重复造轮子；桥接只补缺口，不做全量转发。
5. **前端不改**：WS 协议（state / history / 事件 / 对话框 / 命令）保持不变，只替换服务端适配层。
6. **scoped models** 采用「写 `settings.json` + 重启 pi 子进程」，不追求运行时即时生效（TUI 同样是启动时读取）。
7. **降级策略**：桥接改写属未公开内部约定，必须**特性探测**（`typeof ui.setWidget === "function"` + 改写是否生效）并在失败时退回 RPC 原生行为（功能降级为「工厂 widget 不显示」，不影响会话可用性）。

### 15.7 风险与开放问题

| # | 风险/问题 | 现状与缓解 |
|---|---|---|
| 1 | 依赖未公开内部约定（共享可变 `ctx.ui`） | 1.2.0 实测成立；若上游 freeze 或改为 per-extension context 则失效 → 特性探测 + 降级。**全部宿主依赖已逐项登记在 §16，并配可执行核对器 + 基线（Pi 升级后跑一次即可发现偏移）** |
| 2 | 对话框语义需自实现（`signal`/`timeout`/默认值/分档超时） | 现有 `ui-context.ts` 已实现该语义，迁移时平移 |
| 3 | `toJsonEvent` 剥掉 `partial` | ✅ **已结案**：前端不依赖 `partial`（只用 `partialResult` 与 `delta`，见 §15.5），无需补发 |
| 4 | 两进程 + 侧信道（鉴权、生命周期、子进程重启） | pi-vscode 有同构范式；本仓库 `server/`（Python RPC 时代）亦有可复用经验 |
| 5 | 桥接扩展会出现在用户 Extensions 列表 | 需标注来源（如 `pi-web (bridge)`），并在文档说明用途 |
| 6 | 启动期对话框死锁这一 RPC 缺陷 | 已由决策 3 覆盖；若将来上游修复 stdin 时序，可简化但不能依赖 |
| 7 | `pii`（Python RPC 桥）与本方案的关系 | 本节方案在 TS 侧重建 RPC 通道；`pii` 保留为用户入口与「RPC 版」实现，是否收敛待迁移完成后再定 |

### 15.8 迁移步骤（阶段化；A/B/C 已在原型中部分完成，见括号内状态）

| 阶段 | 内容 | 完成判据 | 原型状态（2026-10） |
|---|---|---|---|
| A | 服务端抽象「引擎接口」，SDK 实现与 native 实现并列（如 `--engine sdk\|native`） | 两种引擎都能起服务，前端无感 | 未做（原型是独立 server） |
| B | 实现 RPC 客户端（TS）+ 桥接扩展（把 `ui-context.ts` 语义搬入）+ 侧信道 server（复用现有 WS 协议） | §15.2 的 9 项在真实架构内复现 | **已完成**（`native/`，原型位于 `experiments/rpc-bridge/` 时完成） |
| C | 逐项对齐：history 走 `get_entries`；会话列表/删除沿用文件操作；scoped models 走 settings+重启；theme / panels / usage / export 对齐 | 与现状功能清单逐条对齐 | **大部分完成**（§15.2 缺口补齐表；余 `.jsonl` 导出、面板按键交互、scoped models 重启、自定义 session 目录） |
| D | 端到端冒烟：现有 42 项扩展为覆盖两种引擎，真实会话跑通 | 全绿后把 `native` 设为默认 | 部分：冒烟 **42/42 已在 native 上通过**，尚未扩为覆盖两引擎 |
| E | **移除 SDK 引擎**：删除 `pi-coding-agent`/`pi-agent-core` 依赖与 SDK 宿主实现（含 `ui-context.ts`，语义已在阶段 B 移植进桥接扩展）；并按 §15.13 决策一并去掉整个 TypeScript 构建链、包改为 `@maxdai/pi-web@1.0.0` | 依赖树中不再有 pi-coding-agent；`native` 为唯一引擎；包内无 TS 产物 | ✅ **已完成**（2026-10-14，实施记录见 §15.13.6） |

### 15.9 与 §14 路线的关系（终态：替换，而非并存）

- **设计意图明确（2026-10 用户确认）**：若本方案通过验证，则**放弃 SDK 宿主模式（§14），转为「RPC + 注入扩展」作为唯一实现**。本节不是「两套并存」的提案。
- **迁移期间的并存只是过程**：阶段 A–D 保留 SDK 实现，用作可回退的参照实现与 A/B 对照（`--engine sdk|native`），阶段 E 移除 `pi-coding-agent` 依赖与 SDK 引擎实现。
- §14 的价值不因替换而消失：它的 `ui-context.ts` 就是桥接扩展要移植的**语义来源**（对话框的 `signal`/`timeout`/默认值/分档超时等）。
- §14.5/§14.11 中「RPC 不可用」的结论**已被本节实测修正**：不是 RPC 变好了，而是我们找到了在 pi 进程内扩展接口的手段。
- **前提与回退（必须一并记住）**：
  - 前提 ①：阶段 D 端到端验证通过（现有 42 项冒烟在 native 引擎上全绿）；② 真实使用中稳定（含扩展工厂 widget、自定义面板、会话切换、scoped models）。
  - 风险：新模式依赖**未公开约定**（共享可变 `ctx.ui`），而 SDK 是**官方文档化**的嵌入路径。若上游改动该约定且无法绕开，回退路径是保留 `--engine sdk` 实现（代价退回版本漂移），**而不是让 pi-web 不可用**。
  - 记录在案的取舍：SDK 路线「官方支持度更高但版本漂移无解」；新路线「版本同步、无副本、与用户扩展/会话环境一致，但依赖内部约定」。前者是长期可预期风险，后者是当下确定的痛点——这是选择替换的理由，也应作为日后复查的依据。

### 15.10 原型与复现

**端到端原型（已入库并提升为正式 bin，见 §17）：`native/`**

| 文件 | 作用 |
|---|---|
| `native/server.mjs` | HTTP 静态服务（复用仓库 `static/`）+ WS 协议 + RPC 客户端 + 侧信道服务端（bin `pi-web-native`） |
| `native/bridge.mjs` | 注入 pi 的桥接扩展：接管工厂 widget / `custom()` / 对话框 / `setTheme`，上报 cwd/scopedModels/commands/tools/extensions |
| `tools/host-contract/` | 宿主契约核对器 + 进程内探针 + 基线（Pi 升级后 / 发版前必跑，见 §16、§15.13 决策 5） |

```bash
node native/server.mjs --session install --port 4096   # 终端 1
node tools/smoke.mjs http://127.0.0.1:4096                            # 终端 2（42 项，零 token）
# 手工复验桥接能力：/pi-web:demo-widget、/pi-web:demo-clear、/pi-web:demo-dialog、/pi-web:reload
```

**机制验证原型（临时目录，价值在对照实验）**：

| 文件 | 作用 |
|---|---|
| `/tmp/proto/bridge.mjs` | 桥接扩展（最小版）：改写 `setWidget`(工厂)/`custom`/`setTheme`/对话框 |
| `/tmp/proto/fake-extension.mjs` | 复刻第三方扩展的调用形态（TodoOverlay 模式 + custom + confirm + setTheme） |
| `/tmp/proto/harness.mjs` | 侧信道 server（token 鉴权）+ spawn 原生 pi + 断言 9 项 |
| `/tmp/proto/deadlock-harness.mjs` | 启动期对话框死锁的对照实验（有/无桥接接管） |

桥接扩展骨架（关键部分，语义与 `ui-context.ts` 一致）：

```js
export default function (pi) {
  const url = process.env.PI_WEB_BRIDGE_URL;
  const token = process.env.PI_WEB_BRIDGE_TOKEN;
  if (!url || !token) return;
  const post = (path, body) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-web-token": token },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json().catch(() => undefined));

  pi.on("session_start", async (_event, ctx) => {
    const ui = ctx.ui;
    // 1) 工厂 widget（RPC 会静默丢弃）：自己渲染并在 requestRender 时重渲染
    const origSetWidget = ui.setWidget.bind(ui);
    ui.setWidget = (key, content, options) => {
      if (typeof content !== "function") return origSetWidget(key, content, options);
      let component;
      const render = (update) => post("/widget", { key, lines: component.render(78), update: !!update });
      component = content({ requestRender: () => render(true), invalidate() {} }, ui.theme);
      render(false);
    };
    // 2) custom() 面板：渲染组件并取宿主返回的结论
    ui.custom = async (factory, options) => {
      let done;
      const settled = new Promise((r) => (done = r));
      const component = await factory({ requestRender() {}, invalidate() {} }, ui.theme, {}, (v) => done(v));
      const answer = await Promise.race([post("/panel", { title: options?.title, lines: component.render(78) }), settled]);
      return answer?.value;
    };
    // 3) 对话框：必须在启动期就可用（RPC 原生会死锁）
    const ask = async (method, payload, fallback) => {
      const a = await post("/dialog", { method, ...payload });
      return !a || a.cancelled ? fallback : method === "confirm" ? !!a.value : (a.value ?? fallback);
    };
    ui.confirm = (title, message) => ask("confirm", { title, message }, false);
    ui.select = (title, options) => ask("select", { title, options }, undefined);
    ui.input = (title, placeholder) => ask("input", { title, placeholder }, undefined);
    ui.editor = (title, prefill) => ask("editor", { title, prefill }, undefined);
    // 4) theme（RPC 原生返回 success:false）
    ui.setTheme = (name) => (void post("/theme", { name }), { success: true });
  });

  pi.registerCommand("pi-web:ping", { description: "pi-web bridge probe", handler: async (args) => post("/command", { args }) });
}
```

复现命令（零 token，除 `prompt` 那步只走扩展命令不进模型）：

```bash
cd /tmp/proto && node harness.mjs              # 9/9
node deadlock-harness.mjs                      # 对照组：启动期对话框死锁
node deadlock-harness.mjs --bridge             # 桥接接管：resolve = true
```

### 15.11 与 SDK 宿主的功能对照（2026-10，逐项核对）

**命令面：完全一致**（31 个客户端命令逐一 diff，无缺项）。本轮补齐了 3 处实现差异：

| 项 | SDK 宿主 | 原生原型（本轮前） | 现状 |
|---|---|---|---|
| `/session` | 只读信息模态（name/ID/file/model/thinking + 消息数/Token/费用/上下文） | 只刷新 state，**无模态** | ✅ 已按同形同内容实现 |
| `get_scoped_models` | 返回 `{scoped, available, configured}`，`available` = **完整模型目录**（`modelRuntime.getAvailableSnapshot()`，162 条） | ① 缺 `scoped`（前端用它预勾选）；② **`available` 传成了 scoped 列表** → 弹窗里只有已选的 11 个、**无法添加新模型** | ✅ 已补齐：`available` 改取 RPC `get_available_models`（同 162 条）。浏览器实测 SDK 与原生均 **162 行 / 11 项勾选**，逐项一致 |
| `set_scoped_models` 的 `persist` 语义 | 仅 `persist===true`（显式保存）才写 settings；勾选（`persist=false`）**仅内存生效**，绝不改 `settings.json` | 原型**不看 `persist` 就写 settings** → 每勾一下都会改写用户的 `settings.json` | ✅ 已修：`persist=false` 只给一次行内提示（30s 去抖）、不落盘；`persist=true` 才写。隔离目录实测：`false` 后 settings md5 不变、`true` 后写入且保留其余 15 个顶层键 |
| 配置目录解析 | 尊重 `PI_CODING_AGENT_DIR`（SDK/pi 自身都尊重） | 硬编码 `$HOME/.pi/agent` → 自定义配置目录下读错 settings、扫错 sessions | ✅ 已修（`AGENT_DIR = PI_CODING_AGENT_DIR ?? ~/.pi/agent`） |
| `dialog_dismissed` | 超时/中止/切会话时通知前端关模态（`ui-context.ts:209`） | **不发** → 模态残留在屏幕上 | ✅ 已实现三条路径（timeout/aborted/session-switch，实测通过） |
| `get_stats` | 有（前端当前不发） | 无 | ✅ 已补（同形接口） |

**状态字段面**：SDK 15 个键 / 原生 14 个；唯一差集是 `gitBranch`——因原生实例的会话 cwd 为 `/root`（非 git 仓库）而被 JSON 丢弃，改用仓库目录的会话实测得到 `gitBranch="main"`，**非缺项**。

**仍存差异（3 项，均已定位）**：

| 差异 | 说明 | 影响 |
|---|---|---|
| ~~**scoped models 即时生效**~~ → **已关闭（2026-10-14）** | 原状：SDK 走 `session.setScopedModels()` 立即生效，原生只能写 `settings.json` 且 `ctx.reload()` 不重算 → 需重启 pi 子进程。**现已实现即时生效**：见下方 §15.11.1（利用 `ctx.scopedModels` 是 session 内部数组这一事实就地改） | `/scoped-models` 勾选立即反映到会话与页脚，无需重启；失败时自动退回"写 settings + 提示重启" |
| **`.jsonl` 导出** | SDK 有 `session.exportToJsonl`；RPC 只有 `export_html` | 原生下 `.jsonl` 导出以降级提示代替 |
| **非功能性** | SDK 宿主有 WS 背压与堆水位保护、`PI_SESSION_DIR`/自定义配置目录解析；原型无（原型服务端很薄，pi 子进程自带内存策略） | 极端流量/自定义目录场景下的健壮性与解析差异 |

**为什么 `/scoped-models` 会和 TUI 不一样（两层原因，2026-10 定位）**：

1. **列表内容（实现 bug，已修）**：TUI 的候选来自 `session.modelRuntime.getAvailableSnapshot()`（`interactive-mode.ts:5233/5268`），即**完整模型目录**；我最初把**当前已 scoped 的列表**当成 `available` 传给前端，于是弹窗只剩已选中的那些，自然"和 TUI 不一样"。改成 RPC 的 `get_available_models` 后两边逐项一致（162/162）。
   - **附带好消息**：原生目录是 Pi 自己的目录，**包含** `deepinfra/zai-org/GLM-5.3-Flash` —— 正是 §14 时期 SDK 宿主看不到、需要 `modelRuntime.refresh()` 兜的那个模型。原生路由在**目录保真度上反而更强**（无 catalog swap 时序问题）。
2. **生效机制（架构性差异，仍在）**：TUI/SDK 都在**进程内**，切换时直接 `session.setScopedModels(...)`（`interactive-mode.ts:5418`）→ 立即生效；只有显式保存才 `settingsManager.setEnabledModels()`（`:5456`）。原生路由**在进程外**：RPC 命令表没有 scoped-models 命令，ExtensionAPI 也没有对应方法，且**实测 `ctx.reload()` 不会重算 scopedModels**（改 `enabledModels` 后 reload，值不变）→ 唯一路径是**写 settings + 重启 pi 子进程**。
   - 因此原生侧当前语义：**勾选不生效也不落盘**（给提示），**保存才写 settings、重启后生效**。要做到 TUI 那样的即时生效，需要实现"保存后自动重启子进程"（未实现，见 §15.11 差异表）。

**为什么 `/ctx-status` 两边不一样（`custom()` 与 `hasUI` 机制；2026-10 定位并解决）**

现象：SDK 版显示 `/ctx-status` 的**状态文本模态**；原生原型一度**什么都不显示**（更早是空面板）。

| 环节 | SDK 宿主 | 原生引擎（桥接） |
|---|---|---|
| 命令怎么执行 | 自己取 `extensionRunner.getCommand(name)`，**构造 `hasUI:false` 的上下文**再调 handler（进程内宿主才能做到） | 经 Pi 的 `prompt "/ctx-status"` → Pi 调 `_extensionRunner.createCommandContext()` |
| 扩展看到的 `ctx.hasUI` | **false** → 走文本路径：`pi.appendEntry`（custom entry）+ `ctx.ui.notify(text)` | **true**（RPC 模式绑定了 UI 上下文）→ 走 TUI 对话框分支 `if (ctx.hasUI) { await showStatusDialog(...); return; }` |
| 网页呈现 | 文本模态（标题 `/ctx-status`） | 桥接把该 TUI 组件**渲染成文本行** → 只读面板 |

**为什么不能照 SDK 那样做**：`createCommandContext()` 的 `hasUI` 是**每个上下文自己的 getter**（`runner.ts:997` 用 `Object.defineProperties` 保留惰性求值），扩展层既没有 `bindUI` 也没有任何 setter；SDK 能做到是因为它**持有 runner 对象**。要与 SDK 完全一致，需要上游提供「以 headless 上下文执行命令」的能力（与 scoped models 同类的 API 缺口）。

**桥接的做法与前提**（已实测）：
- **组件依赖终端尺寸**：`StatusDialogComponent.render()` 读 `tui.terminal.rows`，缺了会抛 `Cannot read properties of undefined (reading 'rows')`（**这就是早期空面板的直接原因**）。桥接因此提供带 `terminal` 的 stub TUI。
- **按面板实际尺寸渲染（自适应，2026-10 追加）**：前端按 `.modal-panel-body` 的真实版面量出「可用列×行」（`static/app.js` 的 `sendPanelGeometry`）→ 经 `{type:'panel_geometry'}` 上报 → 服务端缓存 → 桥接渲染前用 `GET /side/geometry` 取用。这样既**不会折行折断框图**（曾固定按 100 列渲染，而面板只容得下 93 列），也**不需要横向滚动**（符合项目「不横滚」的既有约定）；窗口变窄时组件会按更窄宽度重排（实测：1200px→92 列、700px→81 列，均无折行、无横向溢出）。`PI_WEB_BRIDGE_PANEL_COLS/ROWS` 退化为「浏览器尚未上报时」的兜底。
  - 两个测量陷阱（已修，记录备查）：① 探针不能用 `position:absolute` —— `#modal` 未定位时包含块是**视口**，会量出整屏宽度（曾得到 162 列）；② 模态元素的 id 是 `#modal` / `#modal-list`，用类选择器会落空并回退到 `body`。
- **能力位门控**：原生服务端在 `state.panelGeometry = true`；前端**仅在此标记存在时**才发该消息 —— `static/app.js` 与 SDK 引擎共享，而 SDK 宿主不认这个消息、会回一个 error 帧（已实测门控有效：SDK 侧既不发送也无 error 帧）。
- **必须支持组件的 `requestRender`（异步组件）**：很多扩展组件在构造时**异步取数**，拿到数据后再调
  `tui.requestRender()` 自绘 —— 例：aft-pi 的 `AftStatusDialogComponent` 构造函数里 `fetchOnce()`
  （await AFT bridge 响应）→ 成功后 `this.props.tui.requestRender()`。桥接因此实现**真正的重绘循环**：
  `requestRender`/`requestLayout`/`invalidate` → 120ms 合并后重绘 → **内容变化时** POST `/side/panel-update`
  → 前端按 `update` 标记**就地替换**面板内容（不重开模态、不重置倒计时）。**早期把 requestRender 当空操作
  且只快照一次 → 用户永远停在 `Connecting…`**（实测修复后：0.1s 为 5 行占位，0.3s 收到 update 帧变成 32 行真实状态）。
- 渲染是**只读快照**（内容会随组件自绘刷新，但按键交互仍不支持）：组件内的按键交互（滚动/翻页）不支持；组件自行 `done(value)` 则采用其结论，否则关闭面板视为取消。关闭**只用模态自带的 `Close (Esc)`**（在模态边框上、常驻可见）——早先额外加过一个面板内按钮，与它重复（两个 Close），且位于滚动区内、内容长时会被滚走。
- 实测：`/ctx-status` 面板 33 行、含 `⚡ Magic Context Status` 边框内容——与 TUI 看到的对话框同源同内容。

**SDK 宿主对「命令执行 / 对话框」的特化清单（2026-10 审计 + 对齐；除 ctx-status 外的同类改动）**

审计方法：扫 `pi-sdk-web/src` 中所有偏离 Pi 原生行为的标记（parity/workaround/Align with TUI…），再逐条在原生引擎实测对照。

**A. 命令执行（`server.ts` 的 `executeCommand`）**

| # | SDK 特化 | 原生现状 | 用户可见 | 可对齐 |
|---|---|---|---|---|
| A1 | **按扩展路径白名单强制 `hasUI:false`**：`/pi-magic-context\|magic-context\|aft-pi/` 命中的命令走文本兜底 | Pi 自己执行命令（`prompt`）→ `hasUI=true` → 扩展走 TUI 对话框分支 → 桥接渲染成面板（§15.11 前文） | 呈现不同、信息等价 | ❌ 需 runner 对象；不可 |
| A2 | **命令期间把 notify 的标题改写为 `/<命令名>`** → 前端按「`/` 开头」弹**模态** | ✅ **已对齐**：服务端在命令执行期间置 `runningCommand`，命令期间的 notify 帧标题改写为 `/<命令名>` | 已消除 | ✅ 已实施（实测 `/refresh-deepinfra`、`/mcp` 现在都弹模态、标题逐字一致） |
| A3 | 命令产生的、带 `text` 的 custom entry 额外弹模态——**这些历史条目本身也是扩展在 `hasUI=false` 路径下 `pi.appendEntry` 写的**（不是 pi-web 造的） | 原生走对话框分支、**不产生条目（= 与 TUI 一致：TUI 也没有）**；渲染器本身完好 | 已知差异：SDK 版历史里每条 `/ctx-status` 留一个 `[ctx-status] (click to expand)`，原生不留 | ❌ **决定不复刻（2026-10 用户拍板）**。依据：① 实测页面历史里已渲染 2 条 `[ctx-status]`，与会话文件里的 2 条一一对应 → 原生渲染这类条目没问题；② 原生执行 `/ctx-status` 只收到 `panel` 帧、**无 `entry_appended`** → 扩展在 `hasUI=true` 分支下不写记录；③ 复刻只能由桥接"伪造"，且拿到的是**带边框的对话框文本**，而非 SDK 那条干净 markdown（扩展的文本构造器在 hasUI=true 时不会执行） |
| A4 | `/usage` 原生拦截（不再依赖 pi-usage-extension） | ✅ 已实现 | — | — |

**B. 对话框生命周期（`ui-context.ts`）**

| # | SDK 特化 | 原生现状（`bridge.mjs` 的 `ask()`） | 用户可见 | 可对齐 |
|---|---|---|---|---|
| B1 | **扩展自己的 `opts.timeout` 原样遵守**，并据此下发 `deadline` 倒计时 | ✅ **已对齐**：`opts.timeout` 作为服务端计时器、`opts.defaultValue` 作为超时/中止的结算值 | 已消除 | ✅ 已实施（实测 `timeout:2000` + `defaultValue:false`：倒计时显示、2s 自动关闭、扩展收到 `false`） |
| B2 | **有浏览器连接 → 无限等待**（TUI parity，绝不抢走用户的作答权）；**只有**无浏览器时才启兜底，重连即撤销 | ✅ **已对齐**：`clients.size` 作为在线判据；上线撤销兜底、下线启用兜底 | 已消除 | ✅ 已实施（兜底缩到 3s 实测：有浏览器时 4.5s 后仍开；关掉浏览器后才结算为 `false`） |
| B3 | **只有扩展给了 timeout 才显示倒计时** | ✅ **已对齐**：只在扩展给了 timeout 时才下发 `deadline`（前端 `startDialogCountdown` 本就对无 `deadline` 直接返回） | 已消除 | ✅ 已实施（实测面板标题为 `pi-web demo panel`，无倒计时） |
| B4 | `opts.signal` 中止 → 用默认值结算 + `dialog_dismissed(aborted)` | ✅ **已对齐**：桥接带 `token` 开对话框，signal 中止时 POST `/side/cancel-dialog`，服务端按默认值结算并广播 `dialog_dismissed(aborted)` | 已消除 | ✅ 已实施（代码路径；未单独造中止场景实测） |

**C. 复核结论（此前已对齐全绿）**：`/session` 模态、`dialog_dismissed`、reload 忙时防护、tools/extensions 名单、`get_scoped_models`、`get_stats`、state 字段面。
**D. 已知缺口（另有记录）**：`.jsonl` 导出降级、WS 背压/堆水位、自定义 session 目录。（scoped models 需重启已于 2026-10-14 关闭，见 §15.11.1）
**E. 原生独有**：`state.panelGeometry` 能力位；能渲染 `custom()` 组件（SDK 显示不了，只能走文本兜底）。

**为什么扩展改不了 scoped models（API 缺口；2026-10 查证，含运行时实证）**

结论：**不是架构上的不可能**（桥接扩展确实在进程内），而是 **Pi 没有向扩展暴露这个写操作**。

| 证据 | 出处 / 实测 |
|---|---|
| 扩展运行时**只绑了读**：`getScopedModels: () => this._scopedModels`，无对应 setter | `agent-session.ts` 的 `bindCore` actions；`grep -rn setScopedModels core/extensions/` = **0** |
| 运行时枚举扩展能摸到的对象，均无 setter | `ctx.setScopedModels === undefined`、`pi.setScopedModels === undefined`；`ctx` 全部键：`abort compact cwd fork getContextUsage getSystemPrompt getSystemPromptOptions hasPendingMessages hasUI isIdle isProjectTrusted mode model modelRegistry navigateTree newSession reload scopedModels sessionManager shutdown signal switchSession thinkingLevel ui waitForIdle`（注意 `setActiveTools`/`setModel`/`setThinkingLevel` 都有 setter，唯独 scoped models 没有） |
| `sessionManager` 没有回到 AgentSession 的引用（键全是数据） | 运行时 `Object.keys(ctx.sessionManager)` = `byId cwd fileEntries flushed labelTimestampsById labelsById leafId persist sessionDir sessionFile sessionId` |
| `modelRegistry` 是模型目录/Provider 注册表（有 `refresh()`），与 scoped models 无关 | 运行时 prototype 方法枚举（`getAvailable`/`refresh`/`registerVirtualModel`…，无 scoped） |
| 全 Pi 只有 TUI 调 `.setScopedModels(` | 见下方「对象图」——**TUI 是宿主（持有 `AgentSession` 字段）**，扩展是访客（只拿到动作对象），所以只有 TUI 能做 |
| 写操作是**显式白名单**：`ExtensionActions` 列了 15 项（`sendMessage`/`sendUserMessage`/`appendEntry`/`setSessionName`/`getSessionName`/`setLabel`/`getActiveTools`/`getAllTools`/`getSettings`/`setActiveTools`/`refreshTools`/`getCommands`/`setModel`/`getThinkingLevel`/`setThinkingLevel`），**没有 `setScopedModels`** | `types.ts:2189-2205`；而读接口 `getScopedModels: () => readonly ScopedModel[]` 在 `ExtensionRuntimeState`（`types.ts:2213`）。注意同类写操作 `setModel`/`setThinkingLevel`/`setActiveTools` 都在白名单里 → **这更像遗漏而非有意限制** |
| 会话替换也不行：运行时工厂复用**启动时捕获**的 `sessionOptions.scopedModels` | `main.ts:847` → `createAgentSessionFromServices({ scopedModels: sessionOptions.scopedModels })`；这正是 reload 不重算的原因 |
| 没有后门：无全局句柄、事件载荷不含 session | `globalThis.pi\|session\|agent` 未设置；`session_start` 载荷仅 `{reason, previousSessionFile?}` |

**对象图：TUI（宿主）vs 扩展（访客）**

```text
TUI（宿主，与 Pi 同进程、同代码库）
  InteractiveMode
    └─ runtimeHost: AgentSessionRuntime        // 字段（interactive-mode.ts:452）
         └─ get session() { return this._session }   // agent-session-runtime.ts:101
              └─ AgentSession.setScopedModels(...)   // agent-session.ts:1522 ← TUI 直接调用
                 // TUI 侧链路：interactive-mode.ts:595 `get session()` → :5418 调用

扩展（访客）
  pi（ExtensionAPI 对象，loader.ts:244 createExtensionAPI(…, runtime: ExtensionRuntime, …)）
    └─ runtime: ExtensionRuntime = ExtensionRuntimeState & ExtensionActions
         ├─ getScopedModels: () => this._scopedModels   // 只读闭包，交出"值"
         ├─ setModel / setThinkingLevel / setActiveTools // 白名单里的写操作
         └─ （没有 setScopedModels）
```

关键：`AgentSession` **对象本身从不越过边界**——Pi 交给扩展的是一个逐项挑选的动作对象（成员都是闭包，交出的是值）。
所以「TUI 能、扩展不能」不是机制差异，而是**谁持有那个对象**：TUI 是 Pi 自己的宿主模块，扩展是被限权的访客。

**可选路线**：

| 路线 | 内容 | 代价 |
|---|---|---|
| **A. 上游加 API（推荐）** | 请 Pi 作者在 `bindCore` 绑定 `setScopedModels` 并在 ExtensionContext 上暴露（约 10–15 行）。之后桥接就能像 TUI 一样：切换即时生效（仅内存）、保存才持久化。符合「不改 Pi 本体」——是**上游落地的 API**，不是本地打补丁。先例：作者已为外部宿主提供 pi-vscode 的桥接通道 | 取决于上游；当前 Pi 最新版 1.2.0 尚无此 API |
| B. 保存后重启子进程（可立即做） | 写 settings → kill 并以同一会话重拉 pi 子进程 → 重发 state/history（浏览器无需刷新） | 几秒中断、会话重挂载；「勾选」仍无法仅内存生效 |
| C. 维持现状 | scoped models 改动需重启 pi-web | **相对现 SDK 引擎是功能回退** |
| **D. 就地改共享数组（✅ 已实施，2026-10-14）** | 扩展上下文 `ctx.scopedModels` 返回的**就是 session 内部数组**（`agent-session.ts:3463`，无拷贝）→ 就地 `splice` 等价于 `session.setScopedModels()`；配合 Pi 公开导出 `resolveModelScopeWithDiagnostics` 解析模式 | 依赖两处未公开约定（数组身份、`modelRegistry.runtime` 私有字段）→ 由探针断言 + 回读校验 + 失败降级三层兜底 |

**决定（2026-10，用户拍板）：暂不采用 B，先冻结现状**。理由：重启 pi 子进程会**打断正在运行的会话**，代价大于收益；scoped models 的即时生效能力**搁置**，等 A（上游 API）落地再补。

> **更新（2026-10-14）**：上述"冻结现状"已被**路线 D** 取代并落地实施——用户从 pi-vscode 的源码分析出发提出疑问，
> 复查后确认扩展虽够不到 session 对象，但**够得到 session 的 scoped models 数组本身**（共享可变对象，与 `ctx.ui` 同一性质）。
> 已实施：勾选即时生效、保存才持久化，**无需上游改动、无需重启**；详见 §15.11.1。路线 A（上游 API）仍是更"正规"的长期形态，
> 若将来 Pi 提供 `ctx.setScopedModels`，可平滑切换过去。

**冻结后的 scoped models 语义（当前实现，勿再改动）**：

| 用户操作 | 行为 |
|---|---|
| 在 `/scoped-models` 弹窗里**勾选**（前端发 `persist=false`，对应 TUI 的 onChange） | **不生效、也不落盘**；只给一次行内提示（30s 去抖），说明「原生引擎需保存后重启才生效」 |
| 点**保存**（前端发 `persist=true`） | 写 `settings.json` 的 `enabledModels`（其余键保留），提示「需重启后生效」；**不做自动重启** |
| 生效时机 | 下次启动 pi-web（或 TUI）时由启动路径读取 |

> ⚠️ 保存会**改动真实配置**（`$PI_CODING_AGENT_DIR/settings.json`），TUI 下次启动同样会读到。若希望原型的保存也完全不落盘，加一个环境变量开关即可（约 1 行）。

**恢复这项工作的入口**（无需重新调研）：A = 上文 3 处改动（`types.ts` 白名单 + `bindCore` 绑定 + context 暴露）；B = 「写 settings → kill → 以同一会话重拉 → 重发 state/history」。

#### 15.11.1 scoped models 即时生效的实现（2026-10-14）

**背景**：pi-vscode 的选择器能即时生效，因为它是**宿主**（直接持有 `AgentSession` 并调用
`session.setScopedModels()`）。我们的原生引擎是「RPC 子进程的父进程 + 进程内注入扩展」：
- 父进程侧：RPC 命令面**没有** scoped 相关命令（实测 `grep scoped modes/rpc/*` 为空）；
- 扩展侧：上下文只有只读快照 `ctx.scopedModels` 与文件级 `ctx.sessionManager`，**够不到 session**
  （探针遍历 `ctx`/`pi` 的对象图，未发现任何可调用 `setScopedModels` 的路径）。

**等价路径（源码 + 实测）**：

```ts
// core/agent-session.ts:3463
getScopedModels: () => this._scopedModels,        // 返回 session 内部数组本身（无拷贝）
// core/agent-session.ts:1671
setScopedModels(list) { this._scopedModels = list; }   // setter 也只是换引用
```
扩展上下文的 `scopedModels` getter 返回的就是这个数组 → **就地 `splice` 等价于 `setScopedModels`**。

**id/模式解析复用 Pi 的公开导出**（语义与 TUI 完全一致，不自己重写）：
`resolveModelScopeWithDiagnostics(patterns, modelRuntime)` 是 `model-resolver.ts:364` 的公开导出，
其实现即 `resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(...))`（TUI 用的同一函数）。
取用方式沿用 §16 既有的 `argv[1] → pkgDir` 技术：`realpathSync(process.argv[1])` 后向上找 `package.json`，
再 `import(<pkg>/dist/index.js)`。`ModelRuntime` 取自 `ctx.modelRegistry.runtime`
（TS-private 字段，运行时仍是普通属性）。

**端到端实测（真实 pi 进程内探针）**：`pkgDir` 解析成功；`runtimeReachable=true`；`helperExported=true`；
11 个 scoped 模式 → 解析出 11 个模型、0 诊断；就地改数组后 `sameArrayAfterMutate=true`、回读可见。

**实现**：桥接注册命令 `pi-web:set-scoped-models`（服务端经 RPC `prompt "/pi-web:set-scoped-models"`
触发，与 `pi-web:reload` 同一模式）；桥接从侧信道取待应用的模式列表 → 解析 → **就地改数组** →
**回读校验**（id 集合一致才算成功）→ 回报结果。服务端在成功后刷新缓存的 scoped 列表并广播 state；
`persist===true` 仍照旧写 `settings.json`；**应用失败/超时则退回原行为**（写 settings + 提示需重启）。
三层兜底：① 探针断言（数组身份、导出存在、runtime 可达，见 §16）；② 应用后回读校验；③ 失败自动降级。

### 15.12 面板几何与"横框折行"（2026-10，用户实测闭环）

**现象**：原生引擎下 `/ctx-status` 面板里 TUI 框图的横框折行（一度折成 2~3 段）。日志先出现 `panel geometry ← 111×26`，后出现 `面板内容过宽：最长行 174 列 > 容量 173 列`。

**排查过程（逐层证伪，三层才到底）**
1. **怀疑列数算错**（无头浏览器扫 700–1400px 视口）：容量 81~144 列，与实测"可容列数"完全吻合 → 计算本身没错。
2. **怀疑组件多画**：日志 174 > 173；本地复现出组件确实比下发宽度**多画 1 列**（下发 142 → 输出 143）。
3. **真根因（用户环境）**：等宽字体**缺制表符 U+2500** 时浏览器**回退到全角字体**画 `─` → 单个 `─` 宽度 ≈ 数字的 **2 倍**。用户浏览器数字宽 6.09px（旧 720px 模态容量 ≈ 674/6.09 ≈ **111 列**，正是日志里的 111），而 `─` ≈ 12.2px → 172 个 `─` 在约 86 列处折行。我的机器装了 DejaVu Sans Mono（含 U+2500）→ `─` 与数字同宽，因此无论如何都复现不出。

**修复（两层互补）**

| 层 | 做法 | 效果 |
|---|---|---|
| 字体栈 | 新增 `--font-mono`，显式列出**含制表符/框图字符**的等宽字体（DejaVu Sans Mono / Liberation Mono / Noto Sans Mono / Cascadia Mono / Consolas / Menlo / Courier New），替换全部 10 处 `font-family: monospace` | 消除全角回退，`─` 恢复等宽 → **用户实测面板恢复满宽** |
| 度量与兜底 | 容量不再只量 `0`：按**内容里实际出现的字符类**（框图/色块/CJK/普通）逐字符累加像素宽，取最宽类；留 2 列余量（吸收"组件多画 1 列"与取整）；渲染后用**真实面板**回测并回报（自我校正）；超宽时先缩字号（下限 8px），仍放不下则该面板**退横向滚动**（`white-space: pre`） | 即使字体回退依旧存在，也**绝不折行折断框图** |
| 诊断 | 几何日志带中间量（内容区像素 ÷ 单字符像素）与框图宽度倍率告警 | `⚠️ 框图字符 12.2px 是数字的 2.0 倍（字体缺制表符 U+2500 → 回退全角），面板已按框图宽度计算容量` |

**顺带**：custom() 面板的模态放宽到 `min(1100px, 95vw)`（其他模态仍 720px），列数随视口自适应。

**验证**：正常环境 1200px 视口 → 143 列、无折行；**模拟全角回退**（强制 `IPAGothic`）→ 缩至 8px 仍超宽 → 退横向滚动，视觉行 (26) = 内容行 (26) → 无折行；用户浏览器实测面板满宽、框图完整。

**教训（要长期记住）**：*列数* 只有在"所有字符等宽"时才等价于像素宽度；制表符/框图/CJK/emoji 都可能触发字体回退而改变宽度。任何"按列数渲染"的适配都必须以**最宽字符类**为准，并对不可控的字体差异留兜底；同时诊断日志要能自证（带上中间量），否则只能靠猜。

### 15.13 阶段 E 实施方案（2026-10-14 讨论定稿）

#### 15.13.1 决策记录

| # | 决策点 | 结论 | 理由 / 关键事实 |
|---|---|---|---|
| 1 | `pi-web` 命令去向 | **薄壳**：保留 `pi-web r <name> [--port]`，实现为"会话名解析 + 堆上限处理 + 转调原生引擎" | 不改用户肌肉记忆；`cli.ts` 里真正有价值的部分（堆重启、名字解析、usage 文本）保留，SDK 宿主整块删除 |
| 2 | `usage-render` 归属 | **迁入 `native/usage-render.mjs`**（TS→JS） | 该模块**零 SDK 依赖**（只用 node:fs/path/os），迁走后原生引擎自包含、不再跨目录 import |
| 3 | 是否连 TS 构建链一起去掉 | **是**：全部运行期代码改为 `native/*.mjs`，删 `src/`、`tsconfig.json`、`tsc`/`tsx` devDeps | 与决策 2 连带的必然结果；终态 `build` 只剩"拷资产"，依赖只剩 `ws`，漂移面最小 |
| 4 | 包名与版本 | **`@maxdai/pi-web` + `1.0.0`** | ⚠️ **npm 上 `pi-web` 已被占用**（`ravshansbox/pi-web` 0.15.0，描述同为 "Web UI for the pi coding agent"，同赛道）；作用域包 `@maxdai/*` 必然可用。1.0.0 标记破坏性变更。**bin 名与包名无关**，用户的 `pi-web`/`pii`/`pi-web-native` 命令一律不变，只有安装/升级命令变为 `npm install -g @maxdai/pi-web` |
| 5 | 宿主契约核对器 | **迁到 `tools/host-contract/` 并接入流程**：发版前 / Pi 升级后各跑一次 | E 之后无法再做 SDK↔native 的 A/B，核对器成为唯一的"Pi 升级体检"手段 |

#### 15.13.2 目标文件布局

| 项 | 现在 | E 之后 |
|---|---|---|
| 运行期代码 | `src/*.ts`（2100 行 SDK 宿主）+ `native/*.mjs` | 仅 `native/*.mjs`：`server.mjs`（引擎）、`bridge.mjs`（注入扩展）、`usage-render.mjs`、`cli.mjs`（`pi-web` 薄壳）、`pii-cli.mjs`（`pii` 的 Node 包装器） |
| 构建 | `tsc` + 拷资产 | 仅 `node scripts/build-assets.mjs`（拷 `static/`、`pii/pii`、`native/*.mjs`，补执行位） |
| 依赖 | `pi-agent-core`、`pi-coding-agent`、`ws` | **仅 `ws`** |
| 包内产物 | `dist/{cli,server,session,ui-context,usage-render,log}.js`、`dist/pi-bin/server/*.py` | `dist/native/*.mjs`、`dist/static/*`、`dist/pi-bin/pii`、`dist/pi-bin/pii-cli.mjs` |
| 遗产 Python RPC 服务 | 仓库 `server/*.py`，并拷进 `dist/pi-bin/server/` | **删除**（已无调用方） |
| 包名 / 版本 | `pi-sdk-web` | `@maxdai/pi-web` @ **1.0.0** |
| 目录名 | `pi-sdk-web/` | **保持不动**（避免大面积引用改动；单独一次重命名可后续做） |

#### 15.13.3 迁移步骤（按序，每步可验证）

1. **前置**：① 用户在原生引擎上日常用顺一段时间；② 补一次**有记录的两引擎 A/B**（同一会话分别起 SDK 与 native：命令菜单、`/ctx-status`、`/aft-status`、`/usage`、统计、Ctrl+C 退出）替代 §15.8 阶段 D 的"冒烟扩两引擎"；③ 核对器迁到 `tools/host-contract/` 并跑通（基线不变）。
2. **搬迁（不删功能）**：`usage-render.ts → native/usage-render.mjs`；`cli.ts` 拆出 `native/cli.mjs`（薄壳）；`pii-cli.ts → native/pii-cli.mjs`；`native/server.mjs` 的 usage import 改为同目录 `./usage-render.mjs`；`build-assets.mjs` 改为拷贝 `native/*.mjs` 并补执行位。
3. **包改造**：`name=@maxdai/pi-web`、`version=1.0.0`、`dependencies={ws}`、`bin={pi-web: dist/native/cli.mjs, pi-web-native: dist/native/server.mjs, pii: dist/pi-bin/pii-cli.mjs}`、`scripts.build=node scripts/build-assets.mjs`；移除 `dev`/`verify`（verify 是 SDK 专用）与 TS 相关 devDeps。
4. **删除**：`src/`、`tsconfig.json`、`server/`（Python RPC）、build-assets 中的 server 拷贝、`dist/pi-bin/server/`。
5. **`pii` 项目根探测更新**：现有实现用"`<parent>/server` 是否存在"判断仓库根，`server/` 删除后该启发式失效 → 改用 `native/`（或 `.git`）作为标记；同时更新 `_native_server_cmd` 的候选路径。
6. **验证（全绿才算完成）**：`npm run build` 产物正确且无 TS 残留；三条入口都可用（`pi-web r <name>`、`pii r <name> --web`、`pi-web-native <id> <cwd> --port`）；冒烟 42/42；`/usage` 有数据；`/ctx-status`、`/aft-status` 面板不折行；Ctrl+C 字节流干净（pty 复现）；`npm ls --all` 无 `pi-coding-agent`/`pi-agent-core`；宿主契约核对器全绿。
7. **文档与发版**：README 改单引擎表述 + 安装命令改 `@maxdai/pi-web` + 发布流程加"跑核对器"；AGENTS 更新引擎说明；设计文档 §14/§15.8/§15.9 状态收口；发布 `@maxdai/pi-web@1.0.0`，并 **`npm deprecate pi-sdk-web@'<1.0.0' "已迁移到 @maxdai/pi-web"`** 指向新包。
   - 发版说明须写明：**0.7.5 的 `/usage` 回归**（`sendUsage` 引用了已被删除的 `REPO` 常量 → `usage unavailable: REPO is not defined`）**已修复**（commit `14ee75a`），**不单独发 0.7.6**，随 1.0.0 一并发布（2026-10-14 用户决定）。
8. **用户侧升级**：`npm uninstall -g pi-sdk-web && npm install -g @maxdai/pi-web`（先卸载再装，避免 bin 同名指向旧包）。

#### 15.13.4 风险与回退

| 风险 | 处置 |
|---|---|
| TS→JS 移植引入低级错误 | 步骤 6 的验证清单覆盖 usage 数据、面板、退出、冒烟；移植时逐个文件对照原实现 |
| bin 同名冲突（`pi-web` 同时存在于新旧包） | 用户侧"先卸载旧包再装新包"；发版说明写清 |
| 失去 SDK 引擎后无 A/B | 前置步骤 ② 留下 A/B 记录；回退靠 `git revert` + 不发布新版本 |
| Pi 升级破坏桥接依赖的约定 | 核对器接入流程（决策 5），发版前/Pi 升级后必跑 |
| 目录名 `pi-sdk-web/` 与实际不符 | 记录为不一致项；单独一次重命名处理（低优先） |


#### 15.13.5 两项待定项的裁决（2026-10-14 用户决定）

| 待定项 | 裁决 | 说明 / 何时重新评估 |
|---|---|---|
| `pi-web:reload` 是否从 `/` 菜单隐藏 | **暂时保留** | 它是"reload 必须由注入扩展的命令实现（RPC 无 reload 通道）"的必然产物，当前作为**显式功能**留在 `/` 菜单。若日后菜单项造成困扰、或阶段 E 收敛入口时再评估隐藏方式 |
| 原生引擎启动后是否自动 reload 一次（对齐 SDK/TUI 的 21 项工具 loadout，当前启动 20、缺 `codemode`） | **保持现状** | 不引入启动期自动 reload；需要 `codemode` 时手动执行一次 `/pi-web:reload`。该差异根因在 Pi 自身的"启动 loadout vs reload loadout"，非引擎实现差异（§16 第 22 项、`tools/ab-report-2026-10-14.md`） |

#### 15.13.6 实施记录（2026-10-14，阶段 E 已完成）

按 §15.13.3 的步骤执行，全部验证通过：

| 项 | 结果 |
|---|---|
| 搬迁 | `usage-render`、`pii-cli` 以既有编译产物为基移植为 `native/*.mjs`（保留原作者注释）；`pi-web` 薄壳新写为 `native/cli.mjs`（`r/list/help` + 堆上限处理 → 转调引擎） |
| 包改造 | `@maxdai/pi-web@1.0.0`；`dependencies` 只剩 `ws`（devDependency 只剩 `playwright-core`）；`bin` = `dist/native/{cli.mjs,server.mjs,pii-cli.mjs}` |
| 删除 | `pi-sdk-web/src/`（约 2100 行 SDK 宿主）、`tsconfig.json`、仓库根 `server/`（Python RPC 服务 + `__pycache__`）、TS 相关 devDeps；`build` 改为**纯拷贝**（无 tsc），先清空 `dist/` 再装配 + 缺件自检 |
| `pii` 改造 | 项目根探测由「`server/` 存在」改为「`native/` 存在」（`server/` 已删）；引擎候选路径新增「与 PI_WEB_DIR 同目录的 `server.mjs`」（发布布局 `dist/native`） |
| 迁移引入的自身 bug（已修） | ① `build-assets` 的路径基准写错（`pkg` vs `repo` 混用 → 找不到 `static/`）；② 探针/移植文件里的旧布局注释 |
| 验证 | 三条入口（`pi-web r`、`pii r --web`、`pi-web-native` 位置参数与 `--session` 名）全部可用；`pi-web help/list` 正常；**冒烟 42/42**（`pi-web r` 与 `pii r --web` 各一次）；header `pi v1.2.0 · pi-web v1.0.0`；`/usage` 在仓库与发布布局均返回 `usage_data`；`/ctx-status` 面板无折行（正常 + 模拟全角回退）；Ctrl+C 字节流干净（经薄壳，2/2）；`npm ls` 无 `pi-coding-agent`/`pi-agent-core`；宿主契约核对器零漂移 |
| `dist` 结构 | `dist/native/{server,bridge,usage-render,cli,pii-cli}.mjs` + `dist/native/pii`（均可执行）+ `dist/static/*`；无 TS 产物、无 `pi-bin/` |

**踩坑（值得记住）**：迁移后核对器报 `probe.commandCount` 26 → 23，一度疑似宿主契约变化。真实原因是**用户的
`~/.pi/agent/prompts/` 里有 3 个指向旧全局包 `pi-sdk-web/node_modules/...` 的符号链接**——阶段 E 卸载旧包后
软链悬空，Pi 于是少注册 3 个 prompt 命令（`implement`/`implement-and-review`/`scout-and-plan`）。已把软链改为
**实体文件拷贝**（源取 Pi 自身安装目录的示例 prompts），命令数恢复 26、核对器回到零漂移。
复查时又发现同类残留：`~/.pi/agent/agents/` 下 **4 个子代理定义**（`reviewer`/`worker`/`planner`/`scout`）
同样是悬空软链（指向旧包 `examples/extensions/subagent/agents/*.md`），一并改为实体拷贝；
最终 `find ~/.pi/agent -xtype l` 计数为 **0**。

**随后更正（同日，实证）**：这 7 个文件经查是 **2026-08-31 安装 Pi 官方 `subagent` 示例扩展时的遗留物**
（会话日志里留有当时的 `ln -sf ... examples/extensions/subagent/...` 命令），而该扩展本体
（`~/.pi/agent/extensions/subagent/`）**后来已被移除**：
① 这些 prompt 命令在全部会话记录中**从未被调用**（用户消息文本 0 次）；
② 4 个 agent 定义**没有任何消费者**（唯一会读它们的扩展已不在）。
即：**保留它们只是保留遗留物，不是恢复在用的功能**。用户确认后已**全部删除**
（`~/.pi/agent/prompts/` 只留用户自己的 `newpull.md`；`agents/` 目录移除；悬空软链 0）。
同时改进核对器：`probe.commandCount` 属**环境相关量**（取决于用户装了哪些 prompt/扩展），
已从结构漂移判定中摘出、仅作信息展示——避免这类"用户配置变化"被误判为宿主契约漂移。
→ **教训与待办**：凡是"包内路径被用户配置引用"（软链/配置项）的地方，移动或重命名包都会静默破坏用户环境；
发版说明里应提示检查 `~/.pi/agent/prompts/` 一类目录下的悬空软链（步骤 8 的用户侧升级提示已含此意）。

## 17. 落地切换：`pii r <name> --web` 改为原生引擎（2026-10 决定）

### 17.1 决定

| 入口 | 现状 | 切换后 |
|---|---|---|
| `pii r <name>` | TUI（exec `pi`） | **不变** |
| `pii r <name> --web [port]` | 打包的 **Python RPC 服务端**（`server/server.py`，内部 spawn `pi --mode rpc`） | **一步切换**为**独立原生服务端 bin**（RPC + 桥接扩展 + 现有 WS 协议/前端） |
| `pi-web r <name>` | SDK 宿主 | **保持不动**（过渡期对照与回退；最终去留见 §15.8 阶段 E） |

要点：**不新增用户可见命令/参数**——`--web` 的语义、默认端口 4080、端口越界与占用报错行为全部保持不变，换的只是背后的引擎。

选择理由：① `--web` 本就是「RPC 式 web」的槽位，而桥接是对 RPC UI 通道缺陷的补丁，语义吻合；
② 去掉版本漂移（驱动已安装的 `pi`，不再内嵌 SDK）；③ SDK 版原样保留，回退只需改 `pii` 一行。

### 17.2 接口契约（与 `pii` / Python 服务端同形）

```bash
pi-web-native <session-id> <cwd> --port <n>          # 对应 server.py <session_id> <cwd> --port
```

- `pii`（Python）继续负责：按**会话名**扫描 `~/.pi/agent/sessions/**/*.jsonl`、重名取最近并警告、`chdir(cwd)`
- 原生服务端新增按 **header `id`** 解析会话（并保留原型已有的 `--session <name>` / `--session-file <path>`）
- 端口默认 **4080**、越界与非数字报错退出；`cwd` 不存在报错退出（与 Python 版一致，不自动换端口）

### 17.3 代码位置与打包

| 项 | 位置 |
|---|---|
| 原生服务端源码 | 仓库根新增 `native/`（与既有 `pii/`、`server/` 同级，沿用「非 TS 运行期资产放根目录」的约定）：`server.mjs`（**单文件 bin**：参数/会话解析 + HTTP 静态 + WS 协议 + RPC 客户端 + 侧信道）、`bridge.mjs`（注入 `pi` 的桥接扩展）。不做无谓拆分——参数与会话解析只有几十行，单拆 `cli.mjs` 反而多一层间接 |
| 打包 | `pi-sdk-web/scripts/build-assets.mjs` 增加一步：`native/ → dist/native/`（含执行位）；`package.json` 的 `bin` 增加 **`pi-web-native: ./dist/native/server.mjs`** |
| 前端 | 复用现有 `static/`（`panelGeometry` 能力位已门控，SDK 引擎不受影响） |
| `pii` 改动 | `--web` 分支改为 `_native_server_cmd()`：解析顺序 `PI_WEB_NATIVE_BIN` → PATH 上的 `pi-web-native` → 仓库内 `native/server.mjs`（用 `node` 执行） |

原型（`experiments/rpc-bridge/`，2026-10 已提升为 `native/`）作为验证与回归对照的历史记录保留在设计文档中。

### 17.4 切换前必须补齐（非功能性；只在日常使用中暴露）

| 项 | 要求 |
|---|---|
| **pi 子进程生命周期** | 启动失败给出明确报错（不静默）；子进程异常退出时在界面提示；服务端退出（SIGINT/SIGTERM）时清理子进程；不遗留孤儿进程 |
| **WS 背压** | 客户端落后时跳过流式增量、追上后恢复（对齐 SDK 宿主的做法与日志格式），避免长会话/大输出时内存飙升 |
| **同会话并发写保护** | 同一 `.jsonl` 已被另一个**原生 web 实例**占用时在界面提示：每个实例把 `PI_WEB_BRIDGE_SESSION=<会话文件>` 注入 pi 子进程环境，扫 `/proc/<pid>/environ` 可靠命中。**TUI 无法可靠检测**（2026-10 实测：pi 用 `process.title` 覆写 argv、会话文件写完即关、Pi 无任何锁机制）——为避免误报不对 TUI 做猜测，仅记录该边界 |
| 端口/cwd 校验 | 与 Python 版一致（见 §17.2） |

**Ctrl+C 的退出次序（2026-10-14 实测定位并修复）**：Ctrl+C 会把 SIGINT 送给**整个前台进程组**（pii + 服务端 + pi 子进程），服务端因此自行优雅关停（杀 pi 子进程、关 socket、打印收尾日志）。
若 `pii` 收到 KeyboardInterrupt 就**立刻 `sys.exit`**，则 bash 会先打印提示符，而服务端仍在关停、它的收尾日志会**落到提示符之后**（现象：提示符后多一行/被顶掉，且带不确定性）。修法两条：

- **第 1 层 · Python 启动器 `pii`**：`--web` 分支改为 `Popen` + `wait()`：首次 Ctrl+C 后**继续等子进程**收尾（上限 5s，超时或再次 Ctrl+C 才 `kill`），**不再自己 `print()` 空行**（服务端输出自带换行）；
- **第 2 层 · npm bin 包装器 `pii-cli.js`**（Node，`spawnSync` 调 Python 启动器）：必须**忽略 SIGINT/SIGTERM**，否则 Node 默认行为会立刻杀掉包装器——而包装器才是 bash 的直接子进程，bash 照样会先打印提示符、把后续日志挤到提示符之后；
- 实测（pty 逐字节）：修复前 `…关停…\r\n\r\n bash提示符 [pi-web] pi子进程已退出…\r\n \r\n`；修复后经**真实 `pii` 命令**连测 3 次均为 `…关停…\r\n[pi-web] pi子进程已退出…\r\n bash提示符`，干净且确定。
- 一般化教训：**前台进程组里每一层都要么自己收尾、要么耐心等下一层**；任何一层抢先退出，shell 的提示符就会插到别人的收尾输出中间。

**会话解析三种入口（语义不可混）**：位置参数 ` <session-id> [cwd]` 按 header `id` 匹配（pii 的调用契约）；`--session <name>` 按**显示名**匹配（含 `"(unnamed)"`）；`--session-file <path>` 直接指定。曾把位置参数与 `--session` 合并且都按 id 匹配 → `--session <name>` 静默失效（2026-10-14 修复）。

### 17.5 切换后仍存在的缺口（明确记录，不视为 bug）

- ~~scoped models 改动需重启 pi 子进程~~ → **已关闭**（2026-10-14 实现即时生效，见 §15.11.1）
- **`.jsonl` 导出降级**为提示（RPC 仅 `export_html`）——**可在 RPC 内关闭**（方法见 §18.10.2，~15–20 行，未实施）
- **命令产生的历史条目不复刻**（= 与 TUI 一致；SDK 版会多出 `[ctx-status] (click to expand)` 之类记录；§15.11 A3，2026-10 用户拍板）

### 17.6 验证计划

1. 冒烟 42 项全绿（原生实例）
2. **`pii r <name> --web <port>` 端到端跑通**（真实会话；若该会话同时被 TUI 打开，先确认并发写提示生效）
3. 与 SDK 版 A/B：三列表（Extensions/Tools/`/` 菜单）、命令输出呈现、对话框语义（timeout/无限等待/倒计时/中止）
4. 宿主契约核对器全绿（Pi 1.2.0 基线，§16）
5. **回退演练**：`pi-web r <name>` 仍可用，改回 `pii` 一行即可复原

### 17.6.1 实施与验证结果（2026-10-14）

| 项 | 结果 |
|---|---|
| `native/` 提升 | `git mv experiments/rpc-bridge/{server,bridge}.mjs → native/`；核对器与探针随后迁至 `tools/host-contract/`（`experiments/` 已清空） |
| 打包 | `npm run build` 后 `dist/native/{server.mjs,bridge.mjs}` 就位（server 带执行位）；bin `pi-web-native` 可独立运行 |
| **发布布局实测** | `node pi-sdk-web/dist/native/server.mjs <id> /root --port 4099`：**冒烟 42/42**（静态前端取自 `dist/static`、`ws` 从包内 node_modules 解析、桥接取自 `dist/native/bridge.mjs`） |
| **`pii --web` 端到端** | `PI_WEB_DIR=/root/pi-web python3 pii/pii r install --web 4098` → 原生引擎启动、页面 200、**冒烟 42/42** |
| 参数/错误路径 | 无参数→用法；非法端口→`Invalid port`；cwd 不存在→`Working directory not found`；会话 id 不存在→明确报错（均带时间戳） |
| 子进程生命周期 | SIGTERM 关停：先 SIGTERM 子进程（实测 code=143），1.5s 未退则 SIGKILL；**无孤儿**；子进程意外退出会向界面提示原因（不静默） |
| 并发写提示 | 同会话起第二个实例 → 实测命中 `警告：同一会话已被另一个原生 web 实例打开（PID …）` |
| WS 背压 | 「连上即暂停读取」的客户端 + 4MB 输出实测：命中 `client is behind (0.3MB queued) - skipping stream deltas until it catches up`，服务端保持可用；阈值可经 `PI_WEB_BACKPRESSURE_HIGH/LOW` 调整（默认 8MB/2MB） |
| 自身日志 | 服务端全部诊断行带本地时间戳（命令/扩展输出保持原样不加） |
| 迁移引入的两个真问题 | ① `STATIC_DIR` 原以 `../..` 解析 → 迁移后指到仓库外，已改 `../static`（仓库与发布两种布局均成立）；② `ws` 原用硬编码绝对路径 `createRequire("/root/pi-web/pi-sdk-web/package.json")` → 发布后必然失效，已改为「按自身位置解析，失败回退同级 pi-sdk-web」 |


### 17.7 风险

| 风险 | 缓解 |
|---|---|
| 一步切换 ⇒ 缺口立刻暴露在日常使用中 | SDK 版原样保留；回退只需改 `pii` 一行；缺口清单见 §17.5 |
| 进程模型变复杂（服务端 + pi 子进程，SDK 版是单进程） | §17.4 的生命周期/背压/并发保护作为切换前置条件 |
| Pi 升级后宿主契约可能变 | 升级后跑 §16 核对器（已有基线与 14 项关键判定） |
| 打包路径/执行位问题 | 沿用 `build-assets.mjs` 既有做法，并加自检（文件存在 + 执行位） |

## 16. 宿主（Pi）依赖与兼容性核对清单

> 本节是 §15 方案的**配套维护契约**。RPC + 注入扩展的做法**替换/改写了宿主 pi 的对象**，并直接依赖若干
> 非公开的内部约定（对象共享性、包目录布局、session 文件格式、RPC 细节）。这些都不在 Pi 的公开契约里，
> **Pi 版本更迭后必须逐项核对**。核对器与基线见 §16.6；失效后的降级路径见 §16.7。

### 16.1 最高风险：被替换 / 改写的宿主对象

| # | 对象 / 成员 | 我们的用法 | 依赖的假设 | 失效后果 | 核对项 |
|---|---|---|---|---|---|
| 1 | **`ctx.ui`（整体）** | 改写其方法（setWidget / custom / 对话框 / setTheme） | 它是 runner 的**单一共享可变对象**，改写**对其他扩展可见** | 桥接整体失效 → 回退 RPC 原生（丢工厂 widget、面板、启动期对话框、换肤） | `setTitlePatchable`、`crossExtensionUiVisible` |
| 2 | `ctx.ui.setWidget` | 工厂式内容由我们渲染；字符串/undefined 转发原实现 | 签名 `(key, string[] \| factory, options?)`；组件有 `render(width)`；更新走 `tui.requestRender()`；**移除后须自行 `invalidate()` 并停止转发** | `/todos` 等常驻面板丢失、更新停滞或「复活」 | `signatures.setWidget` + 冒烟 widget 项 |
| 3 | `ctx.ui.custom` | 渲染组件文本行 → 前端只读模态 | 签名 `custom(factory, options?)`，factory 收 `(tui, theme, keybindings, done)` | 面板不可见（现状本就不可见，属能力回退） | `signatures.custom` |
| 4 | `ctx.ui.select/confirm/input/editor` | 接管为网页对话框 | 方法名与参数形态；响应形状 `cancelled` / `confirmed` / `value` | 对话框失效或挂起 | `signatures.select…editor` + 冒烟 dialog 项 |
| 5 | `ctx.ui.setTheme` | 接管并返回 `{success:true}` | 方法存在 | 换肤调用报错 | `signatures.setTheme` |
| 6 | **`ctx.ui.theme`** | `Object.defineProperty` 换成自有 Pi Theme（暗/亮热切换） | 该属性**可配置**（1.2.0 实测为可写+可配置的值属性，非 getter）；`theme.fg(name,text)` 语义 | 扩展 ANSI 颜色不随网页主题切换（降级为宿主主题） | `themeDescriptor`、`uiThemeFg` |

### 16.2 宿主包布局与模块（换肤依赖）

| # | 依赖 | 假设 | 失效后果 |
|---|---|---|---|
| 7 | `process.argv[1]` 指向 `node_modules/.bin/pi`，为指向 `<pkg>/dist/bundle/cli.js` 的符号链接 | 由此得 `pkgDir = resolve(dirname(realpath(argv1)), "../..")` | 换肤降级（保持宿主主题），不致命 |
| 8 | `<pkg>/dist/index.js` 可 `import` 且导出 `Theme` | 导出名 `Theme` 为构造函数 | 同上 |
| 9 | `<pkg>/dist/modes/interactive/theme/{dark,light}.json` | 结构含 `vars` + `colors`；背景键集合为 `selectedBg`/`scrollbarThumb`/`searchMatchBg`/`userMessageBg`/`customMessageBg`/`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`。**`new Theme(fg, bg, …)` 会校验所有 token 可解析**：实测传入不完整的颜色表会抛 `Theme token <key> has unresolved fallback <name>`（我们传整份 `colors`，故正常）；若 Pi 新增背景类 token 而未被上面的集合识别，会被误归为前景键 | 同上 |

### 16.3 直接解析的宿主数据文件（非 API 契约）

| # | 依赖 | 假设 | 失效后果 |
|---|---|---|---|
| 10 | `~/.pi/agent/sessions/**/*.jsonl` | 首行 header 含 `cwd`（与 `id`）；展示名存于 `{"type":"session_info",…,"name":…}`；**无名字视为 `(unnamed)`** | 会话名解析、`(unnamed)` 入口、`get_sessions` 列表、`delete_session` 校验异常 |
| 11 | `~/.pi/agent/settings.json` 的 `enabledModels` | scoped models 的持久化键；**启动时读取**。运行时改动不再需要重启：桥接就地改 `ctx.scopedModels`（§15.11.1） | scoped models 点选/持久化异常 |
| 12 | usage 统计字段（`usage-render.ts`） | session 条目里 message/usage 的形状 | `/usage` 面板数据缺失或错算 |

### 16.4 RPC 协议与 CLI 细节

| # | 依赖 | 假设 | 失效后果 |
|---|---|---|---|
| 13 | 启动参数 | `--session <file>`、`--mode rpc`、`--extension <path>`、`--no-session` 均有效 | 无法启动引擎 |
| 14 | stdin/stdout 协议 | 命令信封 `{id,type,…}`；`response` 关联 `id`；事件经 `toJsonEvent`（剥 delta 的 `partial`，`toolcall_start` 保留 `id`/`toolName`） | 命令无响应/事件丢字段 |
| 15 | `extension_ui_request` | method ∈ {select, confirm, input, editor, notify, setStatus, setWidget, setTitle, set_editor_text}；字段名 `title`/`options`/`message`/`statusKey`/`statusText`/`widgetKey`/`widgetLines`/`widgetPlacement` | 前端渲染错乱（状态/widget/对话框） |
| 16 | `bash` 命令 | 用**命令信封 id** 作为执行 id（出现在 `bash_execution_update`）；**不发** `bash_result`（服务端合成） | bash 流式块匹配失败/无法定稿 |
| 17 | 响应形状 | `get_entries → {entries, leafId}`；`get_state → RpcSessionState`；`get_session_stats`；`get_available_models → {models}`；`get_available_thinking_levels → {levels}`；`get_commands → {commands}`；`export_html{outputPath}`；`switch_session{sessionPath}` | 首屏/模型/thinking/会话切换异常 |
| 18 | 启动时序 | stdin 在 **`session_start` 之后**才挂载 → 启动期对话框必死锁，故对话框必须由桥接接管 | 若上游修复该时序：可简化，但**不能依赖**它 |
| 19 | 模式语义 | RPC 下 `ctx.mode === "rpc"`、`ctx.hasUI === true` | 扩展的 UI 分支行为改变 |
| 20 | ExtensionAPI | `pi.on` / `registerCommand` / `getCommands` / `getActiveTools`；命令形状 `{name,description,source,sourceInfo{path,origin,scope,baseDir}}`；`sourceInfo.path` 的 `builtin:` 与 `<inline:>` 约定；`ctx.reload()`（ExtensionCommandContext） | 扩展列表/资源面板失真；`/pi-web:reload` 失效 |
| 21 | **侧栏 Tools 名单** | `pi.getActiveTools(): string[]`（= `session.activeToolNames = agent.state.tools`，会被 `prepareLoadout` 影响，且**在 reload 前后可能不同**：实测同一个原生进程启动 20 项、reload 后 21 项）＋ `pi.getAllTools(): ToolInfo[]`（字段含 `name/description/parameters/promptGuidelines/exposure/sourceInfo`）；**Tools 面板需要 `{name, description}` 对象**（前端按 `t.name` 渲染，传字符串数组会渲染成空行——已实测踩过） | 侧栏 Tools 空白、条目无名，或 reload 前后名单不一致 |
| 22 | **侧栏 Extensions 名单** | 只能由 `source === "extension"` 的命令路径 ∪ 工具的 `sourceInfo.path` 反推（**没有**「已加载扩展列表」API）；`source` 取值 `extension \| prompt \| skill`，prompt/skill 是 `.md`（**不能**当扩展，否则侧栏混入一堆 `.md`——已实测踩过） | 侧栏扩展列表失真 |
| 23 | **内置扩展名单** | `<pkg>/dist/extensions/index.js` 导出 `builtInExtensions`（当前 4 个：`llama.cpp`/`codemode`/`tool-search`/`mcp`）；用它过滤 `builtin:*` 路径，才能把**内置扩展**与**核心内置工具**（`builtin:bash`/`find`/`ls`/`powershell`…）区分开 | 侧栏把核心工具误列为扩展，或漏掉 codemode/tool-search |
| 24 | **本地扩展命名** | 与 SDK 宿主 `describeLocalExtension` 同规则：`.../extensions/<dir>/index.ts → <dir>`（直接用 basename 会得到 `index`） | 侧栏显示 `index` 而非扩展目录名 |

**已知的引擎差异（同一会话 A/B 实测，2026-10；含一次自我更正）**：

- **Tools 面板的 `codemode`**：SDK 宿主 21 项 / 原生**启动时** 20 项；但实测**同一个原生进程**执行一次
  `/pi-web:reload` 后变为 **21 项（含 `codemode`）**，与 SDK 侧一致。→ 根因不是「SDK 宿主自行注入内置扩展」
  （该推断已被此实验推翻），而是 **Pi 自身的「启动 loadout vs reload loadout」差异**（`codemode` 的
  `exposure === "model-only"`，启动时未列入 active、reload 后列入）。**副作用：侧栏 Tools 名单在 reload 前后会变**。
- **Extensions 面板**：9 / 9 完全一致。
- **`/` 菜单**：原生仅多 `/pi-web:reload`（桥接提供 reload 能力的必要命令；SDK 版的 `/reload` 由前端内置列表提供，两边都可用）。
- **reload 后的桥接健壮性**（实测）：`ctx.reload()` 会重绑扩展并再发 `session_start(reason:"reload")`，
  桥接的补丁随之重新安装——reload 后第二次 `bridge ready` 上报正常、`get_state` 仍返回 state。

### 16.5 依赖分级与「不用改」的部分
- **公开契约（低风险）**：`--mode rpc` 本身是 Pi 对外协议；ExtensionAPI 是给扩展作者的公开面。
- **非公开约定（高风险）**：第 1–6 项（对象改写）、第 7–9 项（包布局）、第 10–12 项（数据文件）。
- 明确**不依赖**：Pi 的 TUI 渲染内部、`InteractiveMode`、Pi 的私有模块路径（除第 8 项那个 import 入口）。

### 16.6 核对方法（Pi 升级后执行）

```bash
# 与基线对比：关键项是否满足 + 结构有无漂移
node tools/host-contract/check-host-contract.mjs

# 记录/更新基线（确认新版本可接受后）
node tools/host-contract/check-host-contract.mjs --update

# 只看当前快照
node tools/host-contract/check-host-contract.mjs --json
```

- **核对器**：`tools/host-contract/check-host-contract.mjs`（内含 14 项关键判定 + 结构 diff）
- **进程内探针**：`host-contract-probe.mjs`（A：探测并改写 `setTitle`）+ `host-contract-probe-b.mjs`（B：触发调用，验证改写跨扩展可见）
- **基线**：`tools/host-contract/host-contract.baseline.json`（当前记录：**Pi 1.2.0 / node v24.18.0**）
- **判定**：`FAIL` = 立足点被破坏（须处理）；`DRIFT` = 与基线有差异（须人工判断，例如 UI 方法增删）
- 补充验证：`node tools/smoke.mjs http://127.0.0.1:4096`（42 项）+ 桥接自带诊断命令 `/pi-web:demo-widget`、`/pi-web:demo-clear`、`/pi-web:demo-dialog`、`/pi-web:demo-panel`
- 核对器自身可靠性已验证（2026-10）：篡改基线（移除一个 UI 方法、把 `theme` 改为不可配置 getter）后，核对器正确报出 4 处差异。

**scoped models 即时生效的三处依赖（2026-10-14 新增，§15.11.1）**：

| 依赖 | 事实 | 破坏后果 | 核对方式 |
|---|---|---|---|
| 包公开导出 `resolveModelScopeWithDiagnostics` | `model-resolver.ts:364` 导出，实现 = TUI 用的 `resolveModelScopeFromModels` | 取不到解析器 → 即时生效不可用（自动退回写 settings + 提示重启） | 探针 `scopedResolverExport` |
| `ctx.modelRegistry.runtime` 可达 | TS-private 字段，运行时仍是普通属性；`getAvailableSnapshot()` 可用 | 同上 | 探针 `scopedRegistryRuntime` |
| `ctx.scopedModels` 是 session 内部数组本身 | `agent-session.ts:3463 getScopedModels: () => this._scopedModels`（无拷贝） | 若改为返回拷贝，就地改无效 → 回读校验会失败 → 自动退回旧行为 | 探针 `scopedSharedArray` + 运行时回读校验 |

### 16.7 失效后的降级路径

| 失效项 | 降级行为 |
|---|---|
| 主题相关（第 6–9 项） | 桥接保持宿主主题（已实现：加载失败即不改写 `ui.theme`），扩展 ANSI 不随网页主题切换 |
| 对象改写（第 1–5 项） | 退回 RPC 原生行为：工厂 widget / 面板 / 启动期对话框 / 换肤丧失，会话仍可用 |
| 共享可变 ui 根本不再成立 | 方案整体退回 **SDK 宿主**（§14），即 §15.9 记录的回退路径（代价：版本漂移） |
| 数据文件格式（第 10–12 项） | 会话列表/`(unnamed)`/scoped models/`/usage` 局部失效，需按新格式适配 |

## 18. 候选路线：TUI 模式 + 桥接（pi-vscode 式，2026-10-15 研究记录）

> **状态：纯研究记录，未决策、未实施、本轮未改任何代码。**
> 起因：用户注意到「pi-vscode 是让 pi 保持在 TUI 模式的」，要求研究其运作方式。
> 本节的定位是**候选路线的事实底稿**——若后续采纳，它将取代 §15/§17 的 RPC 通道；若否，则作为对照留档。
> 研究材料：`/root/research/pi-vscode`（v0.0.9，最后提交 2026-04-24，32 commits，TS 2499 行）
> 与 Pi 源码 `/root/research/pi/packages/coding-agent/src`（1.2.0）。

### 18.1 pi-vscode 的运作方式（源码实证）

**一句话**：它**不替换 TUI**，而是给 TUI **加装一个 IDE 工具层**——pi 以**真 TUI** 跑在 VS Code 内置终端里，
另注入一个桥接扩展，让**模型**能调用 VS Code 的 LSP/编辑器能力，并在 TUI 页脚显示状态行。

| 界面 | 启动方式 | 用途 | 证据 |
|---|---|---|---|
| **主会话（核心）** | `vscode.window.createTerminal({ shellPath: piPath, shellArgs })`：**真终端里跑真 TUI** | 用户与 pi 的全部交互；**所有 TUI 能力天然可用** | `src/terminal.ts:20-40` |
| **桥接扩展** | 参数 `--extension bridge/pi-vscode-bridge.js`；环境 `PI_VSCODE_BRIDGE_URL` / `_TOKEN` / `_TERMINAL_ID` | 给**模型**提供 ~25 个 `vscode_*` 工具 + TUI 页脚状态行 + 会话文件上报 | `src/pi.ts:80-103`、`bridge/pi-vscode-bridge.js` |
| **VS Code Chat 面板** | `spawn(pi, ["--mode","rpc","--no-session", …])` | **仅一次性问答**：RPC 事件流式写入原生 Chat 面板；失败则回退开一个 TUI 终端 | `src/pi.ts:76-78`、`src/chat.ts:60-70` |

> 注意：**RPC 模式只用于 Chat 面板的一次性请求**；主会话始终是 TUI——这正是用户观察到的现象。

**主会话的确切启动形态**：

```bash
pi --extension <ext>/bridge/pi-vscode-bridge.js \
   --append-system-prompt "You are running inside VS Code with a live IDE bridge. Prefer VS Code bridge tools …"
# env: PI_VSCODE_BRIDGE_URL=http://127.0.0.1:<port>
#      PI_VSCODE_BRIDGE_TOKEN=<uuid>   PI_VSCODE_TERMINAL_ID=<uuid>
```

`--append-system-prompt`（`src/constants.ts:5-9`）用于**告知模型「你在 VS Code 里，优先用桥接工具」**——值得借鉴的小设计。

**桥接扩展（单文件，无构建）做了什么**：

| 类别 | 内容 |
|---|---|
| **注册工具（主价值）** | ~25 个：`vscode_get_diagnostics`、`_get_definitions`、`_get_hover`、`_get_references`、`_get_code_actions`、`_execute_code_action`、`_apply_workspace_edit`、`_format_document/_range`、`_open_file`、`_save_document`、`_get_selection`、`_get_notifications` … 每个工具的实现就是一次 `POST {url}/rpc`（头 `x-pi-vscode-authorization: <token>`） |
| **状态行** | `ctx.ui.setStatus("pi-vscode", "VS Code: <文件> • Ln/Col • E0 W1 …")`，每 **1.5s** 刷新；订阅 `session_start` / `input` / `agent_end` / `session_shutdown` 控制启停 |
| **会话上报** | `reportTerminalSession({ terminalId, sessionFile })` → VS Code 重启后可恢复会话（配合 `src/sessions.ts`） |
| **结果限流** | 50KB / 2000 行截断，超限返回结构化提示，让模型收窄查询 |

**宿主侧**（`src/bridge/server.ts` + `handlers.ts` 529 行 + `serialize.ts`）：一个 `node:http` 服务——随机 UUID token 鉴权、
`POST /rpc` 方法分发、以及**通知队列**（`selection_changed` / `diagnostics_changed` / `active_editor_changed` …，
供模型用 `vscode_get_notifications` 轮询）。**零运行时依赖**（`package.json` 只有 devDependencies）。

**它「不」做什么（易误解点，逐条核实）**：

| 常见猜测 | 事实 |
|---|---|
| 解析 TUI 的 ANSI 输出 | **完全没有**（全仓库无 ansi/pty/terminal-parsing 代码）→ 终端由 VS Code 自己渲染 |
| 使用 pty / node-pty | **没有**（VS Code 终端本身就是 pty） |
| 改 pi 本体 / fork pi-coding-agent | **没有**，只用公开扩展 API：`pi.on(...)`、`pi.registerTool(...)`、`ctx.ui.setStatus`、`ctx.ui.theme.fg`、`ctx.sessionManager.getSessionFile()` |
| 用 webview 渲染对话 | **没有**（对话在终端里） |

### 18.2 为什么它「功能齐全」

**因为 UI 就是 TUI 本身**：`/scoped-models`、`/export`、面板、对话框、自定义 session 目录、命令历史……
全都是 interactive 模式自己的实现，pi-vscode 一行都没重写。桥接只是**附加**了 IDE 工具层与一行状态。

这恰好与我们的处境互补：pi-web 是「用 RPC 事件在浏览器里**重画** TUI」，所以每缺一个 TUI-only 能力就要自己补一次
（scoped models 刚补完 §15.11.1，仍余 `.jsonl` 导出、自定义 session 目录）。

### 18.3 与 pi-web 现状对照

| | **RPC + 桥接（现状，§15/§17）** | **TUI + 桥接 + pty（本候选路线）** |
|---|---|---|
| TUI-only 能力 | 需逐项追平 | **天然全部继承** |
| 事件流来源 | RPC stdout 免费得到 | 需桥接**自己镜像**（旧 SDK 宿主代码可复用） |
| 运行时依赖 | 只有 `ws` | 需 pty：`script -qc`（util-linux，免原生依赖）或 `node-pty`（原生模块） |
| 额外开销 | 无 | TUI 仍向 pty 渲染（可忽略；甚至可白送一个「终端视图」标签页） |
| 主要风险 | RPC 命令面缺口 | 命令注入路径、pty 生命周期、TUI 与 Web 争输入焦点 |
| 与「不改 Pi 本体」 | 一致 | 一致（仍只用扩展 + 侧信道） |

### 18.4 可行性核实（逐条证据，Pi 1.2.0）

| 需求 | 是否具备 | 证据 |
|---|---|---|
| 浏览器需要的事件流 | **齐备**：`message_start/update/end`、`tool_execution_start/update/end`、`agent_start/end/settled`、`turn_start/end`、`session_compact`、`model_select`、`thinking_level_select`、`user_bash`、`input` … | `core/extensions/types.ts` 的 `on(event: "…")` 重载清单（共 32 个事件） |
| 从浏览器发提示 | `pi.sendUserMessage(...)` **存在**（官方路径，会触发一轮 run） | `types.ts:448`、`:1741`、`:940` |
| 中止 / 压缩 / 重载 / 关停 | `ctx.abort`、`ctx.compact`、`ctx.reload`、`ctx.shutdown` 均在扩展上下文 | 我们的宿主契约探针已实测（`ctx` keys 清单，§16） |
| UI 接管（面板/对话框/widget/换肤） | 同现状：改写 `ctx.ui` 共享可变对象 | §15、§16；已实施 |
| 让 TUI 跑起来 | **需要 pty**（interactive 模式要求 TTY） | pi interactive 模式前提；`script -qc "pi …" /dev/null` 可免原生依赖 |
| 斜杠命令（扩展命令） | ✅ **已实测可行**：`pi.sendUserMessage("/<cmd>", { expandPromptTemplates: true })` 会派发**扩展命令**（文档原文：dispatch extension commands / expand skill commands and prompt templates），且**不触发模型** | 原型 §18.8 步骤 3a |
| 斜杠命令（内置命令） | ✅ **已实测可行（另一条路）**：`model`/`thinking`/`scoped-models`/`export`/`new`/`compact`/`reload`/`quit` 等**内置命令不经 `sendUserMessage` 执行**（会被识别但不执行）；改为**把命令文本写进 pty stdin**（＝替用户敲），由 TUI 自己的命令 runner 处理 | 原型 §18.8 步骤 3b/3c；命令清单见 `core/slash-commands.ts` |

### 18.5 若采纳，需要做的工程项（预估）

1. **pty 层**：以 `script -qc`（或 node-pty）拉起 `pi --extension <bridge>`，处理尺寸（COLUMNS/LINES）、进程组与
   Ctrl+C（沿用 §17.4 的关停握手经验）；
2. **桥接侧会话镜像**：订阅 18.4 的事件 → 序列化消息/工具块/状态 → 经侧信道推给服务端（可移植我们旧 SDK 宿主
   的 `session.ts`/`ui-context.ts` 语义，代码在 git 历史中）；
3. **输入注入**：浏览器输入 → `pi.sendUserMessage`；中止 → `ctx.abort`；
4. **命令路径**：先实测 `sendUserMessage("/cmd")`；不行则走「写 pty stdin」；
5. **TUI 输出的处置**：默认丢弃；可选提供「终端视图」（把 pty 输出经 WS 转发到前端 xterm.js）作为逃生通道；
6. **宿主契约**：新增探针项（`sendUserMessage` 存在、事件名齐全、pty 启动可行），纳入 §16 清单与核对器；
7. **文档与入口**：入口命令保持零变化（`pii r <name> --web`），引擎内部切换。

### 18.6 风险与未决问题

- ~~**命令注入路径未验证**~~ → **已解决**（§18.8）：扩展命令走 `sendUserMessage`+`expandPromptTemplates`，内置命令走 pty 敲键；
- **敲键需挑时机**：忙碌（模型流式中）时写入 pty 的文字会被当作 steering/排队输入，内置命令应在空闲时注入（原型步骤 3c 首次失败即因在流式中敲入）；
- **`input` 事件语义**：`pi.on("input")` 只对「提交的文本」触发，**命令派发不触发**（原型实测）——桥接镜像输入历史时要按此区分；
- **输入焦点冲突**：TUI 自身仍在读 stdin；若有人在终端里敲字，会与 Web 输入竞争（可接受，但需说明）；
- **pty 可用性**：`script` 依赖 util-linux（Linux/macOS 常见，Windows 需另方案）；
- ~~**重复渲染成本**~~ → **已实测：可忽略**（空闲 0 B/s、CPU≈0；一轮 5.3–7.2 KB/s、pi CPU 12.8% 单核，见 §18.9）；
- **关停必须走信号**：TUI 的 Ctrl+C 是**应用按键**（raw 模式，不是 SIGINT）——实测单次不退出、两次（间隔 2s）也不退出；
  `SIGTERM` 直达 pi 0.6s 退出，`SIGTERM` 打 `script` 包装进程也能带走 pi（不留孤儿）。但**两种方式都不会触发 `session_shutdown`**
  → 引擎不能依赖该事件做收尾（会话数据是增量落盘的，可接受）；
- **子进程识别**：pi 会**改写自身 argv/comm**（实测 `comm=pi`、cmdline 只剩 `pi`）→ 不能按命令行找它，
  要用进程树 / 记录 PID / 环境变量标记（也影响"实例是否在跑"的判断）；
- **迁移代价**：桥接要长大（镜像 + 输入 + 命令），而我们现有的 RPC 服务端逻辑（协议层）会大部分重写；
  但前端与侧信道设计可原样复用。

### 18.7 建议的最小验证原型（三步，待用户决定后再做）

1. **起得来**：`script -qc "pi --extension <我们的 bridge>" /dev/null` 能进入 interactive 模式，且桥接能上报（`/side/ready`）；
2. **送得进**：`pi.sendUserMessage("你好")` 能让会话跑一轮，且事件（`message_start/update/end`、`tool_execution_*`）可被桥接捕获并转发；
3. **命令通**：`sendUserMessage("/usage")` 是否按命令执行；否则验证「写 pty stdin」方案。

**决策状态：未决。** 需要用户拍板是否投入（对照 §17 现状：RPC 路线已发版可用，缺口只剩 2 项）。

> **执行记录（2026-10-15，用户批准后完成）**：三步原型已跑通（§18.8），并补充验证了会话镜像与 pty 开销/关停（§18.9）；原型脚本留档于
> `tools/tui-proto/`（不进入发布产物——npm 包只含 `dist/`）。

### 18.8 最小验证原型结果（2026-10-15，全部实测）

**做法**：临时原型（`tools/tui-proto/`，另在 `/tmp/tui-proto/` 运行）——一个最小桥接（上报就绪 / 轮询待发消息 /
转发事件 / 注册一个测试命令）+ 一个驱动脚本：本机 HTTP 收事件、`script -q -c "pi --extension <bridge> --session <tmp>"
/dev/null` 起 pty、按时间线注入消息与按键。

| 步骤 | 问题 | 结果 | 关键证据 |
|---|---|---|---|
| **1 起得来** | pty + interactive 模式 + 注入桥接能否工作 | ✅ | 桥接上报 `mode:"tui"`、`hasUI:true`、`cwd:"/root"`、`stdoutIsTTY/stdinIsTTY=true`、`scoped:12`；pty 里能看到真 TUI 渲染（`Model scope: …`） |
| **2 送得进** | 能否从外部把用户消息送进会话并拿到事件流 | ✅ | `pi.sendUserMessage("Reply with exactly: PONG")` → 事件序列 `send → input → agent_start → turn_start → message_start/end … → turn_end → agent_end`；模型执行工具时另有 `tool_execution_start/end` |
| **3a 扩展命令** | 扩展命令能否经 API 派发 | ✅ | `/pi-web-proto:ping` + `{expandPromptTemplates:true}` → 命令处理器运行（`command-ran`），**未触发模型** |
| **3b 内置命令（API）** | 内置命令能否同样派发 | ❌（已定性） | `/thinking`、`/model`、`/export <path>.jsonl` → **不触发模型、但也不执行**（无事件、无文件）→ `expandPromptTemplates` 只覆盖扩展/skill/prompt，不含内置命令 |
| **3c 内置命令（pty 敲键）** | 替代路径是否可行 | ✅✅ | 空闲时敲 `/model
` → TUI 选择器面板渲染到 pty（无模型调用）；敲 `/export /tmp/tui-proto/exp2.jsonl
` → **文件生成 58,503 字节** |

**结论**：
1. 「TUI 模式 + 桥接 + pty」在 Pi 1.2.0 上**可行**，且不需要改 Pi 本体；
2. **命令注入有明确的两条路**：扩展命令走 `sendUserMessage(..., {expandPromptTemplates:true})`；内置命令走 pty 敲键
   （须空闲时注入）；
3. **额外收获**：TUI 模式下 `/export x.jsonl` 直接可用 → §17.5 的「`.jsonl` 导出降级」缺口在本路线下**自然消失**；
4. **待测/未覆盖**：`/scoped-models` 面板在本路线下的即时生效（我们已用共享数组方案解决，二者可叠加）。

### 18.9 补充验证：会话镜像与 pty 开销/关停（2026-10-15，实测）

**① 桥接侧会话镜像（浏览器能否完整重画一轮）** —— ✅ 成立

原型做法：桥接订阅事件并归一化成帧（消息块 / 工具块 / 流式增量），经侧信道送出；驱动脚本发一轮**会用到 bash 工具**的对话。

实测帧序列（可完整重画一轮）：

```
send → input → agent.start → turn.start → msg(user, blocks=[text(83)])
     → msg(assistant, update×n, blocks=[thinking… toolCall:bash]) → msg.end(assistant)
     → tool.start(bash, args={"command":"echo MIRROR-TEST-123"})
     → tool.end(bash, result 含 MIRROR-TEST-123, isError=false, durationMs=9) → msg(toolResult)
     → turn.end → turn.start → msg(assistant, update×n, text) → msg.end → turn.end → agent.end
```

判定：用户消息 ✓ 助手文本 ✓ 工具块 ✓ 工具输出含标记 ✓ 流式增量帧 ✓（5/5）。

关键事实：
- `message_start/update/end` 事件**直接携带完整 `AgentMessage`**，`tool_execution_*` 携带 args / partialResult / result / isError / durationMs
  → 镜像**不需要猜测或重建**，序列化即可（`types.ts:1058-1122`）；
- **首屏历史**可由桥接直接读取：`ctx.sessionManager.getEntries()` 实测返回 `array(10)`（另有 `getTree()` → `array(1)`）
  → 新开浏览器标签页也能重画既有会话，无需 RPC 的 `get_entries`。

**② pty 开销与关停** —— ✅ 开销可忽略；关停须走信号

| 项 | 实测 |
|---|---|
| 空闲 5s | pty 输出 **0 字节**（TUI 无变化不重绘）、pi CPU **≈0%** |
| 一轮对话（4–7s） | pty 输出 **5.3–7.2 KB/s**、pi CPU **12.8%（单核）**（含模型流式本身的开销） |
| Ctrl+C 写入 pty（空闲） | **不退出**（raw 模式下是应用按键：单次＝中断/清行；间隔 2s 按两次也未退出） |
| `SIGTERM` → pi | **0.6s 退出**，但**不触发 `session_shutdown`** |
| `SIGTERM` → `script` 包装进程 | pi **随之退出**（不留孤儿），同样无 `session_shutdown` |

实现要点（写入 §18.5 时应吸收）：
1. 引擎收尾**用信号**（SIGTERM 到包装进程或 pi），不要指望 Ctrl+C 或 `session_shutdown`；
2. pi 会**改写自身 argv/comm**（`comm=pi`、cmdline 仅 `pi`）→ 识别子进程要靠**进程树 / 记录 PID / 环境标记**；
3. 镜像 + 历史读取的 API 面已足够，无需任何 Pi 侧改动。

## 19. Web UI 还原目标（TUI 对照，2026-10-15 归档）

> 本节原为 `AGENTS.md` §8；AGENTS 瘦身为"只放规则"后移到这里留档。
> 实现见 `static/{index.html,style.css,app.js}`；早期 MVP 交互描述见 §6.6（该节属已移除的 Python 方案，仅作历史对照）。

从上到下布局（目标是与 TUI fullscreen 的消息流同等效果）：

```text
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

现网实现补充：header 保持简洁（session 名与模型由 footer 展示）；点击 footer 的 model / thinking 打开对应选择面板；
footer 的模型列表受 scoped models 影响（自 §15.11.1 起勾选即时生效，无需重启）。

### 18.10 决策记录（2026-10-15）：暂不实施，研究存档

**决策（用户拍板）**：**保持 RPC + 桥接为唯一引擎（即 1.1.0 现状）**；「TUI + pty + 桥接」记为
**候选路线**，在今后合适的时机实施。本节把该路线的研究结论、实施准备与重新评估的触发条件存档。

#### 18.10.1 决策依据（含事实更正）

| 事实 | 结论 |
|---|---|
| **pi-vscode 是第三方集成，不是 Pi 作者的作品**（作者 Pooya Parsa / pi0，30/32 提交；`publisher: "pi0"`；Pi 作者是 Mario Zechner，3857 提交） | 不能用"pi-vscode 是作者路线"论证 TUI 路线更贴近上游演化 |
| 上游 `docs/cli-integration.md`：**"TUI-only extension capabilities are unavailable or degraded outside interactive mode"** | **支持**「要能力面最全就必须留在 interactive 模式」——这是 TUI 路线最有力的依据 |
| 同一文档：RPC = *"A process needs bidirectional control"*，并推荐 `RpcClient`、提供 RPC Extension UI 子协议与示例 | RPC **不是**将被淘汰的旧路，而是上游文档化的一等集成模式 |
| pi-vscode 实际做法：在 VS Code 终端里**显示真 TUI**，桥接只做 IDE 工具（不解析终端、不镜像会话、不用 pty） | 我们设想的「headless 跑 TUI + 镜像到浏览器」是**上游没有的形态**（自创），其可靠性由扩展 API（文档化 ✓）与共享对象技巧（§16）共同承担 |
| 两条路线的 UI 工作量相同：内置选择器（`/model`、`/scoped-models`）由 `InteractiveMode` 硬编码，TUI 模式下渲染进 pty，浏览器看不到（原型实测） | 切换**不**省 UI 实现；前端现有面板仍要保留 |

**综合**：RPC 现状稳定（1.1.0 已发布、缺口只剩 2 项且可在 RPC 内关闭，见 §18.10.2）；
TUI 路线的收益是"能力面最全 + 不再追 RPC 缺口"，代价是 1200–1800 行重写 + 自创形态风险 + pty 依赖。
用户选择**先保持 RPC，把该路线存档待时机**。

#### 18.10.2 顺带发现：两个剩余缺口可在 RPC 路线内关闭（未实施，记为待办）

| 缺口（§17.5） | 关闭方法 | 量级 |
|---|---|---|
| `.jsonl` 导出降级 | Pi 的 TUI 导出链路是 `exportToJsonl → exportSessionToJsonl(sessionManager, path) → writeFileSync(path, serializeSessionBranch(...))`（`core/session-export.ts:32-44`），两个函数**未从包根导出**；但数据源我们已有：RPC 服务器在用 `get_entries`（`native/server.mjs:432/457`），桥接侧有 `ctx.sessionManager.getEntries()`（实测 `array(10)`）→ 自行序列化为 JSONL 即可 | ~15–20 行（保真度差异：分支选择/尾部补充条目可能与 TUI 导出略有出入，需注明） |
| 自定义 session 目录 | Pi 支持 `settings.sessionDir`（`core/settings-manager.ts:689`），我们只扫 `<agentDir>/sessions` → 读该设置并按它扫描 | ~10 行 |

> 用户决定**暂不实施**（保持 RPC 现状）；将来若要清零缺口，按上表做即可，无需切换引擎。

#### 18.10.3 将来实施时的资产与已知要点

- **原型脚本（9 个，已归档）**：`tools/tui-proto/`（含 README 与 9 条实测结论）；
- **实测数据**：起得来 / 送得进 / 命令通（§18.8）；会话镜像可重画（§18.9 ①）；空闲 0 B/s、对话 5–7 KB/s、CPU 12.8% 单核（§18.9 ②）；
- **实现要点（均已实测，务必吸收）**：
  1. pty 用 `script -q -c … /dev/null`（零依赖；Windows 需另方案）；
  2. 收尾**用信号**（SIGTERM 到包装进程或 pi 均可，不留孤儿），**不要**指望 Ctrl+C（raw 模式下是应用按键）或 `session_shutdown`（不会触发）；
  3. pi 会**改写自身 argv/comm**（`comm=pi`）→ 识别子进程要靠进程树 / 记录 PID / 环境标记；
  4. 命令两条路：扩展命令走 `sendUserMessage(cmd, {expandPromptTemplates:true})`；内置命令走 **pty 敲键**（须空闲时注入）；
  5. `pi.on("input")` 只对"提交的文本"触发，命令派发不触发；
  6. 桥接要长大（镜像 + 历史 + 输入 + 命令路由；生产版估 300–450 行），服务端协议层大部分重写，**前端与侧信道可原样复用**；
  7. 宿主契约需新增探针项：事件面齐全、`sendUserMessage` 存在、`sessionManager.getEntries` 可用、pty 可启动。

#### 18.10.4 重新评估的触发条件（满足任一即值得重启本议题）

1. 再遇到 **TUI-only 能力被降级**、且无法在 RPC 侧绕开（scoped models 属已绕开，见 §15.11.1）；
2. Pi 上游发布**只存在于 interactive 模式**的能力/语义，且用户需要它；
3. "追 RPC 缺口"的长期维护成本开始显著（例如连续多个版本都要补 TUI 独有语义）；
4. 需要把**主会话**与 Pi 的 TUI 完全对齐（例如要求浏览器与终端看到同一份实时状态）。

**当前状态：RPC 路线为唯一引擎（1.1.0），本节路线暂缓、研究已存档。**

## 20. 长会话加载优化（尾部优先 + 按需加载更早 + CSS 容器隔离，2026-10-15）

### 20.1 问题与实测诊断

用户反馈：会话很长时，打开页面要等很久（"整个 session 内容都会被 load 出来"）。以本机最大的
**39.7 MB / 15,662 条**会话（`mv-main` 副本）实测，把耗时拆成三段：

| 阶段 | 实测 | 结论 |
|---|---|---|
| ① 引擎就绪（pi 载入会话 + RPC 起来） | **0.6s** | **pi 侧不是瓶颈**，无需也不应改 Pi |
| ② `history` 帧（`get_entries` → JSON → WS） | **14.7s / 39.7 MB / 15,662 条** | 全量传输是瓶颈之一 |
| ③ 浏览器渲染全部条目 | **26.4s**，转录 15,346 节点、全页 **244,363 节点** | **DOM 爆炸是最大头** |
| 合计 | **~42s** | 全部在我们这侧 |

文件体积构成：15,273 条 `message`（**文本 12.3 MB + thinking 9.4 MB**，工具结果≈0）、
`model_change` 173 条、`compaction` 32 条等。

### 20.2 关键约束（决定了实现方式）

- **`get_entries` 的 `since` 是向前游标**：文档原文 *"pass the last entry id you have seen as `since` to get
  only entries strictly after it"* —— 它用于**增量补齐**，**不能往回翻页**；`since` 不匹配任何 id 时直接失败。
- 因此分页必须由**我们自己读会话文件**实现：文件是 append-only 的条目流（第 1 行是 session header），
  自建**行偏移索引**即可 O(1) 取任意页，并且**顺带把 Pi 从热路径摘出去**（不再让它把整份历史序列化成 JSON）。
- 等价性：`get_entries` = 文件全部条目（都不含 header，都包含被放弃的分支），故两者条目集合一致；
  文件末尾条目即当前 `leafId`。

### 20.3 设计

**服务端**（`native/session-history.mjs` 新模块 + `native/server.mjs`）：

1. **行偏移索引**：读一次会话文件，记录每个条目的起始字节偏移（跳过 header 与空行）；索引可增量扩展
   （文件只会 append）；若文件变小（Pi 重写）则重建。15k 条索引仅 15k 个数字，内存可忽略；
   建索引只扫字节、**不做 JSON.parse**（40 MB 实测 ~0.2s）。
2. **`history` 帧只发尾部**：默认最近 `PI_WEB_HISTORY_TAIL`（300）条，携带
   `{entries, from, total, hasMore, leafId}`；解析只针对这一页。
3. **新增 `history_page` 消息**：`{before, limit}` → 返回 `{entries, from, hasMore}`（同样只解析该页）。
4. **`/session` 的 `Entries:` 计数**改用索引长度（原先为统计条目数额外调了一次全量 `get_entries`，
   大会话下同样是十几秒的浪费）。

**前端**（`static/app.js` + `static/style.css`）：

5. `renderHistory` 渲染尾部条目；若 `hasMore` 在 `#content` 顶部插入"**↑ 还有 N 条更早的记录 · 点击加载**"。
6. 点击加载 → 请求上一页 → **prepend 并保持滚动位置**（记录 prepend 前后的 `scrollHeight` 差值补偿
   `scrollTop`），更新计数与 `hasMore`；按条目 id 去重（防与实时帧重复）。
7. **CSS 容器隔离**（方案 D）：`.message` / `.tool-block` 加
   `content-visibility: auto; contain-intrinsic-size: auto 240px;` —— 离屏条目跳过布局/绘制，降低内存与滚动成本。
   （注意：它**不**减少 JS 构建 DOM 的耗时，因此必须与 5/6 一起用。）

### 20.4 边界与风险

| 风险 | 处理 |
|---|---|
| 文件被 Pi 重写导致偏移失效 | 每次取页前检查大小：变大则增量扩展索引，变小则整份重建 |
| 分页与实时事件重复 | 实时帧只针对当前运行；历史页只覆盖连接前的旧条目；仍按 id 去重兜底 |
| prepend 导致视口跳动 | 滚动锚定补偿（见 6） |
| 保真度 | **不裁剪内容**（thinking/长文本原样保留，仅延迟加载）——保真优先，故未采纳"传输裁剪"方案 |
| 旧客户端兼容 | 前端与服务端同版本发布；`history` 帧仍是 `{entries, ...}` 形状，旧字段不删 |

### 20.5 验证计划

1. 大会话（39.7 MB 副本）首屏：引擎就绪 + history + 渲染 **< 2s**（对照 42s）；
2. 逐页加载到顶后：条目总数 = 索引总数、无重复、顺序正确；
3. 小会话行为不变（冒烟 42/42）；
4. 实时流式消息仍正常追加（不因分页错位）；
5. 与 `get_entries` 做一次性等价核对（条目数/id 集合一致）。
### 20.6 实施与验证结果（2026-10-15）

**实测（39.7 MB / 15,662 条会话副本，连接 → 首屏）**：

| 阶段 | 优化前 | 优化后 |
|---|---|---|
| 引擎就绪 | 0.6s | 0.6s |
| `history` 帧 | 14.7s / 39.7 MB / 15,662 条 | **1.9s / 0.8 MB / 300 条** |
| 浏览器渲染 | 26.4s / 244,363 节点 | **1.0s / 4,607 节点**（转录 297） |
| 合计 | **~42s** | **~3.5s** |

- **分页正确性**：16 页 + 首屏拼接后 = 15,662 条 = 索引总数 = 文件条目数；**0 重复**；顺序与文件完全一致；
- **浏览器交互**：点击「↑ 还有 N 条更早的记录 · 点击加载」→ 顶层节点 296 → 592，`scrollTop` 锚定补偿生效，
  控件计数与 `hasMore` 正确更新；
- **小会话**（50 条副本）：`hasMore=false`、不显示控件，行为不变；
- **`/session`**：**0.15s / 0.04s**（第 1/2 次）——旧实现每次都要先跑一遍全量 `get_entries`（本会话约 14.7s）；
- 冒烟 42/42；`content-visibility` 容器隔离已加（离屏条目跳过布局/绘制）。

**实施中踩到的两个坑（记录）**：

1. `server.mjs` 使用了 `statSync` 但**未导入** → `ensureHistoryIndex()` 抛错 → **静默退化**到全量 `get_entries` ✗。
   教训：**退化路径会掩盖 bug**，所以必须同时量"第二条连接"——首条连接走索引路径（看起来已优化 ✓），
   第二条才暴露问题（实测第二次连接收到 `history(15662/15662)` ✗）。诊断靠"抓浏览器实际收到的帧"，而不是只看服务端日志。
2. 端口未清干净时新实例 `EADDRINUSE` 直接退出，测试脚本却连到旧实例 → 现象是"改了没生效"（老问题，见 AGENTS §7）。
