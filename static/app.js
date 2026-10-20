// pi-web browser client
// Connects to the WebSocket, renders Pi RPC events into a TUI-like view.

const BUILTIN_COMMANDS = [
  { name: 'model', description: 'Select model (opens selector)', builtin: true, action: 'model' },
  { name: 'thinking', description: 'Select thinking level', builtin: true, action: 'thinking' },
  { name: 'scoped-models', description: 'Select models available for cycling', builtin: true, action: 'scoped-models' },
  { name: 'compact', description: 'Manually compact the session context', builtin: true, action: 'compact' },
  { name: 'reload', description: 'Reload session resources and extensions', builtin: true, action: 'reload' },
  { name: 'export', description: 'Export session to HTML (or .jsonl)', builtin: true, action: 'export' },
  { name: 'session', description: 'Show session information', builtin: true, action: 'session' },
  { name: 'resume', description: 'Switch to another session', builtin: true, action: 'resume' },
  { name: 'name', description: 'Set session display name', builtin: true, action: 'name' },
  { name: 'login', description: 'Configure provider authentication (not supported in web)', builtin: true, unsupported: true },
  { name: 'logout', description: 'Remove provider authentication (not supported in web)', builtin: true, unsupported: true },
  { name: 'settings', description: 'Open settings menu (not supported in web)', builtin: true, unsupported: true },
];

// ---------------------------------------------------------------------------
// ANSI escape code to HTML converter.
//
// Extensions build status/widget/notify strings with ANSI escapes (via
// ui.theme.fg/bg, e.g. magic-context's status line). The browser has no
// terminal to render them, so we convert escapes to inline-styled <span>
// here — the browser acts as the "terminal". Pi's own export-html does the
// same conversion server-side (core/export-html/ansi-to-html.ts); this is a
// port of that pure function, matching its behavior.
// ---------------------------------------------------------------------------

// Standard ANSI color palette (0-15)
const ANSI_COLORS = [
  '#000000', // 0: black
  '#800000', // 1: red
  '#008000', // 2: green
  '#808000', // 3: yellow
  '#000080', // 4: blue
  '#800080', // 5: magenta
  '#008080', // 6: cyan
  '#c0c0c0', // 7: white
  '#808080', // 8: bright black
  '#ff0000', // 9: bright red
  '#00ff00', // 10: bright green
  '#ffff00', // 11: bright yellow
  '#0000ff', // 12: bright blue
  '#ff00ff', // 13: bright magenta
  '#00ffff', // 14: bright cyan
  '#ffffff', // 15: bright white
];

/** Convert a 256-color index (0-255) to hex. */
function color256ToHex(index) {
  if (index < 16) return ANSI_COLORS[index];
  if (index < 232) {
    // Color cube (16-231): 6x6x6 = 216 colors
    const cubeIndex = index - 16;
    const r = Math.floor(cubeIndex / 36);
    const g = Math.floor((cubeIndex % 36) / 6);
    const b = cubeIndex % 6;
    const toComponent = (n) => (n === 0 ? 0 : 55 + n * 40);
    const toHex = (n) => toComponent(n).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  // Grayscale (232-255): 24 shades
  const gray = 8 + (index - 232) * 10;
  const grayHex = gray.toString(16).padStart(2, '0');
  return `#${grayHex}${grayHex}${grayHex}`;
}

function escapeHtmlAnsi(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createEmptyStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function styleToInlineCSS(style) {
  const parts = [];
  if (style.fg) parts.push(`color:${style.fg}`);
  if (style.bg) parts.push(`background-color:${style.bg}`);
  if (style.bold) parts.push('font-weight:bold');
  if (style.dim) parts.push('opacity:0.6');
  if (style.italic) parts.push('font-style:italic');
  if (style.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

function hasStyle(style) {
  return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

function applySgrCode(params, style) {
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (code === 0) {
      style.fg = null; style.bg = null; style.bold = false;
      style.dim = false; style.italic = false; style.underline = false;
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 22) {
      style.bold = false; style.dim = false;
    } else if (code === 23) {
      style.italic = false;
    } else if (code === 24) {
      style.underline = false;
    } else if (code >= 30 && code <= 37) {
      style.fg = ANSI_COLORS[code - 30];
    } else if (code === 38) {
      if (params[i + 1] === 5 && params.length > i + 2) {
        style.fg = color256ToHex(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2 && params.length > i + 4) {
        style.fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
    } else if (code === 39) {
      style.fg = null;
    } else if (code >= 40 && code <= 47) {
      style.bg = ANSI_COLORS[code - 40];
    } else if (code === 48) {
      if (params[i + 1] === 5 && params.length > i + 2) {
        style.bg = color256ToHex(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2 && params.length > i + 4) {
        style.bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
    } else if (code === 49) {
      style.bg = null;
    } else if (code >= 90 && code <= 97) {
      style.fg = ANSI_COLORS[code - 90 + 8];
    } else if (code >= 100 && code <= 107) {
      style.bg = ANSI_COLORS[code - 100 + 8];
    }
    i++;
  }
}

// Match ANSI escape sequences: ESC[ followed by params and ending with 'm'
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

// ---------------------------------------------------------------------------
// Modal 键盘导航（对齐 TUI 的 select 语义）
//
// 判据是「单选 vs 多选」，不是对话框类型：
//   单选（resume / model / thinking / 扩展 select / confirm）→ Enter = 选中当前项
//   多选（scoped-models）→ Enter = 切换勾选（TUI scoped-models-selector: "Toggle on Enter"）
// 导航键：↑↓ 循环移动，PageUp/PageDown 跳 10 项，Esc 关闭。
// ---------------------------------------------------------------------------
/** 需要搜索框的 modal 形态（列表型）；其余形态不显示搜索框 */
const SEARCHABLE_MODAL_MODES = new Set(['resume', 'model', 'thinking', 'scoped-models', 'extension-select']);
/** 光标导航适用的形态（列表型 + 单选 confirm 的两个按钮） */
const CURSOR_MODAL_MODES = new Set([...SEARCHABLE_MODAL_MODES, 'extension-confirm', 'model-scoped']);
const CURSOR_PAGE_STEP = 10;

/** Convert ANSI-escaped text to HTML with inline styles. */
function ansiToHtml(text) {
  const style = createEmptyStyle();
  let result = '';
  let lastIndex = 0;
  let inSpan = false;
  ANSI_REGEX.lastIndex = 0;
  let match = ANSI_REGEX.exec(text);
  while (match !== null) {
    const beforeText = text.slice(lastIndex, match.index);
    if (beforeText) result += escapeHtmlAnsi(beforeText);
    const params = match[1] ? match[1].split(';').map((p) => parseInt(p, 10) || 0) : [0];
    if (inSpan) { result += '</span>'; inSpan = false; }
    applySgrCode(params, style);
    if (hasStyle(style)) {
      result += `<span style="${styleToInlineCSS(style)}">`;
      inSpan = true;
    }
    lastIndex = match.index + match[0].length;
    match = ANSI_REGEX.exec(text);
  }
  const remainingText = text.slice(lastIndex);
  if (remainingText) result += escapeHtmlAnsi(remainingText);
  if (inSpan) result += '</span>';
  return result;
}

class PiWebClient {
  constructor() {
    this.ws = null;
    this.contentEl = document.getElementById('content');
    // 长会话分页（设计见 pi-web-design.md §20）：首屏只渲染尾部，
    // 更早的条目按需加载，prepend 时做滚动锚定。
    this.historyFrom = 0;        // 已加载区间的起始条目序号
    this.historyTotal = 0;       // 会话条目总数
    this.historyLoader = null;   // 顶部「加载更早」控件
    this.historyLoading = false; // 分页请求进行中
    this.loadedEntryIds = new Set(); // 按 id 去重（防分页与实时帧重复）
    // 是否"跟随底部"（设计文档 §20.7d）：粘性标记，取代原来每个事件当场算 2px 容差的判断 ——
    // 后者一旦因布局变化（状态区/widget 变高、内容增长）出现缝隙就永久关掉，表现为"每次出现
    // tool output 就脱离底部"（2026-10-15 用户报告）。
    this.followBottom = true;
    this.statusEl = document.getElementById('conn-status');
    this.statusAreaEl = document.getElementById('status');
    this.pendingEl = document.getElementById('pending');
    this.versionEl = document.getElementById('version');
    this.loadedResourcesEl = document.getElementById('loaded-resources');
    this.footerEl = document.getElementById('footer-line');
    this.inputEl = document.getElementById('input');
    // Input history (TUI parity): all submitted inputs (messages, !bash,
    // /commands) plus this session's user messages from history, browsed
    // with the ↑/↓ buttons next to the input box.
    this.inputHistory = [];
    this.historyIndex = -1; // -1 = not browsing (composing new input)
    this.historyDraft = '';
    this.sendBtn = document.getElementById('send-btn');
    this.abortBtn = document.getElementById('abort-btn');
    this.commandMenuEl = document.getElementById('command-menu');
    this.modalOverlay = document.getElementById('modal-overlay');
    this.modalTitle = document.getElementById('modal-title');
    this.modalSearch = document.getElementById('modal-search');
    this.modalList = document.getElementById('modal-list');
    this.modalClose = document.getElementById('modal-close');
    this.modalEl = document.getElementById('modal');
    this.modalMode = null; // 'model' | 'thinking' | 'resume' | 'scoped-models' | 'extension-*'
    this.modalCursor = -1; // 键盘光标所在项（-1 = 未设置）
    this.dialogCountdownTimer = null; // extension dialog countdown (TUI parity)
    this.dialogCountdownBase = '';
    this.hasConnectedBefore = false;
    this.commandMenuIndex = -1;
    this.extStatus = {};

    this.initThemeSwitch();

    // Streaming state: current assistant message being built
    this.streaming = {
      active: false,
      el: null,
    };

    // Tool call rendering state: map toolCallId -> element
    this.toolEls = new Map();
    // Bash streaming blocks: map bash id -> element
    this.bashEls = new Map();
    this.pendingBashId = null;
    this.pendingBashCommand = '';
    // Tool execution timers: map toolCallId -> interval id
    this.toolTimers = new Map();

    // Last known state (model, autoCompaction, etc.) for stats rendering
    this.lastState = null;

    // Status indicator state (working/retry/compaction/branch summary)
    this.status = {
      working: 0,
      retry: null,
      compaction: null,
      branch: false,
    };

    this.watchBottomFollow(); // 滚动/尺寸变化 → 维护 followBottom（设计文档 §20.7d）
    this.connect();
    this.bindInput();
  }

  /** 跟随底部的容差（px）：轻微滚动仍视为"在底部"，明显上滚才算离开。 */
  static get NEAR_BOTTOM_PX() {
    return 60;
  }

  /** 监听滚动与尺寸变化，维护 followBottom 并在需要时重新贴底（设计文档 §20.7d）。 */
  watchBottomFollow() {
    const scroller = document.getElementById('scroll-view');
    if (!scroller || this.bottomWatchBound) return;
    this.bottomWatchBound = true;
    scroller.addEventListener(
      'scroll',
      () => {
        // 程序性贴底也会触发 scroll：此时仍在底部 → 保持 true，符合预期
        this.followBottom = this.wasAtBottom(PiWebClient.NEAR_BOTTOM_PX);
      },
      { passive: true },
    );
    // 尺寸变化（状态区/widget 变高、内容增长、字体晚到）也要重新贴底 —— 这些情况未必伴随事件
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        if (this.followBottom) this.scrollToBottom();
      });
      ro.observe(scroller);
      if (this.contentEl) ro.observe(this.contentEl);
      this.bottomObserver = ro;
    }
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    this.setStatus('disconnected');

    const ws = new WebSocket(url);
    ws.onopen = () => {
      this.setStatus('connected');
      // If this is a reconnect (not the first load), reload the page so the
      // full session history is fetched fresh.
      if (this.hasConnectedBefore) {
        location.reload();
        return;
      }
      this.hasConnectedBefore = true;
      // Sync the persisted theme to the server on first connection so
      // extension ANSI colors match the CSS theme (server defaults to dark).
      const stored = localStorage.getItem('piweb-theme') === 'bright' ? 'light' : (localStorage.getItem('piweb-theme') || 'light');
      this.send({ type: 'set_theme', name: stored });
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.ws = null;
      this.setStatus('disconnected');
      // Auto-reconnect after a short delay
      setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => {
      ws.close();
    };
    this.ws = ws;
  }

  setStatus(status) {
    this.statusEl.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
    this.statusEl.className = status === 'connected' ? 'connected' : 'disconnected';
  }

  // ------------------------------------------------------------------
  // Theme switch (Dark | Bright)
  // ------------------------------------------------------------------

  initThemeSwitch() {
    // Migrate the old 'bright' key to 'light' (renamed for TUI parity).
    const stored = localStorage.getItem('piweb-theme') === 'bright' ? 'light' : (localStorage.getItem('piweb-theme') || 'light');
    this.applyTheme(stored, true);
    document.querySelectorAll('.theme-option').forEach((el) => {
      el.addEventListener('click', () => this.applyTheme(el.dataset.theme, false));
    });
  }

  applyTheme(theme, initial) {
    const light = theme === 'light';
    const name = light ? 'light' : 'dark';
    // CSS variables switch instantly (the "interface frame", like TUI's
    // requestRender on theme change).
    document.body.classList.toggle('theme-light', light);
    localStorage.setItem('piweb-theme', name);
    document.querySelectorAll('.theme-option').forEach((el) => {
      el.classList.toggle('active', el.dataset.theme === name);
    });
    if (initial) return;
    // Tell the server to swap the extension ANSI theme: extensions that
    // setStatus/setWidget AFTER this point generate colors with the new
    // theme. Already-rendered status text keeps its old colors until the
    // extension updates it (same as TUI - status text is fixed at setStatus
    // time; theme change only repaints the frame).
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'set_theme', name: name });
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    switch (data.type) {
      case 'state':
        this.renderState(data.data);
        // 引擎声明支持 panel_geometry 时上报一次面板可用列/行数：
        // TUI 组件按终端宽度渲染，网页等价物是面板宽度（不报则桥接只能用默认 100 列 → 折行折断框图）。
        // 必须按能力位判断：SDK 宿主不认这个消息，会回一个 error 帧。
        if (data.data && data.data.panelGeometry === true && !this.panelGeometrySupported) {
          this.panelGeometrySupported = true;
          this.sendPanelGeometry();
        }
        break;
      case 'theme_set':
        // Server acknowledged the theme switch. No reload needed: CSS
        // variables already switched instantly and the server theme only
        // affects extension setStatus/setWidget generated after this point
        // (same as TUI).
        break;
      case 'history':
        this.renderHistory(data.data);
        break;
      case 'history_page':
        this.prependHistory(data.data);
        break;
      case 'stats':
        this.renderStats(data.data, this.lastState);
        break;
      case 'bash_result':
        this.renderBashResult(data);
        break;
      case 'models':
        this.handleModels(data.data);
        break;
      case 'thinking_levels':
        this.handleThinkingLevels(data.data);
        break;
      case 'scoped_models':
        this.handleScopedModels(data.data);
        break;
      case 'usage_data':
        this.renderUsagePanel(data.data);
        break;
      case 'sessions':
        this.handleSessions(data.data);
        break;
      case 'error':
        this.appendError(data.error);
        break;
      case 'pi_error':
        this.appendError(data.error);
        break;
      case 'ext_status':
        this.applyExtStatusSnapshot(data.data);
        break;
      case 'dialog_dismissed':
        this.dismissExtensionDialog(data);
        break;
      case 'extension_ui_request':
        this.handleExtensionUIRequest(data);
        break;
      default:
        // Agent session event -> render
        this.renderEvent(data);
    }
  }

  // ------------------------------------------------------------------
  // Rendering: state & history
  // ------------------------------------------------------------------

  renderState(state) {
    if (!state) return;
    this.lastState = state;

    // 恢复"运行中"指示器：刷新/重连会丢掉 agent_start/agent_settled 事件，
    // 只靠事件计数会让 #status 的 Working… 永远不出现（用户实测 2026-10-20 ✗）。
    // 服务端按同样的事件规则维护 agentActive 并放进 state 帧 —— 这里按它校正计数：
    // 在跑 → 至少 1（保持事件累加语义）；已空闲 → 归零。
    if (typeof state.agentActive === 'boolean') {
      this.status.working = state.agentActive ? Math.max(1, this.status.working) : 0;
      this.updateStatusDisplay();
    }

    // Page title: pi-web - <session name>
    if (state.sessionName || state.sessionId) {
      document.title = `pi-web - ${state.sessionName || state.sessionId}`;
    }

    // Header version: pi v<pi version> · pi-web v<pi-sdk-web version>
    if (this.versionEl && state.version) {
      const parts = [`v${state.version}`];
      if (state.piWebVersion) parts.push(`pi-web v${state.piWebVersion}`);
      this.versionEl.textContent = parts.join(' · ');
    }

    // Loaded resources
    this.renderLoadedResources(state.commands, state.tools, state.extensions);

    // First footer line: pwd (branch) • session name
    const pwd = state.cwd || '';
    const branch = state.gitBranch ? ` (${state.gitBranch})` : '';
    const name = state.sessionName ? ` • ${state.sessionName}` : '';
    this.footerEl.textContent = `${pwd}${branch}${name}`;

    // Second footer line: TUI-like stats + model info
    this.renderStats(state.sessionStats, state);
  }

  renderLoadedResources(commands, tools, extensions) {
    if (!this.loadedResourcesEl) return;
    this.loadedResourcesEl.innerHTML = '';

    // Loaded Resources block (Skills/Prompts/Extensions)
    if (commands && commands.length > 0) {
      const groups = { skill: [], prompt: [], extension: [] };
      for (const cmd of commands) {
        const source = cmd.source;
        if (source === 'skill') groups.skill.push(cmd);
        else if (source === 'prompt') groups.prompt.push(cmd);
        else groups.extension.push(cmd);
      }

      const div = document.createElement('div');
      div.className = 'resources-block';
      div.dataset.expanded = 'false';

      const header = document.createElement('div');
      header.className = 'resources-header';
      header.textContent = 'Loaded Resources (click to expand)';

      const body = document.createElement('div');
      body.className = 'resources-body';
      body.style.display = 'none';

      const sections = [];
      if (groups.skill.length > 0) {
        sections.push(this.resourceSection('Skills', groups.skill.map((c) => c.name)));
      }
      if (groups.prompt.length > 0) {
        sections.push(this.resourceSection('Prompts', groups.prompt.map((c) => c.name)));
      }
      if (groups.extension.length > 0) {
        sections.push(this.resourceSection('Extension Cmds', groups.extension.map((c) => c.name)));
      }
      body.innerHTML = sections.join('');

      div.appendChild(header);
      div.appendChild(body);
      div.addEventListener('click', () => {
        const expanded = div.dataset.expanded === 'true';
        div.dataset.expanded = expanded ? 'false' : 'true';
        body.style.display = expanded ? 'none' : 'block';
        header.textContent = expanded ? 'Loaded Resources (click to expand)' : 'Loaded Resources (click to collapse)';
      });
      this.loadedResourcesEl.appendChild(div);
    }

    // Separate Tools block below Loaded Resources (web enhancement)
    if (tools && tools.length > 0) {
      const div = document.createElement('div');
      div.className = 'resources-block';
      div.dataset.expanded = 'false';
      div.style.marginTop = '6px';

      const header = document.createElement('div');
      header.className = 'resources-header';
      header.textContent = 'Tools (click to expand)';
      const refreshBtn = document.createElement('span');
      refreshBtn.className = 'tools-refresh';
      refreshBtn.title = 'Refresh tools list';
      refreshBtn.textContent = '⟳';
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.send({ type: 'get_state' });
      });
      header.appendChild(refreshBtn);

      const body = document.createElement('div');
      body.className = 'resources-body';
      body.style.display = 'none';
      body.innerHTML = this.resourceSection('', tools.map((t) => t.name));

      div.appendChild(header);
      div.appendChild(body);
      div.addEventListener('click', () => {
        const expanded = div.dataset.expanded === 'true';
        div.dataset.expanded = expanded ? 'false' : 'true';
        body.style.display = expanded ? 'none' : 'block';
        header.firstChild.textContent = expanded ? 'Tools (click to expand)' : 'Tools (click to collapse)';
      });
      this.loadedResourcesEl.appendChild(div);
    }

    // Separate Extensions block below Tools: loaded extension name + version
    if (extensions && extensions.length > 0) {
      const div = document.createElement('div');
      div.className = 'resources-block';
      div.dataset.expanded = 'false';
      div.style.marginTop = '6px';

      const header = document.createElement('div');
      header.className = 'resources-header';
      header.textContent = `Extensions (${extensions.length})`;

      const body = document.createElement('div');
      body.className = 'resources-body';
      body.style.display = 'none';
      body.innerHTML = extensions
        .map((e) => `<div class="resources-item ext-item"><span>${this.escapeHtml(e.name)}</span><span class="ext-version">${this.escapeHtml(e.version)}</span></div>`)
        .join('');

      div.appendChild(header);
      div.appendChild(body);
      div.addEventListener('click', () => {
        const expanded = div.dataset.expanded === 'true';
        div.dataset.expanded = expanded ? 'false' : 'true';
        body.style.display = expanded ? 'none' : 'block';
        header.textContent = expanded
          ? `Extensions (${extensions.length}) · click to expand`
          : `Extensions (${extensions.length}) · click to collapse`;
      });
      this.loadedResourcesEl.appendChild(div);
    }
  }

  resourceSection(name, items) {
    const listItems = items
      .map((item) => `<li class="resources-item" title="${this.escapeHtml(item)}">${this.escapeHtml(item)}</li>`)
      .join('');
    return `<div class="resources-section"><div class="resources-section-title">${this.escapeHtml(name)}</div><ul class="resources-list">${listItems}</ul></div>`;
  }

  renderStats(stats, state) {
    const statsEl = document.getElementById('footer-stats');
    if (!statsEl) return;
    if (!state) state = this.lastState;
    if (!state) return;

    const leftParts = [];

    // Token/cost stats from sessionStats (if available)
    if (stats && stats.tokens) {
      const t = stats.tokens;
      if (t.input) leftParts.push(`↑${this.formatTokens(t.input)}`);
      if (t.output) leftParts.push(`↓${this.formatTokens(t.output)}`);
      if (t.cacheRead) leftParts.push(`R${this.formatTokens(t.cacheRead)}`);
      if (t.cacheWrite) leftParts.push(`W${this.formatTokens(t.cacheWrite)}`);
      if ((t.cacheRead > 0 || t.cacheWrite > 0)) {
        const promptTokens = t.input + t.cacheRead + t.cacheWrite;
        if (promptTokens > 0) {
          const hitRate = (t.cacheRead / promptTokens) * 100;
          leftParts.push(`CH${hitRate.toFixed(1)}%`);
        }
      }
      if (stats.cost) leftParts.push(`$${stats.cost.toFixed(3)}`);
    }

    // Context usage: percent/contextWindow (auto)
    if (stats && stats.contextUsage && stats.contextUsage.contextWindow) {
      const cu = stats.contextUsage;
      const ctxWindow = this.formatTokens(cu.contextWindow);
      const auto = state.autoCompactionEnabled ? ' (auto)' : '';
      if (cu.percent !== null && cu.percent !== undefined) {
        leftParts.push(`${cu.percent.toFixed(1)}%/${ctxWindow}${auto}`);
      } else {
        leftParts.push(`?/${ctxWindow}${auto}`);
      }
    }

    // Model + thinking on the right (clickable, right-aligned)
    let rightHtml = '';
    if (state.model) {
      const provider = state.model.provider || '';
      const model = state.model.id || state.model.model || '';
      const modelLabel = provider ? `${provider}/${model}` : model;
      const thinking = state.thinkingLevel || 'off';
      const modelHtml = `<span class="clickable model-label" title="Click to pick from scoped models">${this.escapeHtml(modelLabel)}</span>`;
      const cycleHtml = `<span class="clickable cycle-model-label" title="Cycle to next model (TUI Ctrl+P)">>></span>`;
      const thinkingHtml = `<span class="clickable thinking-label" title="Click to change thinking">${this.escapeHtml(thinking)}</span>`;
      rightHtml = `${modelHtml} ${cycleHtml} · ${thinkingHtml}`;
    }

    statsEl.innerHTML = `<span class="stats-left">${leftParts.join(' ')}</span><span class="stats-right">${rightHtml}</span>`;

    const modelEl = statsEl.querySelector('.model-label');
    if (modelEl) {
      modelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openScopedModelPicker();
      });
    }
    const cycleEl = statsEl.querySelector('.cycle-model-label');
    if (cycleEl) {
      cycleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.send({ type: 'cycle_model' });
      });
    }
    const thinkingEl = statsEl.querySelector('.thinking-label');
    if (thinkingEl) {
      thinkingEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openThinkingPicker();
      });
    }
  }

  // ------------------------------------------------------------------
  // Markdown rendering
  // ------------------------------------------------------------------

  renderMarkdown(text) {
    if (!text) return '';
    try {
      const raw = marked.parse(text, { breaks: true, gfm: true });
      return this.sanitizeHtml(raw);
    } catch {
      return this.escapeHtml(text);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const allowed = new Set([
      'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'BLOCKQUOTE',
      'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'SPAN', 'DEL', 'DIV',
    ]);
    const badTags = ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION'];

    for (const el of [...template.content.querySelectorAll('*')]) {
      if (badTags.includes(el.tagName)) {
        el.remove();
        continue;
      }
      if (!allowed.has(el.tagName)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      // Clean attributes: only keep safe href/src, remove event handlers
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' || name === 'src') {
          const val = attr.value.trim().toLowerCase();
          const ok = val.startsWith('http://') || val.startsWith('https://') ||
            val.startsWith('mailto:') || val.startsWith('#') || val.startsWith('/') ||
            val.startsWith('./') || val.startsWith('../');
          if (!ok) {
            el.removeAttribute(attr.name);
          }
        } else if (name !== 'class' && name !== 'id' && name !== 'colspan' && name !== 'rowspan' && name !== 'align') {
          el.removeAttribute(attr.name);
        }
      }
    }

    return template.innerHTML;
  }

  formatTokens(count) {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
  }

  renderHistory(data) {
    this.clearContent();
    const entries = data?.entries ?? [];
    this.historyFrom = data?.from ?? 0;
    this.historyTotal = data?.total ?? entries.length;
    this.historyLoading = false;
    this.loadedEntryIds = new Set();
    for (const entry of entries) this.renderEntryOnce(entry);
    this.updateHistoryLoader(data?.hasMore === true);
    this.stickToBottom(); // 跟住式贴底：布局/离屏高度晚增长时也要停在底部
  }

  /** 渲染一条历史条目，按 id 去重（分页与实时帧可能重叠）。 */
  renderEntryOnce(entry) {
    if (!entry) return false;
    if (entry.id) {
      if (this.loadedEntryIds.has(entry.id)) return false;
      this.loadedEntryIds.add(entry.id);
    }
    this.renderEntry(entry);
    return true;
  }

  /** 顶部「加载更早」控件（无更早条目时移除）。 */
  updateHistoryLoader(hasMore) {
    if (this.historyLoader) {
      this.historyLoader.remove();
      this.historyLoader = null;
    }
    if (!hasMore) return;
    const el = document.createElement('div');
    el.className = 'history-more';
    el.textContent = `↑ 还有 ${this.historyFrom} 条更早的记录 · 点击加载`;
    el.addEventListener('click', () => {
      if (this.historyLoading) return;
      this.historyLoading = true;
      el.textContent = '加载中…';
      this.send({ type: 'history_page', before: this.historyFrom, limit: 300 });
    });
    this.historyLoader = el;
    this.contentEl.insertBefore(el, this.contentEl.firstChild);
  }

  /** 分页结果：prepend 到顶部，并保持视口位置不跳动。 */
  prependHistory(data) {
    const entries = data?.entries ?? [];
    const scroller = document.getElementById('scroll-view');
    const beforeHeight = scroller ? scroller.scrollHeight : 0;
    const startIndex = this.contentEl.childNodes.length;
    for (const entry of entries) this.renderEntryOnce(entry);
    // 新节点被 append 到末尾，先摘出来再整体插到顶部
    const added = Array.from(this.contentEl.childNodes).slice(startIndex);
    for (const node of added) node.remove();
    const frag = document.createDocumentFragment();
    for (const node of added) frag.appendChild(node);
    this.contentEl.insertBefore(frag, this.historyLoader ?? this.contentEl.firstChild);
    this.historyFrom = data?.from ?? Math.max(0, this.historyFrom - entries.length);
    this.historyLoading = false;
    this.updateHistoryLoader(data?.hasMore === true);
    if (scroller) scroller.scrollTop += scroller.scrollHeight - beforeHeight; // 滚动锚定
  }

  renderEntry(entry) {
    if (!entry) return;
    if (entry.type === 'message') {
      this.renderMessage(entry.message);
    } else if (entry.type === 'branch_summary') {
      this.renderBranchSummary(entry);
    } else if (entry.type === 'compaction') {
      this.renderCompaction(entry);
    } else if (entry.type === 'custom' || entry.type === 'custom_message') {
      this.renderCustom(entry);
    }
  }

  renderMessage(message) {
    if (!message) return;
    if (message.role === 'user') {
      this.appendUserMessage(message);
    } else if (message.role === 'assistant') {
      this.renderHistoryAssistantMessage(message);
    } else if (message.role === 'toolResult') {
      this.renderHistoryToolResult(message);
    }
  }

  renderHistoryAssistantMessage(message) {
    // 纯工具调用的消息没有文字 → 不建空气泡（工具块在下面照建）
    if (this.hasVisibleAssistantContent(message)) {
      const div = document.createElement('div');
      div.className = 'message assistant';
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = 'Assistant';
      const body = document.createElement('div');
      body.className = 'body';
      div.appendChild(role);
      div.appendChild(body);
      this.contentEl.appendChild(div);
      this.renderAssistantContent(message, body);
    }

    // Create tool blocks for tool calls
    for (const block of message.content || []) {
      if (block.type === 'toolCall') {
        const toolDiv = this.createToolBlock(block.name, block.arguments, block.id);
        this.toolEls.set(block.id, toolDiv);
      }
    }
  }

  renderHistoryToolResult(message) {
    const div = this.toolEls.get(message.toolCallId);
    if (div) {
      div.className = message.isError ? 'tool-block error' : 'tool-block success';
      this.setToolOutput(div, this.resultText(message));
      // Recorded execution time (Pi >= 1.1.0 stores durationMs on the
      // toolResult message); older session records simply have no field.
      if (typeof message.durationMs === 'number') {
        const durationEl = div.querySelector('.tool-duration');
        if (durationEl) durationEl.textContent = `Took ${this.formatDurationMs(message.durationMs)}`;
      }
      this.toolEls.delete(message.toolCallId);
    }
  }

  // ------------------------------------------------------------------
  // Special message blocks (branch/compaction/custom)
  // ------------------------------------------------------------------

  renderBranchSummary(entry) {
    const label = '[branch]';
    const summary = entry.summary || '';
    const div = this.createSpecialBlock(label);
    this.updateSpecialBlock(div, {
      collapsedText: 'Branch summary (click to expand)',
      expandedHtml: this.renderMarkdown(`**Branch Summary**\n\n${summary}`),
    });
  }

  renderCompaction(entry) {
    const label = '[compaction]';
    const summary = entry.summary || '';
    const tokens = entry.tokensBefore ? entry.tokensBefore.toLocaleString() : '?';
    const div = this.createSpecialBlock(label);
    this.updateSpecialBlock(div, {
      collapsedText: `Compacted from ${tokens} tokens (click to expand)`,
      expandedHtml: this.renderMarkdown(`**Compacted from ${tokens} tokens**\n\n${summary}`),
    });
  }

  renderCustom(entry) {
    // Custom messages (pi.sendMessage) render only when `display` is truthy -
    // TUI gates both the live message and the history entry on exactly that
    // check (interactive-mode.js, case "custom": if (message.display)).
    // Two shapes reach this function:
    //   live    - message_start's app message: { role: "custom", customType,
    //             content, display } (no `type` field)
    //   history - a session entry: { type: "custom_message", ... }
    // Magic-context's ceiling-nudge writes display:false reminders that must
    // stay invisible; mcp-adapter passes a string (truthy), which TUI renders.
    const isCustomMessage =
      entry.type === 'custom_message' || (entry.type === undefined && entry.role === 'custom');
    if (isCustomMessage && !entry.display) {
      return;
    }
    // Status traces (appendEntry entries without data.text, e.g.
    // minimode-status {mode, tools}) are file/event-stream only — TUI
    // renders nothing for them, so neither do we.
    if (entry.type === 'custom' && !(entry.data && typeof entry.data.text === 'string' && entry.data.text.trim().length > 0)) {
      return;
    }
    const customType = entry.customType || 'custom';
    const label = `[${customType}]`;
    const content = this.customEntryText(entry);
    const div = this.createSpecialBlock(label);
    this.updateSpecialBlock(div, {
      collapsedText: `${customType} (click to expand)`,
      expandedHtml: this.renderMarkdown(content),
    });
  }

  customEntryText(entry) {
    if (typeof entry.content === 'string') return entry.content;
    if (Array.isArray(entry.content)) {
      return entry.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
    if (entry.data !== undefined) {
      // magic-context style: {title, text, ...} - prefer the text field
      if (typeof entry.data.text === 'string') return entry.data.text;
      return JSON.stringify(entry.data, null, 2);
    }
    return '';
  }

  createSpecialBlock(label) {
    const div = document.createElement('div');
    div.className = 'special-block';
    div.dataset.expanded = 'false';
    const labelEl = document.createElement('div');
    labelEl.className = 'special-label';
    labelEl.textContent = label;
    const body = document.createElement('div');
    body.className = 'special-body body-text';
    div.appendChild(labelEl);
    div.appendChild(body);
    // Click to expand/collapse, but NOT when the pointer was dragged (see
    // bindExpandToggle - same drag-vs-click logic as tool blocks).
    this.bindExpandToggle(div, (d) => this.toggleSpecial(d));
    this.contentEl.appendChild(div);
    return div;
  }

  updateSpecialBlock(div, { collapsedText, expandedHtml }) {
    div.dataset.collapsedText = collapsedText;
    div.dataset.expandedHtml = expandedHtml;
    this.applySpecialBlock(div);
  }

  applySpecialBlock(div) {
    const body = div.querySelector('.special-body');
    if (!body) return;
    const expanded = div.dataset.expanded === 'true';
    if (expanded) {
      body.innerHTML = div.dataset.expandedHtml || '';
    } else {
      body.textContent = div.dataset.collapsedText || '';
    }
  }

  toggleSpecial(div) {
    const expanded = div.dataset.expanded === 'true';
    div.dataset.expanded = expanded ? 'false' : 'true';
    this.applySpecialBlock(div);
  }

  clearContent() {
    this.contentEl.innerHTML = '';
    for (const timer of this.toolTimers.values()) {
      clearInterval(timer);
    }
    this.toolTimers.clear();
    this.toolEls.clear();
    this.streaming = { active: false, el: null };
    // Drop stale UI state from the previous session (on /resume reload)
    const widgets = document.getElementById('widgets');
    if (widgets) {
      widgets.innerHTML = '';
      widgets.style.display = 'none';
    }
    this.extStatus = {};
    const extStatusEl = document.getElementById('ext-status');
    if (extStatusEl) extStatusEl.style.display = 'none';
    const pendingEl = document.getElementById('pending');
    if (pendingEl) pendingEl.style.display = 'none';
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.style.display = 'none';
    // 清屏只清"上一条会话残留"的显示；**不能就此让指示器消失** ✗ ——
    // 刷新/切会话的顺序是 state(→working=1 显示) 再 history(→clearContent 隐藏)，
    // 所以在末尾按当前状态重绘一次（在跑 → 显示；空闲 → 保持隐藏）。2026-10-20 用户实测修复。
    this.updateStatusDisplay();
  }

  // ------------------------------------------------------------------
  // Rendering: session events
  // ------------------------------------------------------------------

  renderEvent(ev) {
    // Capture stickiness BEFORE the handler mutates the DOM: updates that
    // grow content (message_update, tool deltas) increase scrollHeight, so
    // checking wasAtBottom() after the fact would miss "user was already at
    // the bottom" and stop following the stream.
    const wasAtBottom = this.followBottom;
    switch (ev.type) {
      case 'agent_start':
        this.status.working++;
        this.updateStatusDisplay();
        break;
      case 'message_start':
        this.onMessageStart(ev.message);
        break;
      case 'message_update':
        this.onMessageUpdate(ev);
        break;
      case 'message_end':
        this.onMessageEnd(ev.message);
        break;
      case 'tool_execution_start':
        this.onToolStart(ev);
        break;
      case 'tool_execution_update':
        this.onToolUpdate(ev);
        break;
      case 'tool_execution_end':
        this.onToolEnd(ev);
        break;
      case 'agent_settled':
        this.resetStreaming();
        if (this.status.working > 0) this.status.working--;
        this.updateStatusDisplay();
        break;
      case 'turn_start':
        break;
      case 'turn_end':
        break;
      case 'agent_end':
        this.resetStreaming();
        if (this.status.working > 0) this.status.working--;
        this.updateStatusDisplay();
        break;
      case 'auto_retry_start':
        this.status.retry = {
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
        };
        this.updateStatusDisplay();
        break;
      case 'auto_retry_end':
        this.status.retry = null;
        this.updateStatusDisplay();
        break;
      case 'compaction_start':
        this.status.compaction = ev.reason || 'manual';
        this.updateStatusDisplay();
        break;
      case 'compaction_end':
        this.status.compaction = null;
        this.updateStatusDisplay();
        break;
      case 'summarization_retry_attempt_start':
        if (ev.source === 'branchSummary') {
          this.status.branch = true;
          this.updateStatusDisplay();
        }
        break;
      case 'summarization_retry_finished':
        this.status.branch = false;
        this.updateStatusDisplay();
        break;
      case 'queue_update':
        this.updatePendingMessages(ev);
        break;
      case 'entry_appended':
        // Extension custom entries (e.g. magic-context /ctx-status) arrive live
        this.renderEntry(ev.entry);
        break;
      case 'bash_execution_update':
        // Streaming bash output (e.g. !! running a long-lived program).
        // Append the delta to the matching tool block in real time; the
        // final bash_result finalizes it (exit code, truncation info).
        if (typeof ev.delta === 'string' && ev.delta.length > 0) {
          this.appendBashChunk(ev.id, ev.delta);
        }
        break;
      default:
        break;
    }
    // Auto-scroll only if the user was at the bottom before the event
    // (reading history must not be yanked down by incoming events).
    if (wasAtBottom) this.scrollToBottom();
  }

  onMessageStart(message) {
    if (!message) return;
    if (message.role === 'user') {
      this.appendUserMessage(message);
    } else if (message.role === 'assistant') {
      this.startAssistantMessage(message);
    } else if (message.role === 'custom') {
      // pi.sendMessage emits message_start with the app message (customType /
      // content / display) - render it live instead of waiting for a page
      // reload. renderCustom applies the display gate for both this shape and
      // the history entry shape.
      this.renderCustom(message);
    }
    // toolResult handled via tool_execution events
  }

  /** 助手消息是否有**可见内容**（text / thinking 且非空白）。
   *  纯工具调用的助手消息没有文字 —— 早先照样建气泡，结果只显示一个 "Assistant" 标签 ✗
   *  （实测 install 会话：128 个 assistant 气泡里 37 个是空的）。 */
  hasVisibleAssistantContent(message) {
    for (const block of message?.content || []) {
      if (block.type === 'text' && (block.text || '').trim()) return true;
      if (block.type === 'thinking' && (block.thinking || '').trim()) return true;
    }
    return false;
  }

  /** 由增量缓冲拼出一份"部分消息"（形状与 message_event 的完整 message 一致）。 */
  partialAssistantMessage() {
    const s = this.streaming;
    const content = [];
    if (s.thinking) content.push({ type: 'thinking', thinking: s.thinking });
    if (s.text) content.push({ type: 'text', text: s.text });
    return { role: 'assistant', content };
  }

  /**
   * 流式增量（`message_update`）。
   *
   * **RPC 的载荷里没有 `message`**：Pi 只发
   * `{type:"message_update", usage, assistantMessageEvent:{type:"text_delta", delta:"…"}}`
   * （`text_start`/`text_delta`/`text_end`、`thinking_*`、`toolcall_*`）。
   * 早先这里 `const msg = ev.message; if (!msg) return;` —— 按 SDK 时代形状取数 ✗，
   * 于是**每个增量都被丢掉**，文字只在 `message_end` 时一次性出现（用户实测：
   * "message 流不是完全流式" ✓✓）。现在改为自己累积 delta ✓。
   */
  onMessageUpdate(ev) {
    const aev = ev.assistantMessageEvent;
    if (!aev) return; // 旧形状（带完整 message）不再出现；无增量事件则忽略
    if (!this.streaming.active || !this.streaming.el) {
      this.startAssistantMessage({ role: 'assistant', content: [] });
    }
    if (aev.type === 'text_delta' && typeof aev.delta === 'string') {
      this.streaming.text = (this.streaming.text || '') + aev.delta;
      this.updateAssistantText(this.partialAssistantMessage());
    } else if (aev.type === 'thinking_delta' && typeof aev.delta === 'string') {
      this.streaming.thinking = (this.streaming.thinking || '') + aev.delta;
      this.updateAssistantThinking(this.partialAssistantMessage());
    }
    // text_start/text_end/thinking_start/thinking_end/toolcall_* 无需处理：
    // 文本量由 delta 累积，工具块走 tool_execution_* 事件。
  }

  onMessageEnd(message) {
    if (message && message.role === 'assistant') {
      this.finalizeAssistantMessage(message);
    }
  }

  resetStreaming() {
    this.streaming = { active: false, el: null };
  }

  // ------------------------------------------------------------------
  // Status indicator
  // ------------------------------------------------------------------

  updateStatusDisplay() {
    if (!this.statusAreaEl) return;

    let kind = null;
    let text = '';

    if (this.status.compaction) {
      kind = 'compaction';
      text = this.status.compaction === 'manual' ? 'Compacting context...' : 'Auto-compacting...';
    } else if (this.status.retry) {
      kind = 'retry';
      const secs = Math.ceil((this.status.retry.delayMs || 0) / 1000);
      text = `Retrying (${this.status.retry.attempt}/${this.status.retry.maxAttempts}) in ${secs}s... (to cancel)`;
    } else if (this.status.branch) {
      kind = 'branch';
      text = 'Summarizing branch... (to cancel)';
    } else if (this.status.working > 0) {
      kind = 'working';
      text = 'Working...';
    }

    if (!kind) {
      this.statusAreaEl.innerHTML = '';
      this.statusAreaEl.style.display = 'none';
      if (this.abortBtn) this.abortBtn.style.display = 'none';
      return;
    }

    this.statusAreaEl.style.display = 'block';
    this.statusAreaEl.innerHTML =
      `<div class="status-indicator ${kind}"><span class="spinner"></span><span class="status-text"></span></div>`;
    this.statusAreaEl.querySelector('.status-text').textContent = text;

    // Show Abort button while any operation is running
    if (this.abortBtn) this.abortBtn.style.display = 'inline-block';
  }

  updatePendingMessages(ev) {
    if (!this.pendingEl) return;
    const steering = ev.steering || [];
    const followUp = ev.followUp || [];

    if (steering.length === 0 && followUp.length === 0) {
      this.pendingEl.innerHTML = '';
      this.pendingEl.style.display = 'none';
      return;
    }

    this.pendingEl.style.display = 'block';
    const lines = [];
    for (const msg of steering) {
      lines.push(`<div class="pending-line steering">Steering: ${this.escapeHtml(msg)}</div>`);
    }
    for (const msg of followUp) {
      lines.push(`<div class="pending-line follow-up">Follow-up: ${this.escapeHtml(msg)}</div>`);
    }
    this.pendingEl.innerHTML = lines.join('');
  }

  // ------------------------------------------------------------------
  // Persistent widget panel (extension setWidget, e.g. magic-context todos)
  // ------------------------------------------------------------------

  renderWidget(req) {
    const widgetsEl = document.getElementById('widgets');
    if (!widgetsEl) return;
    const key = req.widgetKey || 'widget';
    const wasAtBottom = this.followBottom;

    if (req.widgetLines === undefined || req.widgetLines === null) {
      // Clear this widget
      const el = widgetsEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
      if (el) el.remove();
      if (widgetsEl.children.length === 0) widgetsEl.style.display = 'none';
      if (wasAtBottom) this.scrollToBottom();
      return;
    }

    let el = widgetsEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    let body;
    if (!el) {
      el = document.createElement('div');
      el.className = 'widget-block';
      el.dataset.widgetKey = key;
      el.dataset.expanded = 'false'; // collapsible; collapsed by default
      const title = document.createElement('div');
      title.className = 'widget-title';
      body = document.createElement('div');
      body.className = 'widget-body';
      body.style.display = 'none'; // collapsed by default
      // Click the title to expand/collapse (keeps the widget compact).
      title.addEventListener('click', () => {
        const expanded = el.dataset.expanded === 'true';
        el.dataset.expanded = expanded ? 'false' : 'true';
        body.style.display = expanded ? 'none' : 'block';
        title.textContent = (expanded ? '▸ ' : '▾ ') + el.dataset.widgetKey;
      });
      el.appendChild(title);
      el.appendChild(body);
      widgetsEl.appendChild(el);
    } else {
      body = el.querySelector('.widget-body');
    }
    // Header label with collapsible indicator (kept in sync).
    const titleEl = el.querySelector('.widget-title');
    titleEl.textContent = (el.dataset.expanded === 'true' ? '▾ ' : '▸ ') + key;
    // ANSI escapes (extension theme) render as colored spans per line.
    body.innerHTML = (req.widgetLines || [])
      .map((line) => ansiToHtml(String(line)))
      .join('<br>');
    widgetsEl.style.display = 'block';
    // Layout change: keep pinned to bottom if already there
    if (wasAtBottom) this.scrollToBottom();
  }

  // ------------------------------------------------------------------
  // Rendering helpers
  // ------------------------------------------------------------------

  // Wall-clock stamp for a message: HH:MM for today, MM-DD HH:MM for older
  // ones (chat convention; the exact time lives in the title tooltip).
  // `pii`-style local time, no locale surprises.
  formatMessageTime(ts) {
    const d = typeof ts === 'number' && isFinite(ts) ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return isToday ? hhmm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
  }

  formatFullTime(ts) {
    const d = typeof ts === 'number' && isFinite(ts) ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  appendUserMessage(message) {
    const text = this.messageText(message);
    // History population (TUI renderInitialMessages populateHistory):
    // session user messages seed the input history, deduped.
    if (text && this.inputHistory[this.inputHistory.length - 1] !== text) {
      this.inputHistory.push(text);
    }
    const div = document.createElement('div');
    div.className = 'message user';
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = 'You';
    // Send time from the message itself (Pi stamps every user message with
    // `timestamp`, live and in history); silently absent for odd payloads.
    const stamp = this.formatMessageTime(message && message.timestamp);
    if (stamp) {
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = stamp;
      time.title = this.formatFullTime(message.timestamp);
      role.appendChild(time);
    }
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = this.renderMarkdown(text);
    div.appendChild(role);
    div.appendChild(body);
    this.contentEl.appendChild(div);
  }

  startAssistantMessage(message) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = 'Assistant';
    const body = document.createElement('div');
    body.className = 'body';
    div.appendChild(role);
    div.appendChild(body);
    this.contentEl.appendChild(div);

    // 增量缓冲：RPC 的 message_update **只给增量**（assistantMessageEvent.delta），没有完整
    // message（那是 SDK 时代的形状）→ 这里自己累积一份"部分消息"交给既有渲染（2026-10-20 修复）。
    this.streaming = { active: true, el: div, body: body, text: '', thinking: '' };
    this.renderAssistantContent(message, body);
  }

  updateAssistantText(message) {
    if (!this.streaming.el) return;
    const body = this.streaming.body;
    if (body) {
      this.renderAssistantContent(message, body);
    }
  }

  updateAssistantThinking(message) {
    if (!this.streaming.el) return;
    const body = this.streaming.body;
    if (body) {
      this.renderAssistantContent(message, body);
    }
  }

  renderAssistantContent(message, body) {
    body.innerHTML = '';
    for (const block of message.content || []) {
      if (block.type === 'thinking') {
        const p = document.createElement('div');
        p.className = 'thinking body-text';
        p.innerHTML = this.renderMarkdown(block.thinking);
        body.appendChild(p);
      } else if (block.type === 'text') {
        const p = document.createElement('div');
        p.className = 'body-text';
        p.innerHTML = this.renderMarkdown(block.text);
        body.appendChild(p);
      }
    }
  }

  finalizeAssistantMessage(message) {
    if (!this.streaming.el) return;
    const body = this.streaming.body;
    // 定稿后仍无文字（纯工具调用的消息）→ 去掉空气泡，避免留下 "Assistant" 标签
    if (!this.hasVisibleAssistantContent(message)) {
      this.streaming.el.remove();
      this.resetStreaming();
      return;
    }
    if (body) {
      this.renderAssistantContent(message, body);
    }
  }

  /**
   * Add expand/collapse-on-click to a block, while preserving text selection.
   *
   * A drag that selects text ends with mouseup -> click; toggling then would
   * re-render the block and wipe the selection. Record the mousedown
   * position and skip the toggle when the pointer moved more than 3px
   * (anything beyond that is a drag, not a click - 3px tolerates hand tremor
   * on a plain click).
   */
  bindExpandToggle(div, toggleFn) {
    let downX = 0, downY = 0;
    div.addEventListener('mousedown', (e) => { downX = e.clientX; downY = e.clientY; });
    div.addEventListener('click', (e) => {
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (dx * dx + dy * dy > 9) return; // dragged: preserve selection
      toggleFn(div);
    });
  }

  createToolBlock(toolName, args, toolCallId) {
    const div = document.createElement('div');
    div.className = 'tool-block pending';
    div.dataset.toolCallId = toolCallId || '';
    div.dataset.toolName = toolName || '';
    div.dataset.expanded = 'false';

    const isBash = toolName === 'bash';

    const top = document.createElement('div');
    top.className = 'tool-border';
    const content = document.createElement('div');
    content.className = 'tool-content';
    const bottom = document.createElement('div');
    bottom.className = 'tool-border';

    // Title
    const title = document.createElement('div');
    title.className = 'tool-title';
    if (isBash) {
      const cmd = (args && args.command) || '';
      title.textContent = `$ ${cmd}`;
    } else {
      title.textContent = toolName || 'tool';
    }
    content.appendChild(title);

    // Args (non-bash)。参数未知（补建的块）时不画 —— 否则会显示一个假的 {}
    const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;
    if (!isBash && hasArgs) {
      const argsEl = document.createElement('div');
      argsEl.className = 'tool-args';
      argsEl.textContent = JSON.stringify(args, null, 2);
      content.appendChild(argsEl);
    }

    // Output
    const output = document.createElement('div');
    output.className = 'tool-output';
    content.appendChild(output);

    // Meta (duration / truncation)
    const meta = document.createElement('div');
    meta.className = 'tool-meta';
    const duration = document.createElement('span');
    duration.className = 'tool-duration';
    meta.appendChild(duration);
    content.appendChild(meta);

    div.appendChild(top);
    div.appendChild(content);
    div.appendChild(bottom);

    // Click to expand/collapse, but NOT when the pointer was dragged (see
    // bindExpandToggle - a drag that selected text must preserve selection).
    this.bindExpandToggle(div, (d) => this.toggleToolExpand(d));

    this.contentEl.appendChild(div);
    return div;
  }

  setToolOutput(div, text) {
    const out = div.querySelector('.tool-output');
    if (!out) return;
    div.dataset.fullOutput = text || '';
    this.applyToolPreview(div);
  }

  applyToolPreview(div) {
    const out = div.querySelector('.tool-output');
    if (!out) return;
    const full = div.dataset.fullOutput || '';
    const expanded = div.dataset.expanded === 'true';
    const isBash = div.dataset.toolName === 'bash';
    const limit = isBash ? 5 : 10;
    const lines = full.split('\n');
    if (!expanded && lines.length > limit) {
      const visible = lines.slice(0, limit).join('\n');
      const hidden = lines.length - limit;
      // ANSI escapes (from tool outputs) render as colored spans; the
      // truncated marker stays plain text.
      out.innerHTML = ansiToHtml(visible) + `<div class="tool-truncated">... (${hidden} more lines, click to expand)</div>`;
    } else {
      out.innerHTML = ansiToHtml(full);
    }
  }

  toggleToolExpand(div) {
    const expanded = div.dataset.expanded === 'true';
    div.dataset.expanded = expanded ? 'false' : 'true';
    this.applyToolPreview(div);
  }

  // TUI-aligned duration formatting (bash.ts formatDuration): one decimal
  // under a minute, then m/s and h/m/s. SDK-recorded durations feed both the
  // live-final and history paths; the wall clock is only the fallback.
  formatDurationMs(ms) {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${remainder}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
  }

  onToolStart(ev) {
    const div = this.createToolBlock(ev.toolName, ev.args, ev.toolCallId);
    this.toolEls.set(ev.toolCallId, div);

    // Start elapsed timer
    const start = Date.now();
    div.dataset.startTime = start;
    const durationEl = div.querySelector('.tool-duration');
    if (durationEl) durationEl.textContent = 'Running...';
    const timer = setInterval(() => {
      if (!div.isConnected) {
        clearInterval(timer);
        return;
      }
      const dur = this.formatDurationMs(Date.now() - start);
      const el = div.querySelector('.tool-duration');
      if (el) el.textContent = `Elapsed ${dur}`;
    }, 1000);
    this.toolTimers.set(ev.toolCallId, timer);
  }

  /** 取工具块；不存在则补建（刷新/重连会丢掉 tool_execution_start，之后的结果不能静默丢弃 ✗）。 */
  ensureToolBlock(ev) {
    let div = this.toolEls.get(ev.toolCallId);
    if (!div) {
      div = this.createToolBlock(ev.toolName || 'tool', {}, ev.toolCallId);
      this.toolEls.set(ev.toolCallId, div);
    }
    return div;
  }

  onToolUpdate(ev) {
    const div = this.ensureToolBlock(ev);
    if (ev.partialResult !== undefined && ev.partialResult !== null) {
      this.setToolOutput(div, this.resultText(ev.partialResult));
    }
  }

  onToolEnd(ev) {
    const div = this.ensureToolBlock(ev);
    div.className = ev.isError ? 'tool-block error' : 'tool-block success';

    if (ev.result) {
      this.setToolOutput(div, this.resultText(ev.result));
    }

    // Stop elapsed timer and show final duration. Prefer the SDK-recorded
    // monotonic duration (tool_execution_end.durationMs, Pi >= 1.1.0); the
    // wall-clock delta is only the fallback (e.g. aborted runs without one).
    const timer = this.toolTimers.get(ev.toolCallId);
    if (timer) {
      clearInterval(timer);
      this.toolTimers.delete(ev.toolCallId);
    }
    const start = parseInt(div.dataset.startTime || '0', 10);
    const durationEl = div.querySelector('.tool-duration');
    const durMs = typeof ev.durationMs === 'number'
      ? ev.durationMs
      : (start ? Date.now() - start : undefined);
    if (durationEl && durMs !== undefined) {
      durationEl.textContent = `Took ${this.formatDurationMs(durMs)}`;
    }

    // Truncation / full output warning
    const result = ev.result;
    if (result && result.details) {
      const details = result.details;
      const warnings = [];
      if (details.fullOutputPath) {
        warnings.push(`Full output: ${details.fullOutputPath}`);
      }
      if (details.truncation && details.truncation.truncated) {
        const tr = details.truncation;
        if (tr.truncatedBy === 'lines') {
          warnings.push(`Truncated: showing ${tr.outputLines} of ${tr.totalLines} lines`);
        } else {
          warnings.push(`Truncated: ${tr.outputLines} lines shown`);
        }
      }
      if (warnings.length > 0) {
        const meta = div.querySelector('.tool-meta');
        const warn = document.createElement('div');
        warn.className = 'tool-truncated';
        warn.textContent = `[${warnings.join('. ')}]`;
        meta.appendChild(warn);
      }
    }

    this.toolEls.delete(ev.toolCallId);
  }

  appendBashChunk(id, delta) {
    // Find or create the tool block for this bash run (keyed by the id the
    // client sent with the bash message, e.g. bash-<timestamp>).
    const key = id || this.pendingBashId;
    if (!key) return;
    let div = this.bashEls.get(key);
    if (!div) {
      div = this.createToolBlock('bash', { command: this.pendingBashCommand || '' }, key);
      div.className = 'tool-block pending';
      // Running indicator (spinner + label) - makes it obvious the stream
      // is still live even when output is quiet; removed on bash_result.
      const run = document.createElement('span');
      run.className = 'bash-running';
      run.textContent = '⟳ running';
      div.querySelector('.tool-title')?.appendChild(run);
      // Stop button in the title row (TUI Ctrl+C equivalent): abort_bash
      // kills only this running bash. Removed when the block finalizes.
      const stopBtn = document.createElement('button');
      stopBtn.className = 'bash-stop-btn';
      stopBtn.textContent = '⏹ stop';
      stopBtn.title = 'Stop this bash command (Ctrl+C in TUI)';
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't toggle expand
        this.send({ type: 'abort_bash' });
        stopBtn.disabled = true;
        stopBtn.textContent = 'stopping...';
      });
      div.querySelector('.tool-title')?.appendChild(stopBtn);
      // The running bash block lives in the #bash-pending area (between the
      // message flow and the input box) so later messages don't push it
      // out of view - same as TUI's pendingMessagesContainer. bash_result
      // moves it into the normal message flow when done.
      const bashPending = document.getElementById('bash-pending');
      if (bashPending) {
        bashPending.appendChild(div);
        // Area-level status line at the TAIL (always visible even when the
        // block's own title scrolled out of view while output streams).
        const statusLine = document.createElement('div');
        statusLine.className = 'bash-stream-status';
        statusLine.textContent = '⟳ running…';
        bashPending.appendChild(statusLine);
        bashPending.style.display = 'block';
        bashPending.scrollTop = bashPending.scrollHeight; // keep tail visible
      } else {
        this.contentEl.appendChild(div);
      }
      this.bashEls.set(key, div);
    }
    // Append the delta to the full text and re-apply the preview (respects
    // the collapsed/expanded state of the block).
    const full = (div.dataset.fullOutput || '') + delta;
    div.dataset.fullOutput = full;
    this.applyToolPreview(div);
    // Keep the stream tail (and its running status line) visible inside the
    // pending area while output is coming in.
    const bashPending = document.getElementById('bash-pending');
    if (bashPending && bashPending.contains(div)) {
      bashPending.scrollTop = bashPending.scrollHeight;
    }
    if (this.followBottom) this.scrollToBottom();
  }

  renderBashResult(data) {
    const id = data.id;
    const result = data.data || {};
    let div = (id && this.bashEls.get(id)) || null;
    if (!div) {
      div = this.createToolBlock('bash', { command: data.command }, id || 'bash-' + Date.now());
      if (id) this.bashEls.set(id, div);
    }
    const output = result.output || '';
    // Streaming blocks have the full text already (appended incrementally);
    // for non-streaming runs set it now.
    if (!(div.dataset.fullOutput && div.dataset.fullOutput.length > 0)) {
      this.setToolOutput(div, output);
    }
    // Move the finished block from the bash-pending (fixed) area into the
    // normal message flow, keeping its accumulated output.
    const bashPending = document.getElementById('bash-pending');
    if (bashPending && bashPending.contains(div)) {
      this.contentEl.appendChild(div);
      // Remove the area-level running status line, then hide the empty area.
      bashPending.querySelectorAll('.bash-stream-status').forEach((el) => el.remove());
      if (bashPending.children.length === 0) {
        bashPending.style.display = 'none';
      }
      // 跟随门控：用户明显上滚时不得被拽回（原先这里无条件贴底 ✗）
      if (this.followBottom) this.scrollToBottom();
    }
    // Bash done: the running indicator and stop button are no longer
    // relevant.
    div.querySelector('.bash-running')?.remove();
    div.querySelector('.bash-stop-btn')?.remove();

    const isError = result.exitCode !== undefined && result.exitCode !== 0;
    div.className = isError ? 'tool-block error' : 'tool-block success';

    const durationEl = div.querySelector('.tool-duration');
    if (durationEl) durationEl.remove();

    if (result.truncated || result.fullOutputPath) {
      const meta = div.querySelector('.tool-meta');
      const warnings = [];
      if (result.fullOutputPath) warnings.push(`Full output: ${result.fullOutputPath}`);
      if (result.truncated) warnings.push('Output truncated');
      const warn = document.createElement('div');
      warn.className = 'tool-truncated';
      warn.textContent = `[${warnings.join('. ')}]`;
      meta.appendChild(warn);
    }

    if (this.followBottom) this.scrollToBottom();
    // Streaming done: drop the block from the live map (no more deltas).
    if (id) this.bashEls.delete(id);
    this.pendingBashId = null;
    this.pendingBashCommand = '';
  }

  resultText(result) {
    if (typeof result === 'string') return result;
    if (result && result.content) {
      const texts = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return texts || JSON.stringify(result, null, 2);
    }
    return JSON.stringify(result, null, 2);
  }

  messageText(message) {
    if (typeof message === 'string') return message;
    if (message && Array.isArray(message.content)) {
      return message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
    return '';
  }

  appendError(msg) {
    const div = document.createElement('div');
    div.style.color = 'var(--error)';
    div.textContent = msg;
    this.contentEl.appendChild(div);
  }

  scrollToBottom() {
    const scroller = document.getElementById('scroll-view');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  /**
   * 首屏/切换后贴底，并**跟住**一小段时间。
   *
   * 为什么不能只贴一次（2026-10-15 用户实测）：长会话里离屏条目带 `content-visibility: auto`
   * （见 pi-web-design.md §20 方案 D），它们的高度在首帧只是**估算值**，会随布局推进继续增长
   * （实测同一页面 70,887 → 81,826px）；扩展 widget/状态区也会在稍后占位。只贴一次就会停在半路，
   * 用户还得自己往下翻。这里持续跟随直到高度稳定，且**用户一滚动/按键就立刻停手**（不抢滚动权）。
   */
  stickToBottom() {
    const scroller = document.getElementById('scroll-view');
    if (!scroller) return;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('keydown', cancel);
    };
    window.addEventListener('wheel', cancel, { passive: true, once: true });
    window.addEventListener('touchstart', cancel, { passive: true, once: true });
    window.addEventListener('keydown', cancel, { once: true });
    const stick = () => {
      if (!cancelled) scroller.scrollTop = scroller.scrollHeight;
    };
    stick();
    let last = scroller.scrollHeight;
    let settled = 0;
    const tick = (n) => {
      if (cancelled || n > 60) return;
      requestAnimationFrame(() => {
        stick();
        const h = scroller.scrollHeight;
        if (h !== last) {
          last = h;
          settled = 0;
        } else if (++settled > 12) {
          return; // 高度已稳定十几帧，收工
        }
        tick(n + 1);
      });
    };
    tick(0);
    // 兜底：布局/字体/widget 晚到的情况
    for (const delay of [120, 400, 1000]) setTimeout(stick, delay);
  }

  /**
   * Jump to the previous (-1) or next (+1) user message in the scroll view.
   * Positions the target message at the top of the viewport.
   */
  jumpToUserMessage(direction) {
    const scroller = document.getElementById('scroll-view');
    if (!scroller) return;
    const users = [...document.querySelectorAll('.message.user')];
    if (users.length === 0) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const offsetTop = (el) => el.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop;
    const current = scroller.scrollTop;
    const buffer = 12; // px: treat "essentially at this message's top" as already there

    let target = null;
    if (direction === -1) {
      for (let i = users.length - 1; i >= 0; i--) {
        if (offsetTop(users[i]) < current - buffer) {
          target = users[i];
          break;
        }
      }
    } else {
      for (const u of users) {
        if (offsetTop(u) > current + buffer) {
          target = u;
          break;
        }
      }
    }
    if (target) {
      scroller.scrollTo({ top: Math.max(0, offsetTop(target) - 8), behavior: 'smooth' });
    }
  }

  /** 滚到底部（最新内容）并**恢复跟随**（设计文档 §23）。
   *  用瞬时跳转而非平滑滚动：长会话里"到底部"可能跨几万像素，smooth 要滚好几秒 ✗。
   *  显式把 followBottom 置 true —— 用户上滚后它为 false（§20.7d），点这个按钮即"我要回到最新" ✓。 */
  jumpToBottom() {
    const scroller = document.getElementById('scroll-view');
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    this.followBottom = true;
  }

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------

  navigateHistory(dir) {
    // dir: -1 = previous (older), +1 = next (newer). Browsing starts from
    // the newest entry when the input is empty; editing resets the browse.
    if (this.inputHistory.length === 0) return;
    if (this.historyIndex === -1) {
      // Not browsing yet: stash the current draft, start at newest entry.
      this.historyDraft = this.inputEl.value;
      this.historyIndex = this.inputHistory.length - 1;
    } else {
      this.historyIndex += dir;
    }
    if (this.historyIndex >= this.inputHistory.length) {
      // Past the newest entry: restore the draft, stop browsing.
      this.historyIndex = -1;
      this.inputEl.value = this.historyDraft;
    } else if (this.historyIndex < 0) {
      this.historyIndex = 0;
      this.inputEl.value = this.inputHistory[0];
    } else {
      this.inputEl.value = this.inputHistory[this.historyIndex];
    }
    // Keep caret at end, keep focus in the box.
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
  }

  sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    // Record every submitted input (messages, !bash, /commands) in the
    // history - TUI parity (handleSubmit addToHistory on all paths).
    if (this.inputHistory[this.inputHistory.length - 1] !== text) {
      this.inputHistory.push(text);
    }
    this.historyIndex = -1;
    this.historyDraft = '';
    if (text.startsWith('!')) {
      // TUI parity: "!cmd" runs bash (output goes to LLM context);
      // "!!cmd" runs bash with excludeFromContext (output NOT sent to LLM).
      const isExcluded = text.startsWith('!!');
      const command = (isExcluded ? text.slice(2) : text.slice(1)).trim();
      if (command) {
        const id = 'bash-' + Date.now();
        this.send({ type: 'bash', command: command, excludeFromContext: isExcluded, id: id });
        this.pendingBashId = id;
        this.pendingBashCommand = command;
      }
    } else if (text.startsWith('/')) {
      // Skill commands (/skill:name args) go through prompt expansion in Pi -
      // sent as-is (with the skill: prefix) so session.prompt expands them.
      if (text.startsWith('/skill:')) {
        this.send({ type: 'prompt', message: text });
        this.inputEl.value = '';
        this.hideCommandMenu();
        return;
      }
      // Other slash commands: builtins are handled locally, everything else is
      // executed as an extension command by the server.
      const m = text.slice(1).match(/^(\S+)\s*(.*)$/);
      const name = m ? m[1] : text.slice(1);
      const args = m ? m[2] : '';
      const builtin = BUILTIN_COMMANDS.find((c) => c.name === name);
      if (builtin && builtin.action && !builtin.unsupported) {
        this.runBuiltinCommand(builtin, args);
      } else if (builtin && builtin.unsupported) {
        this.appendError(`/${name} is not supported in web mode`);
      } else {
        // Prompt templates (/cl etc.) are expanded by Pi's prompt layer -
        // send as prompt text, same as /skill: commands.
        const knownTemplate = (this.lastState?.commands || []).find((c) => c.name === name && c.source === 'prompt');
        if (knownTemplate) {
          this.send({ type: 'prompt', message: text });
        } else {
          this.send({ type: 'command', name: name, args: args });
        }
      }
    } else {
      this.send({ type: 'prompt', message: text });
    }
    this.inputEl.value = '';
    this.hideCommandMenu();
  }

  runBuiltinCommand(cmd, args) {
    if (cmd.action === 'model') {
      this.openModelPicker();
    } else if (cmd.action === 'thinking') {
      this.openThinkingPicker();
    } else if (cmd.action === 'scoped-models') {
      this.openScopedModelsPicker();
    } else if (cmd.action === 'compact') {
      this.send({ type: 'compact' });
    } else if (cmd.action === 'reload') {
      this.send({ type: 'reload' });
    } else if (cmd.action === 'export') {
      const path = (args || '').trim();
      this.send({ type: 'export', path: path });
    } else if (cmd.action === 'session') {
      this.send({ type: 'session' });
    } else if (cmd.action === 'resume') {
      this.openResumePicker();
    } else if (cmd.action === 'name') {
      const newName = window.prompt('Set session display name:', '');
      if (newName && newName.trim()) {
        this.send({ type: 'set_session_name', name: newName.trim() });
      }
    }
  }

  bindInput() {
    this.inputEl.addEventListener('keydown', (e) => {
      const menuOpen = this.commandMenuEl && this.commandMenuEl.style.display !== 'none';
      if (menuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        this.moveCommandMenu(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (menuOpen && e.key === 'Enter' && !e.shiftKey) {
        // Enter picks the highlighted item, or the first one if none highlighted
        e.preventDefault();
        const items = this.commandMenuEl.querySelectorAll('.command-item');
        if (items.length > 0) {
          const idx = this.commandMenuIndex >= 0 ? this.commandMenuIndex : 0;
          items[idx].click();
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      } else if (e.key === 'Escape') {
        this.hideCommandMenu();
      }
    });
    this.inputEl.addEventListener('input', () => this.updateCommandMenu());

    // Header nav buttons: jump to previous/next user message
    const navPrev = document.getElementById('nav-prev');
    const navNext = document.getElementById('nav-next');
    if (navPrev) navPrev.addEventListener('click', () => this.jumpToUserMessage(-1));
    if (navNext) navNext.addEventListener('click', () => this.jumpToUserMessage(1));
    const navBottom = document.getElementById('nav-bottom');
    if (navBottom) navBottom.addEventListener('click', () => this.jumpToBottom());

    if (this.sendBtn) {
      this.sendBtn.addEventListener('click', () => this.sendMessage());
    }
    // Input history navigation (↑/↓ buttons beside the input box)
    const histPrev = document.getElementById('history-prev');
    const histNext = document.getElementById('history-next');
    if (histPrev) histPrev.addEventListener('click', () => this.navigateHistory(-1));
    if (histNext) histNext.addEventListener('click', () => this.navigateHistory(1));
    if (this.abortBtn) {
      this.abortBtn.addEventListener('click', () => {
        this.send({ type: 'abort' });
        this.abortBtn.style.display = 'none';
      });
    }

    // Modal
    if (this.modalClose) {
      this.modalClose.addEventListener('click', () => this.closeModal());
    }
    if (this.modalOverlay) {
      this.modalOverlay.addEventListener('click', (e) => {
        if (e.target === this.modalOverlay) this.closeModal();
      });
    }
    if (this.modalSearch) {
      this.modalSearch.addEventListener('input', () => {
        if (this.modalMode === 'scoped-models') this.renderScopedModelsList();
        else this.filterModalItems();
      });
    }
    document.addEventListener('keydown', (e) => {
      const modalOpen = this.modalOverlay && this.modalOverlay.style.display !== 'none';
      if (e.key === 'Escape' && modalOpen) {
        this.closeModal();
      }
      const usageOverlay = document.getElementById('usage-overlay');
      if (e.key === 'Escape' && usageOverlay && usageOverlay.style.display !== 'none') {
        this.closeUsagePanel();
      }
      // 列表型 modal 的键盘导航（搜索框保持焦点时 ↑↓ 归我们处理，←→ 仍可编辑文字）
      if (!modalOpen || !CURSOR_MODAL_MODES.has(this.modalMode)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveModalCursor(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        this.moveModalCursor(e.key === 'PageDown' ? CURSOR_PAGE_STEP : -CURSOR_PAGE_STEP);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // 单选 = 选中当前项（含 confirm 的 Confirm 按钮）；多选 = 切换勾选
        e.preventDefault();
        this.activateModalCursor();
      }
    });
    const usageClose = document.getElementById('usage-close');
    if (usageClose) usageClose.addEventListener('click', () => this.closeUsagePanel());
    const usageOverlayEl = document.getElementById('usage-overlay');
    if (usageOverlayEl) {
      usageOverlayEl.addEventListener('click', (e) => {
        if (e.target === usageOverlayEl) this.closeUsagePanel();
      });
    }
  }

  // ------------------------------------------------------------------
  // Modal (model/thinking picker)
  // ------------------------------------------------------------------

  openModal(title, mode) {
    this.modalMode = mode;
    this.stopDialogCountdown();
    this.modalTitle.textContent = title;
    this.modalSearch.value = '';
    this.modalList.innerHTML = '';
    this.modalCursor = -1;
    // 搜索框可见性由这里统一决定（此前由各调用方分别设置，导致 model/thinking/
    // scoped-models 会继承上一个 modal 的可见性）；焦点也跟着走——只在搜索框
    // 可见时聚焦它，否则按键会落进一个看不见的输入框。
    const searchable = SEARCHABLE_MODAL_MODES.has(mode);
    this.modalSearch.style.display = searchable ? 'block' : 'none';
    this.modalOverlay.style.display = 'flex';
    if (searchable) this.modalSearch.focus();
    else this.modalEl?.focus();
  }

  /** 光标可导航的元素：confirm 为两个按钮（单选），其余为列表项。 */
  modalCursorItems() {
    if (this.modalMode === 'extension-confirm') {
      return [...this.modalList.querySelectorAll('.modal-actions .modal-btn')];
    }
    return [...this.modalList.querySelectorAll('.modal-item')];
  }

  /** 移动键盘光标（循环，与站内命令菜单一致）。 */
  moveModalCursor(delta) {
    const items = this.modalCursorItems();
    if (items.length === 0) return;
    const base =
      this.modalCursor < 0 ? (delta > 0 ? 0 : items.length - 1) : this.modalCursor + delta;
    this.setModalCursor(((base % items.length) + items.length) % items.length);
  }

  /** 设置键盘光标并滚动入视野。 */
  setModalCursor(idx) {
    const items = this.modalCursorItems();
    this.modalCursor = idx;
    items.forEach((el, i) => el.classList.toggle('cursor', i === idx));
    if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }

  /** Enter：单选列表 = 选中当前项；多选列表 = 切换勾选（复用各自的点击逻辑）。 */
  activateModalCursor() {
    const items = this.modalCursorItems();
    if (items.length === 0) return;
    const el = this.modalCursor >= 0 ? items[this.modalCursor] : items[0];
    el?.click();
  }

  /** Countdown for extension dialogs that carry a deadline (an extension's own
   * opts.timeout). TUI shows the same "(Ns)" ticker; without a deadline the
   * dialog waits indefinitely while a browser is attached. */
  startDialogCountdown(req) {
    this.stopDialogCountdown();
    if (!req || typeof req.deadline !== 'number') return;
    this.dialogCountdownBase = this.modalTitle.textContent || '';
    const tick = () => {
      const remain = Math.max(0, Math.ceil((req.deadline - Date.now()) / 1000));
      this.modalTitle.textContent = `${this.dialogCountdownBase} (${remain}s)`;
      if (remain <= 0) this.stopDialogCountdown();
    };
    tick();
    this.dialogCountdownTimer = setInterval(tick, 1000);
  }

  stopDialogCountdown() {
    if (this.dialogCountdownTimer) {
      clearInterval(this.dialogCountdownTimer);
      this.dialogCountdownTimer = null;
    }
  }

  closeModal() {
    // If an extension dialog (select/confirm/input/editor) was open, notify
    // the server that it was cancelled - otherwise the extension's promise
    // never settles.
    if (this.currentExtRequest && this.currentExtRequest.id) {
      this.send({ type: 'extension_ui_response', id: this.currentExtRequest.id, cancelled: true });
    }
    this.modalOverlay.style.display = 'none';
    this.modalEl?.classList.remove('modal-wide'); // 其他模态保持默认 720px
    this.modalList.innerHTML = '';
    this.modalSearch.value = '';
    this.modalMode = null;
    this.modalCursor = -1;
    this.currentExtRequest = null;
    this.stopDialogCountdown();
    this.inputEl.focus();
  }

  openModelPicker() {
    this.openModal('Select Model', 'model');
    this.send({ type: 'get_available_models' });
  }

  /** 页脚当前 model 链接：只列 **scoped models**（与 `>>` 轮换的是同一集合），
   *  选中即切换——与 /model（全量目录）刻意区分：这里是"我实际会在几个模型间
   *  切换"的短列表。未配置时给提示而不弹空框。 */
  openScopedModelPicker() {
    // state 随 set_scoped_models 重播，所以这份列表始终是最新的
    const scoped = this.lastState?.scopedModels || [];
    if (scoped.length === 0) {
      this.appendNotifyLine(
        '未配置 scoped models —— 用 /scoped-models 选几个模型，这里就能直接切换',
        'warning',
      );
      return;
    }
    this.openModal('Switch Model (scoped)', 'model-scoped');
    const current = this.lastState?.model || {};
    const currentKey = `${current.provider || ''}/${current.id || current.model || ''}`;
    const items = scoped.map((s) => {
      const key = `${s.provider}/${s.id}`;
      const thinking =
        s.thinkingLevel && s.thinkingLevel !== 'off' ? `thinking: ${s.thinkingLevel}` : '';
      return {
        name: key === currentKey ? `${key}  (current)` : key,
        desc: s.name && s.name !== s.id ? s.name : thinking,
        value: s,
      };
    });
    this.renderModalItems(items, (item) => {
      this.send({ type: 'set_model', provider: item.value.provider, modelId: item.value.id });
    });
  }

  openThinkingPicker() {
    this.openModal('Select Thinking Level', 'thinking');
    this.send({ type: 'get_available_thinking_levels' });
  }

  renderModalItems(items, onSelect) {
    this.modalList.innerHTML = '';
    this.modalItems = items;
    this.modalOnSelect = onSelect;
    this.filterModalItems();
  }

  filterModalItems() {
    if (!this.modalItems) return;
    const query = (this.modalSearch.value || '').toLowerCase();
    const filtered = this.modalItems.filter((item) => {
      const name = (item.name || item.id || '').toLowerCase();
      return name.includes(query);
    });
    this.modalList.innerHTML = filtered
      .map(
        (item, i) =>
          `<div class="modal-item" data-index="${i}">` +
          `<span class="modal-item-name">${this.escapeHtml(item.name || item.id || '')}</span>` +
          `<span class="modal-item-desc">${this.escapeHtml(item.desc || '')}</span>` +
          (item.right ? `<span class="modal-item-right">${this.escapeHtml(item.right)}</span>` : '') +
          `</div>`,
      )
      .join('');
    const rendered = this.modalList.querySelectorAll('.modal-item');
    rendered.forEach((el, i) => {
      el.addEventListener('click', () => {
        this.modalOnSelect(filtered[i]);
        this.closeModal();
      });
    });
    // 过滤后应用光标：保持原位置（越界则收敛），无结果时清零
    if (rendered.length > 0) {
      const clamped = this.modalCursor < 0 ? 0 : Math.min(this.modalCursor, rendered.length - 1);
      this.setModalCursor(clamped);
    } else {
      this.modalCursor = -1;
    }
  }

  handleExtensionUIRequest(req) {
    const method = req.method;
    if (method === 'select') {
      this.openExtensionSelect(req);
    } else if (method === 'confirm') {
      this.openExtensionConfirm(req);
    } else if (method === 'input') {
      this.openExtensionInput(req);
    } else if (method === 'editor') {
      this.openExtensionEditor(req);
    } else if (method === 'notify') {
      this.openExtensionNotify(req);
    } else if (method === 'panel') {
      // custom()：扩展的 TUI 组件由桥接渲染成文本行，网页以只读模态呈现
      // （组件自身的按键交互不支持 —— 见 pi-web-design.md §15.11）
      this.openExtensionPanel(req);
    } else if (method === 'setWidget') {
      // Persistent widget panel (TUI: above/below editor). Not a popup.
      this.renderWidget(req);
    } else if (method === 'setStatus') {
      // Extension status text (e.g. magic-context "mc: 29.3K (4%) · idle")
      this.renderStatusItem(req);
    }
    // setTitle / set_editor_text are handled elsewhere or ignored
  }

  renderStatusItem(req) {
    const el = document.getElementById('ext-status');
    if (!el) return;
    const wasAtBottom = this.followBottom;
    if (req.statusText === undefined || req.statusText === null) {
      delete this.extStatus[req.statusKey];
    } else {
      this.extStatus[req.statusKey] = req.statusText;
    }
    this.updateExtStatusDisplay();
    if (wasAtBottom) this.scrollToBottom();
  }

  applyExtStatusSnapshot(snapshot) {
    if (!snapshot) return;
    const wasAtBottom = this.followBottom;
    this.extStatus = Object.assign({}, snapshot);
    this.updateExtStatusDisplay();
    if (wasAtBottom) this.scrollToBottom();
  }

  /** Whether the view is currently pinned to the bottom (before layout changes). */
  wasAtBottom(tolerance = 2) {
    const scroller = document.getElementById('scroll-view');
    return !!scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - tolerance;
  }

  updateExtStatusDisplay() {
    const el = document.getElementById('ext-status');
    if (!el) return;
    const entries = Object.entries(this.extStatus);
    // ANSI escapes (from extension theme.fg/bg) render as colored spans.
    // ansiToHtml escapes the value's HTML; the key is escaped separately.
    el.innerHTML = entries.map(([k, v]) => `${this.escapeHtml(k)}: ${ansiToHtml(String(v))}`).join(' · ');
    el.style.display = entries.length ? 'block' : 'none';
  }

  openExtensionSelect(req) {
    this.openModal(req.title || 'Select', 'extension-select');
    this.currentExtRequest = req;
    this.startDialogCountdown(req);
    const items = (req.options || []).map((opt) => ({ name: opt, desc: '', value: opt }));
    this.renderModalItems(items, (item) => {
      this.send({ type: 'extension_ui_response', id: req.id, value: item.value });
    });
  }

  openExtensionConfirm(req) {
    this.openModal(req.title || 'Confirm', 'extension-confirm');
    this.currentExtRequest = req;
    this.startDialogCountdown(req);
    this.modalList.innerHTML = `
      <div class="modal-message">${this.escapeHtml(req.message || '')}</div>
      <div class="modal-actions">
        <button class="modal-btn confirm-btn">Confirm</button>
        <button class="modal-btn cancel-btn">Cancel</button>
      </div>`;
    this.modalList.querySelector('.confirm-btn').addEventListener('click', () => {
      this.send({ type: 'extension_ui_response', id: req.id, confirmed: true });
      this.closeModal();
    });
    this.modalList.querySelector('.cancel-btn').addEventListener('click', () => {
      this.send({ type: 'extension_ui_response', id: req.id, cancelled: true });
      this.closeModal();
    });
    // 单选：光标初始在第一项（Confirm）——TUI 的 ["Yes","No"] 列表默认 index 0
    this.setModalCursor(0);
  }

  openExtensionInput(req) {
    this.openModal(req.title || 'Input', 'extension-input');
    this.currentExtRequest = req;
    this.startDialogCountdown(req);
    this.modalList.innerHTML = `
      <div class="modal-message">${this.escapeHtml(req.message || '')}</div>
      <input class="modal-input" type="text" placeholder="${this.escapeHtml(req.placeholder || '')}">
      <div class="modal-actions">
        <button class="modal-btn ok-btn">OK</button>
        <button class="modal-btn cancel-btn">Cancel</button>
      </div>`;
    const input = this.modalList.querySelector('.modal-input');
    input.focus();
    this.modalList.querySelector('.ok-btn').addEventListener('click', () => {
      this.send({ type: 'extension_ui_response', id: req.id, value: input.value });
      this.closeModal();
    });
    this.modalList.querySelector('.cancel-btn').addEventListener('click', () => {
      this.send({ type: 'extension_ui_response', id: req.id, cancelled: true });
      this.closeModal();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.send({ type: 'extension_ui_response', id: req.id, value: input.value });
        this.closeModal();
      }
    });
  }

  openExtensionEditor(req) {
    this.openModal(req.title || 'Editor', 'extension-editor');
    this.currentExtRequest = req;
    this.startDialogCountdown(req);
    this.modalList.innerHTML = `
      <div class="modal-message">${this.escapeHtml(req.title || '')}</div>
      <textarea class="modal-editor" rows="10">${this.escapeHtml(req.prefill || '')}</textarea>
      <div class="modal-actions">
        <button class="modal-btn ok-btn">OK</button>
        <button class="modal-btn cancel-btn">Cancel</button>
      </div>`;
    const editor = this.modalList.querySelector('.modal-editor');
    editor.focus();
    this.modalList.querySelector('.ok-btn').addEventListener('click', () => {
      this.send({ type: 'extension_ui_response', id: req.id, value: editor.value });
      this.closeModal();
    });
    this.modalList.querySelector('.cancel-btn').addEventListener('click', () => {
      this.send({ type: 'extension_ui_response', id: req.id, cancelled: true });
      this.closeModal();
    });
  }

  /** Server-side dismissal (timeout / abort / session switch): the dialog was
   * already settled server-side, so close the modal and say why - do NOT send
   * an extension_ui_response (there is nothing left to answer). */
  dismissExtensionDialog({ id, reason } = {}) {
    if (!id || !this.currentExtRequest || this.currentExtRequest.id !== id) return;
    const title = this.currentExtRequest.title || 'Dialog';
    const why =
      reason === 'aborted' ? 'operation aborted'
      : reason === 'session-switch' ? 'session switched'
      : 'no answer received in time';
    this.currentExtRequest = null; // closeModal() must not answer for us
    this.closeModal();
    this.appendNotifyLine(`${title} — auto-dismissed (${why})`, 'warning');
  }

  openExtensionNotify(req) {
    // Command output notifications (title starts with "/", e.g. /ctx-status) keep
    // the modal. Other extension notifies are appended to the chat stream as
    // persistent status lines, matching TUI's notify -> showStatus (a dim text
    // appended to the chat container; NOT a transient toast).
    if (req.title && String(req.title).startsWith('/')) {
      this.openModal(req.title || 'Notification', 'extension-notify');
      this.currentExtRequest = req;
        this.modalList.innerHTML = `<div class="modal-message body-text">${this.renderMarkdown(req.message || '')}</div>`;
      return;
    }
    this.appendNotifyLine(req.message || '', req.notifyType);
  }

  /** 计算「面板能容纳多少列/行」并上报服务端，供桥接按该宽度渲染扩展的 TUI 组件。
   *  TUI 组件是按终端宽度排版的（例：magic-context 的 StatusDialogComponent 读
   *  `tui.terminal.rows` 并以传入 width 画框）；网页这边的等价物就是面板的可用宽度，
   *  按它渲染才能既折不了框、又不需要横向滚动。 */
  sendPanelGeometry() {
    if (!this.panelGeometrySupported) return; // 服务端未声明支持就不要发（SDK 引擎会报错）
    const overlay = document.querySelector('#modal-overlay');
    // 面板用的是 modal-wide（更宽），测量也必须按那个布局量，否则会低估列数
    const modalEl = document.querySelector('#modal');
    const hadWide = modalEl?.classList.contains('modal-wide');
    modalEl?.classList.add('modal-wide');
    try {
      return this.measureAndSendPanelGeometry(overlay);
    } finally {
      if (!hadWide) modalEl?.classList.remove('modal-wide');
    }
  }

  measureAndSendPanelGeometry(overlay) {
    let cols = 100;
    let rows = 40;
    // 注意：这两个值在 try 里被赋值，但要在 catch 之后上报时仍可见 → 必须声明在函数作用域
    // （曾误在 try 内用 const 声明，导致上报那一行 ReferenceError、几何再也发不出去）
    let contentW = 0;
    let charW = 0;
    let boxW = 0;
    let blockW = 0;
    try {
      const prevDisplay = overlay ? overlay.style.display : '';
      const prevVisibility = overlay ? overlay.style.visibility : '';
      if (overlay) {
        overlay.style.visibility = 'hidden'; // 只为了量尺寸，不闪屏
        if (prevDisplay !== 'flex') overlay.style.display = 'flex';
      }
      // 注意是 id 选择器：#modal-list / #modal（写成 .modal-list 会落空 → 量到 body 宽度）
      const host = overlay?.querySelector('#modal-list') || overlay?.querySelector('#modal') || document.body;
      const probe = document.createElement('pre');
      probe.className = 'modal-panel-body';
      // 必须留在文档流内测量：position:absolute 会以「最近的定位祖先」为包含块，
      // 而 #modal/#modal-list 未定位 → 会以视口为基准，量出的是整屏宽度（曾因此得到 162 列）
      probe.style.cssText = 'width:100%;max-height:none;height:0;overflow:hidden;visibility:hidden;';
      probe.textContent = '0';
      host.appendChild(probe);
      const cs = getComputedStyle(probe);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      contentW = probe.clientWidth - padX;
      const metrics = this.monoCharMetrics(cs);
      charW = metrics.digit;
      boxW = metrics.box;
      blockW = metrics.block;
      probe.remove();
      if (overlay) {
        overlay.style.display = prevDisplay;
        overlay.style.visibility = prevVisibility;
      }
      // 容量按**最宽字符类**（数字/框图/色块里最宽者）估算，再留 2 列余量：
      // 亚像素取整、滚动条、以及组件可能比下发宽度多画 1 列（用户浏览器实测 174 > 173）。
      const widest = Math.max(charW, boxW, blockW);
      if (contentW > 0 && widest > 0) cols = Math.max(40, Math.floor(contentW / widest) - 2);
      const lineH = parseFloat(cs.lineHeight) || 16;
      rows = Math.max(10, Math.min(60, Math.floor((window.innerHeight * 0.6) / lineH)));
    } catch {
      /* 量不到就用默认值 */
    }
    this.panelRows = rows;
    this.send({
      type: 'panel_geometry',
      cols,
      rows,
      // 中间量一并上报：日志里能直接看出列数是怎么来的（contentW ÷ charW）
      contentW: Math.round(contentW) || undefined,
      charW: charW ? Number(charW.toFixed(3)) : undefined,
      boxW: boxW ? Number(boxW.toFixed(3)) : undefined,
      blockW: blockW ? Number(blockW.toFixed(3)) : undefined,
    });
  }

  /** 量面板字体下各**字符类**的真实宽度（px）。
   *  必须分开量：当等宽字体缺制表符 U+2500 时浏览器会回退到全角字体，单个 `─` 可能是
   *  数字宽度的两倍 —— 只按数字算列数就会让横框折行（2026-10-14 用户实测）。 */
  monoCharMetrics(cs) {
    const measure = (sample) => {
      const span = document.createElement('span');
      span.style.cssText =
        `position:absolute;visibility:hidden;white-space:pre;font-family:${cs.fontFamily};font-size:${cs.fontSize};`;
      span.textContent = sample;
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width / [...sample].length;
      span.remove();
      return w;
    };
    const digit = measure('0'.repeat(20));
    const box = measure('─'.repeat(20)); // 横框：最能暴露全角回退
    const block = measure('█'.repeat(20)); // 进度条色块
    const cjk = measure('中'.repeat(20));
    return { digit, box, block, cjk, max: Math.max(digit, box, block) };
  }

  /** 面板内容比容器宽时逐档缩小字号，直到最长行放得下（保证不折行、不横滚；下限 8px）。
   *  返回以**基准字号**能容纳的列数，供回报给服务端决定下次渲染宽度。 */
  fitPanelToWidth(pre, lines) {
    if (!pre) return null;
    const stripped = lines.map((l) => String(l).replace(/\u001b\[[0-9;]*m/g, ''));
    const longest = Math.max(0, ...stripped.map((l) => [...l].length));
    if (!longest) return null;
    const cs = getComputedStyle(pre);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const contentW = pre.clientWidth - padX;
    if (contentW <= 0) return null;
    const base = parseFloat(cs.fontSize) || 12;
    /** 逐字符类量宽：数字/框图/色块/CJK 的宽度可能互不相同（字体回退会放大框图字符）。 */
    const widthAt = (px, sample) => {
      const span = document.createElement('span');
      span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${cs.fontFamily};font-size:${px}px;`;
      span.textContent = sample.repeat(20);
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width / 20;
      span.remove();
      return w;
    };
    const widthOf = (px) => {
      const m = {
        digit: widthAt(px, '0'),
        box: widthAt(px, '─'),
        block: widthAt(px, '█'),
        cjk: widthAt(px, '中'),
      };
      return { ...m, max: Math.max(m.digit, m.box, m.block, m.cjk) };
    };
    const pxWidthOfLine = (line, m) => {
      let px = 0;
      for (const ch of line) {
        const c = ch.codePointAt(0);
        if (c >= 0x2500 && c <= 0x257f) px += m.box; // 框图
        else if (c >= 0x2580 && c <= 0x259f) px += m.block; // 色块/进度条
        else if (c > 0x2e7f) px += m.cjk; // CJK、全角、emoji 等宽字符
        else px += m.digit;
      }
      return px;
    };
    const m0 = widthOf(base);
    // 只把**内容里真正出现**的字符类计入最宽值（否则纯 ASCII 面板会被 CJK 宽度白白压窄）
    const present = { box: false, block: false, cjk: false };
    for (const line of stripped) {
      for (const ch of line) {
        const c = ch.codePointAt(0);
        if (c >= 0x2500 && c <= 0x257f) present.box = true;
        else if (c >= 0x2580 && c <= 0x259f) present.block = true;
        else if (c > 0x2e7f) present.cjk = true;
      }
    }
    const presentMax = Math.max(
      m0.digit,
      present.box ? m0.box : 0,
      present.block ? m0.block : 0,
      present.cjk ? m0.cjk : 0,
    );
    const maxPx = Math.max(...stripped.map((l) => pxWidthOfLine(l, m0)));
    // 容量按**内容里出现的最宽字符类**算（并留 2 列余量，吸收组件多画 1 列与取整误差）
    const fitsBase = Math.max(0, Math.floor(contentW / presentMax) - 2);
    if (maxPx <= contentW) return { longest, fitsBase, shrunkTo: base, overflow: false };
    // 放不下：按需要的比例缩小字号（0.5px 一档、下限 8px）
    let size = base;
    while (size > 8) {
      const need = (size * contentW) / maxPx; // 线性缩放：字号乘该比例即可放下
      if (need >= size - 0.25 || size - 0.5 < 8) break;
      size = Math.max(8, Math.floor(need * 2) / 2);
    }
    const m1 = widthOf(size);
    const maxPx1 = Math.max(...stripped.map((l) => pxWidthOfLine(l, m1)));
    pre.style.fontSize = `${size}px`;
    return { longest, fitsBase, shrunkTo: size, overflow: maxPx1 > contentW + 0.5 };
  }

  /** custom() 面板（桥接扩展经 method:'panel' 送来）：只读展示扩展组件渲染出的文本行。
   *  关闭**只用模态自带的 "Close (Esc)"**（在模态边框上、常驻可见；closeModal() 会回 cancelled）。
   *  不另外加按钮：早先加过一个，与自带按钮重复（两个 Close），而且它在滚动区内、内容长时会被滚走。
   *  组件若已 done(value)：桥接随面板一并送来 value，服务端会用该值答复，无需前端特判。 */
  openExtensionPanel(req) {
    const lines = Array.isArray(req.lines) ? req.lines : [];
    // 组件 requestRender 触发的增量刷新：就地替换内容，不重开模态（否则会重置倒计时/丢焦点）
    if (req.update && this.currentExtRequest && this.currentExtRequest.id === req.id) {
      const body = this.modalList.querySelector('.modal-panel-body');
      if (body) {
        // 面板现在**一次性渲染全文**（设计文档 §19.6），滚动交给 #modal-list；
        // 组件每秒自绘（倒计时/用量）会不断触发 update —— 必须保留滚动位置，
        // 否则每秒把用户弹回顶部（贴底时则继续贴底）。
        // 真正的滚动容器是 <pre class="modal-panel-body"> 自身（style.css 里它带 overflow-y:auto），
        // 不是外层 #modal-list
        const scroller = body;
        const prevTop = scroller.scrollTop;
        const wasAtBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        body.innerHTML = ansiToHtml(lines.join('\n'));
        if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
        else scroller.scrollTop = Math.min(prevTop, scroller.scrollHeight);
        const f = this.fitPanelToWidth(body, lines);
        if (f?.overflow) body.classList.add('modal-panel-scrollx');
        else body.classList.remove('modal-panel-scrollx');
        return;
      }
    }
    this.modalEl?.classList.add('modal-wide'); // 面板用更宽的模态（见 style.css）
    this.openModal(req.title || 'Extension panel', 'extension-panel');
    this.currentExtRequest = req;
    this.startDialogCountdown(req);
    this.modalList.innerHTML = `<pre class="modal-panel-body">${ansiToHtml(lines.join('\n'))}</pre>`;
    // 兜底：即使服务端按更大宽度渲染，这里也保证不折行（必要时缩字号），
    // 并把"基准字号下真实能容纳多少列"回报给服务端，让下次渲染直接合适。
    const pre = this.modalList.querySelector('.modal-panel-body');
    const fit = this.fitPanelToWidth(pre, lines);
    if (fit) {
      // 用**真实面板**回测的容量回报（比开工前用探针估的更准），服务端下次即按它渲染
      this.send({
        type: 'panel_geometry',
        cols: Math.max(20, fit.fitsBase - 2), // 同样留 2 列余量（组件可能多画 1 列）
        rows: this.panelRows || 22,
        longest: fit.longest,
        fits: fit.fitsBase,
        shrunkTo: fit.shrunkTo,
        overflow: fit.overflow,
        contentW: Math.round(this.modalList.querySelector('.modal-panel-body')?.clientWidth || 0),
      });
      // 连缩字号都放不下：该面板退横向滚动，绝不让框图被折成几段
      if (fit.overflow) pre?.classList.add('modal-panel-scrollx');
    }
  }

  appendNotifyLine(message, type) {
    // TUI's showStatus reuses the LAST status line: consecutive notifies
    // update it in place (a sticky status); a new line starts only when
    // something else (a message) was inserted in between. Mirror that here.
    const last = this.contentEl.lastElementChild;
    if (last && last.classList.contains('notify-line') && last.dataset.notifyType === (type || '')) {
      last.innerHTML = ansiToHtml(String(message));
      if (this.followBottom) this.scrollToBottom();
      return;
    }
    const div = document.createElement('div');
    div.className = 'notify-line' + (type ? ` notify-${type}` : '');
    div.dataset.notifyType = type || '';
    div.innerHTML = ansiToHtml(String(message));
    this.contentEl.appendChild(div);
    if (this.followBottom) this.scrollToBottom();
  }

  // ------------------------------------------------------------------
  // Usage panel (dedicated big panel for /usage, rendered from the
  // server-aggregated usage_data payload)
  // ------------------------------------------------------------------

  renderUsagePanel(data) {
    if (!data || !data.tabs) return;
    // Preserve the user's current choices (tab/view/scope/expanded) across
    // data refresh (e.g. scope switch Session|All must not reset them);
    // defaults are set only on first open. usageExpanded must exist for the
    // tab/provider click handlers (created once, kept afterwards).
    if (!this.usageTab) this.usageTab = 'thisWeek';
    if (!this.usageView) this.usageView = 'table';
    if (!this.usageScope) this.usageScope = 'session';
    if (!this.usageExpanded) this.usageExpanded = new Set();
    this.usageData = data;
    const overlay = document.getElementById('usage-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    this.renderUsageTabs();
    this.renderUsageBody();
  }

  // Switch the usage scope (session | all) - re-fetch from the server.
  setUsageScope(scope) {
    if (this.usageScope === scope) return;
    this.usageScope = scope;
    this.renderUsageTabs();
    this.send({ type: 'usage', scope });
  }

  closeUsagePanel() {
    const overlay = document.getElementById('usage-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  renderUsageTabs() {
    const tabsEl = document.getElementById('usage-tabs');
    if (!tabsEl) return;
    const labels = {
      today: 'Today',
      thisWeek: 'This Week',
      lastWeek: 'Last Week',
      last30Days: 'Last 30 Days',
      allTime: 'All Time',
    };
    tabsEl.innerHTML = '';
    for (const key of Object.keys(labels)) {
      const tab = document.createElement('span');
      tab.className = 'usage-tab' + (key === this.usageTab ? ' active' : '');
      tab.textContent = labels[key];
      tab.addEventListener('click', () => {
        this.usageTab = key;
        this.usageExpanded.clear();
        this.renderUsageTabs();
        this.renderUsageBody();
      });
      tabsEl.appendChild(tab);
    }
    // View switcher: Table / Insights / Graph + scope (Session | All)
    const viewsEl = document.getElementById('usage-views');
    if (viewsEl) {
      viewsEl.innerHTML = '';
      for (const [key, label] of [['table', 'Table'], ['insights', 'Insights'], ['graph', 'Graph']]) {
        const v = document.createElement('span');
        v.className = 'usage-view' + (key === this.usageView ? ' active' : '');
        v.textContent = label;
        v.addEventListener('click', () => {
          this.usageView = key;
          this.renderUsageTabs();
          this.renderUsageBody();
        });
        viewsEl.appendChild(v);
      }
      const scopeSep = document.createElement('span');
      scopeSep.className = 'usage-scope-sep';
      scopeSep.textContent = '|';
      viewsEl.appendChild(scopeSep);
      for (const [key, label] of [['session', 'Session'], ['all', 'All']]) {
        const s = document.createElement('span');
        s.className = 'usage-view' + (key === this.usageScope ? ' active' : '');
        s.textContent = label;
        s.addEventListener('click', () => this.setUsageScope(key));
        viewsEl.appendChild(s);
      }
    }
  }

  fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  fmtCost(c) {
    if (!c || c <= 0) return '-';
    if (c < 0.01) return '$' + c.toFixed(4);
    if (c < 10) return '$' + c.toFixed(2);
    return '$' + c.toFixed(1);
  }

  renderUsageBody() {
    const body = document.getElementById('usage-body');
    if (!body) return;
    const period = this.usageData.tabs[this.usageTab];
    if (!period) return;
    body.innerHTML = '';
    body.scrollTop = 0;

    if (this.usageView === 'table') {
      const table = document.createElement('table');
      table.className = 'usage-table';
      const head = document.createElement('thead');
      head.innerHTML = '<tr><th>Provider / Model</th><th>Msgs</th><th>Cost</th><th>Tokens</th><th>↑In</th><th>↓Out</th><th>Cache</th><th>Sessions</th></tr>';
      table.appendChild(head);
      const tbody = document.createElement('tbody');

      const rowFor = (name, stat, isModel, isTotals) => {
        const tr = document.createElement('tr');
        if (isTotals) tr.className = 'usage-totals';
        else if (isModel) tr.className = 'usage-model-row';
        else tr.className = 'usage-provider-row';
        const nameTd = document.createElement('td');
        nameTd.className = 'usage-name';
        nameTd.textContent = name;
        const [, cost, tokens, input, output, cache, msgs, sessions] = [null, this.fmtCost(stat.cost), this.fmtTokens(stat.tokens ? stat.tokens.total : 0), this.fmtTokens(stat.tokens ? stat.tokens.input : 0), this.fmtTokens(stat.tokens ? stat.tokens.output : 0), this.fmtTokens(stat.tokens ? (stat.tokens.cacheRead + stat.tokens.cacheWrite) : 0), String(stat.messages), String(stat.sessions)];
        tr.appendChild(nameTd);
        for (const cell of [msgs, cost, tokens, input, output, cache, sessions]) {
          const td = document.createElement('td');
          td.textContent = cell;
          td.className = 'usage-num';
          tr.appendChild(td);
        }
        return tr;
      };

      for (const p of period.providers) {
        const key = 'p:' + p.name;
        const expanded = this.usageExpanded.has(key);
        const tr = rowFor(p.name, p, false, false);
        tr.addEventListener('click', () => {
          if (this.usageExpanded.has(key)) this.usageExpanded.delete(key);
          else this.usageExpanded.add(key);
          this.renderUsageBody();
        });
        tbody.appendChild(tr);
        if (expanded) {
          for (const m of p.models || []) {
            tbody.appendChild(rowFor('  └ ' + m.name, m, true, false));
          }
        }
      }
      const totals = period.totals;
      tbody.appendChild(rowFor('Total', totals, false, true));
      table.appendChild(tbody);
      body.appendChild(table);
    } else if (this.usageView === 'insights') {
      const list = document.createElement('div');
      list.className = 'usage-insights';
      const ins = period.insights || [];
      if (ins.length === 0) {
        list.innerHTML = '<div class="usage-insight">No insights for this period.</div>';
      }
      for (const i of ins) {
        const div = document.createElement('div');
        div.className = 'usage-insight ' + (i.kind === 'alarm' ? 'alarm' : 'structure');
        const stat = document.createElement('span');
        stat.className = 'usage-insight-stat';
        stat.textContent = i.stat;
        const text = document.createElement('span');
        text.textContent = i.headline;
        div.appendChild(stat);
        div.appendChild(text);
        if (i.advice) {
          const advice = document.createElement('div');
          advice.className = 'usage-insight-advice';
          advice.textContent = i.advice;
          div.appendChild(advice);
        }
        list.appendChild(div);
      }
      body.appendChild(list);
    } else if (this.usageView === 'graph') {
      // Simple CSS bar chart: cost per provider (this period) + hourly tokens trend
      const container = document.createElement('div');
      container.className = 'usage-graph';
      if (period.providers.length === 0) {
        container.innerHTML = '<div class="usage-insight">No data for this period.</div>';
        body.appendChild(container);
        return;
      }
      const maxCost = Math.max(...period.providers.map((p) => p.cost), 1e-9);
      let html = '<div class="usage-graph-title">Cost by provider</div><div class="usage-bars">';
      for (const p of period.providers) {
        const w = ((p.cost / maxCost) * 100).toFixed(1);
        html += `<div class="usage-bar-row"><span class="usage-bar-label">${this.escapeHtml(p.name)}</span><div class="usage-bar-track"><div class="usage-bar" style="width:${w}%"></div></div><span class="usage-bar-val">${this.fmtCost(p.cost)}</span></div>`;
      }
      html += '</div>';
      // Hourly tokens trend for the current tab. The server provides one
      // global hourly series + per-tab windows; filtering (per tab) and
      // gap-filling are render-side concerns.
      const hourly = this.usageData.hourly ? this.usageData.hourly : null;
      const window = (this.usageData.tabWindow || {})[this.usageTab] || null;
      if (hourly && hourly.length > 0) {
        // Filter to the tab's window, then fill the x-axis with a
        // continuous hour sequence so idle hours appear as empty columns.
        // Axis start rule: if the earliest data predates the period start,
        // show the whole period (zeros included); if data only exists
        // inside the period, start from the first hour with data (e.g.
        // allTime never starts at epoch - it starts at first usage).
        let seq = hourly;
        if (window && window[1] > window[0]) {
          const H = 3600_000;
          const inWindow = hourly.filter((b) => b.hour >= window[0] && b.hour < window[1]);
          const periodStartHour = Math.floor(window[0] / H) * H;
          // Rule: compare the GLOBAL earliest data hour with the period
          // start. If data predates the period (global first < period
          // start), show the whole period (zeros included). Only when the
          // very first usage ever is inside this period do we start from
          // the first data hour (e.g. allTime starts at first usage, not
          // epoch).
          const globalFirstHour = hourly[0].hour; // hourly is time-sorted
          const startHour = globalFirstHour > periodStartHour ? globalFirstHour : periodStartHour;
          const endHour = Math.floor(window[1] / H) * H;
          const byHour = new Map(inWindow.map((b) => [b.hour, b]));
          seq = [];
          for (let h = startHour; h <= endHour; h += H) {
            const b = byHour.get(h);
            seq.push(b ? { ...b } : { hour: h, cost: 0, tokens: 0, messages: 0 });
          }
        }
        // Cap the column count (~120) so very long windows (allTime) stay
        // manageable; the hourly chart scrolls horizontally to show idle
        // hours, so a generous count is fine.
        let buckets = seq;
        const maxCols = 120;
        if (buckets.length > maxCols) {
          const step = Math.ceil(buckets.length / maxCols);
          const agg = [];
          for (let i = 0; i < buckets.length; i += step) {
            const slice = buckets.slice(i, Math.min(i + step, buckets.length));
            const start = slice[0].hour;
            const end = slice[slice.length - 1].hour + 3600_000;
            agg.push({
              hour: start,
              tokens: slice.reduce((s, b) => s + b.tokens, 0),
              cost: slice.reduce((s, b) => s + b.cost, 0),
              messages: slice.reduce((s, b) => s + b.messages, 0),
              spanEnd: end,
              spanCount: slice.length,
            });
          }
          buckets = agg;
        }
        const maxT = Math.max(...buckets.map((b) => b.tokens), 1e-9);
        // Fixed-height bars (px) - avoids percentage-height resolution
        // issues in nested flex containers.
        const BAR_MAX_PX = 96;
        // Label every ~6th column with its time (sparse to avoid crowding).
        const labelStep = Math.ceil(buckets.length / 8);
        html += '<div class="usage-graph-title" style="margin-top:14px">Hourly tokens (recent)</div><div class="usage-hourly">';
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          const hPx = b.tokens > 0 ? Math.max(2, Math.round((b.tokens / maxT) * BAR_MAX_PX)) : 0;
          const d = new Date(b.hour);
          const spanText = b.spanCount ? ` (${b.spanCount}h)` : '';
          const showLabel = i % labelStep === 0 || i === buckets.length - 1;
          const label = showLabel
            ? d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) + '\n' + d.toLocaleTimeString(undefined, { hour: '2-digit' })
            : '';
          // Day/night banding: hour 6..17 (local) = day, else night
          const hourOfDay = d.getHours();
          const band = hourOfDay >= 6 && hourOfDay < 18 ? 'day' : 'night';
          html += `<div class="usage-hour-col ${band}" title="${d.toLocaleString()}${spanText} — ${this.fmtTokens(b.tokens)}"><div class="usage-hour-bar-wrap"><div class="usage-hour-bar" style="height:${hPx}px"></div></div><div class="usage-hour-label">${this.escapeHtml(label).replace(/\n/g, '<br>')}</div></div>`;
        }
        html += '</div>';
      }
      container.innerHTML = html;
      body.appendChild(container);
    }
  }

  handleModels(models) {
    if (this.modalMode !== 'model') return;
    const items = (models || []).map((m) => ({
      name: `${m.provider}/${m.id}`,
      desc: m.reasoning ? 'reasoning' : '',
      value: { provider: m.provider, id: m.id },
    }));
    this.renderModalItems(items, (item) => {
      this.send({ type: 'set_model', provider: item.value.provider, modelId: item.value.id });
    });
  }

  handleThinkingLevels(levels) {
    if (this.modalMode !== 'thinking') return;
    const descriptions = {
      off: 'No reasoning',
      minimal: 'Very brief reasoning (~1k tokens)',
      low: 'Light reasoning (~2k tokens)',
      medium: 'Moderate reasoning (~8k tokens)',
      high: 'Deep reasoning (~16k tokens)',
      xhigh: 'Extra-high reasoning (~32k tokens)',
      max: 'Maximum reasoning',
    };
    const items = (levels || []).map((level) => ({
      name: level,
      desc: descriptions[level] || '',
      value: level,
    }));
    this.renderModalItems(items, (item) => {
      this.send({ type: 'set_thinking_level', level: item.value });
    });
  }

  // ------------------------------------------------------------------
  // Resume picker (switch to another session)
  // ------------------------------------------------------------------

  openResumePicker() {
    this.openModal('Resume Session', 'resume');
    this.modalList.innerHTML = '<div class="modal-message">Loading sessions...</div>';
    this.send({ type: 'get_sessions' });
  }

  /** 相对时间，口径照抄 TUI 的 formatSessionDate（session-selector.ts:35）：
   *  now / Nm / Nh / Nd / Nw / Nmo / Ny。 */
  formatSessionAge(mtime) {
    if (!Number.isFinite(mtime)) return '';
    const diffMs = Date.now() - mtime;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(diffMs / 3600000);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(diffMs / 86400000);
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }

  handleSessions(data) {
    if (this.modalMode !== 'resume') return;
    const sessions = data || [];
    if (sessions.length === 0) {
      this.modalList.innerHTML = '<div class="modal-message">No other sessions available</div>';
      return;
    }
    this.renderModalItems(
      // right = 相对最后活动时间（对齐 TUI 的 formatSessionDate 口径，见设计文档 §22）
      sessions.map((s) => ({
        name: s.name || s.id,
        desc: s.cwd,
        right: this.formatSessionAge(s.mtime),
        value: s.path,
      })),
      (item) => {
        this.send({ type: 'resume', path: item.value });
      },
    );
    // Add delete buttons to each item (stopPropagation so clicks don't resume)
    this.modalList.querySelectorAll('.modal-item').forEach((el, i) => {
      const session = sessions[i];
      el.classList.add('resume-item');
      const del = document.createElement('span');
      del.className = 'resume-delete';
      del.title = 'Delete this session';
      del.textContent = '🗑';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSession(session);
      });
      el.appendChild(del);
    });
  }

  deleteSession(session) {
    const label = session.name || session.id;
    if (!window.confirm(`Delete session "${label}"?\nThis cannot be undone.`)) return;
    this.send({ type: 'delete_session', path: session.path });
    // Refresh the list after delete (errors surface via toast/error message)
    setTimeout(() => this.send({ type: 'get_sessions' }), 300);
  }

  // ------------------------------------------------------------------
  // Scoped models picker (multi-select: models available for cycling)
  // ------------------------------------------------------------------

  openScopedModelsPicker() {
    this.openModal('Select Scoped Models (empty = all available)', 'scoped-models');
    this.scopedModelsAll = [];
    this.scopedModelsSelected = new Set();
    this.scopedModelsData = null;
    this.scopedModelsSaved = true;
    this.modalList.innerHTML = '<div class="modal-message">Loading models...</div>';
    this.send({ type: 'get_scoped_models' });
  }

  handleScopedModels(data) {
    if (this.modalMode !== 'scoped-models') return;
    const available = data.available || [];
    // Merge settings' configured model patterns (e.g. deepinfra/zai-org/
    // GLM-5.3-Flash) that have no matching provider model - TUI's selector
    // shows these as configured entries (no-match diagnostics) too.
    const known = new Set(available.map((m) => `${m.provider}/${m.id}`));
    const configured = (data.configured || [])
      .filter((p) => !known.has(p))
      .map((p) => {
        const slash = p.indexOf('/');
        return { provider: p.slice(0, slash), id: p.slice(slash + 1), configured: true };
      });
    this.scopedModelsAll = [...available, ...configured];
    this.scopedModelsData = data;
    this.scopedModelsSelected = new Set(
      (data.scoped || []).map((s) => `${s.provider}/${s.id}`),
    );
    this.renderScopedModelsList();
  }

  renderScopedModelsList() {
    if (this.modalMode !== 'scoped-models') return;
    const query = (this.modalSearch.value || '').toLowerCase();
    const items = (this.scopedModelsAll || [])
      .filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(query))
      .sort((a, b) => {
        // Selected models first, preserving original order within each group
        const aSel = this.scopedModelsSelected.has(`${a.provider}/${a.id}`) ? 0 : 1;
        const bSel = this.scopedModelsSelected.has(`${b.provider}/${b.id}`) ? 0 : 1;
        return aSel - bSel;
      });
    const rows = items
      .map((m) => {
        const key = `${m.provider}/${m.id}`;
        const checked = this.scopedModelsSelected.has(key);
        return (
          `<div class="modal-item scoped-model ${checked ? 'selected' : ''}" data-key="${key}">` +
          `<span class="modal-check">${checked ? '☑' : '☐'}</span>` +
          `<span class="modal-item-name">${this.escapeHtml(key)}${m.configured ? ' <span class="configured-badge">[configured]</span>' : ''}</span>` +
          `</div>`
        );
      })
      .join('');
    this.modalList.innerHTML =
      `<div class="modal-actions">
         <button class="modal-btn ok-btn">Save</button>
         <button class="modal-btn cancel-btn">Cancel</button>
         <span class="modal-hint"></span>
       </div>` +
      rows;
    this.updateScopedUnsavedHint();
    const renderedScoped = this.modalList.querySelectorAll('.modal-item');
    if (renderedScoped.length > 0) {
      this.setModalCursor(this.modalCursor < 0 ? 0 : Math.min(this.modalCursor, renderedScoped.length - 1));
    } else {
      this.modalCursor = -1;
    }
    this.modalList.querySelectorAll('.scoped-model').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        if (this.scopedModelsSelected.has(key)) this.scopedModelsSelected.delete(key);
        else this.scopedModelsSelected.add(key);
        const checked = this.scopedModelsSelected.has(key);
        el.classList.toggle('selected', checked);
        el.querySelector('.modal-check').textContent = checked ? '☑' : '☐';
        // TUI onChange: apply to session (memory, persist=false); Save persists.
        this.applyScopedModels(false);
      });
    });
    const okBtn = this.modalList.querySelector('.ok-btn');
    if (okBtn) {
      okBtn.addEventListener('click', () => {
        this.applyScopedModels(true);
        this.closeModal();
      });
    }
    const cancelBtn = this.modalList.querySelector('.cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeModal());
  }

  /** Send the current selection to the server (persist=false = memory only). */
  applyScopedModels(persist) {
    const models = [];
    for (const m of this.scopedModelsAll || []) {
      const key = `${m.provider}/${m.id}`;
      if (this.scopedModelsSelected.has(key)) {
        const scopedInfo = (this.scopedModelsData?.scoped || []).find(
          (s) => `${s.provider}/${s.id}` === key,
        );
        models.push({
          provider: m.provider,
          modelId: m.id,
          thinkingLevel: scopedInfo?.thinkingLevel,
        });
      }
    }
    this.send({ type: 'set_scoped_models', models, persist: persist });
    this.scopedModelsSaved = persist;
    this.updateScopedUnsavedHint();
  }

  updateScopedUnsavedHint() {
    const hint = this.modalList.querySelector('.modal-hint');
    if (!hint) return;
    hint.textContent = this.scopedModelsSaved ? '' : ' (unsaved)';
    hint.className = this.scopedModelsSaved ? 'modal-hint' : 'modal-hint unsaved';
  }

  // ------------------------------------------------------------------
  // Slash command menu
  // ------------------------------------------------------------------

  updateCommandMenu() {
    if (!this.commandMenuEl) return;
    const text = this.inputEl.value;
    if (!text.startsWith('/')) {
      this.hideCommandMenu();
      return;
    }

    const query = text.slice(1).toLowerCase();
    const commands = [
      ...((this.lastState && this.lastState.commands) || []),
      ...BUILTIN_COMMANDS,
    ];
    const filtered = commands
      .filter((c) => {
        // Match against the raw command name (with skill:/prompt prefixes, e.g.
        // "skill:meeting-discuss") so typing "/skill" surfaces every skill
        // command instead of only ones whose bare name contains "skill".
        const name = (c.name || '').toLowerCase();
        const desc = (c.description || c.source || '').toLowerCase();
        return name.includes(query) || desc.includes(query);
      })
      .sort((a, b) => {
        // Exact-name match first, then name-prefix, then name-contains,
        // then description-contains (avoids unrelated commands flooding the list)
        const score = (c) => {
          const name = (c.name || '').toLowerCase();
          if (name === query) return 0;
          if (name.startsWith(query)) return 1;
          if (name.includes(query)) return 2;
          return 3;
        };
        return score(a) - score(b);
      });

    if (filtered.length === 0) {
      this.hideCommandMenu();
      return;
    }

    this.commandMenuEl.innerHTML = filtered
      .map(
        (c, i) =>
          `<div class="command-item" data-index="${i}">` +
          `<span class="command-name">/${this.escapeHtml(c.name)}</span>` +
          `<span class="command-desc">${this.escapeHtml(c.description || c.source || '')}</span>` +
          (c.unsupported ? `<span class="command-unsupported">not supported</span>` : '') +
          `</div>`,
      )
      .join('');
    this.commandMenuEl.style.display = 'block';
    this.commandMenuIndex = -1;

    this.commandMenuEl.querySelectorAll('.command-item').forEach((el, i) => {
      el.addEventListener('click', () => this.selectCommand(filtered[i]));
      el.addEventListener('mouseenter', () => this.setCommandMenuIndex(i));
    });
  }

  moveCommandMenu(delta) {
    const items = this.commandMenuEl.querySelectorAll('.command-item');
    if (items.length === 0) return;
    let idx = this.commandMenuIndex < 0 ? (delta > 0 ? 0 : items.length - 1) : this.commandMenuIndex + delta;
    idx = (idx + items.length) % items.length;
    this.setCommandMenuIndex(idx);
  }

  setCommandMenuIndex(idx) {
    this.commandMenuIndex = idx;
    const items = this.commandMenuEl.querySelectorAll('.command-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === idx));
    if (idx >= 0 && items[idx]) {
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  selectCommand(cmd) {
    if (!cmd) return;

    // Builtin commands with actions
    if (cmd.builtin && cmd.action && !cmd.unsupported) {
      this.runBuiltinCommand(cmd, '');
      this.hideCommandMenu();
      this.inputEl.value = '';
      return;
    }

    // Unsupported builtin
    if (cmd.builtin && cmd.unsupported) {
      this.appendError(`/${cmd.name} is not supported in web mode`);
      this.hideCommandMenu();
      this.inputEl.value = '';
      return;
    }

    // Regular commands: insert into input (keep skill: prefix - Pi expands it)
    this.inputEl.value = '/' + cmd.name + ' ';
    this.inputEl.focus();
    this.hideCommandMenu();
  }

  hideCommandMenu() {
    this.commandMenuIndex = -1;
    if (this.commandMenuEl) {
      this.commandMenuEl.style.display = 'none';
      this.commandMenuEl.innerHTML = '';
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const client = new PiWebClient();
  // 窗口尺寸/字号变化会改变面板可用列数 —— 防抖后重新上报（供桥接按该宽度渲染扩展组件）
  let geomTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(geomTimer);
    geomTimer = setTimeout(() => client.sendPanelGeometry(), 300);
  });
});
