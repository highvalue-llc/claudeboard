// src/orchestrator.js
const { spawn } = require('child_process');
const { createTask, updateTask, getTask, getTasks, savePRD } = require('./store');
const { runVerifier } = require('./verifier');
const { notify } = require('./notifier');
const { scanProject } = require('./scanner');

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
let projectContext = null;

function buildGreeting(ctx) {
  if (ctx.isNewProject) {
    const stackInfo = ctx.techStack.length > 0
      ? ` I can see you're working with ${ctx.techStack.join(', ')}.`
      : '';
    return `¡Hola! Soy tu Orquestador. Voy a coordinar tu equipo de agentes IA para **${ctx.projectName}**.${stackInfo} ¿Qué querés construir?`;
  }

  // Existing project — reference what's already there
  const stackInfo = ctx.techStack.length > 0
    ? ` (${ctx.techStack.join(', ')})`
    : '';
  return `¡Bienvenido de vuelta! Veo que **${ctx.projectName}**${stackInfo} ya tiene un PRD. ¿Querés continuar donde lo dejaste, agregar más tareas o empezar de nuevo?`;
}

function startOrchestrator() {
  conversationHistory = [];
  orchBuffer = '';

  try {
    projectContext = scanProject();
  } catch (err) {
    console.warn('[orchestrator] scanner error:', err.message);
    projectContext = null;
  }

  const greeting = projectContext
    ? buildGreeting(projectContext)
    : "¡Hola! Soy tu Orquestador. Contame qué querés construir y coordino tu equipo de agentes IA.";

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

  // Build project context section for the system prompt
  let projectSection = '';
  if (projectContext) {
    const lines = [];
    lines.push(`## Project Context`);
    lines.push(`- **Name**: ${projectContext.projectName}`);
    if (projectContext.techStack.length > 0) {
      lines.push(`- **Tech stack**: ${projectContext.techStack.join(', ')}`);
    }
    if (projectContext.pkgDescription) {
      lines.push(`- **Description**: ${projectContext.pkgDescription}`);
    }
    if (projectContext.readme) {
      lines.push(`\n### README (excerpt)\n${projectContext.readme.slice(0, 1000)}`);
    }
    if (projectContext.existingPrd) {
      lines.push(`\n### Existing PRD\n${projectContext.existingPrd.slice(0, 2000)}`);
    }
    lines.push(`\n### File tree\n\`\`\`\n${projectContext.fileTree.slice(0, 2000)}\n\`\`\``);
    projectSection = '\n\n' + lines.join('\n');
  }

  const systemPrompt = `Sos un orquestador experto de proyectos de software dentro de ClaudeBoard. Respondé SIEMPRE en español argentino, de forma casual y directa.${projectSection}

Tu trabajo:
1. Entrevistar al usuario para entender qué quiere construir (máximo 2-3 intercambios).
2. Una vez que tenés suficiente contexto, generar un PRD y desglosarlo en tareas concretas.

Cuando estés listo para generar las tareas, incluí AMBOS bloques en tu respuesta:
<PRD>
[PRD completo en markdown]
</PRD>
<TASKS>
[
  {
    "title": "Título de la tarea",
    "description": "Descripción detallada",
    "successCriteria": "Cómo verificar que está completa",
    "priority": "high|medium|low"
  }
]
</TASKS>

Reglas:
- Hacé una pregunta aclaratoria a la vez. Respondé de forma concisa.
- Generá entre 3 y 8 tareas con criterios de éxito concretos e independientemente verificables.
- Solo emitir los bloques <PRD> y <TASKS> cuando tenés suficiente contexto.
- Respondé SIEMPRE en español argentino. Nunca en inglés.`;

  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const fullPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}\n\nAssistant:`;

  // claude --print requires the prompt as a positional argument (not stdin)
  // On Windows, use cmd /c to invoke .cmd files without shell:true deprecation warning
  const spawnArgs = process.platform === 'win32'
    ? ['cmd', ['/c', 'claude', '--permission-mode', 'bypassPermissions', '--print', fullPrompt]]
    : ['claude', ['--permission-mode', 'bypassPermissions', '--print', fullPrompt]];

  const proc = spawn(spawnArgs[0], spawnArgs[1], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

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
    shell: process.platform === 'win32',
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
