// pi-web browser client
// Connects to the WebSocket, renders Pi RPC events into a TUI-like view.

class PiWebClient {
  constructor() {
    this.ws = null;
    this.contentEl = document.getElementById('content');
    this.statusEl = document.getElementById('conn-status');
    this.footerEl = document.getElementById('footer-line');
    this.inputEl = document.getElementById('input');

    // Streaming state: current assistant message being built
    this.streaming = {
      active: false,
      el: null,
      role: 'assistant',
    };

    // Tool call rendering state: map toolCallId -> element
    this.toolEls = new Map();

    // Last known state (model, autoCompaction, etc.) for stats rendering
    this.lastState = null;

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
      case 'models':
        break;
      case 'thinking_levels':
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

    // First footer line: pwd (branch) • session name
    const pwd = state.cwd || '';
    const branch = state.gitBranch ? ` (${state.gitBranch})` : '';
    const name = state.sessionName ? ` • ${state.sessionName}` : '';
    this.footerEl.textContent = `${pwd}${branch}${name}`;

    // Second footer line: TUI-like stats + model info
    this.renderStats(state.sessionStats, state);
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

    // Model + thinking on the right
    if (state.model) {
      const provider = state.model.provider || '';
      const model = state.model.id || state.model.model || '';
      const modelLabel = provider ? `${provider}/${model}` : model;
      const thinking = state.thinkingLevel || 'off';
      parts.push(`${modelLabel} · ${thinking}`);
    }

    statsEl.textContent = parts.join(' ');
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
      }
    }
    this.scrollToBottom();
  }

  clearContent() {
    this.contentEl.innerHTML = '';
    this.toolEls.clear();
    this.streaming = { active: false, el: null, role: 'assistant' };
  }

  // ------------------------------------------------------------------
  // Rendering: session events
  // ------------------------------------------------------------------

  renderEvent(ev) {
    switch (ev.type) {
      case 'agent_start':
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
        break;
      case 'turn_start':
        break;
      case 'turn_end':
        break;
      case 'agent_end':
        this.resetStreaming();
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

  onToolStart(ev) {
    const div = document.createElement('div');
    div.className = 'tool-block pending';
    const title = document.createElement('div');
    title.className = 'tool-title';
    title.textContent = ev.toolName || 'tool';
    const output = document.createElement('div');
    output.className = 'tool-output';
    output.textContent = JSON.stringify(ev.args || {}, null, 2);
    div.appendChild(title);
    div.appendChild(output);
    this.contentEl.appendChild(div);
    this.toolEls.set(ev.toolCallId, div);
  }

  onToolUpdate(ev) {
    const div = this.toolEls.get(ev.toolCallId);
    if (div) {
      const out = div.querySelector('.tool-output');
      if (out && ev.partialResult) {
        out.textContent = JSON.stringify(ev.partialResult, null, 2);
      }
    }
  }

  onToolEnd(ev) {
    const div = this.toolEls.get(ev.toolCallId);
    if (div) {
      div.className = ev.isError ? 'tool-block error' : 'tool-block success';
      const out = div.querySelector('.tool-output');
      if (out && ev.result) {
        const text = this.resultText(ev.result);
        out.textContent = text;
      }
      this.toolEls.delete(ev.toolCallId);
    }
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

  bindInput() {
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = this.inputEl.value.trim();
        if (text) {
          this.send({ type: 'prompt', message: text });
          this.inputEl.value = '';
        }
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PiWebClient();
});
