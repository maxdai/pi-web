# MAINTAINING.md

**目标读者：项目维护者与 AI 代理。** 本文件只放**操作流程**（开发环境、验证、发版、已知坑）。

| 文档 | 读者 | 内容 |
|---|---|---|
| `README.md` | 使用者 | 安装、使用、SSH 隧道、项目结构、技术说明 |
| `AGENTS.md` | AI 代理 | **必须遵守的规则**（硬约束、三阶段流程、Git/发版原则、端口与实例管理） |
| `pi-web-design.md` | 维护者 / 代理 | 设计与实现依据（含实测证据、决策记录） |
| **本文件** | 维护者 / 代理 | **操作流程**（怎么做，而不是"必须怎么做"） |

## 1. 开发环境（dev-first）

默认流程（用户指定）：**先把本机开发环境更新到仓库代码，等用户在 4080 测满意，再发版。**

```bash
cd /root/pi-web/pi-sdk-web
npm run build                            # 纯拷贝：static/ + native/*.mjs + pii → dist/（无 tsc）
npm install -g /root/pi-web/pi-sdk-web   # 全局安装变为**指向仓库的软链**
```

- 软链形态下，之后改 `native/`、`static/` 只需 `npm run build`，`pi-web` / `pii` / `pi-web-native`
  立刻用上新代码，**无需发版**；
- `npm run build` 会**重写 `dist/`** → 必须在**用户 4080 实例停止**时做（见 `AGENTS.md` §7 规则 8）；
- **发过版之后**全局安装会变回 registry 发布版；下次开发要重新执行上面的 `npm install -g <仓库目录>` 指回仓库，
  否则"改了代码却没生效"。

## 2. 验证（发版前必做）

### 2.1 宿主契约核对器（Pi 升级后 / 发版前各跑一次）

```bash
node tools/host-contract/check-host-contract.mjs          # 与基线对比
node tools/host-contract/check-host-contract.mjs --update # 有意变更契约时记录基线
```

- **PASS** = 与基线一致；**FAIL** = 关键项缺失/行为异常（方案立足点被破坏，按设计文档 §16.7 降级）；
  **DRIFT** = 与基线有差异，需人工判断是否影响我们；
- `probe.commandCount` / `probe.scopedModelsCount` 属**环境相关量**（取决于用户装了哪些 prompt/扩展、
  勾选了哪些模型），只作信息展示、不参与漂移判定；
- 细节与探针说明见 `tools/host-contract/README.md`。

### 2.2 冒烟测试（42 项只读回归）

```bash
pi-web r <session>              # 先起着服务（默认 4080；测试实例统一用 4096）
node tools/smoke.mjs            # 也可指定地址：node tools/smoke.mjs http://127.0.0.1:4096
node tools/smoke.mjs --headed   # 需要肉眼观察时
```

- **只读**：不发 prompt/命令、不改被测会话；测试页面是脚本自开的无头实例，与浏览器互不影响；
- **零 token**：全部是确定性 DOM/协议断言，不调用 LLM；
- **部署漂移检测**：比对服务端提供的 `app.js` / `style.css` 与仓库源文件哈希——「改了没生效／忘了重启／
  全局装的是旧版」会直接 FAIL 并打印两侧哈希；
- **不要**与 `npm install -g`（替换 dist）**同时**跑，否则会读到替换中的文件而误报；
- 退出码：`0` 全通过、`1` 有失败、`2` 依赖缺失或服务不可达；
- 依赖：`playwright-core`（devDependency）+ 一个 Chromium（用 `~/.cache/ms-playwright` 缓存，可用
  `PI_WEB_CHROMIUM` 覆盖）。

### 2.3 其他工具

| 工具 | 用途 |
|---|---|
| `tools/ab-compare.mjs` | 引擎 A/B 对比（阶段 E 的对照工具，记录见 `tools/ab-report-*.md`） |
| `tools/tui-proto/` | 「TUI + pty + 桥接」候选路线的原型与实测脚本（设计与结论见设计文档 §18） |

## 3. 发版流程

```bash
# 0. 发版前两项检查
node tools/host-contract/check-host-contract.mjs      # 0a. 宿主契约（Pi 升级后尤其必须）
node tools/smoke.mjs                                  # 0b. 冒烟（需先起着服务）

# 1. 提升版本（必须在 pi-sdk-web/ 目录；npm version 只改 package.json，不会自动 commit）
cd /root/pi-web/pi-sdk-web && npm version patch       # 或 minor / major

# 2. 提交 + 打附注 tag
cd /root/pi-web
git add -A && git commit -m "Release @maxdai/pi-web x.y.z"
git tag -a vX.Y.Z -m "Release @maxdai/pi-web x.y.z"

# 3. 发布（prepublishOnly 会自动 build；已配 Automation token 则零交互）
cd /root/pi-web/pi-sdk-web && npm publish --access public

# 4. 推送 git（含 tag）
cd /root/pi-web && git push --follow-tags
git ls-remote --tags origin | grep vX.Y.Z             # 核对远端确有该 tag

# 5. 等 registry 传播后更新本机全局安装（需先停用户 4080 实例）
for i in $(seq 1 16); do npm view @maxdai/pi-web@x.y.z version && break; sleep 15; done
npm install -g @maxdai/pi-web@x.y.z

# 6. 安装版复验：三入口 + 冒烟 42/42 + header 版本 + /usage + /resume + 核对器
```

- **作用域包首次/每次发布都要 `--access public`**；
- 认证：本机 `~/.npmrc` 配 npm 的 **Automation/Granular token**（npmjs.org → Access Tokens）；
- 用户侧升级命令：`npm update -g @maxdai/pi-web`；
- 旧包 `pi-sdk-web` 已 deprecate 并指向本包。

## 4. 已知坑（维护者）

- **`npm publish` 必须在 `pi-sdk-web/` 目录执行**：在仓库根执行会 `ENOENT`（那里没有 package.json）。
  2026-10 踩过**两次**，都是把 `cd` 串进同一条命令链导致的——发布这一步单独跑。
- **tag 必须用附注 tag**（`git tag -a`）：`git push --follow-tags` **只推附注 tag**，轻量 tag 会被静默跳过
  （2026-10 实测 `v0.7.0`~`v0.7.5` 六个 tag 因此都没上远端，后用 `git push origin --tags` 补推）。
- **更新全局安装前先确认用户 4080 实例已停**：`npm install -g` 会替换包目录，老进程懒加载静态资源时
  可能出错（预防性规则，不是事故复盘）。
- **npm 注册表传播需要 1–3 分钟**：`npm view <pkg>@<version>` 轮询确认后再 `npm install -g`，
  否则会 `notarget`。
- **会话显示名解析必须取"最后一条 `session_info`"**：fork 会把父会话条目带进新文件，取第一条会拿到父名
  （2026-10 的 1.1.1 修的就是这个；实现见 `native/session-name.mjs`）。
- **不要用 `pkill -f` 清理自启实例**（会自杀）；按端口清理，详见 `AGENTS.md` §7。
