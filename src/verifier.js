// src/verifier.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateTask, createTask, getTask, getProjectPath } = require('./store');
const { notify } = require('./notifier');

function spawnClaude(prompt, cwd) {
  const tmpFile = path.join(os.tmpdir(), `cb-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpFile, prompt, { encoding: 'utf8' });
  let child;
  if (process.platform === 'win32') {
    const psCmd = `Get-Content -Raw -Encoding UTF8 '${tmpFile}' | claude --permission-mode bypassPermissions --print`;
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
  } else {
    child = spawn('sh', ['-c', `claude --permission-mode bypassPermissions --print < '${tmpFile}'`], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
  }
  child.on('close', () => { try { fs.unlinkSync(tmpFile); } catch (_) {} });
  return child;
}

const MAX_FIELD_LEN = 2000;
const MAX_RETRIES = 2;

function sanitizeField(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\0/g, '').slice(0, MAX_FIELD_LEN);
}

function runVerifier(task, broadcast, onRetry) {
  const title = sanitizeField(task.title);
  const description = sanitizeField(task.description);
  const successCriteria = sanitizeField(task.successCriteria);
  const agentOutput = sanitizeField(typeof task.output === 'string' ? task.output.slice(-2000) : '');
  const projectPath = getProjectPath();

  const prompt = `You are a code verifier. Check if this task was completed correctly.

Task: ${title}
Success criteria: ${successCriteria}
Project directory: ${projectPath}

What the agent did:
${agentOutput || '(no output)'}

Instructions:
1. Read the relevant files in the project directory to check the actual result.
2. Your ENTIRE response must be ONE of these two formats, nothing else:
   VERIFIED
   FAILED: <one sentence reason>

Do not add explanations, greetings, or any other text. Start your response with VERIFIED or FAILED.`;

  broadcast({ type: 'task:verifying', taskId: task.id });
  updateTask(task.id, { status: 'verifying' });

  const proc = spawnClaude(prompt, projectPath);
  let output = '';

  proc.stdout.on('data', (data) => {
    const chunk = data.toString('utf-8');
    output += chunk;
    broadcast({ type: 'task:verifier_output', taskId: task.id, chunk });
  });

  proc.stderr.on('data', () => {});

  proc.on('close', () => {
    const trimmed = output.trim();
    // Flexible parsing: check anywhere in the first 300 chars
    const head = trimmed.slice(0, 300).toUpperCase();
    const isVerified = head.includes('VERIFIED') && !head.includes('FAILED');

    if (isVerified) {
      updateTask(task.id, { status: 'done', verifierOutput: trimmed.slice(0, 500) });
      broadcast({ type: 'task:done', taskId: task.id });
      notify('task:completed', { taskTitle: task.title, status: 'done' });
      return;
    }

    // Extract failure reason
    const failedMatch = trimmed.match(/FAILED[:\s]+(.+?)(?:\n|$)/i);
    const reason = failedMatch
      ? failedMatch[1].trim().slice(0, 300)
      : trimmed.slice(0, 300) || 'Verificación sin respuesta esperada';

    const retryCount = (task.retryCount || 0) + 1;

    if (retryCount <= MAX_RETRIES) {
      // Auto-retry: reset same task with more context
      const enrichedDesc = `[Reintento ${retryCount}/${MAX_RETRIES}] Intento anterior falló: ${reason}\n\nTarea original: ${task.description}`;
      updateTask(task.id, {
        status: 'backlog',
        output: '',
        verifierOutput: reason,
        retryCount,
        description: enrichedDesc.slice(0, 2000),
      });
      broadcast({ type: 'task:updated', task: getTask(task.id) });
      notify('task:failed', { taskTitle: task.title, status: 'retrying' });
      if (onRetry) onRetry();
    } else {
      // Human intervention needed
      updateTask(task.id, {
        status: 'error',
        needsHuman: true,
        humanReason: reason,
        verifierOutput: trimmed.slice(0, 500),
      });
      broadcast({ type: 'task:error', taskId: task.id, reason, needsHuman: true });
      notify('task:failed', { taskTitle: task.title, status: 'error' });
    }
  });

  proc.on('error', (err) => {
    console.error('[verifier] spawn error:', err.message);
    updateTask(task.id, { status: 'error', needsHuman: false });
    broadcast({ type: 'task:error', taskId: task.id, reason: 'Verifier process failed to start' });
  });
}

module.exports = { runVerifier };
