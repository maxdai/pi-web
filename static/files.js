// pi-web 文件浏览器（设计文档 §28）——只读、走 /fs/* JSON 接口。
// token 由服务端注入到页面里（__PI_WEB_FS_TOKEN__），所有请求都带 header。

const TOKEN = window.__PI_WEB_FS_TOKEN__ || "";
const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

const state = {
  path: null,
  entries: [],
  truncated: false,
  filter: "",
  sort: "name", // name | mtime
  showHidden: localStorage.getItem("piweb-fs-hidden") !== "0",
  wrap: localStorage.getItem("piweb-fs-wrap") !== "0",
  split: Number(localStorage.getItem("piweb-fs-split")) || 0.42, // 列表占左栏比例
  listOpen: localStorage.getItem("piweb-fs-list") !== "0",
  selected: null, // 当前查看的文件
  pendingMode: null, // 下一次 openFile 想要的视图（null = 默认预览）
  viewMode: "source", // 当前实际视图：source | preview（带 &line= 时会强制 source）
  objectUrls: [], // 图片 blob URL，切换/关闭时释放
};

const el = (id) => document.getElementById(id);
const clampSplit = (value) => Math.min(0.8, Math.max(0.2, value));
const listEl = el("fs-list");
const viewEl = el("fs-view");
const textEl = el("fs-text");
const imageEl = el("fs-image");
const noteEl = el("fs-note");
const previewEl = el("fs-preview");

function apiHeaders() {
  return { "x-pi-web-fs-token": TOKEN };
}

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.body = data; // 服务端会把解析出的绝对路径放在 body.path 里（文件链接要用）
    throw err;
  }
  return data;
}

function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)}${units[unit]}`;
}

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const isHidden = (name) => name.startsWith(".");

/** 文本行数（把末尾换行当作结束而不是空行）。 */
function countLines(text) {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function fileUrl(path, download = false) {
  const url = new URL("/fs/raw", location.origin);
  url.searchParams.set("path", path);
  if (download) url.searchParams.set("download", "1");
  return url.toString();
}

function currentEntries() {
  const needle = state.filter.trim().toLowerCase();
  let rows = state.entries.filter((entry) => {
    if (!state.showHidden && isHidden(entry.name)) return false;
    if (needle && !entry.name.toLowerCase().includes(needle)) return false;
    return true;
  });
  rows = rows.slice().sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (state.sort === "mtime") return (b.mtime || 0) - (a.mtime || 0);
    return a.name.localeCompare(b.name, "en");
  });
  return rows;
}

function renderCrumbs(basePath = state.path) {
  const nav = el("fs-crumbs");
  nav.innerHTML = "";
  const parts = (basePath || "/").split("/").filter(Boolean);
  const add = (label, target) => {
    const a = document.createElement("a");
    a.href = "#";
    a.className = "fs-crumb";
    a.textContent = label;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(target);
    });
    nav.appendChild(a);
  };
  add("/", "/");
  let acc = "";
  parts.forEach((part, index) => {
    acc += `/${part}`;
    // 根那一段本身以 "/" 结尾 → 第一段不再补分隔符（否则出现 "//root/…"）
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "fs-sep";
      sep.textContent = "/";
      nav.appendChild(sep);
    }
    add(part, acc);
  });
}

function renderList() {
  const rows = currentEntries();
  listEl.innerHTML = "";
  if (state.path !== "/") {
    const up = document.createElement("div");
    up.className = "fs-row dir";
    up.innerHTML = '<span class="fs-icon">↰</span><span class="fs-name">..</span>';
    up.addEventListener("click", () => navigate(state.path.replace(/\/[^/]+\/?$/, "") || "/"));
    listEl.appendChild(up);
  }
  for (const entry of rows) {
    const row = document.createElement("div");
    row.className = `fs-row ${entry.dir ? "dir" : "file"}`;
    const icon = document.createElement("span");
    icon.className = "fs-icon";
    icon.textContent = entry.dir ? "▸" : "·";
    const name = document.createElement("span");
    name.className = "fs-name";
    name.textContent = entry.name + (entry.link ? " →" : "");
    const size = document.createElement("span");
    size.className = "fs-size";
    size.textContent = entry.dir ? "" : fmtSize(entry.size);
    const time = document.createElement("span");
    time.className = "fs-time";
    time.textContent = fmtTime(entry.mtime);
    row.append(icon, name, size, time);
    row.addEventListener("click", () => {
      if (entry.dir) navigate(joinPath(state.path, entry.name));
      else openFile(joinPath(state.path, entry.name));
    });
    listEl.appendChild(row);
  }
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fs-empty";
    empty.textContent = state.truncated ? "too many entries — use the filter" : "empty directory";
    listEl.appendChild(empty);
  }
  if (state.truncated) {
    const note = document.createElement("div");
    note.className = "fs-note";
    note.textContent = `目录条目超过上限，只显示前 2000 项（用 filter 收窄）`;
    listEl.appendChild(note);
  }
}

function joinPath(dir, name) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

async function navigate(path, line = 0) {
  closeView();
  try {
    await loadDir(path);
  } catch (err) {
    // 传入的是**文件**而不是目录：消息流里的路径链接（§28.4）就属于这种，
    // 早先只调 /fs/list → "not a directory"，链接点了打不开（2026-11-05 用户实测反馈）。
    const target = err.body && err.body.path;
    if (err.body && err.body.error === "not a directory" && target) {
      await loadDir(target.replace(/\/[^/]+$/, "") || "/");
      await openFile(target, line);
      return;
    }
    // 错误必须显示在**左侧列表区**：早先只写进 #fs-note，而那个提示条在"还没打开文件"时
    // 整个查看器是隐藏的 → 页面一片空白、没有任何反馈（2026-11-05 用户实测 /files?path=/old）✗
    const attempted = (err.body && err.body.path) || path || "/";
    const parent = attempted.replace(/\/[^/]+$/, "") || "/";
    renderCrumbs(parent);
    showListError(`打不开：${err.message}`, attempted);
  }
}

/** 列表区的错误提示（含尝试过的路径，并给出可回到上级的面包屑）。 */
function showListError(message, attemptedPath) {
  listEl.innerHTML = "";
  const box = document.createElement("div");
  box.className = "fs-empty fs-error";
  box.textContent = message;
  listEl.appendChild(box);
  if (attemptedPath) {
    const detail = document.createElement("div");
    detail.className = "fs-empty fs-error-path";
    detail.textContent = attemptedPath;
    listEl.appendChild(detail);
  }
}

/** 只刷新左侧目录列表（不动右侧查看器）。 */
async function loadDir(path) {
  const data = await api("/fs/list", { path });
  state.path = data.path;
  state.entries = data.entries || [];
  state.truncated = Boolean(data.truncated);
  history.replaceState(null, "", `/files?path=${encodeURIComponent(state.path)}`);
  renderCrumbs();
  renderList();
}


/**
 * 记录当前阅读位置（刷新前后保持，方便对着改动看）。
 * 折行模式按**行号**锚定（插入/删除行后仍停在同一行）；非折行模式按像素（两列布局没有行元素）。
 */
function captureViewAnchor() {
  if (textEl.hidden) return null;
  const base = { scrollTop: textEl.scrollTop, scrollLeft: textEl.scrollLeft, line: null };
  if (!state.wrap) return base;
  // 视口内**最上面那一行**的行号：二分查找（行的 rect 单调递增），比 elementFromPoint 可靠
  // ——后者在 padding 区域会命中容器本身而不是行元素（实测拿到 null ✗）。
  const rows = textEl.querySelectorAll(".fs-line");
  if (rows.length === 0) return base;
  const top = textEl.getBoundingClientRect().top;
  let lo = 0;
  let hi = rows.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > top) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  base.line = Number(rows[found].dataset.line) || null;
  return base;
}

function restoreViewAnchor(anchor) {
  if (!anchor || textEl.hidden) return;
  if (state.wrap && anchor.line) {
    const row = textEl.querySelector(`.fs-line[data-line="${anchor.line}"]`);
    if (row) {
      const delta = row.getBoundingClientRect().top - textEl.getBoundingClientRect().top;
      textEl.scrollTop += delta;
      return;
    }
  }
  textEl.scrollTop = anchor.scrollTop;
  textEl.scrollLeft = anchor.scrollLeft;
}


// ---------------------------------------------------------------- 富文本预览（设计 §29）

/** 按扩展名判断可预览的类型。 */
function fileKind(path) {
  const m = /\.([^./\\]+)$/.exec(path || "");
  const ext = m ? m[1].toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "json") return "json";
  if (ext === "jsonc") return "jsonc";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  return "";
}

/** 字符串感知地剥掉 JSONC 的 // 与 /* *\/ 注释（行注释保留换行，行号不变）。 */
function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 1;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** 字符串感知地去掉尾逗号（只删 `,` 后面只剩空白再接 `}` / `]` 的情况）。 */
function dropTrailingCommas(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

const escapeText = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 单行 JSON 着色（键/字符串/数字/布尔/null/标点）。输入是**一整行原始文本**。 */
function highlightJsonLine(line) {
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    out += escapeText(line.slice(last, m.index));
    if (m[1]) {
      const isKey = Boolean(m[2]);
      out += `<span class="${isKey ? "json-key" : "json-str"}">${escapeText(m[1])}</span>`;
      if (m[2]) out += `<span class="json-punc">${escapeText(m[2])}</span>`;
    } else if (m[3]) {
      out += `<span class="json-bool">${escapeText(m[3])}</span>`;
    } else if (m[4]) {
      out += `<span class="json-num">${escapeText(m[4])}</span>`;
    } else if (m[5]) {
      out += `<span class="json-punc">${escapeText(m[5])}</span>`;
    }
    last = m.index + m[0].length;
  }
  out += escapeText(line.slice(last));
  return out;
}

/** 渲染带行号的代码行（每行单独一个 flex 行，行号与折行对齐）。 */
function renderCodeLines(lines, { html = false, badLines = null } = {}) {
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "fs-line";
    row.dataset.line = String(i + 1);
    const no = document.createElement("span");
    no.className = "fs-lineno";
    no.textContent = String(i + 1);
    const code = document.createElement("span");
    code.className = "fs-linecode";
    if (badLines && badLines.has(i)) code.classList.add("json-bad");
    if (html) code.innerHTML = line.length ? line : " ";
    else code.textContent = line.length ? line : " ";
    row.append(no, code);
    frag.appendChild(row);
  });
  return frag;
}

/** markdown：渲染 → 消毒 → 相对图片/链接改写。 */
async function renderMarkdownPreview(container, text, filePath) {
  const raw = window.marked ? window.marked.parse(text, { breaks: true, gfm: true }) : escapeText(text);
  const html = window.sanitizeHtml ? window.sanitizeHtml(raw) : raw;
  const box = document.createElement("div");
  box.className = "fs-preview-body body-text";
  box.innerHTML = html;

  // 相对图片先在**挂到 DOM 之前**摘掉 src 并记下真实路径：否则浏览器会立刻按页面路径请求一次
  // （实测 404 /pic.png），随后我们才换成 blob URL。
  const baseDir = filePath.replace(/\/[^/]*$/, "");
  const pendingImgs = [];
  for (const img of [...box.querySelectorAll("img[src]")]) {
    const src = img.getAttribute("src");
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
    img.removeAttribute("src");
    img.dataset.fsSrc = src.startsWith("/") ? src : resolveRelative(baseDir, src);
    pendingImgs.push(img);
  }

  container.textContent = "";
  container.appendChild(box);

  // 相对链接：在文件页内跳转；外链新标签
  for (const a of box.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener";
      continue;
    }
    const target = href.startsWith("/") ? href : resolveRelative(baseDir, href.split("#")[0]);
    if (target) {
      a.href = `/files?path=${encodeURIComponent(target)}${href.includes("#") ? href.slice(href.indexOf("#")) : ""}`;
    }
  }
  // 相对图片：走 /fs/raw（带 token → blob，见 §29.3）
  await Promise.all(
    pendingImgs.map(async (img) => {
      const target = img.dataset.fsSrc;
      if (!target) return;
      try {
        img.src = await blobUrlFor(target);
      } catch {
        img.replaceWith(document.createTextNode(`[图片加载失败：${target}]`));
      }
    }),
  );
}

/** 拼接相对路径（../ 与 ./ 归一化）。 */
function resolveRelative(baseDir, rel) {
  if (!rel) return "";
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** 图片必须带 token 取，`<img src>` 无法带头 → fetch 成 blob URL（§29.3）。 */
async function blobUrlFor(path) {
  const res = await fetch(fileUrl(path), { headers: apiHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  return url;
}

function releaseObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

/** 预览内容（md / json / jsonc / jsonl）。失败返回 false，交由源码视图兜底。 */
async function renderPreview(kind, path, text) {
  releaseObjectUrls();
  previewEl.textContent = "";
  if (kind === "md") {
    await renderMarkdownPreview(previewEl, text, path);
    buildLineMap(); // 给预览块打 data-src-line（§29.6）
    return true;
  }
  if (kind === "json" || kind === "jsonc") {
    let parsed;
    try {
      const source = kind === "jsonc" ? dropTrailingCommas(stripJsonComments(text)) : text;
      parsed = JSON.parse(source);
    } catch (err) {
      showNote(`JSON 解析失败（${err.message}）—— 已切换到源码视图`);
      return false;
    }
    const pretty = JSON.stringify(parsed, null, 2).split("\n");
    previewEl.appendChild(renderCodeLines(pretty.map(highlightJsonLine), { html: true }));
    return true;
  }
  if (kind === "jsonl") {
    // 一行一条，**不展开**：行号 = 文件真实行号
    const lines = text.replace(/\n$/, "").split("\n");
    const bad = new Set();
    const html = lines.map((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      try {
        JSON.parse(trimmed);
      } catch {
        bad.add(i);
      }
      return highlightJsonLine(line);
    });
    previewEl.appendChild(renderCodeLines(html, { html: true, badLines: bad }));
    if (bad.size > 0) showNote(`${bad.size} 行不是合法 JSON（已标红，原文保留）`);
    return true;
  }
  return false;
}

function showNote(text) {
  noteEl.hidden = !text;
  noteEl.textContent = text || "";
}

function closeView() {
  if (state.selected && state.path) {
    history.replaceState(null, "", `/files?path=${encodeURIComponent(state.path)}`);
  }
  state.selected = null;
  viewEl.hidden = true;
  applySplit();
  textEl.textContent = "";
  previewEl.textContent = "";
  previewEl.hidden = true;
  imageEl.innerHTML = "";
  releaseObjectUrls();
  showNote("");
}

function isImage(path) {
  return /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(path);
}

async function openFile(path, line = 0) {
  state.raw = null;
  const anchor = state.selected === path ? captureViewAnchor() : null;
  // 预览视图的"刷新"也要保持位置：源码视图用行锚点，预览只能按比例
  const previewRatio = state.selected === path && !previewEl.hidden ? currentScrollRatio() : null;
  state.selected = path;
  // URL 跟着文件走：刷新后仍停在这个文件（链接分享/直达也一致）
  history.replaceState(null, "", `/files?path=${encodeURIComponent(path)}`);
  viewEl.hidden = false;
  // 打开文件＝要读内容 → 左侧列表自动收起，正文占满整宽（用户点 « / » 仍可随时切换）
  state.listOpen = false;
  applySplit();
  textEl.textContent = "";
  previewEl.textContent = "";
  previewEl.hidden = true;
  imageEl.innerHTML = "";
  showNote("");
  el("fs-view-name").textContent = path;
  el("fs-view-meta").textContent = "";
  el("fs-download").href = fileUrl(path, true);
  const kind = fileKind(path);
  state.kind = kind;
  updatePreviewToggle(kind);

  if (isImage(path)) {
    releaseObjectUrls();
    textEl.hidden = true;
    imageEl.hidden = false;
    const img = document.createElement("img");
    img.alt = path;
    img.addEventListener("error", () => showNote("图片加载失败（可能不是合法图片）"));
    imageEl.appendChild(img);
    try {
      img.src = await blobUrlFor(path); // <img src> 带不了 token → blob（§29.3）
    } catch (err) {
      showNote(`图片加载失败：${err.message}`);
    }
    return;
  }

  try {
    const data = await api("/fs/text", { path });
    state.raw = data.text || ""; // 供内容锚点查找使用（§29.6）
    const lines = countLines(data.text || "");
    el("fs-view-meta").textContent =
      `${fmtSize(data.size)} · ${lines.toLocaleString()} lines` +
      (data.truncated ? `（前 ${fmtSize(TEXT_PREVIEW_BYTES)}）` : "");
    if (data.binary) {
      textEl.hidden = true;
      imageEl.hidden = true;
      showNote("二进制文件（不预览）—— 用 download 下载");
      return;
    }
    imageEl.hidden = true;
    // 视图选择（§29.6）：**默认预览**；带行号跳转强制源码；"切换视图/刷新"这类操作传一次性 pendingMode。
    const wanted = state.pendingMode || "preview"; // 默认预览；&line= 不再强制源码（§29.6）
    state.pendingMode = null;
    state.viewMode = "source";
    if (kind && wanted === "preview" && !data.binary) {
      const ok = await renderPreview(kind, path, data.text || "");
      if (ok) {
        state.viewMode = "preview";
        updatePreviewToggle(kind);
        textEl.hidden = true;
        previewEl.hidden = false;
        if (pendingSwitch) {
          const sw = pendingSwitch;
          pendingSwitch = null;
          if (!applySwitchAnchor(sw)) applyScrollRatio(sw.ratio);
        } else if (line > 0) {
          scrollPreviewToLine(line); // 改动列表的 &line= → 预览里滚到对应块（§29.6）
        } else if (previewRatio !== null) {
          applyScrollRatio(previewRatio);
        }
        if (data.truncated) showNote(`文件较大，预览只覆盖前 ${fmtSize(TEXT_PREVIEW_BYTES)}；完整内容请 download`);
        return;
      }
      // 解析失败等 → 落到源码视图
    }
    textEl.hidden = false;
    previewEl.hidden = true;
    updatePreviewToggle(kind);
    renderText(data.text || "");
    if (line > 0) focusLine(line);
    else if (pendingSwitch) {
      const sw = pendingSwitch;
      pendingSwitch = null;
      if (!applySwitchAnchor(sw)) applyScrollRatio(sw.ratio);
    } else restoreViewAnchor(anchor); // 刷新后回到原来的行
    if (data.truncated) showNote(`文件较大，只显示前 ${fmtSize(TEXT_PREVIEW_BYTES)}；完整内容请 download`);
  } catch (err) {
    showNote(`读不了这个文件：${err.message}`);
  }
}

/**
 * 渲染文本正文。
 * - 折行模式：每行一个 `.fs-line`（行号 + 内容），文字 `pre-wrap` —— 行号与折行后的内容仍对齐；
 * - 非折行模式：行号列 + 正文列两列，横向滚动（等宽对齐、便于看表格/对齐代码）。
 * 两种模式都按行数截断渲染（折行模式 DOM 行更多，上限更小），避免几万行卡住页面。
 */
function renderText(text) {
  const lines = text.split("\n");
  const wrap = state.wrap;
  const max = wrap ? 5000 : 20000;
  const shown = lines.length > max ? lines.slice(0, max) : lines;
  textEl.textContent = "";
  textEl.classList.toggle("wrap", wrap);
  if (wrap) {
    const frag = document.createDocumentFragment();
    shown.forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "fs-line";
      row.dataset.line = String(i + 1);
      const no = document.createElement("span");
      no.className = "fs-lineno";
      no.textContent = String(i + 1);
      const code = document.createElement("span");
      code.className = "fs-linecode";
      code.textContent = line.length ? line : " ";
      row.append(no, code);
      frag.appendChild(row);
    });
    textEl.appendChild(frag);
  } else {
    const width = String(shown.length).length;
    const gutter = shown.map((_, i) => String(i + 1).padStart(width, " ")).join("\n");
    const g = document.createElement("span");
    g.className = "fs-gutter";
    g.textContent = gutter;
    const body = document.createElement("span");
    body.className = "fs-code";
    body.textContent = shown.join("\n");
    textEl.append(g, body);
  }
  if (lines.length > max) showNote(`文件行数过多，只渲染前 ${max} 行（${wrap ? "折行模式" : "非折行模式"}）；完整内容请 download`);
}


// ---------------------------------------------------------------- 行号 ↔ 预览块映射（§29.6）

/**
 * 预览渲染后没有"源码行号"信息（marked 不提供 sourcemap），所以**一次性**建立映射：
 * 源码行与预览块都在文档顺序上单调，做一次顺序对齐即可给每个命中的块打上
 * `data-src-line`（相当于用户说的"隐藏标记"）——之后两边都往这个标记跳，不再做文本模糊匹配。
 */
let lineMap = null; // [{ line, el }]，line 递增

function buildLineMap() {
  lineMap = null;
  const body = previewEl.querySelector(".fs-preview-body");
  if (!body || !state.raw) return;
  const blocks = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,table,td,th,blockquote")];
  if (blocks.length === 0) return;
  const texts = blocks.map((el) => normText(el.textContent));
  const lines = state.raw.split("\n");
  const map = [];
  let bi = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = normText(lines[i]);
    const meaningful = (t.match(/[\p{L}\p{N}]/gu) || []).length;
    if (meaningful < 4) continue; // 空行、围栏、表格分隔线不参与
    const short = t.slice(0, 12);
    // 只往前走（两边顺序一致），最多向前找 120 个块
    for (let j = bi; j < Math.min(blocks.length, bi + 120); j++) {
      if (!texts[j].includes(short)) continue;
      bi = j;
      blocks[j].dataset.srcLine = String(i + 1);
      map.push({ line: i + 1, el: blocks[j] });
      break;
    }
  }
  lineMap = map;
}

/** 找 line 对应的预览块：取 srcLine ≤ line 的最后一个（映射是稀疏的）。 */
function previewBlockForLine(line) {
  if (!lineMap || lineMap.length === 0) return null;
  let lo = 0;
  let hi = lineMap.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineMap[mid].line <= line) {
      best = lineMap[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ? best.el : lineMap[0].el;
}

/** 预览顶部可见块对应的源码行号（用 data-src-line，没有就往前找最近有标记的块）。 */
function sourceLineForPreviewTop() {
  const body = previewEl.querySelector(".fs-preview-body");
  if (!body) return null;
  const top = previewEl.getBoundingClientRect().top;
  const blocks = [...body.querySelectorAll("[data-src-line]")];
  if (blocks.length === 0) return null;
  let candidate = null;
  for (const el of blocks) {
    if (el.getBoundingClientRect().bottom > top + 6) {
      candidate = el;
      break;
    }
  }
  if (!candidate) candidate = blocks[blocks.length - 1];
  return Number(candidate.dataset.srcLine) || null;
}

// ---------------------------------------------------------------- 视图切换保持位置（§29.6）

/**
 * 切换 preview / source 时携带的"锚点"。
 * 渲染会改变行数与行高（空行消失、标题变高、表格加边框、段落折行），所以不能按行号换算：
 * 优先用**内容锚点**（顶部可见行的文本），匹配不到再退回滚动比例。
 */
let pendingSwitch = null;

/** 归一化：去掉 markdown 标记符号、压缩空白。 */
function normText(value) {
  return String(value ?? "")
    .replace(/[`*_#>~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 当前可见视图的滚动比例（没有可滚动的就返回 0）。 */
function currentScrollRatio() {
  const pane = !previewEl.hidden ? previewEl : textEl;
  const max = pane.scrollHeight - pane.clientHeight;
  if (!(max > 0)) return 0;
  return Math.min(1, Math.max(0, pane.scrollTop / max));
}

/** 把比例应用回"新视图"（内容锚点匹配失败时的兜底）。 */
function applyScrollRatio(ratio) {
  const pane = !previewEl.hidden ? previewEl : textEl;
  const max = pane.scrollHeight - pane.clientHeight;
  if (max > 0) pane.scrollTop = Math.round(ratio * max);
}

/** 源码视图视口顶部那一行（折行模式按行元素二分；非折行按行高估算）。 */
function currentTopLine() {
  const anchor = captureViewAnchor();
  if (anchor && anchor.line) return anchor.line;
  const total = state.raw ? state.raw.split("\n").length : 0;
  if (!total) return null;
  const code = textEl.querySelector(".fs-code") || textEl.querySelector(".fs-linecode");
  if (!code) return null;
  const lineHeight = code.getBoundingClientRect().height / total;
  if (!(lineHeight > 0)) return null;
  return Math.max(1, Math.min(total, Math.floor(textEl.scrollTop / lineHeight) + 1));
}

/**
 * 源码视图顶部可见行的文本（往下找几行取更有辨识度的一行）。
 * 纯符号行（表格分隔线 `|---|---|`、代码围栏等）归一化后没有实质内容，跳过——
 * 否则会拿 "|" 这种片段去预览里匹配，命中文件最前面的表格 → 看起来"跳回第一行"。
 */
function sourceAnchorText(line) {
  if (!line || !state.raw) return "";
  const lines = state.raw.split("\n");
  for (let i = line - 1; i < Math.min(lines.length, line + 5); i++) {
    const t = normText(lines[i]);
    const meaningful = (t.match(/[\p{L}\p{N}]/gu) || []).length;
    if (meaningful >= 4) return t.slice(0, 60);
  }
  return "";
}

/** 预览视图顶部可见块的文本。 */
function previewAnchorText() {
  const body = previewEl.querySelector(".fs-preview-body");
  if (!body) return "";
  const top = previewEl.getBoundingClientRect().top;
  const blocks = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote");
  for (const el of blocks) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top + 6) continue;
    const t = normText(el.textContent);
    if (t.length >= 8) return t.slice(0, 60);
  }
  return "";
}

/**
 * 在预览正文里找含该文本的元素（按整块 textContent 匹配，行内 code/加粗把文本切开也能命中）。
 * 有多处匹配时取**离预期滚动比例最近**的那一处：文档里重复出现的小标题/表格行很常见，
 * 直接取第一处会让人误以为"跳回第一行"。
 */
function findPreviewElement(needle, expectedRatio = 0) {
  const body = previewEl.querySelector(".fs-preview-body");
  if (!body || !needle) return null;
  const short = needle.slice(0, 24);
  const blocks = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,td,th,blockquote")].filter((el) =>
    normText(el.textContent).includes(short),
  );
  if (blocks.length === 0) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (normText(walker.currentNode.nodeValue).includes(short.slice(0, 12))) {
        return walker.currentNode.parentElement;
      }
    }
    return null;
  }
  if (blocks.length === 1) return blocks[0];
  const max = Math.max(1, previewEl.scrollHeight - previewEl.clientHeight);
  const wanted = expectedRatio * max;
  const paneTop = previewEl.getBoundingClientRect().top;
  let best = blocks[0];
  let bestDist = Infinity;
  for (const el of blocks) {
    const offset = el.getBoundingClientRect().top - paneTop + previewEl.scrollTop;
    const dist = Math.abs(offset - wanted);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }
  return best;
}

/** 在源码里找含该文本的行号（多处命中时取离预期比例最近的一行）。 */
function findSourceLine(needle, expectedRatio = 0) {
  if (!state.raw || !needle) return null;
  const short = needle.slice(0, 24);
  const lines = state.raw.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (normText(lines[i]).includes(short)) hits.push(i + 1);
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  const wanted = expectedRatio * lines.length;
  let best = hits[0];
  let bestDist = Infinity;
  for (const line of hits) {
    const dist = Math.abs(line - wanted);
    if (dist < bestDist) {
      bestDist = dist;
      best = line;
    }
  }
  return best;
}

/** 切到新视图后按锚点定位；返回 false 表示锚点不可用（调用方退回比例）。 */
function applySwitchAnchor(sw) {
  if (!sw) return false;
  if (!previewEl.hidden) {
    if (sw.from !== "source") return false;
    // ① 行号映射（精确）② 文本匹配 ③ 比例
    const el = (sw.line && previewBlockForLine(sw.line)) || (sw.text ? findPreviewElement(sw.text, sw.ratio || 0) : null);
    if (!el) return false;
    const offset = el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop - 8;
    previewEl.scrollTop = Math.max(0, Math.round(offset));
    return true;
  }
  if (sw.from !== "preview") return false;
  const line = sourceLineForPreviewTop() ?? (sw.text ? findSourceLine(sw.text, sw.ratio || 0) : null);
  if (!line) return false;
  focusLine(line, { highlight: false, alignTop: true });
  return true;
}

/** 预览里滚到第 N 行对应的块（用 data-src-line 标记；没有标记就退回比例）。 */
function scrollPreviewToLine(line) {
  const el = previewBlockForLine(line);
  if (!el) {
    applyScrollRatio(Math.min(1, Math.max(0, line / Math.max(1, (state.raw || "").split("\n").length))));
    return;
  }
  const offset = el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop - 10;
  previewEl.scrollTop = Math.max(0, Math.round(offset));
  el.classList.add("fs-block-focus");
  setTimeout(() => el.classList.remove("fs-block-focus"), 2000);
}

// ---------------------------------------------------------------- 定位到指定行

/**
 * 滚到第 N 行（1 基）。
 * 折行模式：每行是独立元素 → 精确滚动 + 高亮闪烁；
 * 非折行模式：只有一个行号栏 + 一大块文本 → 按行高估算滚动（不高亮）。
 */
function focusLine(line, opts = {}) {
  if (!(line > 0)) return;
  const alignTop = opts.alignTop === true; // 视图切换时贴在顶部（居中会让"顶部行"再偏移几行）
  if (state.wrap) {
    const row = textEl.querySelector(`.fs-line[data-line="${line}"]`);
    if (row) {
      if (alignTop) {
        const delta = row.getBoundingClientRect().top - textEl.getBoundingClientRect().top;
        textEl.scrollTop = Math.max(0, textEl.scrollTop + delta - 4);
      } else {
        row.scrollIntoView({ block: "center" });
      }
      if (opts.highlight !== false) {
        row.classList.add("fs-line-focus");
        setTimeout(() => row.classList.remove("fs-line-focus"), 2000);
      }
      return;
    }
  }
  const code = textEl.querySelector(".fs-code") || textEl.querySelector(".fs-linecode");
  if (!code) return;
  const total = (textEl.querySelector(".fs-gutter")?.textContent || "").split("\n").length ||
    textEl.querySelectorAll(".fs-line").length;
  if (!total) return;
  const box = textEl.getBoundingClientRect();
  const lineHeight = code.getBoundingClientRect().height / total;
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  textEl.scrollTop = Math.max(0, (line - 1) * lineHeight - (alignTop ? 4 : box.height / 2 - lineHeight));
}

// ---------------------------------------------------------------- 主题（Dark / Light）

/** 与主页面共用 localStorage 的 `piweb-theme`（页面打开时已由内联脚本先应用一次）。 */
function currentTheme() {
  const stored = localStorage.getItem("piweb-theme");
  return stored === "bright" ? "light" : stored || "light";
}

function applyTheme(name) {
  const light = name === "light";
  document.body.classList.toggle("theme-light", light);
  localStorage.setItem("piweb-theme", light ? "light" : "dark");
  for (const el of document.querySelectorAll(".theme-option")) {
    el.classList.toggle("active", el.dataset.theme === (light ? "light" : "dark"));
  }
}

// ---------------------------------------------------------------- 事件绑定

el("fs-filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});
if (el("fs-hidden")) el("fs-hidden").checked = state.showHidden;
el("fs-hidden").addEventListener("change", (e) => {
  state.showHidden = e.target.checked;
  localStorage.setItem("piweb-fs-hidden", state.showHidden ? "1" : "0");
  renderList();
});
el("fs-sort").addEventListener("click", () => {
  state.sort = state.sort === "name" ? "mtime" : "name";
  el("fs-sort").textContent = state.sort;
  renderList();
});
el("fs-close-view").addEventListener("click", closeView);

/** 预览/源码切换按钮：只在可预览的类型上出现；文案反映**当前实际视图**要切去哪边。 */
function updatePreviewToggle(kind) {
  const btn = el("fs-preview-toggle");
  const supported = Boolean(kind);
  btn.hidden = !supported;
  if (!supported) return;
  const inPreview = state.viewMode === "preview";
  btn.textContent = inPreview ? "source" : "preview";
  btn.title = inPreview ? "Show the raw text (line numbers)" : "Show the rendered preview";
}

el("fs-preview-toggle").addEventListener("click", () => {
  // 以"当前实际视图"为准取反：带 &line= 被强制成 source 时，点一下也能正常进预览
  const useText = state.kind === "md"; // 只有 markdown 两者文本可对应
  const topLine = state.viewMode === "preview" ? null : currentTopLine();
  pendingSwitch = state.viewMode === "preview"
    ? { from: "preview", text: useText ? previewAnchorText() : "", ratio: currentScrollRatio() }
    : { from: "source", line: topLine, text: useText ? sourceAnchorText(topLine) : "", ratio: currentScrollRatio() };
  // 只影响当前文件：不写入偏好，新打开的文件仍默认预览（§29.6）
  state.pendingMode = state.viewMode === "preview" ? "source" : "preview";
  if (state.selected) openFile(state.selected);
});
el("fs-refresh").addEventListener("click", () => {
  state.pendingMode = state.viewMode; // 刷新保持当前视图
  if (state.selected) openFile(state.selected); // 重新读盘（文本走 no-store，图片加时间戳破缓存）
});

/** 列表/查看器分栏：`#fs-list` 用固定百分比，拖动分栏条调整并记忆；列表可整体收起。 */
function applySplit() {
  const viewOpen = !viewEl.hidden;
  // 没有打开文件时列表总是显示：否则"收起了列表 + 刷新页面"会得到一片空白（只剩顶栏按钮）✗
  const listOpen = state.listOpen || !viewOpen;
  listEl.hidden = !listOpen;
  el("fs-splitter").hidden = !viewOpen || !listOpen;
  if (!listOpen) {
    listEl.style.flex = "";
    viewEl.style.flex = "1 1 100%";
  } else if (!viewOpen) {
    listEl.style.flex = "1 1 100%";
    viewEl.style.flex = "";
  } else {
    listEl.style.flex = `0 0 ${(state.split * 100).toFixed(2)}%`;
    viewEl.style.flex = "1 1 auto";
  }
  const btn = el("fs-toggle-list");
  // 没有打开文件时按钮本身不显示：此时列表本来就占满整宽，"收起"会变成一个按了没反应的按钮 ✗
  btn.hidden = !viewOpen;
  btn.textContent = state.listOpen ? "«" : "»";
  btn.title = state.listOpen ? "Collapse the file list" : "Expand the file list";
}
function startSplitDrag(startEvent) {
  startEvent.preventDefault();
  const mainRect = el("fs-main").getBoundingClientRect();
  const move = (e) => {
    state.split = clampSplit((e.clientX - mainRect.left) / mainRect.width);
    applySplit();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    localStorage.setItem("piweb-fs-split", String(state.split));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
el("fs-splitter").addEventListener("pointerdown", startSplitDrag);

// 一键收起/展开左侧文件列表（不用再手动拖分栏条）
el("fs-toggle-list").addEventListener("click", () => {
  state.listOpen = !state.listOpen;
  localStorage.setItem("piweb-fs-list", state.listOpen ? "1" : "0");
  applySplit();
});
el("fs-splitter").addEventListener("dblclick", () => {
  state.split = 0.42;
  applySplit();
  localStorage.setItem("piweb-fs-split", String(state.split));
});

if (el("fs-wrap")) el("fs-wrap").checked = state.wrap;
el("fs-wrap").addEventListener("change", (e) => {
  state.wrap = e.target.checked;
  localStorage.setItem("piweb-fs-wrap", state.wrap ? "1" : "0");
  if (state.selected) openFile(state.selected); // 重新渲染正文（行号对齐方式不同）
});

// 默认从**当前会话 cwd** 开始：不带 path 时服务端按会话 cwd 解析（§28.3）
applySplit();
localStorage.removeItem("piweb-fs-preview"); // 旧版本记忆的偏好：不再使用（§29.6）
applyTheme(currentTheme());
for (const el of document.querySelectorAll(".theme-option")) {
  el.addEventListener("click", () => applyTheme(el.dataset.theme));
}

const initialPath = new URLSearchParams(location.search).get("path");
const initialLine = Number(new URLSearchParams(location.search).get("line"));
// URL 里带 &line=N（来自"本轮改动文件"的链接）→ 直接定位到该行（§30.6）：
// 行号只对源码视图有意义，所以带行号时强制源码视图（预览没有行号可跳）。
navigate(initialPath || null, initialLine > 0 ? initialLine : 0);
