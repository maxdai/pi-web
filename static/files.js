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
};

const el = (id) => document.getElementById(id);
const clampSplit = (value) => Math.min(0.8, Math.max(0.2, value));
const listEl = el("fs-list");
const viewEl = el("fs-view");
const textEl = el("fs-text");
const imageEl = el("fs-image");
const noteEl = el("fs-note");

function apiHeaders() {
  return { "x-pi-web-fs-token": TOKEN };
}

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
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

function renderCrumbs() {
  const nav = el("fs-crumbs");
  nav.innerHTML = "";
  const parts = (state.path || "/").split("/").filter(Boolean);
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

async function navigate(path) {
  closeView();
  try {
    const data = await api("/fs/list", { path });
    state.path = data.path;
    state.entries = data.entries || [];
    state.truncated = Boolean(data.truncated);
    history.replaceState(null, "", `/files?path=${encodeURIComponent(state.path)}`);
    renderCrumbs();
    renderList();
  } catch (err) {
    showNote(`打不开目录：${err.message}`);
  }
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

function showNote(text) {
  noteEl.hidden = !text;
  noteEl.textContent = text || "";
}

function closeView() {
  state.selected = null;
  viewEl.hidden = true;
  applySplit();
  textEl.textContent = "";
  imageEl.innerHTML = "";
  showNote("");
}

function isImage(path) {
  return /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(path);
}

async function openFile(path) {
  const anchor = state.selected === path ? captureViewAnchor() : null;
  state.selected = path;
  viewEl.hidden = false;
  // 打开文件＝要读内容 → 左侧列表自动收起，正文占满整宽（用户点 « / » 仍可随时切换）
  state.listOpen = false;
  applySplit();
  textEl.textContent = "";
  imageEl.innerHTML = "";
  showNote("");
  el("fs-view-name").textContent = path;
  el("fs-view-meta").textContent = "";
  el("fs-download").href = fileUrl(path, true);

  if (isImage(path)) {
    textEl.hidden = true;
    imageEl.hidden = false;
    const img = document.createElement("img");
    img.src = `${fileUrl(path)}&_=${Date.now()}`;
    img.alt = path;
    img.addEventListener("error", () => showNote("图片加载失败（可能不是合法图片）"));
    imageEl.appendChild(img);
    return;
  }

  try {
    const data = await api("/fs/text", { path });
    el("fs-view-meta").textContent = `${fmtSize(data.size)}${data.truncated ? ` · 只显示前 ${fmtSize(TEXT_PREVIEW_BYTES)}` : ""}`;
    if (data.binary) {
      textEl.hidden = true;
      imageEl.hidden = true;
      showNote("二进制文件（不预览）—— 用 download 下载");
      return;
    }
    textEl.hidden = false;
    imageEl.hidden = true;
    renderText(data.text || "");
    restoreViewAnchor(anchor); // 刷新后回到原来的行
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
el("fs-refresh").addEventListener("click", () => {
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
const initialPath = new URLSearchParams(location.search).get("path");
navigate(initialPath || null);
