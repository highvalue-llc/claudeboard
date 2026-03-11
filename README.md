# ClaudeBoard v3

Visual orchestrator for Claude Code agent teams. Run and manage multiple Claude Code agents from a single browser-based kanban dashboard.

## What it does

ClaudeBoard launches a local web server that gives you a visual interface to create, monitor, and coordinate Claude Code agents working on tasks in parallel. Each agent runs in its own worktree, and their status, output, and progress are streamed to the dashboard in real time.

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
| `--webhook <url>` | — | Webhook URL to POST agent lifecycle events to |
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
2. Create a task from the dashboard — give it a name, description, and target directory.
3. ClaudeBoard spawns a Claude Code agent in a dedicated git worktree for that task.
4. The agent's output is streamed live to the board via WebSocket.
5. Tasks move through columns (Queued → Running → Done / Failed) as agents progress.
6. When an agent finishes, you can review its output and diff directly in the UI.

Agents respect the `--max-agents` limit — additional tasks queue until a slot opens.

## Project data

ClaudeBoard stores all project state in a `.claudeboard/` directory in your working directory:

- `.claudeboard/tasks.json` — task list and metadata
- `.claudeboard/logs/` — per-agent output logs
- `.claudeboard/worktrees/` — git worktrees created for each task

Add `.claudeboard/worktrees/` to your `.gitignore`. The `tasks.json` and logs can be committed if you want to track agent history.

## License

MIT
