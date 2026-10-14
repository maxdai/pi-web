# experiments/rpc-bridge —— 端到端原型（RPC + 注入桥接扩展）

> **这不是发布路径。** 它验证 pi-web-design.md §15 的路线：引擎改为 spawn **已安装的原生 pi**
> （`--mode rpc` + `--extension`），复用现有 `static/` 前端与同一套 WS 协议，从而消掉内嵌 SDK
> 的并行副本与版本漂移。

## 架构

```text
浏览器 ←─WS（协议不变）─→ experiments/rpc-bridge/server.mjs
                                │  ├─ HTTP /side/*（token）─→ [bridge.mjs：在 pi 进程内接管 UI 方法层]
                                │  └─ stdin/stdout JSON line ─→ [原生 pi --mode rpc --session <file>]
```

- `server.mjs` —— HTTP 静态服务（仓库 `static/`）+ WS 协议 + RPC 客户端 + 侧信道服务端
- `bridge.mjs` —— 以 `--extension` 注入 pi 的扩展：接管工厂 widget / `custom()` / 对话框 /
  `setTheme`，并上报 cwd、scopedModels、commands、tools、extensions

## 运行

```bash
# 终端 1
node experiments/rpc-bridge/server.mjs --session install --port 4096

# 终端 2：既有冒烟套件（只读、零 token）
node tools/smoke.mjs http://127.0.0.1:4096
```

可选参数：`--session <名字>` 或 `--session-file <路径>`、`--port <端口>`。

## 已验证（2026-10，Pi 1.2.0 / Node 24）

| 验证项 | 结果 |
|---|---|
| 既有冒烟套件 42 项（含静态文件一致性、state/history 快照、Extensions builtin 标注） | **42/42 通过** |
| bash 经 UI → WS → RPC → 事件 → 渲染 | 通过（`tool-block success` + 输出） |
| 工厂 widget 经「扩展 → 侧信道 → 服务端 → 浏览器」渲染 | 通过（面板显示桥接渲染的两行） |
| `requestRender()` 增量更新（TodoOverlay 的更新方式） | 通过（render #1 → #2） |
| 对话框：浏览器点击 → 服务端 → 桥接 → `ctx.ui.confirm()` 返回 | 通过（桥接收到 `answer: true`） |
| `setWidget(key, undefined)` 移除 widget | 通过（修复生命周期后） |
| 页面错误 | 0 |

`bridge.mjs` 自带三条诊断命令便于手工复验：`/pi-web:demo-widget`、`/pi-web:demo-clear`、
`/pi-web:demo-dialog`（另有 `/pi-web:reload`，用到 `ExtensionCommandContext.reload()`——
RPC 命令表里没有的能力）。

## 已补齐的缺口（2026-10，逐项实测）

| 能力 | 实现方式 | 验证结果 |
|---|---|---|
| **扩展 ANSI 换肤** | 桥接从**运行中的 pi 包目录**（`realpath(argv[1])/../..`）动态 import Pi 的 `Theme` 类，用 `dark.json`/`light.json` 构造主题（truecolor，与 SDK 宿主一致），并改写 `ui.theme`；服务端暴露 `GET /side/theme`，桥接每 2s 轮询，变化时强制重渲染所有 widget | 切换 Light 后 widget 的 ANSI 颜色立即改变（`themeSwapped: true`，帧 `theme_set` ×2） |
| **`custom()` 面板** | 桥接把组件 `render(width)` 的文本行经侧信道送到服务端 → 前端以只读模态 `extension-panel` 呈现（Esc/×/Close 关闭），关闭时回传结论；组件若已 `done(value)` 则采用该值 | 面板标题带倒计时、两行内容正确、Close 后遮罩关闭、桥接收 `{"type":"demo-panel","value":null}` |
| **`/usage`** | 服务端原生拦截（`command` 名为 `usage` 时优先于扩展命令，与 SDK 宿主一致），复用 pi-web 既有的 `usage-render`（读 session 文件，**0 处 SDK 依赖**——证明该功能本就与引擎无关） | `usage_data` 帧 + 前端 usage 面板打开 |
| **`export`** | RPC `export_html`（接受 `outputPath`）→ notify 导出路径 | 收到 `/export: Session exported to: …` |
| **`delete_session`** | 校验「已知会话 + 非当前会话」后删除文件 | 三个分支全通过：伪造路径被拒、当前会话被拒、临时会话被删 |
| **`(unnamed)` 会话解析** | 无 `session_info` 名字的会话按 `(unnamed)` 匹配（与 `pii` 展示名一致） | 合成未命名会话可被 `--session "(unnamed)"` 解析到 |

## 实测中发现的机制要点

1. **widget 生命周期必须由桥接接管**：TUI 下组件由 TUI 管理（移除时 `invalidate()`）。我们接管
   `setWidget` 后若不自己做，扩展的定时器/状态会让面板「复活」——实测：`setWidget(key, undefined)`
   之后组件仍在 `requestRender()`，面板重新出现。修法：按 key 记录 active 状态，移除时置为
   inactive 并调用组件的 `invalidate?.()`。
2. **RPC 的 `bash` 用命令信封 id 作为执行 id**（会出现在 `bash_execution_update` 事件里），而前端
   用自己生成的 `bash-<ts>` 关联流式块。服务端必须把两者对齐，否则前端匹配不到流式块；同时
   `bash_result` 需要服务端自行合成（RPC 不发这个事件）。
3. **`ui.theme` 可被改写且对其他扩展生效**（实测两扩展对照）：它是 runner 上的可配置属性；
   换肤因此不需要改 Pi。注意 RPC 自带主题是 256 色，而桥接构造的是 truecolor——与 SDK 宿主
   现行表现一致。
4. **`/usage` 这类 pi-web 原生功能与引擎无关**：它读 session 文件，不 import SDK，迁移时源码级复用即可。

## 仍存在的缺口

| 缺口 | 说明 |
|---|---|
| `.jsonl` 导出 | RPC 只有 `export_html`（SDK 宿主用 `session.exportToJsonl`）；原生引擎下 `.jsonl` 导出暂以提示降级 |
| scoped models 设置 | 写 `settings.json` 的 `enabledModels` 后需**重启 pi 子进程**才生效（TUI 同样是启动时读取） |
| 面板的按键交互 | 只读模态：面板内组件的按键/焦点交互不支持（内容可见，不能在里面操作） |
| TUI-only 项 | `setWorkingIndicator`/`setFooter`/`setHeader`/`setEditorComponent` 等：宿主与 RPC 下都是 no-op，未实现（与现状一致） |
| 会话目录约定 | 解析按 `session_info` 名 + `(unnamed)`；自定义 session 目录（`PI_SESSION_DIR` 等）未覆盖 |

## 宿主契约核对（Pi 升级后必须执行）

本方案**替换/改写了宿主 pi 的对象**并依赖若干内部约定 —— 完整清单、失效后果与降级路径见
`pi-web-design.md` §16。可执行核对器：

```bash
node experiments/rpc-bridge/check-host-contract.mjs            # 与基线对比（14 项关键判定 + 结构 diff）
node experiments/rpc-bridge/check-host-contract.mjs --update   # 记录新基线
node experiments/rpc-bridge/check-host-contract.mjs --json     # 只看当前快照
```

- 进程内探针：`host-contract-probe.mjs`（探测并改写 `setTitle`）+ `host-contract-probe-b.mjs`（触发调用，
  验证「改写跨扩展可见」这一最关键假设）
- 基线：`host-contract.baseline.json`（当前 **Pi 1.2.0 / node v24.18.0**）
- `FAIL` = 立足点被破坏；`DRIFT` = 与基线有差异（需人工判断）
- 核对器自身已验证：篡改基线（移除一个 UI 方法 + 把 `theme` 改成不可配置 getter）后能正确报出 4 处差异

## 下一步

见 pi-web-design.md §15.8：阶段 A 抽象引擎接口（`--engine sdk|native`）→ B 落地本原型 →
C 逐项对齐 → D 端到端冒烟覆盖两种引擎 → E 移除 SDK 引擎与依赖。
