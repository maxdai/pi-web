#!/usr/bin/env node
/**
 * pi-web smoke test —— 针对**已在运行**的 pi-web 实例做只读回归检查。
 *
 * 覆盖这几类高频回归面（全部确定性、不需要 LLM、不消耗 token）：
 *   部署一致性  服务端提供的 app.js/style.css 是否与仓库源文件一致
 *                （专治「改了没生效/忘了重启/全局装的是旧版」这类困惑）
 *   页面加载    无 pageerror、WS 已连接、favicon 可用
 *   协议        连接时收到 state / history（以及串上 widgets 快照重放）
 *   渲染        markdown、代码块折行（pre-wrap 无横滚）、tool block、
 *               widget（ANSI→HTML）、ext-status
 *               扩展消息：custom（实时/历史、display 真/假/字符串）、
 *               appendEntry（有/无 data.text）
 *   交互        dialog 倒计时与清理、confirm 回传、滚动门控
 *
 * 用法：
 *   node tools/smoke.mjs                       # 默认 http://127.0.0.1:4080
 *   node tools/smoke.mjs http://127.0.0.1:4090
 *   PI_WEB_CHROMIUM=/path/to/chrome node tools/smoke.mjs
 *   node tools/smoke.mjs --headed              # 需要肉眼观察时
 *
 * 依赖：playwright-core（pi-sdk-web 的 devDependency）与一个 Chromium。
 * 浏览器按序解析：PI_WEB_CHROMIUM → ~/.cache/ms-playwright 下各 revision 的
 * chrome-linux64/chrome → chrome-linux/chrome → chrome-headless-shell。
 *
 * 只读保证：只发 WS 读消息与页面内 DOM 操作，不发送 prompt/命令，
 * 不改动被测会话（测试页面是脚本自己开的无头实例，与你的浏览器无关）。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const url = (args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4080").replace(/\/$/, "");

let failures = 0;
let skips = 0;
let total = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok === "skip") {
    skips++;
    console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

// ---------------------------------------------------------------- 依赖解析
function loadPlaywright() {
  const candidates = [
    join(REPO_ROOT, "pi-sdk-web", "package.json"),
    join(REPO_ROOT, "package.json"),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    try {
      return createRequire(base)("playwright-core");
    } catch {
      /* 试下一个 */
    }
  }
  try {
    return createRequire(import.meta.url)("playwright-core");
  } catch {
    /* 落空 */
  }
  console.error(
    "找不到 playwright-core。安装：\n" +
      `  cd ${join(REPO_ROOT, "pi-sdk-web")} && npm install\n` +
      "（playwright-core 是 pi-sdk-web 的 devDependency；无需下载浏览器，脚本会用系统缓存里的 Chromium）",
  );
  process.exit(2);
}

function findChromium() {
  if (process.env.PI_WEB_CHROMIUM) return process.env.PI_WEB_CHROMIUM;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const rels = [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ];
  for (const dir of readdirSync(root)) {
    for (const [sub, bin] of rels) {
      const p = join(root, dir, sub, bin);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- HTTP 检查
async function fetchText(path) {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}

async function checkDeployment() {
  const index = await fetchText("/");
  check("GET / 返回 200", index.status === 200, `status=${index.status}`);
  check(
    "index.html 引用 favicon",
    index.text.includes('rel="icon"') && index.text.includes("pi-logo.svg"),
  );
  const logo = await fetch(`${url}/pi-logo.svg`);
  check(
    "GET /pi-logo.svg 可访问且类型正确",
    logo.status === 200 && (logo.headers.get("content-type") ?? "").includes("svg"),
    `${logo.status} ${logo.headers.get("content-type")}`,
  );

  // 部署一致性：服务端提供的静态文件 vs 仓库源文件（改完没生效会在这里暴露）
  for (const [served, local] of [
    ["/app.js", join(REPO_ROOT, "static", "app.js")],
    ["/style.css", join(REPO_ROOT, "static", "style.css")],
  ]) {
    const remote = await fetchText(served);
    const localText = readFileSync(local, "utf8");
    const same = remote.text === localText;
    check(
      `服务端 ${served} 与仓库源文件一致`,
      same,
      same ? sha(localText) : `服务端 ${sha(remote.text)} ≠ 仓库 ${sha(localText)}（未同步/未重启？）`,
    );
  }
}

// ---------------------------------------------------------------- 主流程
const { chromium } = loadPlaywright();
const executablePath = findChromium();
const browser = await chromium.launch({ executablePath, headless: !headed });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

// 抓 WS 帧，用于断言连接时的快照重放（不额外建连接）
const frames = [];
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => {
    try {
      frames.push(JSON.parse(typeof f.payload === "string" ? f.payload : f.payload.toString()));
    } catch {
      /* 非 JSON 帧忽略 */
    }
  });
});

console.log(`pi-web smoke test → ${url}${executablePath ? "" : "（使用 playwright 自带浏览器解析）"}\n`);

// 预检：服务不可达时给出干净提示，而不是抛栈
try {
  const probe = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (err) {
  console.error(
    `无法访问 ${url}（${err instanceof Error ? err.message : String(err)}）。\n` +
      "先启动一个实例，例如：pi-web r <session名> [--port 4080]",
  );
  process.exit(2);
}

await checkDeployment();

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(2500); // 等 WS 连接 + 首屏 history 渲染

check("页面加载无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));
const status = await page.evaluate(() => document.getElementById("conn-status")?.textContent ?? "");
check("WS 已连接", /connected/i.test(status), `conn-status=${status}`);

const frameTypes = frames.map((f) => f.type);
check("连接时收到 state", frameTypes.includes("state"));
check("连接时收到 history", frameTypes.includes("history"));
// 内置扩展（builtin:*，hidden）不得出现在 Extensions 列表——TUI 过滤 !hidden，我们同义
const stateFrame = frames.find((f) => f.type === "state");
const extNames = (stateFrame?.data?.extensions || []).map((e) => String(e.name));
check(
  "Extensions 框不含内置扩展（builtin:*）",
  extNames.length > 0 && extNames.every((n) => !n.startsWith("builtin:")),
  extNames.join(", ") || "(none)",
);
const widgetReplays = frames.filter((f) => f.type === "extension_ui_request" && f.method === "setWidget");
check(
  "widget 快照重放（无 widget 时跳过）",
  widgetReplays.length > 0 ? true : "skip",
  widgetReplays.length ? `${widgetReplays.length} 条` : "当前会话没有 widget",
);

// ------------------------------------------------------------ 渲染 & 交互
const results = await page.evaluate(() => {
  const out = {};
  const client = new PiWebClient();
  const blocks = () => document.querySelectorAll(".special-block").length;
  const content = [{ type: "text", text: "SMOKE-BODY" }];

  // markdown
  const md = client.renderMarkdown("## 标题\n\n- 甲\n- 乙\n\n```\ncode line\n```");
  out.markdown = { h2: md.includes("<h2"), ul: md.includes("<ul"), pre: md.includes("<pre") };

  // 代码块折行（pre-wrap，无横向滚动）
  const probe = document.createElement("div");
  probe.className = "message assistant";
  probe.innerHTML =
    '<div class="role">Assistant</div><div class="body"><div class="body-text"><pre><code>' +
    "const x = '" + "A".repeat(200) + "'; " + "padding ".repeat(40) +
    "</code></pre></div></div>";
  document.getElementById("content").appendChild(probe);
  const pre = probe.querySelector("pre");
  out.codeWrap = {
    whiteSpace: getComputedStyle(probe.querySelector("code")).whiteSpace,
    noXScroll: pre.scrollWidth <= pre.clientWidth + 1,
  };
  probe.remove();

  // custom message：实时（message_start，role=custom，无 type 字段）
  let n = blocks();
  client.onMessageStart({ role: "custom", customType: "smoke-live", content, display: true });
  out.customLiveShown = blocks() - n;
  n = blocks();
  client.onMessageStart({ role: "custom", customType: "smoke-live-hidden", content, display: false });
  out.customLiveHidden = blocks() - n;

  // custom message：历史（custom_message entry）
  n = blocks();
  client.renderEntry({ type: "custom_message", customType: "smoke-h1", content, display: false });
  out.customHistHidden = blocks() - n;
  n = blocks();
  client.renderEntry({ type: "custom_message", customType: "smoke-h2", content, display: true });
  out.customHistShown = blocks() - n;
  n = blocks();
  client.renderEntry({ type: "custom_message", customType: "smoke-h3", content, display: "💬 UI Prompt: x" });
  out.customHistString = blocks() - n;

  // appendEntry（type=custom）：无 data.text 静默、有则渲染
  n = blocks();
  client.renderEntry({ type: "custom", customType: "smoke-trace", data: { mode: "x" } });
  out.appendEntryNoText = blocks() - n;
  n = blocks();
  client.renderEntry({ type: "custom", customType: "smoke-status", data: { text: "hello" } });
  out.appendEntryWithText = blocks() - n;

  // widget 渲染 + ANSI→HTML
  const widgets = document.getElementById("widgets");
  client.renderWidget({ widgetKey: "smoke-widget", widgetLines: ["\u001b[31mRED\u001b[39m plain"] });
  const wEl = widgets.querySelector('[data-widget-key="smoke-widget"]');
  out.widget = { present: !!wEl, ansi: (wEl?.querySelector(".widget-body")?.innerHTML ?? "").includes("color:") };
  client.renderWidget({ widgetKey: "smoke-widget", widgetLines: undefined });

  // tool block
  const before = document.querySelectorAll(".tool-block").length;
  const tb = client.createToolBlock("bash", { command: "echo smoke" }, "smoke-tool");
  out.toolBlock = document.querySelectorAll(".tool-block").length - before === 1 && !!tb;
  tb?.remove();

  // ext-status
  client.renderStatusItem({ statusKey: "smoke", statusText: "smoke-ok" });
  const st = document.getElementById("ext-status");
  out.extStatus = (st?.textContent ?? "").includes("smoke-ok");
  client.renderStatusItem({ statusKey: "smoke", statusText: undefined });

  // dialog 倒计时 + 清理
  client.openModal("Smoke Dialog", "extension-confirm");
  client.currentExtRequest = { id: "smoke-dialog", title: "Smoke Dialog" };
  client.startDialogCountdown({ deadline: Date.now() + 5000 });
  out.dialogTitle = document.getElementById("modal-title").textContent;
  out.countdownTicking = /\([45]s\)/.test(out.dialogTitle);
  client.closeModal();
  out.countdownCleared = client.dialogCountdownTimer === null;

  // confirm 回传 payload
  const sent = [];
  const origSend = client.send.bind(client);
  client.send = (o) => sent.push(o);
  client.openExtensionConfirm({ id: "smoke-confirm", title: "T", message: "M" });
  client.modalList.querySelector(".cancel-btn").click();
  client.send = origSend;
  out.confirmCancel = sent.some((m) => m.type === "extension_ui_response" && m.cancelled === true);

  // 滚动门控：底部时应判定为贴底；上滚后判定为不贴底；
  // 且上滚状态下新事件不得把视图拽回底部（renderEvent 的 wasAtBottom 门控）
  const scroller = document.getElementById("scroll-view");
  scroller.scrollTop = scroller.scrollHeight;
  const atBottom = client.wasAtBottom();
  scroller.scrollTop = 0;
  const notAtBottom = !client.wasAtBottom();
  const topBefore = scroller.scrollTop;
  client.renderEvent({
    type: "entry_appended",
    entry: { type: "custom", customType: "smoke-scroll", data: { text: "scroll-probe" } },
  });
  const notYanked = scroller.scrollTop === topBefore;
  out.scrollGate = { atBottomWhenBottom: atBottom, notAtBottomAfterScrollUp: notAtBottom, notYankedWhileScrolledUp: notYanked };

  // ---- 键盘导航（判据是单选/多选，不是对话框类型；对齐 TUI select 语义）----
  const key = (k) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const cursorIndex = () => client.modalCursorItems().findIndex((el) => el.classList.contains("cursor"));
  const picked = [];
  const sentNav = [];
  const origSendNav = client.send.bind(client);

  // 单选列表（用 model 形态 + 自造列表，避免真的切换模型）：↑↓ 循环、PageDown、Enter 选中
  client.openModal("Smoke List", "model");
  const listSearchVisible = client.modalSearch.style.display;
  client.renderModalItems([{ name: "a" }, { name: "b" }, { name: "c" }], (item) => picked.push(item.name));
  out.navList = { initial: cursorIndex(), searchVisible: listSearchVisible };
  key("ArrowDown");
  out.navList.afterDown = cursorIndex();
  key("ArrowUp");
  key("ArrowUp"); // 1 → 0 → 2（首尾循环）
  out.navList.afterWrapUp = cursorIndex();
  key("PageDown"); // 2 + 10 → 0（取模）
  out.navList.afterPageDown = cursorIndex();
  key("Enter"); // 选中光标项
  out.navList.picked = picked.slice();

  // confirm 是单选（Confirm/Cancel 两个按钮）：光标起始在第一项，Enter 激活之
  client.send = (o) => sentNav.push(o);
  client.openExtensionConfirm({ id: "smoke-nav-confirm", title: "T", message: "M" });
  out.confirmNav = {
    focus: document.activeElement?.id || document.activeElement?.tagName,
    initial: cursorIndex(),
    searchHidden: client.modalSearch.style.display,
  };
  key("ArrowDown");
  out.confirmNav.afterDown = cursorIndex();
  key("Enter"); // 激活第二项 = Cancel
  out.confirmNav.sent = sentNav.map((m) => `${m.type}:${m.cancelled === true ? "cancelled" : ""}`);

  // 多选（scoped-models）：Enter = 切换勾选（TUI scoped-models-selector "Toggle on Enter"）
  client.openModal("Smoke Scoped", "scoped-models");
  client.scopedModelsAll = [{ provider: "p", id: "m1" }, { provider: "p", id: "m2" }];
  client.scopedModelsSelected = new Set(["p/m1"]);
  client.scopedModelsSaved = true;
  sentNav.length = 0;
  client.renderScopedModelsList();
  out.scopedNav = { initial: cursorIndex(), before: [...client.scopedModelsSelected] };
  key("Enter"); // 光标在 p/m1（已勾选）→ 取消勾选
  out.scopedNav.after = [...client.scopedModelsSelected];
  out.scopedNav.sent = sentNav.map((m) => m.type);
  client.send = origSendNav;
  client.closeModal();

  // 页脚 model 链接 = 只列 scoped models（与 `>>` 同一集合），选中即切换
  const sentModel = [];
  const origSendModel = client.send.bind(client);
  client.send = (o) => sentModel.push(o);
  client.lastState = {
    ...(client.lastState || {}),
    model: { provider: "p", id: "m2" },
    scopedModels: [
      { provider: "p", id: "m1", name: "Model One" },
      { provider: "p", id: "m2", name: "Model Two", thinkingLevel: "high" },
    ],
  };
  client.openScopedModelPicker();
  const scopedItems = [...client.modalList.querySelectorAll(".modal-item")];
  out.scopedPicker = {
    open: client.modalOverlay.style.display !== "none",
    mode: client.modalMode,
    count: scopedItems.length,
    labels: scopedItems.map((el) => el.querySelector(".modal-item-name")?.textContent ?? ""),
    searchHidden: client.modalSearch.style.display,
  };
  scopedItems[0]?.click(); // 选中第一项 → set_model
  out.scopedPicker.sent = sentModel.filter((m) => m.type === "set_model");

  // 空 scope：提示而不弹空框
  client.lastState = { ...client.lastState, scopedModels: [] };
  client.openScopedModelPicker();
  // 注意：appendNotifyLine 对同类型会原地更新（TUI showStatus 语义），故断言文本而非行数
  const notifyLines = [...document.querySelectorAll(".notify-line")];
  out.emptyScoped = {
    modalOpen: client.modalOverlay.style.display !== "none",
    notified: notifyLines.some((el) => (el.textContent || "").includes("未配置 scoped models")),
  };
  client.send = origSendModel;
  client.closeModal();
  client.lastState = { ...client.lastState, scopedModels: [] };

  // 清理本次注入的节点（按 smoke 标签精确识别，避免误判会话里本就存在的块）
  const cleanup = () => {
    for (const el of [...document.querySelectorAll(".special-block")]) {
      const label = el.querySelector(".special-label")?.textContent ?? "";
      if (label.includes("smoke")) el.remove();
    }
    for (const el of [...document.querySelectorAll(".widget-block")]) {
      if ((el.dataset.widgetKey ?? "").includes("smoke")) el.remove();
    }
  };
  cleanup();
  out.leftovers = {
    smokeBlocks: [...document.querySelectorAll(".special-block")].filter((el) =>
      (el.querySelector(".special-label")?.textContent ?? "").includes("smoke"),
    ).length,
    smokeWidgets: document.querySelectorAll('[data-widget-key="smoke-widget"]').length,
  };

  client.ws?.close?.();
  return out;
});

check("markdown：标题/列表/代码块", results.markdown.h2 && results.markdown.ul && results.markdown.pre, JSON.stringify(results.markdown));
check(
  "代码块 pre-wrap 且无横向滚动",
  results.codeWrap.whiteSpace === "pre-wrap" && results.codeWrap.noXScroll,
  JSON.stringify(results.codeWrap),
);
check("custom 消息实时渲染（display=true）", results.customLiveShown === 1, `+${results.customLiveShown}`);
check("custom 消息实时静默（display=false）", results.customLiveHidden === 0, `+${results.customLiveHidden}`);
check("custom_message 历史静默（display=false）", results.customHistHidden === 0, `+${results.customHistHidden}`);
check("custom_message 历史渲染（display=true）", results.customHistShown === 1, `+${results.customHistShown}`);
check("custom_message 历史渲染（display=字符串）", results.customHistString === 1, `+${results.customHistString}`);
check("appendEntry 无 data.text 静默", results.appendEntryNoText === 0, `+${results.appendEntryNoText}`);
check("appendEntry 有 data.text 渲染", results.appendEntryWithText === 1, `+${results.appendEntryWithText}`);
check("widget 渲染 + ANSI→HTML", results.widget.present && results.widget.ansi, JSON.stringify(results.widget));
check("tool block 创建", results.toolBlock);
check("ext-status 渲染", results.extStatus);
check("dialog 倒计时显示 (Ns)", results.countdownTicking, results.dialogTitle);
check("dialog 关闭后计时器清理", results.countdownCleared);
check("confirm 取消回传 extension_ui_response", results.confirmCancel);
check(
  "键盘导航：列表光标 初始/↓/循环/PageDown",
  results.navList.initial === 0 &&
    results.navList.afterDown === 1 &&
    results.navList.afterWrapUp === 2 &&
    results.navList.afterPageDown === 0,
  JSON.stringify(results.navList),
);
check(
  "键盘导航：Enter 选中光标项（单选）",
  results.navList.picked.length === 1 && results.navList.picked[0] === "a",
  JSON.stringify(results.navList.picked),
);
check(
  "confirm 作单选：光标起始在 Confirm、↓ 移动、Enter 激活",
  results.confirmNav.initial === 0 &&
    results.confirmNav.afterDown === 1 &&
    results.confirmNav.sent.some((s) => s.startsWith("extension_ui_response")),
  JSON.stringify(results.confirmNav),
);
check(
  "多选（scoped-models）：Enter = 切换勾选",
  results.scopedNav.before.join() === "p/m1" &&
    results.scopedNav.after.length === 0 &&
    results.scopedNav.sent.includes("set_scoped_models"),
  JSON.stringify(results.scopedNav),
);
check(
  "页脚 model 链接：只列 scoped models（非全量）+ 当前项标注",
  results.scopedPicker.open &&
    results.scopedPicker.mode === "model-scoped" &&
    results.scopedPicker.count === 2 &&
    // 当前模型是 m2 → 标记应落在第二项，而不是第一项
    results.scopedPicker.labels[0]?.includes("(current)") === false &&
    results.scopedPicker.labels[1]?.includes("(current)") === true,
  JSON.stringify(results.scopedPicker),
);
check(
  "页脚 model 链接：选中即发 set_model（不弹全量目录）",
  results.scopedPicker.sent.length === 1 &&
    results.scopedPicker.sent[0].provider === "p" &&
    results.scopedPicker.sent[0].modelId === "m1",
  JSON.stringify(results.scopedPicker.sent),
);
check(
  "未配置 scoped models 时：提示而不弹空框",
  results.emptyScoped.modalOpen === false && results.emptyScoped.notified === true,
  JSON.stringify(results.emptyScoped),
);
check(
  "搜索框可见性由 modal 形态决定（列表显示 / confirm 隐藏）",
  results.navList.searchVisible === "block" && results.confirmNav.searchHidden === "none",
  `list=${results.navList.searchVisible} confirm=${results.confirmNav.searchHidden}`,
);
check(
  "非搜索型 modal 焦点不落在隐藏输入框",
  results.confirmNav.focus === "modal",
  `activeElement=${results.confirmNav.focus}`,
);
check(
  "滚动门控（底部判定 / 上滚判定 / 上滚不被拽下）",
  results.scrollGate.atBottomWhenBottom &&
    results.scrollGate.notAtBottomAfterScrollUp &&
    results.scrollGate.notYankedWhileScrolledUp,
  JSON.stringify(results.scrollGate),
);

// 注入节点应已被清理，且全程无新增 pageerror
check(
  "测试注入的节点已清理（不污染会话视图）",
  results.leftovers.smokeBlocks === 0 && results.leftovers.smokeWidgets === 0,
  JSON.stringify(results.leftovers),
);
check("全程无新增 pageerror", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? "全部通过" : `${failures} 项失败`}` +
    `${skips ? `（${skips} 项跳过）` : ""} — 共 ${total} 项检查`,
);
process.exit(failures === 0 ? 0 : 1);
