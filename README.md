# pi-web

给 [Pi](https://github.com/earendil-works/pi)（AI coding agent）提供浏览器 Web 访问方式，解决 SSH + TUI 场景下的终端渲染不稳定问题。

**不改 Pi 本体**，所有控制逻辑集中在 `pii` 脚本和 Web 服务中。

## 特性

- 通过浏览器访问 Pi，获得与 TUI 接近的使用体验
- 完整还原 TUI 风格：
  - Markdown 渲染（用户/助手消息）
  - 工具执行块（bash 样式、输出预览、耗时、截断警告）
  - Status 指示器（working / retry / compaction / branch summary）
  - Pending Messages（steering / follow-up 队列）
  - 特殊消息（branch / compaction / custom）
  - Header + Loaded Resources（右侧栏）
  - Footer（pwd / git branch / token / context / model / thinking）
- 支持操作：
  - 发送消息（prompt）
  - 中止（abort）
  - 模型切换（点击 footer 或 `/model`）
  - Thinking 切换（点击 footer 或 `/thinking`）
  - 直接执行 bash（`!command`）
  - 斜杠命令菜单（`/`）
- 事件驱动刷新，与 TUI 行为一致

## 架构

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

## 安装

### 1. 获取项目

```bash
git clone https://github.com/maxdai/pi-web.git
cd pi-web
```

### 2. 安装 pii（可选，全局使用）

```bash
# 复制到全局路径（原文件会备份）
cp /usr/local/bin/pii /usr/local/bin/pii.bak 2>/dev/null || true
cp pii/pii /usr/local/bin/pii
chmod +x /usr/local/bin/pii
```

> 也可以不安装，直接用 `python3 pii/pii ...` 运行。

### 3. 项目路径解析

pii 按以下优先级定位 Web 服务路径：

1. 环境变量 `PI_WEB_DIR`
2. 项目内运行时自动推导
3. 全局安装时 fallback 到 `~/pi-web`

如果项目不在 `~/pi-web`，可以通过 `PI_WEB_DIR` 指定：

```bash
PI_WEB_DIR=/path/to/pi-web pii r <name> --web
```

## 使用

### TUI 模式（原有行为，不变）

```bash
pii r <name>
```

### Web 模式

```bash
pii r <name> --web          # 默认端口 4080
pii r <name> --web 12345    # 指定端口
```

启动后终端会显示：

```
server at http://127.0.0.1:4080/
```

用浏览器打开该地址即可。

### 其他命令

```bash
pii list          # 列出所有 session
pii list -l       # 列出 session 文件路径
pii delete <name> # 删除 session
```

## 项目结构

```text
pi-web/
├── AGENTS.md           # AI 代理工作指引
├── pi-web-design.md    # 设计文档
├── README.md
├── pii/
│   └── pii             # pii 启动脚本（含 Web 模式）
├── server/             # Python Web 服务
│   ├── server.py       # HTTP + WebSocket 桥接
│   ├── rpc_client.py   # Pi RPC 客户端
│   └── websocket.py    # 标准库 WebSocket 实现
└── static/             # 浏览器前端
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

- 小的、细碎修改 → 本地 `git commit`
- 相对阶段性的更新 → 推送到 GitHub
- 避免频繁的 GitHub 操作

### 设计文档

详细的架构、协议、UI 设计见 [pi-web-design.md](pi-web-design.md)。

## 技术说明

- **Python 标准库**实现 Web 服务（无第三方 Python 依赖）
- **前端**使用 vanilla JS + marked（本地 vendor，无 CDN）
- **Pi RPC 协议**：JSON line over stdin/stdout（`pi --session <id> --mode rpc`）
- 仅监听 `127.0.0.1`，单用户本机使用，暂不做鉴权
