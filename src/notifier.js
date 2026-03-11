// src/notifier.js
const https = require('https');
const { getConfig } = require('./store');

const TIMEOUT_MS = 5000;

function isValidHttpsUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function notify(event, data = {}) {
  const config = getConfig();
  const webhookUrl = config.webhook;
  if (!webhookUrl) return;

  if (!isValidHttpsUrl(webhookUrl)) {
    console.warn('[notifier] Webhook URL must be https:// — skipping');
    return;
  }

  const payload = JSON.stringify({
    event,
    taskTitle: data.taskTitle || null,
    status: data.status || null,
    timestamp: new Date().toISOString(),
  });

  try {
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.resume();
        res.on('end', resolve);
      });

      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy(new Error('Webhook request timed out'));
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.warn('[notifier] Webhook error:', err.message);
  }
}

module.exports = { notify };
