// src/orchestrator.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTask, updateTask, getTask, getTasks, savePRD, getPRD, getProjectPath, appendChatHistory, saveChatImage } = require('./store');
const { runVerifier } = require('./verifier');
const { notify } = require('./notifier');
const { scanProject } = require('./scanner');

// spawnClaude: writes prompt to temp file and pipes via PowerShell (Win) or sh (Mac/Linux)
// This is the only reliable cross-platform way to pass long prompts to `claude --print`
function spawnClaude(prompt, cwd) {
  const tmpFile = path.join(os.tmpdir(), `cb-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpFile, prompt, { encoding: 'utf8' });

  let child;
  if (process.platform === 'win32') {
    // PowerShell pipes file content reliably on Windows (no cmd line length limit, no char escaping issues)
    const psCmd = `Get-Content -Raw -Encoding UTF8 '${tmpFile}' | claude --permission-mode bypassPermissions --print`;
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } else {
    child = spawn('sh', ['-c', `claude --permission-mode bypassPermissions --print < '${tmpFile}'`], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  }

  child.on('close', () => { try { fs.unlinkSync(tmpFile); } catch (_) {} });
  return child;
}
const MAX_INPUT_LEN = 10000;   // max user input chars
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const AGENT_ROLES = [
  'Lead Developer',
  'Frontend Dev',
  'Backend Dev',
  'QA Engineer',
  'UI/UX Dev',
  'DevOps',
  'Data Engineer',
  'Security Dev',
  'Tech Lead',
];

let activeAgents = new Map(); // taskId -> { proc, timer }
let broadcast = null;
let maxAgents = 3;
let agentSlot = 0;
let qaAgentRan = false;
let qaBuffer = '';
let serverPort = 3000;

function setBroadcast(fn) { broadcast = fn; }
function setMaxAgents(n) { maxAgents = n; }
function setServerPort(p) { serverPort = p; }

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

  // Parse individual <TASK>...</TASK> blocks (no JSON, no escaping issues)
  if (orchBuffer.includes('</TASKS>')) {
    const taskBlocks = [...orchBuffer.matchAll(/<TASK>([\s\S]*?)<\/TASK>/g)];
    if (taskBlocks.length > 0) {
      const taskDefs = taskBlocks.map(m => {
        const block = m[1];
        const get = (key) => {
          const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
          return match ? match[1].trim() : '';
        };
        return { title: get('title'), description: get('description'), successCriteria: get('successCriteria'), priority: get('priority') || 'medium' };
      }).filter(t => t.title);
      if (taskDefs.length > 0) {
        const created = taskDefs.map(t => createTask(t));
        if (broadcast) broadcast({ type: 'tasks:created', tasks: created });
        notify('tasks:created', { taskTitle: null, status: 'created' });
        qaAgentRan = false; // new tasks → QA can run again after they complete
        orchBuffer = '';
        processQueue();
      }
    }
  }
}

function sendMessage(rawMessage, imageData = null) {
  const message = sanitizeInput(rawMessage);
  if (!message) return;

  orchBuffer = ''; // reset buffer for each new message exchange
  conversationHistory.push({ role: 'user', content: message });
  appendChatHistory({ role: 'user', content: message });
  if (broadcast) broadcast({ type: 'orchestrator:thinking' });

  // Save attached image to disk so Claude can read it
  let imagePath = null;
  if (imageData) {
    try { imagePath = saveChatImage(imageData); } catch (err) {
      console.warn('[orchestrator] failed to save chat image:', err.message);
    }
  }

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
    if (projectContext.contextMd) {
      lines.push(`\n### Brand guidelines / context.md\n${projectContext.contextMd.slice(0, 2000)}`);
    }
    lines.push(`\n### File tree\n\`\`\`\n${projectContext.fileTree.slice(0, 2000)}\n\`\`\``);
    projectSection = '\n\n' + lines.join('\n');
  }

  const systemPrompt = `Sos el orquestador de ClaudeBoard. Español argentino, directo, sin rodeos.${projectSection}

Conversación en curso — no te presentes. Si el usuario describió lo que quiere, generá las tareas YA.

Cuando tengas suficiente contexto, incluí estos dos bloques (sin excepciones):

<PRD>
Descripción breve del objetivo y cambios clave.
</PRD>
<TASKS>
<TASK>
title: Título concreto de la tarea
description: Qué hacer exactamente, con ruta de archivo si aplica
successCriteria: Cómo verificar que está lista
priority: high|medium|low
</TASK>
</TASKS>

Reglas:
- 3 a 8 tareas concretas e independientes.
- Cada tarea va en su propio bloque <TASK>...</TASK>.
- No uses JSON, no uses comillas, solo el formato de arriba.
- Rutas de archivos exactas en description cuando el usuario las mencione.`;

  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'Usuario' : 'Orquestador'}: ${m.content}`)
    .join('\n\n');

  const imageSection = imagePath
    ? `\n\nEl usuario adjuntó una imagen del estado actual del proyecto en: ${imagePath}\nPodés leerla para ver cómo se ve visualmente y tenerlo en cuenta al crear las tareas.`
    : '';

  const fullPrompt = `${systemPrompt}\n\n--- CONVERSACIÓN ACTUAL ---\n${historyText}${imageSection}\n\nOrquestador:`;

  const proc = spawnClaude(fullPrompt, process.cwd());

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
      const assistantContent = response.slice(0, MAX_INPUT_LEN);
      conversationHistory.push({ role: 'assistant', content: assistantContent });
      appendChatHistory({ role: 'assistant', content: assistantContent });
    }
  });

  proc.on('error', (err) => {
    console.error('[orchestrator] spawn error:', err.message);
    if (broadcast) broadcast({ type: 'orchestrator:error', message: 'Orchestrator failed to start. Is the claude CLI installed and logged in?' });
  });
}

function spawnTaskAgent(task) {
  if (activeAgents.has(task.id)) return;

  // Assign a role to this agent slot
  const agentLabel = AGENT_ROLES[agentSlot % AGENT_ROLES.length];
  agentSlot++;

  const projectPath = getProjectPath();

  // Read .claudeboard/context.md if present
  let contextMdContent = '';
  try {
    const contextMdPath = path.join(projectPath, '.claudeboard', 'context.md');
    if (fs.existsSync(contextMdPath)) {
      contextMdContent = fs.readFileSync(contextMdPath, 'utf-8').slice(0, 8000);
    }
  } catch { /* ignore */ }

  // Detect file path mentioned in task description
  let fileContent = '';
  const filePathMatch = task.description && task.description.match(/[\w/\\.\-]+\.(html|css|js|ts|jsx|tsx|json|md)/i);
  if (filePathMatch) {
    try {
      const mentionedPath = filePathMatch[0];
      const absPath = path.isAbsolute(mentionedPath)
        ? mentionedPath
        : path.join(projectPath, mentionedPath);
      if (fs.existsSync(absPath)) {
        fileContent = fs.readFileSync(absPath, 'utf-8').slice(0, 8000);
      }
    } catch { /* ignore */ }
  }

  // File tree from project context
  const fileTree = projectContext ? projectContext.fileTree : '';

  const contextMdSection = contextMdContent
    ? `\n## Guías de marca / Design tokens\n${contextMdContent}`
    : '';

  const fileTreeSection = fileTree
    ? `\n## Contexto del proyecto\n\`\`\`\n${fileTree.slice(0, 3000)}\n\`\`\``
    : '';

  const fileContentSection = fileContent
    ? `\n## Contenido actual del archivo relevante\n\`\`\`\n${fileContent}\n\`\`\``
    : '';

  const prompt = `Sos un agente de desarrollo de software. Completá la siguiente tarea exactamente como se describe.

## Tarea
Título: ${task.title}
Descripción: ${task.description}
Criterio de éxito: ${task.successCriteria}
Prioridad: ${task.priority || 'medium'}

## Directorio de trabajo
${projectPath}
${fileTreeSection}${contextMdSection}${fileContentSection}

Trabajá en el directorio actual. Sé meticuloso, seguí el estilo existente del código y las guías de marca si están disponibles.`;

  updateTask(task.id, { status: 'in_progress', agentLabel });
  if (broadcast) broadcast({ type: 'task:started', taskId: task.id, agentLabel });

  const proc = spawnClaude(prompt, projectPath);

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
      runVerifier(current, broadcast, processQueue);
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

  // Trigger QA when all tasks are done and none are running
  if (toStart.length === 0 && activeAgents.size === 0 && !qaAgentRan) {
    const allTasks = getTasks();
    const pending = allTasks.filter(t => ['backlog', 'in_progress', 'verifying'].includes(t.status));
    const done = allTasks.filter(t => t.status === 'done');
    if (pending.length === 0 && done.length > 0) {
      qaAgentRan = true;
      spawnQAAgent(allTasks);
    }
  }
}

function startTask(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  if (task.status === 'error') {
    updateTask(taskId, { status: 'backlog', output: '', verifierOutput: '' });
    const reset = getTask(taskId);
    if (broadcast) broadcast({ type: 'task:updated', task: reset });
    spawnTaskAgent(reset);
  } else if (task.status === 'backlog') {
    spawnTaskAgent(task);
  }
}

function spawnQAAgent(allTasks) {
  const prd = (() => { try { return getPRD() || ''; } catch { return ''; } })();
  const doneSummary = allTasks.filter(t => t.status === 'done').map(t => `- ${t.title}`).join('\n');
  const errorSummary = allTasks.filter(t => t.status === 'error').map(t => `- ${t.title}`).join('\n');

  const targetUrl = `http://127.0.0.1:${serverPort}`;
  const screenshotPath = path.join(process.cwd(), '.claudeboard', 'qa-screenshot.png');
  const screenshotPathEscaped = screenshotPath.replace(/\\/g, '/');

  // Platform hints for finding Chrome
  let findChromeHint, chromeFlagHint;
  if (process.platform === 'win32') {
    findChromeHint = `Run this to find Chrome: cmd /c "where chrome 2>nul & where msedge 2>nul & dir \\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\\" 2>nul & dir \\"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe\\" 2>nul"`;
    chromeFlagHint = `--headless=new --disable-gpu --no-sandbox --screenshot="${screenshotPathEscaped}" --window-size=1280,900`;
  } else if (process.platform === 'darwin') {
    findChromeHint = `Run: which google-chrome || ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null`;
    chromeFlagHint = `--headless=new --disable-gpu --no-sandbox --screenshot="${screenshotPath}" --window-size=1280,900`;
  } else {
    findChromeHint = `Run: which google-chrome || which chromium-browser || which chromium`;
    chromeFlagHint = `--headless=new --disable-gpu --no-sandbox --screenshot="${screenshotPath}" --window-size=1280,900`;
  }

  const prompt = `You are a QA Engineer doing a visual review of a web project.
The app is running at: ${targetUrl}

PRD / Objective:
${prd || 'No PRD available — review the completed tasks below.'}

Completed tasks:
${doneSummary || '(none)'}
${errorSummary ? `\nFailed tasks (not fixed):\n${errorSummary}` : ''}

== YOUR STEPS (follow in order) ==

STEP 1 — Find Chrome on this machine.
${findChromeHint}
If Chrome is not found, try Microsoft Edge (msedge) as a fallback.

STEP 2 — Take a screenshot.
Use the Chrome (or Edge) path you found and run:
  [chrome-path] ${chromeFlagHint} ${targetUrl}
This saves the screenshot to: ${screenshotPath}
NOTE: This runs headless — no window will open. It silently saves the PNG file.

STEP 3 — Read the screenshot file.
Use your file reading tool to read the image at: ${screenshotPath}
Look carefully at: layout, colors, spacing, broken elements, missing content, typography.

STEP 4 — Review the source files.
Also read the main HTML/CSS/JS files of the project to spot any code-level issues.

STEP 5 — Report results.
If you find visual or functional issues, output EXACTLY this format (no JSON, no markdown fences):

<TASKS>
<TASK>
title: Fix: [describe the issue concisely]
description: [exact file path + what to change]
successCriteria: [how to verify it looks/works correctly]
priority: high
</TASK>
</TASKS>

If everything is correct, say only: QA PASSED — all objectives met.`;

  if (broadcast) broadcast({ type: 'qa:started' });

  const projectPath = getProjectPath();
  const proc = spawnClaude(prompt, projectPath);
  qaBuffer = '';

  proc.stdout.on('data', (data) => {
    const chunk = data.toString('utf-8');
    if (broadcast) broadcast({ type: 'qa:output', chunk });
    qaBuffer += chunk;
    if (qaBuffer.includes('</TASKS>')) {
      const taskBlocks = [...qaBuffer.matchAll(/<TASK>([\s\S]*?)<\/TASK>/g)];
      if (taskBlocks.length > 0) {
        const taskDefs = taskBlocks.map(m => {
          const block = m[1];
          const get = (key) => {
            const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
            return match ? match[1].trim() : '';
          };
          return { title: get('title'), description: get('description'), successCriteria: get('successCriteria'), priority: get('priority') || 'high' };
        }).filter(t => t.title);
        if (taskDefs.length > 0) {
          const created = taskDefs.map(t => createTask(t));
          if (broadcast) broadcast({ type: 'tasks:created', tasks: created });
          qaAgentRan = false; // new QA tasks → allow QA to run again after they complete
          qaBuffer = '';
          processQueue();
        }
      }
    }
  });

  proc.on('close', () => {
    if (broadcast) broadcast({ type: 'qa:done' });
  });

  proc.on('error', (err) => {
    console.error('[qa] spawn error:', err.message);
    if (broadcast) broadcast({ type: 'qa:done' });
  });
}

function stopTask(taskId) {
  const agent = activeAgents.get(taskId);
  if (agent) {
    clearTimeout(agent.timer);
    if (!agent.proc.killed) agent.proc.kill('SIGTERM');
    activeAgents.delete(taskId);
  }
  updateTask(taskId, { status: 'backlog' });
  if (broadcast) broadcast({ type: 'task:stopped', taskId });
}

function pauseAll() {
  for (const [taskId, { proc, timer }] of activeAgents) {
    clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
    updateTask(taskId, { status: 'backlog' });
    if (broadcast) broadcast({ type: 'task:stopped', taskId });
  }
  activeAgents.clear();
}

function killAll() {
  for (const [, { proc, timer }] of activeAgents) {
    clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
  }
  activeAgents.clear();
}

// Manual QA trigger — can be called regardless of task state
function runQA() {
  qaAgentRan = false;
  spawnQAAgent(getTasks());
}

module.exports = { setBroadcast, setMaxAgents, setServerPort, sendMessage, startTask, processQueue, startOrchestrator, killAll, stopTask, pauseAll, runQA };
