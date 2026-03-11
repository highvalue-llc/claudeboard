// src/orchestrator.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

IMPORTANTE: Esta es una conversación EN CURSO. NO te presentes ni saludes de nuevo. Continuá directamente desde donde se dejó.

Tu trabajo:
1. Leer el pedido del usuario y entenderlo. Si ya hay suficiente contexto, generá las tareas DIRECTAMENTE.
2. Solo hacer UNA pregunta aclaratoria si realmente falta información crítica.
3. En cuanto tenés suficiente info, generá el PRD y las tareas SIN más preguntas.

REGLA CLAVE: Si el usuario ya describió lo que quiere (proyecto, archivos, cambios), NO preguntes más — generá las tareas de inmediato.

Cuando tengas suficiente contexto, incluí AMBOS bloques:
<PRD>
[PRD completo en markdown]
</PRD>
<TASKS>
[
  {
    "title": "Título de la tarea",
    "description": "Descripción detallada con ruta de archivo si aplica",
    "successCriteria": "Cómo verificar que está completa",
    "priority": "high|medium|low"
  }
]
</TASKS>

Reglas:
- Respondé SIEMPRE en español argentino. Nunca en inglés.
- Generá entre 3 y 8 tareas concretas e independientemente verificables.
- Incluí rutas de archivos exactas en las descripciones cuando el usuario las mencione.`;

  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'Usuario' : 'Orquestador'}: ${m.content}`)
    .join('\n\n');

  const fullPrompt = `${systemPrompt}\n\n--- CONVERSACIÓN ACTUAL ---\n${historyText}\n\nOrquestador:`;

  // Write prompt to temp file and use input redirection — works on Windows + Mac
  // Avoids: (1) cmd line length limit, (2) special char escaping, (3) stdin hang
  const tmpFile = path.join(os.tmpdir(), `cb-orch-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, fullPrompt, 'utf8');

  const isWin = process.platform === 'win32';
  const shellCmd = isWin
    ? `claude --permission-mode bypassPermissions --print < "${tmpFile}"`
    : `claude --permission-mode bypassPermissions --print < "${tmpFile}"`;

  const proc = spawn(isWin ? 'cmd' : 'sh', [isWin ? '/c' : '-c', shellCmd], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  proc.on('close', () => { try { fs.unlinkSync(tmpFile); } catch {} });

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

  const taskTmpFile = path.join(os.tmpdir(), `cb-task-${task.id}-${Date.now()}.txt`);
  fs.writeFileSync(taskTmpFile, prompt, 'utf8');
  const isWin2 = process.platform === 'win32';
  const taskShellCmd = `claude --permission-mode bypassPermissions --print < "${taskTmpFile}"`;
  const proc = spawn(isWin2 ? 'cmd' : 'sh', [isWin2 ? '/c' : '-c', taskShellCmd], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

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
