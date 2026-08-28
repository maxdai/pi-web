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
  - 主题切换（Dark / Light，与 TUI 命名一致；扩展 ANSI 颜色同步）
- 支持操作：
  - 发送消息（prompt）、中止（abort）
  - 模型切换（点击 footer、`>>` 循环切换或 `/model`）
  - Thinking 切换（点击 footer 或 `/thinking`）
  - 直接执行 bash（`!command`；`!!command` 排除上下文不发给 LLM）
  - 斜杠命令菜单（`/`，支持键盘导航）
  - 扩展命令执行与弹窗（如 `/ctx-status`）
  - 右侧栏 Tools 框（当前暴露给 LLM 的工具；SDK 方案）
  - `/resume` 会话切换
- 事件驱动刷新，与 TUI 行为一致
- 扩展输出渲染 ANSI 颜色（状态栏 / widget / 通知 / 工具输出）

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

1. **Node.js ≥ 20 + npm**（SDK 方案及 pii 的 npm 启动器需要）
2. **Python 3**（RPC 方案需要——pii 的内嵌 Python 桥）
3. **Pi 已安装并配置完成**：`~/.pi/agent/` 下需有认证（`auth.json`）、模型库、设置及 session 文件。两个方案都依赖 Pi 的模型/认证/会话配置。

## 安装

### 1. 获取项目

```bash
git clone https://github.com/maxdai/pi-web.git
cd pi-web
```

### 2. 安装 pii（RPC 方案，可选）

`pii` 已随 npm 包分发：安装 `pi-sdk-web` 后 `pii` 命令立即可用（无需单独复制脚本）。

```bash
npm install -g pi-sdk-web    # 同时提供 pi-web 和 pii 命令
pii list                     # 验证
```

> pii 的 Node 启动器会调用本机 `python3` 运行内嵌的 Python 桥（RPC 方案），需要机器装有 Python 3。
> 从仓库源码运行（开发）：`python3 pii/pii ...`（不依赖 npm 包装器）。

### 3. 安装 pi-web（SDK 方案，推荐）

**已发布到 npm registry**，直接安装（同时提供 `pi-web` 和 `pii` 命令）：

```bash
npm install -g pi-sdk-web    # 全局安装 pi-web / pii 命令
pi-web list                  # 验证
pii list                     # 验证（需 Python 3）
```

升级：`npm update -g pi-sdk-web`。

> 从仓库源码安装/开发（在另一台设备同步源码时用）：
> ```bash
> cd pi-sdk-web && npm install && npm run build && npm install -g .
> ```
> 开发期也可以不安装：`cd pi-sdk-web && npx tsx src/cli.ts r <name>`（源码改动即时生效）。

## 发布新版本（维护者）

pi-sdk-web 已发布到 npm（`pi-sdk-web`，作者 maxdai）。发布新版本流程：

```bash
# 1. 修改代码后，在仓库根提升版本
#    （pi-sdk-web 子目录执行 npm version 只改 package.json，不会自动 git commit）
npm version patch                          # 或 minor / major（改 pi-sdk-web/package.json）

# 2. 提交 + 打 tag
git add pi-sdk-web/package.json pi-sdk-web/package-lock.json
git commit -m "Release pi-sdk-web x.y.z"
git tag vX.Y.Z

# 3. 发布（prepublishOnly 自动构建；自动化 token 无需交互式认证）
cd pi-sdk-web && npm publish

# 4. 推送 git（含 tag）
cd .. && git push --follow-tags
```

> 认证：本机 `~/.npmrc` 配置 npm 的 **Automation/Granular token**（npmjs.com → Access Tokens 创建）后发布零交互；用户升级命令：`npm update -g pi-sdk-web`。

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

## SSH 隧道远程访问

pi-web / pii 的 Web 服务只监听 **服务端本机的 `127.0.0.1`**（不暴露公网）。在另一台设备（如本地电脑）的浏览器访问时，用 SSH 隧道把服务端口安全转发到本地的 `127.0.0.1`：

1. **在 Pi 服务器上启动服务**（保持运行）：

   ```bash
   pi-web r <name> --port 4080        # 或 pii r <name> --web
   ```

2. **在本地电脑建立 SSH 隧道**：

   ```bash
   ssh -L 4080:127.0.0.1:4080 <user>@<pi-server>
   ```

3. **本地浏览器访问**：http://127.0.0.1:4080/

说明：

- `-L <本地端口>:127.0.0.1:<远端端口>`：把远端服务器上的 `127.0.0.1` 端口转发到本地 `127.0.0.1` 端口；本地端口可与远端不同（如 `-L 8080:127.0.0.1:4080` 时访问 http://127.0.0.1:8080/）
- 整个链路（HTTP + WebSocket）都经过加密的 SSH 隧道；服务端始终只监听 `127.0.0.1`，不会暴露公网，安全性有保障
- 隧道随 ssh 会话存续（该终端保持运行）；可加 `-N` 仅转发不执行远程命令，配合 `-f` 后台运行（如 `ssh -f -N -L 4080:127.0.0.1:4080 <user>@<pi-server>`）
- Windows 10+ 自带 OpenSSH 客户端，同样可用

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
├── pi-sdk-web/         # SDK 客户端模块（npm 包 pi-sdk-web，bin 命令 pi-web 和 pii）
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── cli.ts          # pi-web 命令入口（r/list）
│       ├── pii-cli.ts      # pii 命令的 Node 启动器（spawn 内嵌 Python 桥）
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

> 打包：`npm run build` 把 pii 启动器 + Python 桥（`pii/pii`、`server/*.py`）复制进 `dist/pi-bin/`，随 npm 包分发（`files: ["dist"]`），安装后 `pii` / `pi-web` 命令均可用。

## 技术说明

- **RPC 方案**：Python 标准库实现 Web 服务（无第三方 Python 依赖），Pi RPC 协议 JSON line over stdin/stdout
- **SDK 方案**：TypeScript + 公开 SDK（`@earendil-works/pi-coding-agent`），Node 内置 http + `ws` 包，单进程
- **前端**：vanilla JS + marked（本地 vendor，无 CDN），两方案共用同一份前端
- 仅监听 `127.0.0.1`，单用户本机使用，暂不做鉴权
