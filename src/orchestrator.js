// src/orchestrator.js
const { spawn } = require('child_process');
const { createTask, updateTask, getTask, getTasks, savePRD } = require('./store');
const { runVerifier } = require('./verifier');
const { notify } = require('./notifier');

// Use claude.cmd on Windows so spawn() works without shell: true
const CLAUDE_CMD = process.platform === 'win32' ? 'claude.cmd' : 'claude';
const MAX_INPUT_LEN = 10000;   // max user input chars
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let activeAgents = new Map(); // taskId -> { proc, timer }
let broadcast = null;
let maxAgents = 3;

function setBroadcast(fn) { broadcast = fn; }
function setMaxAgents(n) { maxAgents = n; }

// Strip null bytes and enforce length limit before any input reaches the CLI
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\0/g, '').slice(0, MAX_INPUT_LEN);
}

// In-memory conversation state (not persisted to disk)
let conversationHistory = [];
let orchBuffer = '';

function startOrchestrator() {
  conversationHistory = [];
  orchBuffer = '';
  const greeting = "Hi! I'm your Orchestrator. Tell me what you'd like to build and I'll coordinate your AI development team.";
  if (broadcast) broadcast({ type: 'orchestrator:chunk', chunk: greeting });
}

function handleOrchOutput(text) {
  orchBuffer += text;

  const prdMatch = orchBuffer.match(/<PRD>([\s\S]*?)<\/PRD>/);
  if (prdMatch) {
    savePRD(prdMatch[1].trim());
    notify('prd:generated', { taskTitle: null, status: 'generated' });
  }

  const tasksMatch = orchBuffer.match(/<TASKS>([\s\S]*?)<\/TASKS>/);
  if (tasksMatch) {
    try {
      const taskDefs = JSON.parse(tasksMatch[1].trim());
      if (Array.isArray(taskDefs)) {
        const created = taskDefs.map(t => createTask(t));
        if (broadcast) broadcast({ type: 'tasks:created', tasks: created });
        notify('tasks:created', { taskTitle: null, status: 'created' });
        orchBuffer = '';
        processQueue();
      }
    } catch (e) {
      console.error('[orchestrator] failed to parse tasks:', e.message);
    }
  }
}

function sendMessage(rawMessage) {
  const message = sanitizeInput(rawMessage);
  if (!message) return;

  conversationHistory.push({ role: 'user', content: message });
  if (broadcast) broadcast({ type: 'orchestrator:thinking' });

  const systemPrompt = `You are an expert software project orchestrator embedded in ClaudeBoard.

Your job:
1. Interview the user to understand what they want to build (2-3 exchanges max).
2. Once you have enough context, generate a PRD and break it into concrete tasks.

When ready to generate tasks, include BOTH blocks in your response:
<PRD>
[Full PRD in markdown]
</PRD>
<TASKS>
[
  {
    "title": "Task title",
    "description": "Detailed description",
    "successCriteria": "How to verify completion",
    "priority": "high|medium|low"
  }
]
</TASKS>

Rules:
- Ask one clarifying question at a time. Keep replies concise.
- Generate 3-8 tasks with concrete, independently verifiable success criteria.
- Only output the <PRD> and <TASKS> blocks when you truly have enough context.`;

  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const fullPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}\n\nAssistant:`;

  // Spawn without shell — prompt delivered via stdin only, never via argv
  const proc = spawn(CLAUDE_CMD, ['--print'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  proc.stdin.write(fullPrompt);
  proc.stdin.end();

  let response = '';

  proc.stdout.on('data', (data) => {
    const chunk = data.toString('utf-8');
    response += chunk;
    if (broadcast) broadcast({ type: 'orchestrator:chunk', chunk });
    handleOrchOutput(chunk);
  });

  proc.stderr.on('data', () => {
    // Swallow — don't expose internal details or system paths to the client
  });

  proc.on('close', () => {
    if (response) {
      conversationHistory.push({ role: 'assistant', content: response.slice(0, MAX_INPUT_LEN) });
    }
  });

  proc.on('error', (err) => {
    console.error('[orchestrator] spawn error:', err.message);
    if (broadcast) broadcast({ type: 'orchestrator:error', message: 'Orchestrator failed to start. Is the claude CLI installed and logged in?' });
  });
}

function spawnTaskAgent(task) {
  if (activeAgents.has(task.id)) return;

  // Fields already sanitized by store.createTask
  const prompt = `You are a focused software development agent. Complete the following task exactly as described.

Task: ${task.title}
Description: ${task.description}
Success Criteria: ${task.successCriteria}

Working directory: ${process.cwd()}

Work in the current directory. Be thorough and follow best practices.`;

  updateTask(task.id, { status: 'in_progress' });
  if (broadcast) broadcast({ type: 'task:started', taskId: task.id });

  const proc = spawn(CLAUDE_CMD, ['--permission-mode', 'bypassPermissions', '--print'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  const timer = setTimeout(() => {
    if (!proc.killed) {
      console.warn(`[orchestrator] agent for task ${task.id} timed out — killing`);
      proc.kill('SIGTERM');
    }
  }, AGENT_TIMEOUT_MS);

  activeAgents.set(task.id, { proc, timer });

  proc.stdout.on('data', (data) => {
    const chunk = data.toString('utf-8');
    const current = getTask(task.id);
    if (current) {
      updateTask(task.id, { output: (current.output || '') + chunk });
    }
    if (broadcast) broadcast({ type: 'task:output', taskId: task.id, chunk });
  });

  proc.stderr.on('data', () => {
    // Swallow stderr — don't expose system paths or tokens
  });

  proc.on('close', () => {
    clearTimeout(timer);
    activeAgents.delete(task.id);
    const current = getTask(task.id);
    if (current && current.status === 'in_progress') {
      runVerifier(current, broadcast);
    }
    processQueue();
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    activeAgents.delete(task.id);
    updateTask(task.id, { status: 'error' });
    if (broadcast) broadcast({ type: 'task:error', taskId: task.id, reason: 'Agent process failed to start' });
    console.error(`[orchestrator] spawn error for task ${task.id}:`, err.message);
    processQueue();
  });
}

function processQueue() {
  const tasks = getTasks();
  const backlog = tasks.filter(t => t.status === 'backlog');
  const slots = maxAgents - activeAgents.size;
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const toStart = backlog
    .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1))
    .slice(0, Math.max(0, slots));
  toStart.forEach(t => spawnTaskAgent(t));
}

function startTask(taskId) {
  const task = getTask(taskId);
  if (task && task.status === 'backlog') spawnTaskAgent(task);
}

function killAll() {
  for (const [, { proc, timer }] of activeAgents) {
    clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
  }
  activeAgents.clear();
}

module.exports = { setBroadcast, setMaxAgents, sendMessage, startTask, processQueue, startOrchestrator, killAll };
