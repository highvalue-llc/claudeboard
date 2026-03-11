// src/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { getTasks, getConfig, setConfig, getPRD } = require('./store');
const { setBroadcast, setMaxAgents, sendMessage, startTask, processQueue, startOrchestrator, killAll } = require('./orchestrator');

const WS_RATE_LIMIT = 10; // max WS messages per second per connection
const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function createServer(options = {}) {
  const { port = 3000, maxAgents = 3, webhook = null, openBrowser = true } = options;

  if (webhook) setConfig({ webhook });
  setMaxAgents(maxAgents);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Read-only REST endpoints
  app.get('/api/tasks', (req, res) => {
    try { res.json(getTasks()); }
    catch { res.status(500).json({ error: 'Failed to read tasks' }); }
  });

  app.get('/api/prd', (req, res) => {
    try { res.json({ prd: getPRD() }); }
    catch { res.status(500).json({ error: 'Failed to read PRD' }); }
  });

  // Start a specific backlog task — ID validated before acting
  app.post('/api/tasks/:id/start', (req, res) => {
    const { id } = req.params;
    if (!TASK_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid task id' });
    startTask(id);
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  const clients = new Set();

  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  setBroadcast(broadcast);

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Per-connection rate-limit state
    let msgCount = 0;
    let windowStart = Date.now();

    try {
      ws.send(JSON.stringify({ type: 'init', tasks: getTasks(), prd: getPRD() }));
    } catch { /* ignore */ }

    ws.on('message', (raw) => {
      // Rate limit: max WS_RATE_LIMIT messages per second per client
      const now = Date.now();
      if (now - windowStart >= 1000) {
        msgCount = 0;
        windowStart = now;
      }
      msgCount++;
      if (msgCount > WS_RATE_LIMIT) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded — slow down' }));
        return;
      }

      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (msg.type === 'orchestrator:message' && typeof msg.text === 'string') {
        sendMessage(msg.text); // sanitized inside sendMessage
      } else if (msg.type === 'task:start' && typeof msg.taskId === 'string') {
        if (TASK_ID_RE.test(msg.taskId)) startTask(msg.taskId);
      } else if (msg.type === 'queue:process') {
        processQueue();
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // Bind ONLY to 127.0.0.1 — never 0.0.0.0
  server.listen(port, '127.0.0.1', async () => {
    console.log(`ClaudeBoard running at http://127.0.0.1:${port}`);
    startOrchestrator();

    if (openBrowser) {
      try {
        const open = await import('open');
        await open.default(`http://127.0.0.1:${port}`);
      } catch {
        console.log(`Open your browser at http://127.0.0.1:${port}`);
      }
    }
  });

  // Graceful shutdown — kill all child processes before exiting
  function shutdown(signal) {
    console.log(`\n[server] ${signal} received — shutting down`);
    killAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

module.exports = { createServer };
