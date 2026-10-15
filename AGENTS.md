# AGENTS.md

pi-web 项目的 AI 代理工作指引。**本文件只放"必须遵守的规则"**：设计/技术细节见 `pi-web-design.md`，
操作流程（开发环境、验证、发版）见 `MAINTAINING.md`，使用说明与目录树见 `README.md`，历史事故与经验教训记在 memory（OpenViking）。

## 1. 项目与硬约束

pi-web 给 Pi（AI coding agent 终端工具）提供浏览器 Web 访问，让用户在浏览器获得接近 TUI 的体验。

- **硬约束：不改 Pi 本体代码。** 一切控制逻辑都在本仓库（启动器 / Web 服务 / 注入扩展）内。
- **唯一引擎**：原生 `pi --mode rpc` 子进程 + 注入桥接扩展（`native/bridge.mjs` 在 pi 进程内改写
  `ctx.ui`，补回 RPC 丢掉的 UI 方法层）；运行时依赖只剩 `ws`。候选的「TUI 模式 + 桥接」路线已研究并**暂缓**（研究存档见设计文档 §18，决策见 §18.10）。
- **Web UI 目标**：尽量还原 TUI 的展示结构与配色，不做通用聊天界面。

> 架构图、关键决策清单、与 SDK 时代的历史对照：设计文档 §4 / §15 / §17 / §18。

## 2. 命令行契约（用户可见行为，不得擅自变更）

```text
pii r <name>                # 默认：进入 TUI（原有行为，不变）
pii r <name> --web          # Web 服务，默认端口 4080
pii r <name> --web <port>   # Web 服务，指定端口
```

- `--web` 不带值 → `4080`；带值 → 指定端口（1–65535）；统一绑定 `127.0.0.1`。
- 端口非法或已被占用 → **报错退出**，不做自动换端口。
- 入口命令保持零变化：引擎换代只改内部实现，不新增用户可见命令。

## 3. 开发流程（三阶段，顺序不可跳过）

1. **讨论**：先把目标、方案、边界、不确定性谈清楚；**此阶段不动代码**。
2. **设计文件**：结论写入 `pi-web-design.md`（本项目所有设计内容只放这里，不另建散落说明文件）；
   任何设计的新增/变更/撤销都必须同步更新它。
3. **开发**：依据讨论结果与设计文件动手。

> 没有讨论与设计铺垫，不要直接改代码。

## 4. Git 与发版原则

### 提交与推送

- 默认分支 `master`；远程 `origin` = `https://github.com/maxdai/pi-web.git`。
- **判断标准**：①**尝试性/结果不确定**的改动 → 只本地 `git commit`（便于回滚，不污染远端历史）；
  ②**确定性且无后继操作**的改动 → 直接 `git push`，不要长期留在本地。
- 避免频繁的 GitHub 操作；提交信息简洁、描述性，一个提交聚焦一个改动点。

### 发版（原则；完整步骤见 `MAINTAINING.md` §3）

- **默认 dev-first**：先 `npm run build && npm install -g /root/pi-web/pi-sdk-web` 更新开发环境
  （全局安装会成为指向仓库的**软链**，此后改 `native/`、`static/` 只需 `npm run build`，无需发版），
  **等用户测满意**再发版。
- **必须获得明确指令**：用户说出"发版 / 可以发版"才执行动作链；"修改完成"不算指令。
  `npm publish` 前还要确认一次"是否修改完成"。
- **一次做完，不得遗漏**：① `git push --follow-tags` → ② `npm publish` → ③
  `npm install -g @maxdai/pi-web@<版本>`；每步各自验证。
- **tag 必须用附注 tag**（`git tag -a vX.Y.Z -m …`）：`--follow-tags` 只推附注 tag，轻量 tag 会被静默跳过；
  推送后用 `git ls-remote --tags origin` 核对远端确有该 tag。
- **发版前必跑宿主契约核对器**：`node tools/host-contract/check-host-contract.mjs`（Pi 升级后与发版前各一次）。
  FAIL = 方案立足点被破坏（按设计文档 §16.7 降级）；DRIFT 需人工判断。
- 版本号由用户确认后提升；用户侧升级命令 `npm update -g @maxdai/pi-web`。
- 更新开发环境会重写 `dist/`：**必须在用户 4080 实例停止时做**（见 §7）。

## 5. 目录与源码位置

```text
~/pi-web/
├── AGENTS.md / MAINTAINING.md / pi-web-design.md   # 规则 / 维护者流程 / 设计文档
├── native/        # 引擎运行时（纯 JS，无 TS 构建）：server / bridge / usage-render / cli / pii-cli
├── pii/pii        # Python 启动器（会话名解析、TUI 入口、--web 转调引擎）
├── static/        # 浏览器前端（唯一一份）
├── tools/         # smoke.mjs、ab-compare.mjs、host-contract/（宿主契约核对器）、tui-proto/（原型留档）
└── pi-sdk-web/    # npm 包源码目录（包名 @maxdai/pi-web）：build-assets.mjs + dist/
```

> 完整目录树与各文件职责见 README「项目结构」。

- **Pi 源码**：`~/research/pi/`；RPC 模式：`packages/coding-agent/src/modes/rpc/`（`rpc-mode.ts` / `rpc-types.ts`）。
- **Pi TUI 组件与主题**（UI 还原参考）：`packages/coding-agent/src/modes/interactive/{components,theme}/`。
- **RPC 协议细节**：设计文档 §16.4 与 `modes/rpc/rpc-types.ts`；**TUI 展示结构（UI 还原目标）**：设计文档 §19。

## 6. 编码注意事项

- `pii` 只用 **Python 标准库**（当前零第三方依赖，尽量保持）。
- 引擎为纯 JS（`native/*.mjs`）；包内没有 TypeScript，`build` 只做拷贝。
- 前端优先还原 TUI 深色主题与结构，不做花哨样式。

## 7. 本地实例与端口管理（务必遵守）

- **禁止用 `pkill -f` 清理本会话启动的实例**：pattern 会匹配到执行它的 shell 自身（同一根因重复踩过 3 次；
  「括号技巧」只是延迟症状，不是解法）。
- **按端口清理（推荐）**：`lsof -ti:4096 | xargs -r kill`；或启动时记录 PID 再按 PID 清理
  （`$!` 可能是包装进程的 PID，故仅作备份手段）。
- 只做审计时可用 `pgrep -af <pattern>`，但**不要把输出直接管道给 `kill`**。
- **启动实例前先确认端口空闲**：`lsof -ti:4096 || echo free`；连到旧实例会伪装成"改了没生效"。
- 每个长驻实例，都要在当次回复里说明**它占用的端口**与**停止方式**。
- **端口约定**：测试统一用 `4096`（共享前必须先清理旧实例；可长期运行，但每次重启要说明状态）；
  **`4080` 是用户实例端口，任何情况下不得占用**。
- **升级全局安装前**先确认用户实例没在运行（看 4080 与 `tmux ls`），在跑就先告知用户、由其决定何时停。
- 用户实例启动命令：`pi-web r <会话名>` 或 `pii r <会话名> --web`（两者都启动同一原生引擎并占用 4080）。

> 相关事故细节与时间线（0.7.0 发版那次、`$!` 包装进程实测等）见 memory 与设计文档 §17.4。
