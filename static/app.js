// pi-web browser client
// Connects to the WebSocket, renders Pi RPC events into a TUI-like view.

const BUILTIN_COMMANDS = [
  { name: 'model', description: 'Select model (opens selector)', builtin: true, action: 'model' },
  { name: 'thinking', description: 'Select thinking level', builtin: true, action: 'thinking' },
  { name: 'compact', description: 'Manually compact the session context', builtin: true, action: 'compact' },
  { name: 'name', description: 'Set session display name', builtin: true, action: 'name' },
  { name: 'login', description: 'Configure provider authentication (not supported in web)', builtin: true, unsupported: true },
  { name: 'logout', description: 'Remove provider authentication (not supported in web)', builtin: true, unsupported: true },
  { name: 'settings', description: 'Open settings menu (not supported in web)', builtin: true, unsupported: true },
];

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

    // Streaming state: current assistant message being built
    this.streaming = {
      active: false,
      el: null,
      role: 'assistant',
    };

    // Tool call rendering state: map toolCallId -> element
    this.toolEls = new Map();
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
      case 'error':
        this.appendError(data.error);
        break;
      case 'pi_error':
        this.appendError(data.error);
        break;
      case 'extension_ui_request':
        // Ignore UI requests for now (or render minimally in footer)
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

    // Header version
    if (this.versionEl && state.version) {
      this.versionEl.textContent = `v${state.version}`;
    }

    // Loaded resources
    this.renderLoadedResources(state.commands);

    // First footer line: pwd (branch) • session name
    const pwd = state.cwd || '';
    const branch = state.gitBranch ? ` (${state.gitBranch})` : '';
    const name = state.sessionName ? ` • ${state.sessionName}` : '';
    this.footerEl.textContent = `${pwd}${branch}${name}`;

    // Second footer line: TUI-like stats + model info
    this.renderStats(state.sessionStats, state);
  }

  renderLoadedResources(commands) {
    if (!this.loadedResourcesEl) return;
    if (!commands || commands.length === 0) {
      this.loadedResourcesEl.innerHTML = '';
      return;
    }

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

    this.loadedResourcesEl.innerHTML = '';
    this.loadedResourcesEl.appendChild(div);
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

    const parts = [];

    // Token/cost stats from sessionStats (if available)
    if (stats && stats.tokens) {
      const t = stats.tokens;
      if (t.input) parts.push(`↑${this.formatTokens(t.input)}`);
      if (t.output) parts.push(`↓${this.formatTokens(t.output)}`);
      if (t.cacheRead) parts.push(`R${this.formatTokens(t.cacheRead)}`);
      if (t.cacheWrite) parts.push(`W${this.formatTokens(t.cacheWrite)}`);
      if ((t.cacheRead > 0 || t.cacheWrite > 0)) {
        const promptTokens = t.input + t.cacheRead + t.cacheWrite;
        if (promptTokens > 0) {
          const hitRate = (t.cacheRead / promptTokens) * 100;
          parts.push(`CH${hitRate.toFixed(1)}%`);
        }
      }
      if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
    }

    // Context usage: percent/contextWindow (auto)
    if (stats && stats.contextUsage && stats.contextUsage.contextWindow) {
      const cu = stats.contextUsage;
      const ctxWindow = this.formatTokens(cu.contextWindow);
      const auto = state.autoCompactionEnabled ? ' (auto)' : '';
      if (cu.percent !== null && cu.percent !== undefined) {
        parts.push(`${cu.percent.toFixed(1)}%/${ctxWindow}${auto}`);
      } else {
        parts.push(`?/${ctxWindow}${auto}`);
      }
    }

    // Model + thinking on the right (clickable)
    if (state.model) {
      const provider = state.model.provider || '';
      const model = state.model.id || state.model.model || '';
      const modelLabel = provider ? `${provider}/${model}` : model;
      const thinking = state.thinkingLevel || 'off';
      const modelHtml = `<span class="clickable model-label" title="Click to change model">${this.escapeHtml(modelLabel)}</span>`;
      const thinkingHtml = `<span class="clickable thinking-label" title="Click to change thinking">${this.escapeHtml(thinking)}</span>`;
      parts.push(`${modelHtml} · ${thinkingHtml}`);
    }

    statsEl.innerHTML = parts.join(' ');

    const modelEl = statsEl.querySelector('.model-label');
    if (modelEl) {
      modelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openModelPicker();
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
    const items = entries.entries;
    for (const entry of items) {
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
    this.scrollToBottom();
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
    body.className = 'special-body';
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
    if (aev.type === 'test_delta' || aev.type === 'text_delta') {
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
        p.className = 'thinking';
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
      out.textContent = visible + `\n... (${hidden} more lines, click to expand)`;
    } else {
      out.textContent = full;
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

  renderBashResult(data) {
    const div = this.createToolBlock('bash', { command: data.command }, 'bash-' + Date.now());
    const result = data.data || {};
    const output = result.output || '';
    this.setToolOutput(div, output);

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

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------

  sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (command) {
        this.send({ type: 'bash', command: command });
      }
    } else {
      this.send({ type: 'prompt', message: text });
    }
    this.inputEl.value = '';
    this.hideCommandMenu();
  }

  bindInput() {
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      } else if (e.key === 'Escape') {
        this.hideCommandMenu();
      }
    });
    this.inputEl.addEventListener('input', () => this.updateCommandMenu());
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
      this.modalSearch.addEventListener('input', () => this.filterModalItems());
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
    this.modalMode = null;
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
    const filtered = commands.filter((c) => {
      const name = (c.name || '').replace(/^skill:/, '').toLowerCase();
      const desc = (c.description || c.source || '').toLowerCase();
      return name.includes(query) || desc.includes(query);
    });

    if (filtered.length === 0) {
      this.hideCommandMenu();
      return;
    }

    this.commandMenuEl.innerHTML = filtered
      .map(
        (c, i) =>
          `<div class="command-item" data-index="${i}">` +
          `<span class="command-name">/${this.escapeHtml(c.name.replace(/^skill:/, ''))}</span>` +
          `<span class="command-desc">${this.escapeHtml(c.description || c.source || '')}</span>` +
          (c.unsupported ? `<span class="command-unsupported">not supported</span>` : '') +
          `</div>`,
      )
      .join('');
    this.commandMenuEl.style.display = 'block';

    this.commandMenuEl.querySelectorAll('.command-item').forEach((el, i) => {
      el.addEventListener('click', () => this.selectCommand(filtered[i]));
    });
  }

  selectCommand(cmd) {
    if (!cmd) return;

    // Builtin commands with actions
    if (cmd.builtin && cmd.action && !cmd.unsupported) {
      if (cmd.action === 'model') {
        this.openModelPicker();
      } else if (cmd.action === 'thinking') {
        this.openThinkingPicker();
      } else if (cmd.action === 'compact') {
        this.send({ type: 'compact' });
      } else if (cmd.action === 'name') {
        const newName = window.prompt('Set session display name:', '');
        if (newName && newName.trim()) {
          this.send({ type: 'set_session_name', name: newName.trim() });
        }
      }
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

    // Regular commands: insert into input
    const name = cmd.name.replace(/^skill:/, '');
    this.inputEl.value = '/' + name + ' ';
    this.inputEl.focus();
    this.hideCommandMenu();
  }

  hideCommandMenu() {
    if (this.commandMenuEl) {
      this.commandMenuEl.style.display = 'none';
      this.commandMenuEl.innerHTML = '';
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PiWebClient();
});
