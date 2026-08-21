# pi-web

给 [Pi](https://github.com/earendil-works/pi)（AI coding agent）提供浏览器 Web 访问方式，解决 SSH + TUI 场景下的终端渲染不稳定问题。

**不改 Pi 本体**。提供两种可选的 Web 接入方案：

| 方案 | 入口 | 方式 | 状态 |
|------|------|------|------|
| RPC 桥接 | `pii r <name> --web` | Python 服务 + Pi RPC 子进程（JSON line 协议） | 稳定，保留 |
| SDK 客户端 | `pi-web r <name>` | TypeScript 包（pi-sdk-web），用 Pi 公开 SDK 直连 AgentSession | 推荐，功能更全 |

## 特性

- 通过浏览器访问 Pi，获得与 TUI 接近的使用体验
- 完整还原 TUI 风格：
  - Markdown 渲染（用户/助手消息）
  - 工具执行块（bash 样式、输出预览、耗时、截断警告）
  - Status 指示器（working / retry / compaction / branch summary）
  - Pending Messages（steering / follow-up 队列）
  - 特殊消息（branch / compaction / custom）
  - Header + Loaded Resources（右侧栏：Skills / Prompts / Extensions）
  - Footer（pwd / git branch / token / context / model / thinking）
- 支持操作：
  - 发送消息（prompt）、中止（abort）
  - 模型切换（点击 footer、`>>` 循环切换或 `/model`）
  - Thinking 切换（点击 footer 或 `/thinking`）
  - 直接执行 bash（`!command`）
  - 斜杠命令菜单（`/`，支持键盘导航）
  - 扩展命令执行与弹窗（如 `/ctx-status`）
- 事件驱动刷新，与 TUI 行为一致

## 架构

### 方案 1：RPC 桥接（pii）

```text
浏览器
  |  HTTP / WebSocket
  v
Python Web 服务（127.0.0.1:<port>）
  |  JSON line 协议（stdin/stdout）
  v
Pi 后端（pi --session <id> --mode rpc）
  |  AgentSession / Agent 事件
  v
LLM / Provider
```

### 方案 2：SDK 客户端（pi-web / pi-sdk-web，推荐）

```text
浏览器
  |  HTTP / WebSocket
  v
pi-sdk-web（TypeScript，单进程）
  |  公开 SDK（@earendil-works/pi-coding-agent）
  v
AgentSession（进程内）
  |  Agent / 工具 / 扩展
  v
LLM / Provider
```

SDK 方案直接持有 AgentSession：无 JSON line 序列化边界、扩展 UI 完整（`/ctx-status` 弹窗、`setWidget` 常驻面板等）、内置命令更全（`/reload` `/scoped-models` `/export`），且 **Pi 本体零修改**（纯依赖公开 npm 包）。

## 前置条件

1. **Node.js ≥ 20 + npm**（SDK 方案需要；RPC 方案仅需 Python 3）
2. **Pi 已安装并配置完成**：`~/.pi/agent/` 下需有认证（`auth.json`）、模型库、设置及 session 文件。两个方案都依赖 Pi 的模型/认证/会话配置。

## 安装

### 1. 获取项目

```bash
git clone https://github.com/maxdai/pi-web.git
cd pi-web
```

### 2. 安装 pii（RPC 方案，可选）

```bash
# 复制到全局路径（原文件会备份）
cp /usr/local/bin/pii /usr/local/bin/pii.bak 2>/dev/null || true
cp pii/pii /usr/local/bin/pii
chmod +x /usr/local/bin/pii
```

> 也可以不安装，直接用 `python3 pii/pii ...` 运行。

pii 的项目路径解析优先级：环境变量 `PI_WEB_DIR` → 项目内推导 → `~/pi-web` fallback。

### 3. 安装 pi-web（SDK 方案，推荐）

```bash
cd pi-sdk-web
npm install        # 安装依赖（SDK + ws）
npm run build      # 编译 TypeScript + 复制前端 static 进包
npm install -g .   # 全局安装 pi-web 命令
pi-web list        # 验证
```

> 未发布到 npm registry，因此从仓库源码安装。更新时重新执行 `npm run build && npm install -g .`。
> 开发期也可以不安装：`cd pi-sdk-web && npx tsx src/cli.ts r <name>`（源码改动即时生效）。

## 使用

### 方案 1：pii（RPC 桥接）

```bash
pii r <name>                # TUI 模式（原有行为，不变）
pii r <name> --web          # Web 模式，默认端口 4080
pii r <name> --web 12345    # Web 模式，指定端口
```

### 方案 2：pi-web（SDK 客户端）

```bash
pi-web r <name> [--port]    # 启动 Web 服务（默认端口 4080）
pi-web list                 # 列出所有 session
```

> 从你自己的终端启动（继承 shell 环境变量，如 `DEEPSEEK_API_KEY`，否则对应 provider 的模型不可用）。

### 启动后

终端显示：

```
server at http://127.0.0.1:4080/
```

用浏览器打开该地址即可。

### 其他命令（pii）

```bash
pii list          # 列出所有 session
pii list -l       # 列出 session 文件路径
pii delete <name> # 删除 session
```

## 项目结构

```text
pi-web/
├── AGENTS.md           # AI 代理工作指引
├── pi-web-design.md    # 设计文档（含 §14 pi-sdk-web 方案）
├── README.md
├── pii/
│   └── pii             # pii 启动脚本（RPC 方案）
├── server/             # Python Web 服务（RPC 方案）
│   ├── server.py       # HTTP + WebSocket 桥接
│   ├── rpc_client.py   # Pi RPC 客户端
│   └── websocket.py    # 标准库 WebSocket 实现
├── pi-sdk-web/         # SDK 客户端模块（npm 包 pi-sdk-web，bin 命令 pi-web）
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── cli.ts          # pi-web 命令入口（r/list）
│       ├── session.ts      # session 查找 + 内置扩展加载
│       ├── server.ts       # HTTP + WebSocket 桥接（AgentSession 直连）
│       ├── ui-context.ts   # WebUIContext（扩展 UI 映射浏览器）
│       └── verify-sdk.ts   # SDK 链路验证脚本（npm run verify）
└── static/             # 浏览器前端（两方案共用）
    ├── index.html
    ├── style.css
    ├── app.js
    └── vendor/         # 本地第三方库（marked）
```

## 开发

### 三阶段流程

1. **讨论**：确定设计或修改方案（此阶段不改代码）
2. **生成/更新设计文件**：把结论写入 `pi-web-design.md`
3. **开发/修改**：根据讨论结果和设计文件实现

### Git 原则

- 具有不确定性的尝试性修改 → 本地 `git commit`（便于回滚）
- 确定性的修改且无后继操作 → 推送到 GitHub
- 相对阶段性的更新 → 推送到 GitHub
- 避免频繁的 GitHub 操作

### 设计文档

详细的架构、协议、UI 设计见 [pi-web-design.md](pi-web-design.md)。

## 技术说明

- **RPC 方案**：Python 标准库实现 Web 服务（无第三方 Python 依赖），Pi RPC 协议 JSON line over stdin/stdout
- **SDK 方案**：TypeScript + 公开 SDK（`@earendil-works/pi-coding-agent`），Node 内置 http + `ws` 包，单进程
- **前端**：vanilla JS + marked（本地 vendor，无 CDN），两方案共用同一份前端
- 仅监听 `127.0.0.1`，单用户本机使用，暂不做鉴权
