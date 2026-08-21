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

> 本节是 2025-08 的讨论结论，记录为**备选方案**，尚未决定实施。当前已实现并运行的仍是 RPC 桥接方案（§6）。
>
> **方案演进**：本节初稿记录的是「Pi 内置 WebMode」（改 Pi 源码）。后续调研发现 Pi 以**公开 npm 包 + SDK**形式发布，因此主推方案调整为「**独立 pi-web npm 包（SDK 客户端）**」——不改 Pi 本体，安装 pi-web 后接管 TUI 场景的职责。「改 Pi 内置 WebMode」降为次选（见 §14.5）。

### 14.1 动机

当前 RPC 桥接方案的根因限制（见 §6.16）：Pi RPC 模式对「工厂函数 / 自定义组件」类 UI 不支持，导致 `custom()`、`setWidget(factory)` 等扩展 UI 无法在 Web 端呈现。这些限制的根源是 **JSON line 序列化边界**——事件和 UI 请求必须可序列化，且 RPC 模式刻意移除了 TUI 相关的 UI 能力。

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
| 扩展 UI 完整性 | 受 RPC 序列化限制（§6.16） | 完整（Web UI context） |
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

- **模块结构**：`pi-sdk-web/src/`（`cli.ts` 命令入口、`session.ts` 查找、`server.ts` HTTP+WS 桥接、`ui-context.ts` WebUIContext）+ `verify-sdk.ts` 验证脚本。
- **WebSocket 协议**：与现有 Python 桥接（server.py）**完全一致**——连接时发 `state`+`history`，Pi 事件原样广播，客户端消息 `prompt/abort/bash/set_model/...`，前端 `static/` 零修改复用。
- **扩展 UI**：`WebUIContext` 实现 `ExtensionUIContext`，select/confirm/input/editor 通过 `extension_ui_response` 由浏览器 resolve；notify/setStatus/setTitle/setWidget 直接广播；theme 用 identity Proxy（扩展调用 `ui.theme.fg` 等颜色函数不崩溃，颜色由浏览器 CSS 承担）。`bindExtensions` 的 mode 用 `"rpc"`（ExtensionMode 无 web 值；rpc = dialog 可用、非终端 UI）。
- **扩展命令执行**（`/ctx-status` 等，新增决策）：前端 `/cmd` 输入发送 `command` 消息 → 服务端 `extensionRunner.getCommand(name)` 取 `RegisteredCommand.handler`（公开字段）→ 调用时构造 `ExtensionCommandContext` 并传 **`hasUI: false`** → 扩展走文本 fallback（magic-context 的 ctx-status 用 `pi.appendEntry` 写 session custom entry）→ `entry_appended` 事件回传。**根因**：Pi 的 `ExtensionRunner.hasUI()` 实现是 `uiContext !== noOpUIContext`，提供任何 uiContext 即 hasUI=true（§6.16 的"误判"）；命令上下文是自构造对象，其 `hasUI` 是普通字段可覆盖。
- **命令输出弹窗**（新增决策，对齐 TUI）：服务端执行命令时订阅捕获期间产生的 custom entry，转为 `extension_ui_request`（method `notify`，title `/<命令名>`，message 为 Markdown 文本）弹窗广播；前端 notify 弹窗以 Markdown 渲染（sanitize 白名单复用）。session 历史中的 custom 块保留（默认收起，可回看）。
- **已知限制**：扩展命令的新会话操作（newSession/fork/switchSession 等）在命令上下文中返回 `{cancelled:true}` 占位；trust 流程简化（默认信任）；theme 切换不支持；`session.dispose` 退出清理。
- **验证记录**：`npm run verify` 全链路通过（createAgentSession → bindExtensions → subscribe → prompt → 事件流）；`pi-web list`/`r` 正常；`/ctx-status` 弹窗实测成功。
