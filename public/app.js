/* ============================================================
   ClaudeBoard v3 — Frontend Application
   Vanilla JS, no frameworks, no build step
   ============================================================ */

'use strict';

// ── Simple Markdown Renderer ─────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<strong style="font-size:1.05em">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong style="font-size:1.1em">$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:rgba(227,198,154,0.15);padding:0 4px;border-radius:3px">$1</code>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/^\d+\. (.+)$/gm, (_, item) => `• ${item}`)
    .replace(/\n/g, '<br>');
}

// ── State ────────────────────────────────────────────────────
const state = {
  ws: null,
  connected: false,
  reconnectTimer: null,
  reconnectDelay: 1500,
  maxReconnectDelay: 30000,

  tasks: new Map(),        // taskId -> task object
  selectedTaskId: null,
  currentAssistantMsgEl: null,   // streaming message element
  chatHistory: [],         // [{role, content}]

  elapsedTimers: new Map(),      // taskId -> intervalId
  taskStartTimes: new Map(),     // taskId -> Date

  drawerOpen: false,
  prdAvailable: false,
};

// ── DOM refs ─────────────────────────────────────────────────
const dom = {
  connStatus:       document.getElementById('connStatus'),
  chatMessages:     document.getElementById('chatMessages'),
  chatInput:        document.getElementById('chatInput'),
  sendBtn:          document.getElementById('sendBtn'),
  typingIndicator:  document.getElementById('typingIndicator'),
  kanbanBoard:      document.getElementById('kanbanBoard'),
  runAllBtn:        document.getElementById('runAllBtn'),
  prdBtn:           document.getElementById('prdBtn'),
  terminalDrawer:   document.getElementById('terminal-drawer'),
  terminalToggle:   document.getElementById('terminalToggle'),
  terminalTaskName: document.getElementById('terminalTaskName'),
  terminalBody:     document.getElementById('terminalBody'),
  clearTerminal:    document.getElementById('clearTerminal'),
  closeTerminal:    document.getElementById('closeTerminal'),
  prdModal:         document.getElementById('prdModal'),
  prdContent:       document.getElementById('prdContent'),
  app:              document.getElementById('app'),
};

// ── WebSocket ────────────────────────────────────────────────
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}`;

  try {
    state.ws = new WebSocket(url);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    state.connected = true;
    state.reconnectDelay = 1500;
    setConnectionStatus('connected', 'Connected');
    clearTimeout(state.reconnectTimer);
  };

  state.ws.onclose = () => {
    state.connected = false;
    setConnectionStatus('disconnected', 'Disconnected');
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    state.connected = false;
    setConnectionStatus('disconnected', 'Connection error');
  };

  state.ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    setConnectionStatus('connecting', `Reconnecting…`);
    connectWS();
  }, state.reconnectDelay);
  state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, state.maxReconnectDelay);
}

function sendWS(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function setConnectionStatus(status, label) {
  const el = dom.connStatus;
  el.className = `connection-status ${status}`;
  el.querySelector('span:last-child').textContent = label;
}

// ── Message handler ──────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      handleInit(msg);
      break;

    case 'orchestrator:chunk':
      handleOrchestratorChunk(msg.chunk);
      break;

    case 'orchestrator:thinking':
      showTypingIndicator(true);
      finalizeAssistantMessage();
      break;

    case 'orchestrator:done':
      showTypingIndicator(false);
      finalizeAssistantMessage();
      break;

    case 'orchestrator:error':
      showTypingIndicator(false);
      finalizeAssistantMessage();
      appendChatError(msg.error || 'An error occurred.');
      break;

    case 'tasks:created':
      handleTasksCreated(msg.tasks);
      break;

    case 'task:started':
      handleTaskStarted(msg.taskId);
      break;

    case 'task:output':
      handleTaskOutput(msg.taskId, msg.chunk, 'stdout');
      break;

    case 'task:verifying':
      handleTaskVerifying(msg.taskId);
      break;

    case 'task:verifier_output':
      handleTaskOutput(msg.taskId, msg.chunk, 'stdout');
      break;

    case 'task:done':
      handleTaskDone(msg.taskId);
      break;

    case 'task:error':
      handleTaskError(msg.taskId, msg.error);
      break;

    case 'prd:generated':
      state.prdAvailable = true;
      dom.prdBtn.style.display = 'inline-flex';
      break;

    default:
      break;
  }
}

// ── Init ─────────────────────────────────────────────────────
function handleInit(msg) {
  // Load existing tasks
  if (msg.tasks && Array.isArray(msg.tasks)) {
    msg.tasks.forEach(task => {
      state.tasks.set(task.id, task);
      if (task.status === 'in_progress' || task.status === 'verifying') {
        startElapsedTimer(task.id, task.startedAt ? new Date(task.startedAt) : new Date());
      }
    });
    renderBoard();
    if (msg.tasks.length > 0) {
      dom.runAllBtn.style.display = 'inline-flex';
    }
  }

  if (msg.prd != null) {
    state.prdAvailable = true;
    dom.prdBtn.style.display = 'inline-flex';
  }
}

// ── Task handlers ────────────────────────────────────────────
function handleTasksCreated(tasks) {
  tasks.forEach(task => {
    state.tasks.set(task.id, { ...task, output: [] });
  });
  renderBoard();
  dom.runAllBtn.style.display = 'inline-flex';
}

function handleTaskStarted(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'in_progress';
  task.startedAt = new Date().toISOString();
  state.tasks.set(taskId, task);
  startElapsedTimer(taskId, new Date());
  renderBoard();

  // If this task is selected, update terminal header
  if (state.selectedTaskId === taskId) {
    updateTerminalHeader(task);
  }
}

function handleTaskOutput(taskId, chunk, type) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  if (!task.output) task.output = [];
  task.output.push({ chunk, type });
  state.tasks.set(taskId, task);

  // If this task is selected, append to terminal
  if (state.selectedTaskId === taskId) {
    appendTerminalLine(chunk, type);
  }
}

function handleTaskVerifying(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'verifying';
  state.tasks.set(taskId, task);
  renderBoard();

  if (state.selectedTaskId === taskId) {
    appendTerminalLine('\n[Verifier] Starting verification…\n', 'system');
    updateTerminalHeader(task);
  }
}

function handleTaskDone(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  state.tasks.set(taskId, task);
  stopElapsedTimer(taskId);
  renderBoard();

  if (state.selectedTaskId === taskId) {
    appendTerminalLine('\n[Done] Task completed successfully.\n', 'success');
    updateTerminalHeader(task);
  }
}

function handleTaskError(taskId, errorMsg) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'error';
  task.error = errorMsg;
  state.tasks.set(taskId, task);
  stopElapsedTimer(taskId);
  renderBoard();

  if (state.selectedTaskId === taskId) {
    appendTerminalLine(`\n[Error] ${errorMsg || 'Task failed.'}\n`, 'stderr');
    updateTerminalHeader(task);
  }
}

// ── Elapsed time timers ──────────────────────────────────────
function startElapsedTimer(taskId, startTime) {
  stopElapsedTimer(taskId);
  state.taskStartTimes.set(taskId, startTime);
  const intervalId = setInterval(() => {
    updateElapsedDisplay(taskId);
  }, 1000);
  state.elapsedTimers.set(taskId, intervalId);
  updateElapsedDisplay(taskId);
}

function stopElapsedTimer(taskId) {
  const id = state.elapsedTimers.get(taskId);
  if (id) {
    clearInterval(id);
    state.elapsedTimers.delete(taskId);
  }
}

function updateElapsedDisplay(taskId) {
  const el = document.querySelector(`.task-card[data-task-id="${taskId}"] .card-elapsed`);
  if (!el) return;
  el.textContent = formatElapsed(taskId);
}

function formatElapsed(taskId) {
  const start = state.taskStartTimes.get(taskId);
  if (!start) return '';
  const secs = Math.floor((Date.now() - start.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${String(remSecs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${String(remMins).padStart(2, '0')}m`;
}

// ── Board Rendering ──────────────────────────────────────────
function renderBoard() {
  const cols = ['backlog', 'in_progress', 'verifying', 'done', 'error'];
  const buckets = {};
  cols.forEach(c => { buckets[c] = []; });

  state.tasks.forEach(task => {
    const col = buckets[task.status] || buckets['backlog'];
    col.push(task);
  });

  cols.forEach(col => {
    const container = document.getElementById(`col-${col}`);
    const countEl   = document.getElementById(`count-${col}`);
    if (!container || !countEl) return;

    const tasks = buckets[col];
    countEl.textContent = tasks.length;

    // Diff render: rebuild only changed cards
    const existingIds = new Set(
      [...container.querySelectorAll('.task-card')].map(el => el.dataset.taskId)
    );
    const newIds = new Set(tasks.map(t => t.id));

    // Remove cards no longer in this column
    existingIds.forEach(id => {
      if (!newIds.has(id)) {
        const el = container.querySelector(`.task-card[data-task-id="${id}"]`);
        if (el) el.remove();
      }
    });

    // Add or update cards
    tasks.forEach((task, idx) => {
      let cardEl = container.querySelector(`.task-card[data-task-id="${task.id}"]`);
      if (!cardEl) {
        cardEl = createTaskCardEl(task);
        container.appendChild(cardEl);
      } else {
        // Update badge and title in place
        updateTaskCardEl(cardEl, task);
      }
    });

    // Empty state
    let emptyEl = container.querySelector('.col-empty');
    if (tasks.length === 0) {
      if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'col-empty';
        emptyEl.textContent = 'No tasks';
        container.appendChild(emptyEl);
      }
    } else {
      if (emptyEl) emptyEl.remove();
    }
  });
}

function createTaskCardEl(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.taskId = task.id;
  card.dataset.status = task.status;
  if (task.id === state.selectedTaskId) card.classList.add('selected');

  card.innerHTML = renderTaskCardHTML(task);
  card.addEventListener('click', () => selectTask(task.id));
  return card;
}

function updateTaskCardEl(cardEl, task) {
  cardEl.dataset.status = task.status;
  if (task.id === state.selectedTaskId) {
    cardEl.classList.add('selected');
  } else {
    cardEl.classList.remove('selected');
  }
  cardEl.innerHTML = renderTaskCardHTML(task);
  // Re-attach click listener (innerHTML wipes it)
  cardEl.addEventListener('click', () => selectTask(task.id));
}

function renderTaskCardHTML(task) {
  const badge = badgeHTML(task.status);
  const agentNum = task.agentId || (task.id ? parseInt(task.id, 36) % 9 + 1 : 1);
  const isActive = task.status === 'in_progress' || task.status === 'verifying';
  const elapsed  = state.taskStartTimes.has(task.id) ? formatElapsed(task.id) : '';
  const desc = escapeHTML(task.description || task.desc || '');
  const title = escapeHTML(task.title || task.name || 'Untitled task');

  const spinnerOrAvatar = isActive
    ? `<div class="card-spinner"></div>`
    : `<div class="agent-avatar">${agentNum}</div>`;

  const agentLabel = task.agentLabel || `Agent ${agentNum}`;

  return `
    <div class="card-header">
      <span class="card-title">${title}</span>
      ${badge}
    </div>
    ${desc ? `<p class="card-desc">${desc}</p>` : ''}
    <div class="card-footer">
      <div class="card-agent">
        ${spinnerOrAvatar}
        <span>${escapeHTML(agentLabel)}</span>
      </div>
      <span class="card-elapsed">${elapsed}</span>
    </div>
  `.trim();
}

function badgeHTML(status) {
  const labels = {
    backlog:     'Backlog',
    in_progress: 'Running',
    verifying:   'Verifying',
    done:        'Done',
    error:       'Error',
  };
  const label = labels[status] || status;
  return `<span class="card-badge badge-${status}">${label}</span>`;
}

// ── Task selection & terminal ────────────────────────────────
function selectTask(taskId) {
  // Deselect previous
  if (state.selectedTaskId) {
    const prev = document.querySelector(`.task-card[data-task-id="${state.selectedTaskId}"]`);
    if (prev) prev.classList.remove('selected');
  }

  state.selectedTaskId = taskId;
  const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (card) card.classList.add('selected');

  const task = state.tasks.get(taskId);
  if (!task) return;

  openTerminal();
  updateTerminalHeader(task);
  renderTerminalOutput(task);
}

function updateTerminalHeader(task) {
  const title = task.title || task.name || 'Task output';
  dom.terminalTaskName.textContent = `${statusIcon(task.status)} ${title}`;
}

function statusIcon(status) {
  const icons = {
    backlog:     '📋',
    in_progress: '⚡',
    verifying:   '🔍',
    done:        '✅',
    error:       '❌',
  };
  return icons[status] || '▸';
}

function renderTerminalOutput(task) {
  dom.terminalBody.innerHTML = '';
  if (!task.output || task.output.length === 0) {
    const p = document.createElement('div');
    p.className = 'terminal-placeholder';
    p.textContent = task.status === 'backlog'
      ? 'Task is queued. Output will appear when it starts.'
      : 'No output yet.';
    dom.terminalBody.appendChild(p);
    return;
  }

  task.output.forEach(entry => {
    appendTerminalLine(entry.chunk, entry.type);
  });
  scrollTerminalToBottom();
}

function appendTerminalLine(text, type) {
  // Remove placeholder if present
  const placeholder = dom.terminalBody.querySelector('.terminal-placeholder');
  if (placeholder) placeholder.remove();

  const line = document.createElement('span');
  line.className = `terminal-line ${type || 'stdout'}`;
  line.textContent = text;
  dom.terminalBody.appendChild(line);
  scrollTerminalToBottom();
}

function scrollTerminalToBottom() {
  dom.terminalBody.scrollTop = dom.terminalBody.scrollHeight;
}

function openTerminal() {
  if (state.drawerOpen) return;
  state.drawerOpen = true;
  dom.terminalDrawer.classList.remove('closed');
  dom.terminalDrawer.classList.add('open');
  dom.app.classList.add('drawer-open');
}

function closeTerminal() {
  state.drawerOpen = false;
  dom.terminalDrawer.classList.remove('open');
  dom.terminalDrawer.classList.add('closed');
  dom.app.classList.remove('drawer-open');
}

// ── Chat UI ──────────────────────────────────────────────────
function sendMessage() {
  const text = dom.chatInput.value.trim();
  if (!text) return;
  if (!state.connected) {
    appendChatError('Not connected to server. Please wait…');
    return;
  }

  dom.chatInput.value = '';
  dom.chatInput.style.height = '';
  appendChatMessage('user', text);
  state.chatHistory.push({ role: 'user', content: text });

  sendWS({ type: 'orchestrator:message', text });
  showTypingIndicator(true);
}

function appendChatMessage(role, content) {
  // Finalize any in-progress streaming message first
  if (role === 'assistant') {
    finalizeAssistantMessage();
  }

  const wrapper = document.createElement('div');
  wrapper.className = `chat-message ${role}`;

  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'Vos' : 'Orquestador';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  wrapper.appendChild(label);
  wrapper.appendChild(bubble);

  // Remove welcome screen on first real message
  const welcome = dom.chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  dom.chatMessages.appendChild(wrapper);
  scrollChatToBottom();

  return wrapper;
}

function appendChatError(errorText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-message assistant error';

  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = 'Error';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = errorText;

  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  dom.chatMessages.appendChild(wrapper);
  scrollChatToBottom();
}

// Streaming: build assistant message incrementally
function handleOrchestratorChunk(chunk) {
  showTypingIndicator(false);

  if (!state.currentAssistantMsgEl) {
    // Start a new assistant message
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message assistant';

    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = 'Orquestador';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble streaming-cursor';
    bubble.textContent = '';
    bubble._rawText = '';

    wrapper.appendChild(label);
    wrapper.appendChild(bubble);

    const welcome = dom.chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    dom.chatMessages.appendChild(wrapper);
    state.currentAssistantMsgEl = bubble;
  }

  state.currentAssistantMsgEl._rawText = (state.currentAssistantMsgEl._rawText || '') + chunk;
  state.currentAssistantMsgEl.innerHTML = renderMarkdown(state.currentAssistantMsgEl._rawText) + '<span class="cursor-blink">▊</span>';
  scrollChatToBottom();
}

function finalizeAssistantMessage() {
  if (state.currentAssistantMsgEl) {
    state.currentAssistantMsgEl.classList.remove('streaming-cursor');
    const raw = state.currentAssistantMsgEl._rawText || state.currentAssistantMsgEl.textContent;
    // Hide <PRD> and <TASKS> blocks from chat — they're internal signals
    const display = raw.replace(/<PRD>[\s\S]*?<\/PRD>/g, '').replace(/<TASKS>[\s\S]*?<\/TASKS>/g, '✅ Tareas creadas — revisá el board →').trim();
    state.currentAssistantMsgEl.innerHTML = renderMarkdown(display);
    if (raw) state.chatHistory.push({ role: 'assistant', content: raw });
    state.currentAssistantMsgEl = null;
  }
}

function showTypingIndicator(show) {
  dom.typingIndicator.style.display = show ? 'flex' : 'none';
}

function scrollChatToBottom() {
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

// ── PRD Modal ────────────────────────────────────────────────
async function openPRD() {
  dom.prdModal.style.display = 'flex';
  dom.prdContent.textContent = 'Loading…';

  try {
    const res = await fetch('/api/prd');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const md = data.prd || '';
    dom.prdContent.innerHTML = renderMarkdown(md);
  } catch (err) {
    dom.prdContent.textContent = `Failed to load PRD: ${err.message}`;
  }
}

function closePRD() {
  dom.prdModal.style.display = 'none';
}

// Minimal Markdown renderer (no external deps)
function renderMarkdown(md) {
  let html = escapeHTML(md);

  // Code blocks first (protect from other replacements)
  const codeBlocks = [];
  html = html.replace(/```[\s\S]*?```/g, match => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\x00CODE_BLOCK_${idx}\x00`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm,  '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm,   '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm,    '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,     '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,      '<h1>$1</h1>');

  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>');
  html = html.replace(/__(.+?)__/g,         '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g,           '<em>$1</em>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/^[ \t]*[-*+] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs: wrap double-newline separated text blocks
  html = html.replace(/\n{2,}/g, '\n</p>\n<p>');
  html = '<p>' + html + '</p>';

  // Clean up around block elements
  html = html.replace(/<p>(<h[1-6]>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
  html = html.replace(/<p><\/p>/g, '');

  // Restore code blocks
  codeBlocks.forEach((block, idx) => {
    const lang = block.match(/^```(\w+)/)?.[1] || '';
    const code = block
      .replace(/^```\w*\n?/, '')
      .replace(/\n?```$/, '');
    html = html.replace(
      `\x00CODE_BLOCK_${idx}\x00`,
      `<pre><code class="lang-${lang}">${code}</code></pre>`
    );
  });

  return html;
}

// ── Utilities ────────────────────────────────────────────────
function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Event Listeners ──────────────────────────────────────────
dom.sendBtn.addEventListener('click', sendMessage);

dom.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
dom.chatInput.addEventListener('input', () => {
  dom.chatInput.style.height = 'auto';
  dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 120) + 'px';
});

dom.runAllBtn.addEventListener('click', () => {
  if (!state.connected) return;
  sendWS({ type: 'queue:process' });
  dom.runAllBtn.disabled = true;
  dom.runAllBtn.textContent = '⏳ Running…';
  setTimeout(() => {
    dom.runAllBtn.disabled = false;
    dom.runAllBtn.innerHTML = '&#9654; Run All Tasks';
  }, 3000);
});

dom.prdBtn.addEventListener('click', openPRD);

dom.terminalToggle.addEventListener('click', (e) => {
  // Don't toggle if clicking on controls
  if (e.target.closest('.terminal-controls')) return;
  if (state.drawerOpen) {
    closeTerminal();
  } else {
    openTerminal();
  }
});

dom.clearTerminal.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.terminalBody.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'terminal-placeholder';
  p.textContent = 'Terminal cleared.';
  dom.terminalBody.appendChild(p);
});

dom.closeTerminal.addEventListener('click', (e) => {
  e.stopPropagation();
  closeTerminal();
});

// Close modal with Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (dom.prdModal.style.display !== 'none') {
      closePRD();
    } else if (state.drawerOpen) {
      closeTerminal();
    }
  }
});

// ── Global exposed functions ─────────────────────────────────
// (for onclick attributes in HTML)
window.closePRD = closePRD;

// ── Init ─────────────────────────────────────────────────────
connectWS();
renderBoard();
