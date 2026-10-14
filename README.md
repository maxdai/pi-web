# pi-web

给 [Pi](https://github.com/earendil-works/pi)（AI coding agent）提供浏览器 Web 访问方式，解决 SSH + TUI 场景下的终端渲染不稳定问题。

**不改 Pi 本体**。唯一引擎是「原生 pi 的 RPC 模式 + 注入桥接扩展」：
`pi --mode rpc` 提供命令与全部会话事件，桥接扩展在 pi 进程内接管 RPC 模式丢掉的 UI 方法层
（`custom()` 面板、工厂 widget、对话框、换肤）。

| 入口 | 说明 |
|------|------|
| `pii r <name> --web [port]` | 启动 Web 服务（默认 4080）；`pii r <name>` 仍是 TUI |
| `pi-web r <name> [--port <port>]` | 等价入口（薄壳，保留原命令习惯）；另有 `pi-web list` / `pi-web help` |
| `pi-web-native <session-id> [cwd] --port <n>` | 引擎本体（由上面两个命令调用；也支持 `--session <名字>`） |

> 历史：早期是 Python RPC 服务，其后引入 SDK 宿主（`pi-sdk-web`，直接持有 `AgentSession`），
> 因 SDK 的**版本漂移**问题，2026-10 按 pi-web-design.md §15/§17 迁移到当前引擎；
> 阶段 E（§15.13）已移除 SDK 宿主与 Python RPC 服务，依赖只剩 `ws`。

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
  - 右侧栏 Tools 框（当前暴露给 LLM 的工具）
  - `/resume` 会话切换
- 事件驱动刷新，与 TUI 行为一致
- 扩展输出渲染 ANSI 颜色（状态栏 / widget / 通知 / 工具输出）

## 架构

## 架构

```text
浏览器
  |  HTTP / WebSocket（复用 static/ 前端与既有 WS 协议）
  v
pi-web-native（Node，单进程：静态服务 + WS 协议 + RPC 客户端 + 侧信道）
  |  JSON line 协议（stdin/stdout）+ 本机 HTTP 侧信道
  v
pi 子进程（pi --session <id> --mode rpc --extension bridge.mjs）
  |  AgentSession / Agent 事件 / 桥接扩展接管的 UI 方法
  v
LLM / Provider
```

桥接扩展在 pi 进程内改写 `ctx.ui`（runner 的**共享可变对象**，实测跨扩展可见），
因此 RPC 模式原本丢掉的 `custom()` 面板、工厂 widget、对话框、`setTheme` 都能在 Web 端呈现；
RPC 拿不到的会话信息（cwd / scopedModels / commands / tools / extensions）由侧信道上报。
宿主依赖清单与"Pi 升级后如何自检"见 pi-web-design.md §16 与 `tools/host-contract/`。

## 前置条件

1. **Node.js ≥ 20 + npm**（引擎与 pii 的 npm 包装器需要）
2. **Python 3**（`pii` 启动器需要：会话名解析 / TUI 入口）
3. **Pi 已安装并配置完成**：`~/.pi/agent/` 下需有认证（`auth.json`）、模型库、设置及 session 文件。两个方案都依赖 Pi 的模型/认证/会话配置。

## 安装

### 1. 获取项目

```bash
git clone https://github.com/maxdai/pi-web.git
cd pi-web
```

### 安装

**已发布到 npm**（作用域包 `@maxdai/pi-web`：`pi-web` 这个名字在 npm 上已被他人占用）：

```bash
npm install -g @maxdai/pi-web    # 同时提供 pi-web / pii / pi-web-native 命令
pi-web list                      # 验证
pii list                         # 验证（需 Python 3）
```

升级：`npm update -g @maxdai/pi-web`。

**从旧版（`pi-sdk-web`）迁移**（1.0.0 起包名变更 + 引擎切换）：

```bash
npm uninstall -g pi-sdk-web          # 先卸载旧包，避免同名 bin 冲突
npm install -g @maxdai/pi-web        # 三个 bin（pi-web / pii / pi-web-native）随之更新
```

> ⚠️ 旧包的 `package.json` 可能被你的配置以**软链**形式引用（常见于 `~/.pi/agent/prompts/` 下的
> prompt 文件软链指向旧包的 `node_modules/...`）。卸载旧包会让这些软链**悬空**、Pi 静默少注册对应
> 命令。升级后请检查并改为实体文件：
> ```bash
> find ~/.pi/agent -xtype l 2>/dev/null          # 列出悬空软链
> ```
> （2026-10 本机就遇到过 3 个 prompt 软链因此失效。）

> `pii` 的 Node 包装器会调用本机 `python3` 运行随包分发的 Python 启动器（会话名解析 / TUI 入口），
> 需要机器装有 Python 3。
> 从仓库源码安装/开发：
> ```bash
> cd pi-sdk-web && npm run build && npm install -g .
> ```
> 这样全局命令会**软链到仓库**，之后改 `native/`、`static/` 只需 `npm run build` 即生效（无需发版）。

## 发布新版本（维护者）

已发布到 npm（`@maxdai/pi-web`，作者 maxdai）。发布新版本流程：

```bash
# 0. 发布前两项检查
# 0a. 宿主契约核对（Pi 升级后尤其必须；见 tools/host-contract/README.md）
node tools/host-contract/check-host-contract.mjs
# 0b. 冒烟测试——需先起着服务，见下节
node tools/smoke.mjs

# 1. 修改代码后，在仓库根提升版本
#    （pi-sdk-web 子目录执行 npm version 只改 package.json，不会自动 git commit）
npm version patch                          # 或 minor / major（改 pi-sdk-web/package.json）

# 2. 提交 + 打 tag（必须是**附注 tag**，见下方说明）
git add pi-sdk-web/package.json pi-sdk-web/package-lock.json
git commit -m "Release @maxdai/pi-web x.y.z"
git tag -a vX.Y.Z -m "Release @maxdai/pi-web x.y.z"

# 3. 发布（prepublishOnly 自动构建；自动化 token 无需交互式认证）
cd pi-sdk-web && npm publish

# 4. 推送 git（含 tag）
cd .. && git push --follow-tags

# 5. 更新本机全局安装（用户侧升级：npm update -g @maxdai/pi-web）
npm install -g @maxdai/pi-web@x.y.z
```

> 认证：本机 `~/.npmrc` 配置 npm 的 **Automation/Granular token**（npmjs.org → Access Tokens 创建）后发布零交互；用户升级命令：`npm update -g @maxdai/pi-web`。

> **tag 必须用 `-a`（附注 tag）**：`git push --follow-tags` **只推附注 tag**，轻量 tag（`git tag vX.Y.Z`）不会被推送——2026-10 实测发现 `v0.7.0`~`v0.7.5` 六个 tag 因此都没上远端（后已用 `git push origin --tags` 补推）。若还是漏了，用 `git ls-remote --tags origin` 核对。

## 冒烟测试（维护者）

`tools/smoke.mjs` 对**已在运行的** pi-web 实例做只读回归检查（28 项）：部署一致性、页面加载、WS 协议快照、渲染路径（markdown／代码块折行／widget／ANSI／扩展消息 display 判据）、交互（dialog 倒计时、confirm 回传、滚动门控）。

```bash
pi-web r <session>            # 另开一个终端先起服务（默认 4080）
node tools/smoke.mjs          # 也可：node tools/smoke.mjs http://127.0.0.1:4090
node tools/smoke.mjs --headed # 需要肉眼观察时
```

- **只读**：不发送 prompt／命令，不改动被测会话；测试页面是脚本自开的无头实例，与你的浏览器互不影响。
- **零 token**：全部为确定性 DOM/协议断言，不调用 LLM。
- **不污染视图**：注入的测试节点按 `smoke` 标签精确清理。
- **运行时机**：不要在 `npm install -g pi-web`（重装/替换 dist）的**同时**跑——部署一致性检查会读到替换中的文件而误报（实测踩过一次：3 项瞬时失败，随后连跑两次 37/37 通过）。
- **部署漂移检测**：比对服务端提供的 `app.js`/`style.css` 与仓库源文件哈希——「改了没生效／忘了重启／全局装的是旧版」会直接 FAIL 并打印两侧哈希。
- 退出码：`0` 全部通过，`1` 有失败，`2` 依赖缺失或服务不可达。
- 依赖：`playwright-core`（pi-sdk-web 的 devDependency，`npm install` 即得）与一个 Chromium（自动用 `~/.cache/ms-playwright` 下的缓存，可用 `PI_WEB_CHROMIUM` 覆盖）。


## 使用

### 启动 Web 服务

```bash
pii r <name>                # TUI 模式（原有行为，不变）
pii r <name> --web          # Web 模式，默认端口 4080
pii r <name> --web 12345    # Web 模式，指定端口

pi-web r <name> [--port]    # 等价入口（薄壳，转调同一个引擎）
pi-web list                 # 列出所有 session
```

> 两个入口完全等价（都启动原生引擎）；`pii` 侧重会话名解析与 TUI 习惯，`pi-web` 保留原有命令形态。

> 从你自己的终端启动（继承 shell 环境变量，如 `DEEPSEEK_API_KEY`，否则对应 provider 的模型不可用）。

**堆内存**：大会话加上进程内扩展（本地 embedding、historian、索引）可能超过 Node 默认的堆上限（本机约 2.2GB），导致 `FATAL ERROR: Reached heap limit` 中途崩溃。`pi-web r` 启动时若发现上限不足，会**为引擎子进程指定更大的 `--max-old-space-size`（默认 4096MB）**，并打印生效值（`heap: starting native engine with --max-old-space-size=4096 (current limit 2240MB)`）。

- 自定义目标：`PI_WEB_MAX_OLD_SPACE_MB=8192 pi-web r <name>`；
- 自己指定过 `--max-old-space-size`（argv 或 `NODE_OPTIONS`）时**完全尊重你的设置**，不再自动调整；
- 宿主机内存不足目标的两倍时保持默认，不会强行提升。

### 启动后

终端显示：

```
server at http://127.0.0.1:4080/
heap limit: 4288MB
```

用浏览器打开该地址即可。

### 其他命令（pii）

```bash
pii list          # 列出所有 session
pii list -l       # 列出 session 文件路径
pii delete <name> # 删除 session
```

## SSH 隧道远程访问

pi-web 的 Web 服务只监听 **服务端本机的 `127.0.0.1`**（不暴露公网）。在另一台设备（如本地电脑）的浏览器访问时，用 SSH 隧道把服务端口安全转发到本地的 `127.0.0.1`：

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

### 长期持续运行（systemd service，可选）

如果需要隧道**长期保持**（不依赖某个终端窗口），可以在本地电脑配置一个 systemd 用户服务。把下面的内容保存为 `~/.config/systemd/user/pi-web-tunnel.service`（替换 `xxxx@xxxx` 为你的 SSH 服务器/用户）：

```ini
[Unit]
Description=SSH tunnel to pi web (localhost:4080 -> 127.0.0.1:4080 via xxxx@xxxxxx)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/usr/bin/ssh -v -N -T -L 4080:127.0.0.1:4080 \
   -o ExitOnForwardFailure=yes \
   -o ServerAliveInterval=60 \
   -o ServerAliveCountMax=3 \
   -o ConnectTimeout=10 \
   -o BatchMode=yes \
   xxxx@xxxx
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

启用并启动：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-web-tunnel
systemctl --user status pi-web-tunnel   # 查看状态/日志
```

要点：

- `-o BatchMode=yes`：不交互，依赖 SSH key 认证（`ssh-keygen` 生成、`ssh-copy-id` 部署；若无 key 认证该服务会启动失败，属预期）
- `-o ExitOnForwardFailure=yes`：本地端口被占用/转发失败时立即退出（配合 `Restart` 自动重试），避免"静默失败"
- `-o ServerAliveInterval/CountMax`：检测断连并自动重连
- `Restart=on-failure` + `RestartSec=5`：崩溃后 5 秒自动重启
- `WantedBy=default.target`：用户登录后自动启动（`systemctl --user enable` 后开机生效）
- 开机自启需启用 lingering：`loginctl enable-linger <user>`（否则用户未登录时代理不启动）

## 项目结构

```text
pi-web/
├── AGENTS.md            # AI 代理工作指引
├── pi-web-design.md     # 设计文档（§15 原生引擎 / §15.13 阶段 E / §16 宿主契约 / §17 切换）
├── README.md
├── native/              # 引擎运行时（全部为纯 JS，无 TypeScript 构建）
│   ├── server.mjs       # bin: pi-web-native —— 静态服务 + WS 协议 + RPC 客户端 + 侧信道
│   ├── bridge.mjs       # 注入 pi 的桥接扩展（接管 ctx.ui 的 UI 方法层 + 侧信道上报）
│   ├── usage-render.mjs # /usage 面板数据（读 session 文件，零 SDK 依赖）
│   ├── cli.mjs          # bin: pi-web —— 薄壳（r/list/help + 堆上限处理 → 转调引擎）
│   └── pii-cli.mjs      # bin: pii —— Node 包装器（spawn 同目录的 Python 启动器）
├── pii/
│   └── pii              # Python 启动器（会话名解析、TUI 入口、--web 转调引擎）
├── static/              # 浏览器前端（唯一一份，index/style/app + vendor）
├── tools/
│   ├── smoke.mjs        # 只读冒烟（42 项，含部署漂移校验）
│   ├── ab-compare.mjs   # 两引擎 A/B 对比工具（阶段 E 前的对照证据）
│   ├── ab-report-*.md   # A/B 记录
│   └── host-contract/   # 宿主契约核对器 + 进程内探针 + 基线（Pi 升级后 / 发版前必跑）
└── pi-sdk-web/          # npm 包源码目录（包名 @maxdai/pi-web；运行时资产在仓库根的 native/ 与 static/）
    ├── package.json
    ├── scripts/build-assets.mjs   # 装配 dist/：拷 static + native + pii（无 tsc）
    └── dist/                      # 发布产物（files: ["dist"]）
        ├── native/{server,bridge,usage-render,cli,pii-cli}.mjs + pii
        └── static/
```

> **打包**：`npm run build` 只做拷贝——`static/`、`native/*.mjs`、`pii/pii` → `dist/`（bin 补执行位，最后自检缺件）。
> 阶段 E 起包内**没有 TypeScript**、`src/` 与 `tsconfig.json` 已删除，依赖只剩 `ws`（devDependency `playwright-core` 供工具链使用）。
> 目录名 `pi-sdk-web/` 保留了历史名称（避免大面积引用改动），其内容已是"原生引擎包"。

## 技术说明

- **引擎**：Node 单进程（内置 http + `ws`），spawn 已安装的 `pi --mode rpc` 子进程，JSON line over stdin/stdout
- **扩展 UI**：随 `--extension` 注入 `bridge.mjs`，在 pi 进程内改写 `ctx.ui`（共享可变对象）——`custom()` 面板、工厂 widget、对话框、换肤由此呈现
- **前端**：vanilla JS + marked（本地 vendor，无 CDN）
- **Python**：只用于 `pii` 启动器（标准库，零第三方依赖；会话名解析 / TUI 入口 / `--web` 转调引擎）
- 仅监听 `127.0.0.1`，单用户本机使用，暂不做鉴权

> 旧的两套实现（Python RPC 服务 `server/`、SDK 宿主 `src/`）已在阶段 E 移除，历史设计与证据见 `pi-web-design.md` §11–§15。
