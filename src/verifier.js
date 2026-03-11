// src/verifier.js
const { spawn } = require('child_process');
const { updateTask, createTask } = require('./store');
const { notify } = require('./notifier');

const CLAUDE_CMD = process.platform === 'win32' ? 'claude.cmd' : 'claude';
const MAX_FIELD_LEN = 2000;

function sanitizeField(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\0/g, '').slice(0, MAX_FIELD_LEN);
}

function runVerifier(task, broadcast) {
  // Sanitize task fields — they originate from LLM output, not directly from user
  const title = sanitizeField(task.title);
  const description = sanitizeField(task.description);
  const successCriteria = sanitizeField(task.successCriteria);

  const prompt = `You are a code verification agent. Check if the following task was completed correctly.

Task: ${title}
Description: ${description}
Success Criteria: ${successCriteria}

Review the relevant files in the current working directory. Respond with exactly one of:
- VERIFIED  (if the task meets the success criteria)
- FAILED: <brief reason>  (if the task is incomplete or incorrect)`;

  broadcast({ type: 'task:verifying', taskId: task.id });
  updateTask(task.id, { status: 'verifying' });

  // claude --print requires prompt as positional arg; use cmd /c on Windows to avoid shell:true
  const spawnArgs = process.platform === 'win32'
    ? ['cmd', ['/c', 'claude', '--permission-mode', 'bypassPermissions', '--print', prompt]]
    : ['claude', ['--permission-mode', 'bypassPermissions', '--print', prompt]];

  const proc = spawn(spawnArgs[0], spawnArgs[1], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  let output = '';

  proc.stdout.on('data', (data) => {
    const chunk = data.toString('utf-8');
    output += chunk;
    broadcast({ type: 'task:verifier_output', taskId: task.id, chunk });
  });

  proc.stderr.on('data', () => {
    // Swallow — don't expose system paths to the client
  });

  proc.on('close', () => {
    const trimmed = output.trim();
    if (trimmed.startsWith('VERIFIED')) {
      updateTask(task.id, { status: 'done', verifierOutput: trimmed.slice(0, 500) });
      broadcast({ type: 'task:done', taskId: task.id });
      notify('task:completed', { taskTitle: task.title, status: 'done' });
    } else {
      const reason = trimmed.startsWith('FAILED:')
        ? trimmed.slice(7).trim().slice(0, 500)
        : 'Verification did not return an expected response';
      updateTask(task.id, { status: 'error', verifierOutput: trimmed.slice(0, 500) });
      broadcast({ type: 'task:error', taskId: task.id, reason });
      notify('task:failed', { taskTitle: task.title, status: 'error' });

      const fixTask = createTask({
        title: `Fix: ${task.title}`,
        description: `Previous attempt failed.\nReason: ${reason}\n\nOriginal task: ${task.description}`,
        successCriteria: task.successCriteria,
        priority: task.priority,
      });
      broadcast({ type: 'tasks:created', tasks: [fixTask] });
    }
  });

  proc.on('error', (err) => {
    console.error('[verifier] spawn error:', err.message);
    broadcast({ type: 'task:error', taskId: task.id, reason: 'Verifier process failed to start' });
    updateTask(task.id, { status: 'error' });
  });
}

module.exports = { runVerifier };
