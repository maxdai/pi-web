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

## 实测中发现的两个机制要点

1. **widget 生命周期必须由桥接接管**：TUI 下组件由 TUI 管理（移除时 `invalidate()`）。我们接管
   `setWidget` 后若不自己做，扩展的定时器/状态会让面板「复活」——实测：`setWidget(key, undefined)`
   之后组件仍在 `requestRender()`，面板重新出现。修法：按 key 记录 active 状态，移除时置为
   inactive 并调用组件的 `invalidate?.()`。
2. **RPC 的 `bash` 用命令信封 id 作为执行 id**（会出现在 `bash_execution_update` 事件里），而前端
   用自己生成的 `bash-<ts>` 关联流式块。服务端必须把两者对齐，否则前端匹配不到流式块；同时
   `bash_result` 需要服务端自行合成（RPC 不发这个事件）。

## 已知缺口（原型未实现，迁移时需补齐或明确降级）

| 缺口 | 说明 |
|---|---|
| 扩展 ANSI 换肤 | 前端 CSS 立即切换；扩展 `setStatus`/widget 的 ANSI 颜色跟随 Pi theme，需在桥接里实现 theme 交换 |
| `custom()` 面板 | 桥接已能承载（渲染成行文本并回传结论），但**前端还没有面板模态**；当前返回 `undefined`（与现状 SDK 宿主一致，`/usage` 已改为原生实现） |
| `/usage`、`export`、`delete_session` | 原型未实现（`/usage` 是 pi-web 原生功能，直接读 session 文件即可迁） |
| scoped models 设置 | 写 `settings.json` 的 `enabledModels` 后需**重启 pi 子进程**才生效（TUI 同样是启动时读取） |
| 会话名/未命名会话 | 只按 `session_info` 里的名字解析；`(unnamed)` 与非默认目录未覆盖 |

## 下一步

见 pi-web-design.md §15.8：阶段 A 抽象引擎接口（`--engine sdk|native`）→ B 落地本原型 →
C 逐项对齐 → D 端到端冒烟覆盖两种引擎 → E 移除 SDK 引擎与依赖。
