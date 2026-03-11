# ClaudeBoard v3

Visual orchestrator for Claude Code agent teams. Run and manage multiple Claude Code agents from a single browser-based kanban dashboard.

## What it does

ClaudeBoard launches a local web server and opens a dashboard where you can:
- Chat with an Orchestrator agent that interviews you, generates a PRD, and breaks work into tasks
- Watch tasks move through a Kanban board (Backlog → In Progress → Verifying → Done / Error)
- Stream live agent output in a built-in terminal drawer
- Receive webhook notifications when tasks complete or fail

## Requirements

- Node.js >= 18
- Claude CLI installed and logged in (`claude --version` should work)

## Installation

Run without installing:

```
npx claudeboard
```

Or install globally:

```
npm install -g claudeboard
claudeboard
```

## Usage

```
claudeboard [options]
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `3000` | Port to run the dashboard server on |
| `--open <bool>` | `true` | Automatically open the dashboard in your browser |
| `--webhook <url>` | — | Webhook URL (must be `https://`) to POST agent lifecycle events to |
| `--max-agents <number>` | `3` | Maximum number of agents allowed to run concurrently |

### Examples

```
# Start on default port, auto-open browser
claudeboard

# Use a custom port without auto-opening
claudeboard --port 4000 --open false

# Limit to 5 concurrent agents and send events to a webhook
claudeboard --max-agents 5 --webhook https://example.com/hooks/claudeboard
```

## How it works

1. Start ClaudeBoard — a local Express server starts and the dashboard opens in your browser.
2. The Orchestrator agent greets you and asks what you want to build.
3. After 2–3 exchanges it generates a PRD and populates the Kanban board with tasks.
4. Claude Code sub-agents are spawned automatically (respecting `--max-agents`).
5. Each agent's output streams live to the task card in the dashboard.
6. A Verifier agent checks each completed task — approved tasks move to Done; failed tasks spawn a Fix task.

## Project data

ClaudeBoard stores all state in `.claudeboard/` inside your working directory:

| File | Contents |
|------|----------|
| `.claudeboard/tasks.json` | Task list and status |
| `.claudeboard/prd.md` | Generated PRD |
| `.claudeboard/agents.json` | Active agent registry |
| `.claudeboard/config.json` | Board configuration (webhook URL, etc.) |

**Add `.claudeboard/` to your `.gitignore`** — it may contain webhook URLs and agent output that should not be committed.

## Security

ClaudeBoard is designed to be safe to run on a shared development machine.

### Localhost-only server

The server **only** binds to `127.0.0.1` (loopback). It is never reachable from the network or other machines on the same LAN.

### No external data transmission

ClaudeBoard sends **no data to any external service**. The only outbound network calls are:

- Calls to the `claude` CLI (uses your existing local session — no API key required)
- Optional webhook `POST` requests to a URL **you** configure with `--webhook`

Webhook URLs must be `https://` and calls time out after 5 seconds.

### Subprocess safety

All `claude` CLI invocations use `spawn()` with an explicit argument array (`shell: false`). Prompts are delivered via stdin, not command-line arguments, so they never appear in process listings and there is no shell-injection risk regardless of what the user types.

### Input sanitization & rate limiting

- User chat messages are stripped of null bytes and capped at 10,000 characters before reaching the CLI.
- WebSocket connections are rate-limited to 10 messages per second per client.
- Task IDs are validated against a strict alphanumeric pattern before any file or process operations.

### Agent output cap

Agent output stored to disk is capped at **1 MB per task** to prevent runaway processes from filling the disk.

### Session-based auth

Access to the dashboard requires access to `127.0.0.1` (i.e., you must be logged in to the machine). There is no additional authentication layer — treat it like any other local dev tool.

### Reporting vulnerabilities

Please open a GitHub issue with the `[SECURITY]` tag. Do **not** include exploit details in a public issue — reach out privately first.

## License

MIT
