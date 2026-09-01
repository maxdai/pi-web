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
    this.statusEl = document.getElementById('conn-status');
    this.statusAreaEl = document.getElementById('status');
    this.pendingEl = document.getElementById('pending');
    this.versionEl = document.getElementById('version');
    this.loadedResourcesEl = document.getElementById('loaded-resources');
    this.footerEl = document.getElementById('footer-line');
    this.inputEl = document.getElementById('input');
    this.sendBtn = document.getElementById('send-btn');
    this.abortBtn = document.getElementById('abort-btn');
    this.commandMenuEl = document.getElementById('command-menu');
    this.modalOverlay = document.getElementById('modal-overlay');
    this.modalTitle = document.getElementById('modal-title');
    this.modalSearch = document.getElementById('modal-search');
    this.modalList = document.getElementById('modal-list');
    this.modalClose = document.getElementById('modal-close');
    this.modalMode = null; // 'model' | 'thinking'
    this.hasConnectedBefore = false;
    this.commandMenuIndex = -1;
    this.extStatus = {};

    this.initThemeSwitch();

    // Streaming state: current assistant message being built
    this.streaming = {
      active: false,
      el: null,
      role: 'assistant',
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

    this.connect();
    this.bindInput();
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
    this.renderLoadedResources(state.commands, state.tools);

    // First footer line: pwd (branch) • session name
    const pwd = state.cwd || '';
    const branch = state.gitBranch ? ` (${state.gitBranch})` : '';
    const name = state.sessionName ? ` • ${state.sessionName}` : '';
    this.footerEl.textContent = `${pwd}${branch}${name}`;

    // Second footer line: TUI-like stats + model info
    this.renderStats(state.sessionStats, state);
  }

  renderLoadedResources(commands, tools) {
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
        sections.push(this.resourceSection('Extensions', groups.extension.map((c) => c.name)));
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
      const modelHtml = `<span class="clickable model-label" title="Click to change model">${this.escapeHtml(modelLabel)}</span>`;
      const cycleHtml = `<span class="clickable cycle-model-label" title="Cycle to next model (TUI Ctrl+P)">>></span>`;
      const thinkingHtml = `<span class="clickable thinking-label" title="Click to change thinking">${this.escapeHtml(thinking)}</span>`;
      rightHtml = `${modelHtml} ${cycleHtml} · ${thinkingHtml}`;
    }

    statsEl.innerHTML = `<span class="stats-left">${leftParts.join(' ')}</span><span class="stats-right">${rightHtml}</span>`;

    const modelEl = statsEl.querySelector('.model-label');
    if (modelEl) {
      modelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openModelPicker();
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

  getStats() {
    this.send({ type: 'get_stats' });
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

  renderHistory(entries) {
    this.clearContent();
    if (!entries || !entries.entries) return;
    for (const entry of entries.entries) {
      this.renderEntry(entry);
    }
    this.scrollToBottom();
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
    div.addEventListener('click', () => this.toggleSpecial(div));
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
    div.classList.toggle('expanded', !expanded);
    this.applySpecialBlock(div);
  }

  clearContent() {
    this.contentEl.innerHTML = '';
    for (const timer of this.toolTimers.values()) {
      clearInterval(timer);
    }
    this.toolTimers.clear();
    this.toolEls.clear();
    this.streaming = { active: false, el: null, role: 'assistant' };
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
  }

  // ------------------------------------------------------------------
  // Rendering: session events
  // ------------------------------------------------------------------

  renderEvent(ev) {
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
    this.scrollToBottom();
  }

  onMessageStart(message) {
    if (!message) return;
    if (message.role === 'user') {
      this.appendUserMessage(message);
    } else if (message.role === 'assistant') {
      this.startAssistantMessage(message);
    }
    // toolResult handled via tool_execution events
  }

  onMessageUpdate(ev) {
    const msg = ev.message;
    if (!msg) return;
    // Find the delta event for partial text/thinking updates
    const aev = ev.assistantMessageEvent;
    if (!aev) return;
    if (!this.streaming.active || !this.streaming.el) {
      this.startAssistantMessage(msg);
    }
    if (aev.type === 'text_delta') {
      // Update the assistant text content
      this.updateAssistantText(msg);
    } else if (aev.type === 'thinking_delta') {
      this.updateAssistantThinking(msg);
    } else if (aev.type === 'toolcall_delta') {
      // Tool call streaming - could update later
    }
  }

  onMessageEnd(message) {
    if (message && message.role === 'assistant') {
      this.finalizeAssistantMessage(message);
    }
  }

  resetStreaming() {
    this.streaming = { active: false, el: null, role: 'assistant' };
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
    const wasAtBottom = this.wasAtBottom();

    if (req.widgetLines === undefined || req.widgetLines === null) {
      // Clear this widget
      const el = widgetsEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
      if (el) el.remove();
      if (widgetsEl.children.length === 0) widgetsEl.style.display = 'none';
      if (wasAtBottom) this.scrollToBottom();
      return;
    }

    let el = widgetsEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'widget-block';
      el.dataset.widgetKey = key;
      const title = document.createElement('div');
      title.className = 'widget-title';
      const body = document.createElement('div');
      body.className = 'widget-body';
      el.appendChild(title);
      el.appendChild(body);
      widgetsEl.appendChild(el);
    }
    el.querySelector('.widget-title').textContent = key;
    // ANSI escapes (extension theme) render as colored spans per line.
    el.querySelector('.widget-body').innerHTML = (req.widgetLines || [])
      .map((line) => ansiToHtml(String(line)))
      .join('<br>');
    widgetsEl.style.display = 'block';
    // Layout change: keep pinned to bottom if already there
    if (wasAtBottom) this.scrollToBottom();
  }

  // ------------------------------------------------------------------
  // Rendering helpers
  // ------------------------------------------------------------------

  appendUserMessage(message) {
    const text = this.messageText(message);
    const div = document.createElement('div');
    div.className = 'message user';
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = 'You';
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

    this.streaming = { active: true, el: div, body: body, role: 'assistant' };
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
    if (body) {
      this.renderAssistantContent(message, body);
    }
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

    // Args (non-bash)
    if (!isBash) {
      const argsEl = document.createElement('div');
      argsEl.className = 'tool-args';
      argsEl.textContent = JSON.stringify(args || {}, null, 2);
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

    // Click to expand/collapse
    div.addEventListener('click', () => this.toggleToolExpand(div));

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
    div.classList.toggle('expanded', !expanded);
    this.applyToolPreview(div);
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
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      const el = div.querySelector('.tool-duration');
      if (el) el.textContent = `Elapsed ${dur}s`;
    }, 1000);
    this.toolTimers.set(ev.toolCallId, timer);
  }

  onToolUpdate(ev) {
    const div = this.toolEls.get(ev.toolCallId);
    if (!div) return;
    if (ev.partialResult !== undefined && ev.partialResult !== null) {
      this.setToolOutput(div, this.resultText(ev.partialResult));
    }
  }

  onToolEnd(ev) {
    const div = this.toolEls.get(ev.toolCallId);
    if (!div) return;
    div.className = ev.isError ? 'tool-block error' : 'tool-block success';

    if (ev.result) {
      this.setToolOutput(div, this.resultText(ev.result));
    }

    // Stop elapsed timer and show final duration
    const timer = this.toolTimers.get(ev.toolCallId);
    if (timer) {
      clearInterval(timer);
      this.toolTimers.delete(ev.toolCallId);
    }
    const start = parseInt(div.dataset.startTime || '0', 10);
    const durationEl = div.querySelector('.tool-duration');
    if (durationEl && start) {
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      durationEl.textContent = `Took ${dur}s`;
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
    if (this.wasAtBottom()) this.scrollToBottom();
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
      this.scrollToBottom();
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

    this.scrollToBottom();
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

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------

  sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;
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

    if (this.sendBtn) {
      this.sendBtn.addEventListener('click', () => this.sendMessage());
    }
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
      if (e.key === 'Escape' && this.modalOverlay && this.modalOverlay.style.display !== 'none') {
        this.closeModal();
      }
    });
  }

  // ------------------------------------------------------------------
  // Modal (model/thinking picker)
  // ------------------------------------------------------------------

  openModal(title, mode) {
    this.modalMode = mode;
    this.modalTitle.textContent = title;
    this.modalSearch.value = '';
    this.modalList.innerHTML = '';
    this.modalOverlay.style.display = 'flex';
    this.modalSearch.focus();
  }

  closeModal() {
    this.modalOverlay.style.display = 'none';
    this.modalList.innerHTML = '';
    this.modalSearch.value = '';
    this.modalSearch.style.display = 'block';
    this.modalMode = null;
    this.currentExtRequest = null;
    this.inputEl.focus();
  }

  openModelPicker() {
    this.openModal('Select Model', 'model');
    this.send({ type: 'get_available_models' });
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
          `</div>`,
      )
      .join('');
    this.modalList.querySelectorAll('.modal-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        this.modalOnSelect(filtered[i]);
        this.closeModal();
      });
    });
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
    const wasAtBottom = this.wasAtBottom();
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
    const wasAtBottom = this.wasAtBottom();
    this.extStatus = Object.assign({}, snapshot);
    this.updateExtStatusDisplay();
    if (wasAtBottom) this.scrollToBottom();
  }

  /** Whether the view is currently pinned to the bottom (before layout changes). */
  wasAtBottom() {
    const scroller = document.getElementById('scroll-view');
    return !!scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
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
    this.modalSearch.style.display = 'block';
    const items = (req.options || []).map((opt) => ({ name: opt, desc: '', value: opt }));
    this.renderModalItems(items, (item) => {
      this.send({ type: 'extension_ui_response', id: req.id, value: item.value });
    });
  }

  openExtensionConfirm(req) {
    this.openModal(req.title || 'Confirm', 'extension-confirm');
    this.currentExtRequest = req;
    this.modalSearch.style.display = 'none';
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
  }

  openExtensionInput(req) {
    this.openModal(req.title || 'Input', 'extension-input');
    this.currentExtRequest = req;
    this.modalSearch.style.display = 'none';
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
    this.modalSearch.style.display = 'none';
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

  openExtensionNotify(req) {
    // Command output notifications (title starts with "/", e.g. /ctx-status) keep
    // the modal. Other extension notifies are lightweight toasts (TUI shows
    // notify as a transient status message, not a dialog).
    if (req.title && String(req.title).startsWith('/')) {
      this.openModal(req.title || 'Notification', 'extension-notify');
      this.currentExtRequest = req;
      this.modalSearch.style.display = 'none';
      this.modalList.innerHTML = `<div class="modal-message body-text">${this.renderMarkdown(req.message || '')}</div>`;
      return;
    }
    this.showToast(req.message || '', req.notifyType);
  }

  showToast(message, type) {
    let container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ` toast-${type}` : '');
    // Extension notify messages may carry ANSI escapes (theme.fg); render them.
    toast.innerHTML = ansiToHtml(String(message));
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 8000 : 5000);
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

  handleSessions(data) {
    if (this.modalMode !== 'resume') return;
    const sessions = data || [];
    if (sessions.length === 0) {
      this.modalList.innerHTML = '<div class="modal-message">No other sessions available</div>';
      return;
    }
    this.resumeSessions = sessions;
    this.renderModalItems(
      sessions.map((s) => ({ name: s.name || s.id, desc: s.cwd, value: s.path })),
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
    this.scopedModelsAll = data.available || [];
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
          `<span class="modal-item-name">${this.escapeHtml(key)}</span>` +
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
  new PiWebClient();
});
