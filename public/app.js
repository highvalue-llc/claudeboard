/* ============================================================
   ClaudeBoard v3 — Frontend Application
   Vanilla JS, no frameworks, no build step
   ============================================================ */

'use strict';


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
  attachedImage: null,     // base64 DataURL of pending image attachment

  elapsedTimers: new Map(),      // taskId -> intervalId
  taskStartTimes: new Map(),     // taskId -> Date

  panelOpen: false,
  prdAvailable: false,
};

// ── DOM refs ─────────────────────────────────────────────────
const dom = {
  connStatus:         document.getElementById('connStatus'),
  chatMessages:       document.getElementById('chatMessages'),
  chatInput:          document.getElementById('chatInput'),
  sendBtn:            document.getElementById('sendBtn'),
  typingIndicator:    document.getElementById('typingIndicator'),
  kanbanBoard:        document.getElementById('kanbanBoard'),
  runAllBtn:          document.getElementById('runAllBtn'),
  pauseAllBtn:        document.getElementById('pauseAllBtn'),
  prdBtn:             document.getElementById('prdBtn'),
  prdModal:           document.getElementById('prdModal'),
  prdContent:         document.getElementById('prdContent'),
  app:                document.getElementById('app'),
  // Sidebar collapse
  sidebarCollapseBtn: document.getElementById('sidebarCollapseBtn'),
  sidebarExpandBtn:   document.getElementById('sidebarExpandBtn'),
  sysMonitor:         document.getElementById('sysMonitor'),
  // Detail panel
  detailPanel:        document.getElementById('detail-panel'),
  closePanel:         document.getElementById('closePanel'),
  panelBadge:         document.getElementById('panelBadge'),
  panelAgentLabel:    document.getElementById('panelAgentLabel'),
  panelElapsed:       document.getElementById('panelElapsed'),
  panelTaskName:      document.getElementById('panelTaskName'),
  panelTaskDesc:      document.getElementById('panelTaskDesc'),
  panelCriteria:      document.getElementById('panelCriteria'),
  panelCriteriaWrap:  document.getElementById('panelCriteriaWrap'),
  panelTerminalBody:  document.getElementById('panelTerminalBody'),
  clearPanelTerminal: document.getElementById('clearPanelTerminal'),
  // QA toast
  qaToast:            document.getElementById('qaToast'),
  qaToastText:        document.getElementById('qaToastText'),
  // Image attachment
  imgAttach:          document.getElementById('imgAttach'),
  imgPreview:         document.getElementById('imgPreview'),
  imgPreviewImg:      document.getElementById('imgPreviewImg'),
  removeImg:          document.getElementById('removeImg'),
  // QA button
  qaBtn:              document.getElementById('qaBtn'),
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
      handleTaskStarted(msg.taskId, msg.agentLabel);
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
      handleTaskError(msg.taskId, msg.error, msg.needsHuman);
      break;
    case 'task:stopped':
      handleTaskStopped(msg.taskId);
      break;
    case 'task:updated':
      handleTaskUpdated(msg.task);
      break;
    case 'prd:generated':
      state.prdAvailable = true;
      dom.prdBtn.style.display = 'inline-flex';
      break;
    case 'qa:started':
      handleQAStarted();
      break;
    case 'qa:output':
      handleQAOutput(msg.chunk);
      break;
    case 'qa:done':
      handleQADone();
      break;
    default:
      break;
  }
}

// ── Init ─────────────────────────────────────────────────────
function handleInit(msg) {
  if (msg.tasks && Array.isArray(msg.tasks)) {
    msg.tasks.forEach(task => {
      state.tasks.set(task.id, { ...task, output: Array.isArray(task.output) ? task.output : [] });
      if (task.status === 'in_progress' || task.status === 'verifying') {
        startElapsedTimer(task.id, task.startedAt ? new Date(task.startedAt) : new Date());
      }
    });
    renderBoard();
    if (msg.tasks.length > 0) {
      dom.runAllBtn.style.display = 'inline-flex';
      dom.qaBtn.style.display = 'inline-flex';
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
  dom.qaBtn.style.display = 'inline-flex';
}

function handleTaskStarted(taskId, agentLabel) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'in_progress';
  task.startedAt = new Date().toISOString();
  if (agentLabel) task.agentLabel = agentLabel;
  state.tasks.set(taskId, task);
  startElapsedTimer(taskId, new Date());
  updatePauseAllVisibility();
  renderBoard();
  if (state.selectedTaskId === taskId) refreshPanelHeader(task);
}

function handleTaskOutput(taskId, chunk, type) {
  const task = state.tasks.get(taskId);
  if (!task && taskId !== '__qa__') return;
  if (task) {
    if (!task.output) task.output = [];
    task.output.push({ chunk, type });
    state.tasks.set(taskId, task);
  }
  if (state.selectedTaskId === taskId) {
    appendPanelLine(chunk, type);
  }
}

function handleTaskVerifying(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'verifying';
  state.tasks.set(taskId, task);
  renderBoard();
  if (state.selectedTaskId === taskId) {
    appendPanelLine('\n[Verifier] Iniciando verificación…\n', 'system');
    refreshPanelHeader(task);
  }
}

function handleTaskDone(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  state.tasks.set(taskId, task);
  stopElapsedTimer(taskId);
  updatePauseAllVisibility();
  renderBoard();
  if (state.selectedTaskId === taskId) {
    appendPanelLine('\n[Done] Tarea completada con éxito.\n', 'success');
    refreshPanelHeader(task);
  }
}

function handleTaskError(taskId, errorMsg, needsHuman) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'error';
  task.error = errorMsg;
  if (needsHuman) task.needsHuman = true;
  state.tasks.set(taskId, task);
  stopElapsedTimer(taskId);
  updatePauseAllVisibility();
  renderBoard();
  if (state.selectedTaskId === taskId) {
    appendPanelLine(`\n[Error] ${errorMsg || 'Tarea fallida.'}\n`, 'stderr');
    refreshPanelHeader(task);
  }
}

function handleTaskUpdated(serverTask) {
  if (!serverTask || !serverTask.id) return;
  const existing = state.tasks.get(serverTask.id);
  const merged = { ...existing, ...serverTask, output: existing ? (existing.output || []) : [] };
  state.tasks.set(serverTask.id, merged);
  // Stop timer if no longer active
  if (serverTask.status !== 'in_progress' && serverTask.status !== 'verifying') {
    stopElapsedTimer(serverTask.id);
  }
  updatePauseAllVisibility();
  renderBoard();
  if (state.selectedTaskId === serverTask.id) refreshPanelHeader(merged);
}

function handleTaskStopped(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  task.status = 'backlog';
  delete task.startedAt;
  state.tasks.set(taskId, task);
  stopElapsedTimer(taskId);
  updatePauseAllVisibility();
  renderBoard();
  if (state.selectedTaskId === taskId) refreshPanelHeader(task);
}

// ── QA Toast ─────────────────────────────────────────────────
function showQAToast(text) {
  dom.qaToastText.textContent = text;
  dom.qaToast.style.display = 'flex';
}
function hideQAToast() {
  dom.qaToast.style.display = 'none';
}

// ── QA virtual task (not a kanban card — only appears in the panel) ──────────
function handleQAStarted() {
  showQAToast('Agente QA revisando el proyecto…');
  // Create/reset a virtual task so the panel shows live QA output
  state.tasks.set('__qa__', {
    id: '__qa__',
    title: '🔍 QA Review — Chrome screenshot',
    description: 'Revisión visual automática: Chrome abre el proyecto, captura pantalla y analiza el resultado.',
    status: 'in_progress',
    agentLabel: 'QA Engineer',
    output: [],
    startedAt: new Date().toISOString(),
  });
  startElapsedTimer('__qa__', new Date());
  selectTask('__qa__');
}

function handleQAOutput(chunk) {
  const task = state.tasks.get('__qa__');
  if (task) {
    task.output.push({ chunk, type: 'stdout' });
  }
  if (state.selectedTaskId === '__qa__') {
    appendPanelLine(chunk, 'stdout');
  }
}

function handleQADone() {
  hideQAToast();
  stopElapsedTimer('__qa__');
  const task = state.tasks.get('__qa__');
  if (task) task.status = 'done';
  dom.qaBtn.disabled = false;
  dom.qaBtn.innerHTML = '&#128269; Revisar en Chrome';
  if (state.selectedTaskId === '__qa__') {
    appendPanelLine('\n[QA] Revisión completada.\n', 'success');
    refreshPanelHeader(state.tasks.get('__qa__'));
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
  if (el) el.textContent = formatElapsed(taskId);
  if (state.selectedTaskId === taskId) {
    dom.panelElapsed.textContent = formatElapsed(taskId);
  }
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
  _renderBoard();
  refreshDraggableCards();
}

function _renderBoard() {
  const cols = ['backlog', 'in_progress', 'verifying', 'done', 'error'];
  const buckets = {};
  cols.forEach(c => { buckets[c] = []; });

  state.tasks.forEach(task => {
    if (task.id === '__qa__') return; // virtual task — panel only, no kanban card
    const col = buckets[task.status] || buckets['backlog'];
    col.push(task);
  });

  cols.forEach(col => {
    const container = document.getElementById(`col-${col}`);
    const countEl   = document.getElementById(`count-${col}`);
    if (!container || !countEl) return;

    const tasks = buckets[col];
    countEl.textContent = tasks.length;

    const existingIds = new Set(
      [...container.querySelectorAll('.task-card')].map(el => el.dataset.taskId)
    );
    const newIds = new Set(tasks.map(t => t.id));

    existingIds.forEach(id => {
      if (!newIds.has(id)) {
        const el = container.querySelector(`.task-card[data-task-id="${id}"]`);
        if (el) el.remove();
      }
    });

    tasks.forEach((task) => {
      let cardEl = container.querySelector(`.task-card[data-task-id="${task.id}"]`);
      if (!cardEl) {
        cardEl = createTaskCardEl(task);
        container.appendChild(cardEl);
      } else {
        updateTaskCardEl(cardEl, task);
      }
    });

    let emptyEl = container.querySelector('.col-empty');
    if (tasks.length === 0) {
      if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'col-empty';
        emptyEl.textContent = col === 'in_progress' ? 'Arrastrá tareas con error aquí' : 'No tasks';
        container.appendChild(emptyEl);
      }
    } else {
      if (emptyEl) emptyEl.remove();
    }
  });
}

function attachCardListeners(card, task) {
  card.addEventListener('click', (e) => {
    if (e.target.closest('.btn-stop-task') || e.target.closest('.btn-resolve')) return;
    selectTask(task.id);
  });
  card.addEventListener('click', (e) => {
    const stopBtn = e.target.closest('.btn-stop-task');
    if (stopBtn) { e.stopPropagation(); sendWS({ type: 'task:stop', taskId: stopBtn.dataset.taskId }); }
    const resolveBtn = e.target.closest('.btn-resolve');
    if (resolveBtn) { e.stopPropagation(); sendWS({ type: 'task:resolve', taskId: resolveBtn.dataset.taskId }); }
  });
}

function createTaskCardEl(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.taskId = task.id;
  card.dataset.status = task.status;
  if (task.needsHuman) card.dataset.needsHuman = 'true';
  if (task.id === state.selectedTaskId) card.classList.add('selected');
  card.innerHTML = renderTaskCardHTML(task);
  attachCardListeners(card, task);
  return card;
}

function updateTaskCardEl(cardEl, task) {
  cardEl.dataset.status = task.status;
  cardEl.dataset.needsHuman = task.needsHuman ? 'true' : '';
  cardEl.classList.toggle('selected', task.id === state.selectedTaskId);
  cardEl.innerHTML = renderTaskCardHTML(task);
  attachCardListeners(cardEl, task);
}

function renderTaskCardHTML(task) {
  const isActive = task.status === 'in_progress' || task.status === 'verifying';
  const isVerifying = task.status === 'verifying';
  const elapsed = state.taskStartTimes.has(task.id) ? formatElapsed(task.id) : '';
  const title = escapeHTML(task.title || task.name || 'Untitled task');
  const agentLabel = escapeHTML(task.agentLabel || (isVerifying ? 'Verificador' : ''));

  let badge;
  if (task.needsHuman && task.status === 'error') {
    badge = `<span class="card-badge badge-error" data-human="true" style="background:rgba(245,158,11,.18);color:#f59e0b">⚠ Intervención</span>`;
  } else {
    badge = badgeHTML(task.status);
  }

  const spinnerOrAvatar = isActive
    ? `<div class="card-spinner"></div>`
    : (agentLabel ? `<div class="agent-avatar agent-avatar--role">${escapeHTML(agentLabel[0])}</div>` : '');

  const stopBtn = task.status === 'in_progress'
    ? `<button class="btn-stop-task" data-task-id="${task.id}" title="Detener">&#9632;</button>`
    : '';

  const resolveBtn = task.needsHuman
    ? `<button class="btn-resolve" data-task-id="${task.id}" title="Marcar como resuelto y reintentar">✓ Resolver</button>`
    : '';

  const humanNote = task.needsHuman && task.humanReason
    ? `<p class="human-reason">⚠ ${escapeHTML(task.humanReason.slice(0, 120))}</p>`
    : '';

  return `
    <div class="card-header">
      <span class="card-title">${title}</span>
    </div>
    ${humanNote}
    <div class="card-footer">
      <div class="card-footer-left">
        ${badge}
        ${spinnerOrAvatar}
      </div>
      <div class="card-footer-right">
        <span class="card-elapsed">${elapsed}</span>
        ${resolveBtn}
        ${stopBtn}
      </div>
    </div>
    ${agentLabel ? `<div class="card-agent-row"><span class="card-agent-name">${agentLabel}</span></div>` : ''}
  `.trim();
}

function badgeHTML(status) {
  const labels = {
    backlog:     'Pendiente',
    in_progress: 'Corriendo',
    verifying:   'Verificando',
    done:        'Listo',
    error:       'Error',
  };
  const label = labels[status] || status;
  return `<span class="card-badge badge-${status}">${label}</span>`;
}

// ── Drag and Drop ────────────────────────────────────────────
let dragTaskId = null;

function onCardDragStart(e) {
  dragTaskId = e.currentTarget.dataset.taskId;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragTaskId);
  // Highlight valid drop target
  document.querySelectorAll('.kanban-col[data-status="in_progress"]').forEach(c => c.classList.add('drop-zone'));
}

function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  dragTaskId = null;
  document.querySelectorAll('.kanban-col').forEach(c => {
    c.classList.remove('drag-over');
    c.classList.remove('drop-zone');
  });
  // Always keep col-in_progress as drop zone
  const col = document.getElementById('col-in_progress');
  if (col) col.closest('.kanban-col').classList.add('drop-zone');
}

function initDropZones() {
  // Make the whole in_progress column a drop zone
  document.querySelectorAll('.kanban-col[data-status="in_progress"]').forEach(zone => {
    zone.classList.add('drop-zone');
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain') || dragTaskId;
      if (!taskId) return;
      const task = state.tasks.get(taskId);
      if (task && (task.status === 'error')) {
        sendWS({ type: 'task:start', taskId });
      }
    });
  });
}

// Add drag listeners to error cards (called after renderBoard)
function refreshDraggableCards() {
  state.tasks.forEach(task => {
    if (task.status === 'error') {
      const el = document.querySelector(`.task-card[data-task-id="${task.id}"]`);
      if (el && el.getAttribute('draggable') !== 'true') {
        el.setAttribute('draggable', 'true');
        el.addEventListener('dragstart', onCardDragStart);
        el.addEventListener('dragend', onCardDragEnd);
      }
    }
  });
}

// ── Detail Panel ─────────────────────────────────────────────
function openPanel() {
  state.panelOpen = true;
  dom.app.classList.add('panel-open');
}

function closePanel() {
  state.panelOpen = false;
  dom.app.classList.remove('panel-open');
  state.selectedTaskId = null;
  document.querySelectorAll('.task-card.selected').forEach(el => el.classList.remove('selected'));
}

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

  openPanel();
  refreshPanelHeader(task);
  renderPanelOutput(task);
}

function refreshPanelHeader(task) {
  if (state.selectedTaskId !== task.id) return;
  dom.panelTaskName.textContent = task.title || 'Tarea';
  dom.panelTaskDesc.textContent = task.description || '';
  dom.panelCriteria.textContent = task.successCriteria || '';
  dom.panelCriteriaWrap.style.display = task.successCriteria ? '' : 'none';
  dom.panelBadge.innerHTML = badgeHTML(task.status);
  dom.panelAgentLabel.textContent = task.agentLabel || '';
  dom.panelElapsed.textContent = state.taskStartTimes.has(task.id) ? formatElapsed(task.id) : '';
}

function renderPanelOutput(task) {
  dom.panelTerminalBody.innerHTML = '';
  if (!task.output || task.output.length === 0) {
    const p = document.createElement('div');
    p.className = 'terminal-placeholder';
    p.textContent = task.status === 'backlog'
      ? 'Tarea en cola. El output aparecerá cuando empiece.'
      : 'Sin output todavía.';
    dom.panelTerminalBody.appendChild(p);
    return;
  }
  task.output.forEach(entry => appendPanelLine(entry.chunk, entry.type));
  scrollPanelToBottom();
}

function appendPanelLine(text, type) {
  const placeholder = dom.panelTerminalBody.querySelector('.terminal-placeholder');
  if (placeholder) placeholder.remove();

  const line = document.createElement('span');
  line.className = `terminal-line ${type || 'stdout'}`;
  line.textContent = text;
  dom.panelTerminalBody.appendChild(line);
  scrollPanelToBottom();
}

function scrollPanelToBottom() {
  dom.panelTerminalBody.scrollTop = dom.panelTerminalBody.scrollHeight;
}

// ── Pause All visibility ──────────────────────────────────────
function updatePauseAllVisibility() {
  const hasRunning = [...state.tasks.values()].some(
    t => t.status === 'in_progress' || t.status === 'verifying'
  );
  dom.pauseAllBtn.style.display = hasRunning ? 'inline-flex' : 'none';
}

// ── Chat UI ──────────────────────────────────────────────────
function sendMessage() {
  const text = dom.chatInput.value.trim();
  if (!text && !state.attachedImage) return;
  if (!state.connected) {
    appendChatError('Not connected to server. Please wait…');
    return;
  }

  dom.chatInput.value = '';
  dom.chatInput.style.height = '';
  const displayText = text || '📎 [imagen adjunta]';
  appendChatMessage('user', displayText);
  state.chatHistory.push({ role: 'user', content: displayText });

  const wsMsg = { type: 'orchestrator:message', text: text || '(El usuario envió una imagen sin texto)' };
  if (state.attachedImage) {
    wsMsg.image = state.attachedImage;
    state.attachedImage = null;
    dom.imgPreview.style.display = 'none';
    dom.imgPreviewImg.src = '';
  }

  sendWS(wsMsg);
  showTypingIndicator(true);
}

function appendChatMessage(role, content) {
  if (role === 'assistant') finalizeAssistantMessage();

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

function handleOrchestratorChunk(chunk) {
  showTypingIndicator(false);

  if (!state.currentAssistantMsgEl) {
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
    const display = raw
      .replace(/<PRD>[\s\S]*?<\/PRD>/g, '')
      .replace(/<TASKS>[\s\S]*?<\/TASKS>/g, '✅ Tareas creadas — revisá el board →')
      .trim();
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

  const codeBlocks = [];
  html = html.replace(/```[\s\S]*?```/g, match => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\x00CODE_BLOCK_${idx}\x00`;
  });

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm,  '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm,   '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm,    '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,     '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,      '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>');
  html = html.replace(/__(.+?)__/g,         '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g,           '<em>$1</em>');
  html = html.replace(/^---+$/gm, '<hr>');
  html = html.replace(/^[ \t]*[-*+] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`);
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\n{2,}/g, '\n</p>\n<p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>(<h[1-6]>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
  html = html.replace(/<p><\/p>/g, '');

  codeBlocks.forEach((block, idx) => {
    const lang = block.match(/^```(\w+)/)?.[1] || '';
    const code = block.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
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

dom.chatInput.addEventListener('input', () => {
  dom.chatInput.style.height = 'auto';
  dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 120) + 'px';
});

// Paste image from clipboard (Ctrl+V on screenshot)
dom.chatInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.attachedImage = ev.target.result;
        dom.imgPreviewImg.src = ev.target.result;
        dom.imgPreview.style.display = 'flex';
      };
      reader.readAsDataURL(blob);
      break;
    }
  }
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

dom.pauseAllBtn.addEventListener('click', () => {
  if (!state.connected) return;
  sendWS({ type: 'agents:pause' });
});

dom.qaBtn.addEventListener('click', () => {
  if (!state.connected) return;
  sendWS({ type: 'qa:run' });
  showQAToast('Agente QA abriendo Chrome y revisando el proyecto…');
  dom.qaBtn.disabled = true;
  dom.qaBtn.textContent = '⏳ Revisando…';
  setTimeout(() => {
    dom.qaBtn.disabled = false;
    dom.qaBtn.innerHTML = '&#128269; Revisar en Chrome';
  }, 8000);
});

dom.prdBtn.addEventListener('click', openPRD);

// Sidebar collapse/expand
dom.sidebarCollapseBtn.addEventListener('click', () => {
  dom.app.classList.add('sidebar-collapsed');
  dom.sidebarExpandBtn.style.display = 'inline-flex';
});
dom.sidebarExpandBtn.addEventListener('click', () => {
  dom.app.classList.remove('sidebar-collapsed');
  dom.sidebarExpandBtn.style.display = 'none';
});

// Redo all error tasks
document.getElementById('redoErrorsBtn').addEventListener('click', () => {
  if (!state.connected) return;
  sendWS({ type: 'errors:retry-all' });
});

// Image attachment
dom.imgAttach.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    state.attachedImage = ev.target.result;
    dom.imgPreviewImg.src = ev.target.result;
    dom.imgPreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
  dom.imgAttach.value = ''; // allow re-selecting same file
});

dom.removeImg.addEventListener('click', () => {
  state.attachedImage = null;
  dom.imgPreviewImg.src = '';
  dom.imgPreview.style.display = 'none';
});

dom.closePanel.addEventListener('click', closePanel);

dom.clearPanelTerminal.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.panelTerminalBody.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'terminal-placeholder';
  p.textContent = 'Terminal cleared.';
  dom.panelTerminalBody.appendChild(p);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (dom.prdModal.style.display !== 'none') {
      closePRD();
    } else if (state.panelOpen) {
      closePanel();
    }
  }
});

// ── Global exposed functions ─────────────────────────────────
window.closePRD = closePRD;

// ── System monitor ────────────────────────────────────────────
async function updateSysMonitor() {
  try {
    const res = await fetch('/api/system');
    if (!res.ok) return;
    const { cpu, ramUsed, ramTotal, ramPercent } = await res.json();
    const cpuHigh = cpu > 80 ? 'high' : '';
    const ramHigh = ramPercent > 80 ? 'high' : '';
    dom.sysMonitor.innerHTML = `
      <span class="sys-stat">
        <span>CPU</span>
        <span class="sys-bar"><span class="sys-bar-fill ${cpuHigh}" style="width:${cpu}%"></span></span>
        <span>${cpu}%</span>
      </span>
      <span class="sys-stat">
        <span>RAM</span>
        <span class="sys-bar"><span class="sys-bar-fill ${ramHigh}" style="width:${ramPercent}%"></span></span>
        <span>${ramUsed}MB</span>
      </span>
    `;
  } catch {}
}
updateSysMonitor();
setInterval(updateSysMonitor, 5000);

// ── Init ─────────────────────────────────────────────────────
connectWS();
renderBoard();
initDropZones();
