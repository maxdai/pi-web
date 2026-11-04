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
  showHidden: false,
  selected: null, // 当前查看的文件
};

const el = (id) => document.getElementById(id);
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
  for (const part of parts) {
    acc += `/${part}`;
    const sep = document.createElement("span");
    sep.className = "fs-sep";
    sep.textContent = "/";
    nav.appendChild(sep);
    add(part, acc);
  }
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

function showNote(text) {
  noteEl.hidden = !text;
  noteEl.textContent = text || "";
}

function closeView() {
  state.selected = null;
  viewEl.hidden = true;
  textEl.textContent = "";
  imageEl.innerHTML = "";
  showNote("");
}

function isImage(path) {
  return /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(path);
}

async function openFile(path) {
  state.selected = path;
  viewEl.hidden = false;
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
    img.src = fileUrl(path);
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
    if (data.truncated) showNote(`文件较大，只显示前 ${fmtSize(TEXT_PREVIEW_BYTES)}；完整内容请 download`);
  } catch (err) {
    showNote(`读不了这个文件：${err.message}`);
  }
}

/** 行号 + 等宽正文；不折行（横向滚动），大文件按行数截断渲染以保持流畅。 */
function renderText(text) {
  const lines = text.split("\n");
  const max = 20000;
  const shown = lines.length > max ? lines.slice(0, max) : lines;
  const width = String(shown.length).length;
  const gutter = shown.map((_, i) => String(i + 1).padStart(width, " ")).join("\n");
  textEl.textContent = "";
  const g = document.createElement("span");
  g.className = "fs-gutter";
  g.textContent = gutter;
  const body = document.createElement("span");
  body.className = "fs-code";
  body.textContent = shown.join("\n");
  textEl.append(g, body);
  if (lines.length > max) showNote(`文件行数过多，只渲染前 ${max} 行；完整内容请 download`);
}

// ---------------------------------------------------------------- 事件绑定

el("fs-filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});
el("fs-hidden").addEventListener("change", (e) => {
  state.showHidden = e.target.checked;
  renderList();
});
el("fs-sort").addEventListener("click", () => {
  state.sort = state.sort === "name" ? "mtime" : "name";
  el("fs-sort").textContent = state.sort;
  renderList();
});
el("fs-close-view").addEventListener("click", closeView);

const initialPath = new URLSearchParams(location.search).get("path") || "/";
navigate(initialPath);
