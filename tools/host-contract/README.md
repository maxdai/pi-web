# 宿主契约核对器（tools/host-contract/）

pi-web 的桥接方案**替换/改写了宿主 `pi` 进程内的对象**（`ctx.ui` 的方法、`ui.theme` 属性等），
依赖若干内部约定。完整清单、失效后果与降级路径见 `pi-web-design.md` §16；
本目录是可执行核对器，用于在 **Pi 升级后 / 发版前**确认立足点没被破坏。

```bash
node tools/host-contract/check-host-contract.mjs            # 与基线对比（14 项关键判定 + 结构 diff）
node tools/host-contract/check-host-contract.mjs --update   # 记录新基线（Pi 升级并确认兼容后）
node tools/host-contract/check-host-contract.mjs --json     # 只看当前快照
```

| 文件 | 作用 |
|---|---|
| `check-host-contract.mjs` | 入口：跑探针、与基线比对、输出 PASS/FAIL/DRIFT |
| `host-contract-probe.mjs` | 进程内探针 A：探测并改写 `setTitle` 等对象 |
| `host-contract-probe-b.mjs` | 进程内探针 B：触发调用，验证「改写跨扩展可见」这一最关键假设 |
| `host-contract.baseline.json` | 基线快照（当前：**Pi 1.2.0 / node v24.18.0**） |

- `FAIL` = 立足点被破坏（方案前提不成立，需按 §16.7 降级）；
- `DRIFT` = 与基线有差异（需人工判断是宿主变化还是无害差异）。
- 核对器自身已验证有效：篡改基线（移除一个 UI 方法 + 把 `theme` 改成不可配置 getter）后能正确报出 4 处差异。

**何时必须跑**（§15.13 决策 5）：
1. Pi 升级之后（`pi --version` 变化）；
2. 每次发版之前。
