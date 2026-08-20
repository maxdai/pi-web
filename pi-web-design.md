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
- 提供浏览器与 Pi 之间的实时通道：
  - WebSocket（推荐，双向）
  - 或 SSE（仅服务端到浏览器）+ HTTP POST 输入
- 转播 Pi 的 Agent 事件给浏览器。
- 把浏览器用户输入转成 RPC 命令发送给 Pi。

### 6.3 MVP 页面功能

- 消息列表（user / assistant / 可选 tool 状态）
- 输入框 + 发送按钮
- 加载已有 session 历史
- 连接状态显示（Connected / Disconnected）
- 页面刷新后重连同一个 session

### 6.4 暂不做（后续可加）

- 模型切换
- thinking 详细展示
- compaction 状态
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
- 无 `--web`：保持现有 `pi --session <id>` 行为。
- 有 `--web`：走 Web 分支，启动 Pi RPC 后端 + Python Web 服务，常驻等待信号。

### 9.3 参数解析建议规则

```text
pii r <name> --web [port]
```

- 找到 `--web`。
- 若其后是数字 → 作为端口。
- 否则 → 默认 4080。

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

1. Python Web 服务用标准库还是第三方框架（如 FastAPI / aiohttp）？
   - MVP 可先用标准库 `http.server` + 简单 WebSocket。
2. WebSocket 实现：
   - 手写简单 WebSocket，还是引一个库？
   - MVP 若想最简，也可以用 SSE + POST。
3. `pii` 与 Pi RPC 的事件订阅如何关联请求 ID？
4. 是否需要在 Web 界面显示 tool 调用？
   - MVP 可以先只显示 user / assistant 文本。
5. `pii web` 退出时如何干净地杀掉 Pi RPC 子进程？
   - 建议：先发关闭命令，再 `terminate()`，最后兜底 `kill()`。

## 12. 已确认的设计决策（摘要）

| 项 | 决策 |
|----|------|
| 是否改 Pi | 不改，控制逻辑在 `pii` |
| 启动方式 | 通过 `pii r <name>` 增加 `--web` |
| 默认 UI | TUI（`pii r <name>`） |
| Web 语法 | `pii r <name> --web [port]` |
| 默认端口 | `4080` |
| 绑定地址 | `127.0.0.1` |
| 生命周期 | Web 模式常驻，直到 Ctrl+C / kill |
| Pi 后端 | `pi --session <id> --mode rpc` |
| Web 服务 | Python 实现 |
| 浏览器断线 | 不影响 Pi，可重连 |
| 端口占用/非法 | 报错退出 |

## 13. 下一步建议

按顺序细化：

1. RPC 模式下 Pi 与 `pii` 的具体 JSON line 协议。
2. Web 服务事件转播设计（WebSocket vs SSE）。
3. 浏览器页面历史加载与增量事件去重。
4. `pii` 的进程生命周期/信号处理细节。
