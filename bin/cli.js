#!/usr/bin/env node
// bin/cli.js
const { program } = require('commander');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

program
  .name('claudeboard')
  .description('Visual orchestrator for Claude Code agent teams')
  .version('3.0.0')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--open <bool>', 'Open browser automatically', 'true')
  .option('--webhook <url>', 'Webhook URL for notifications (must be https://)')
  .option('--max-agents <number>', 'Max parallel agents (skips team selection prompt)')
  .option('--project <path>', 'Absolute path to the project to work on')
  .parse(process.argv);

const opts = program.opts();
const port = parseInt(opts.port, 10) || 3000;
const openBrowser = opts.open !== 'false';

// ── Agent team options ────────────────────────────────────────
const TEAMS = [
  { label: '🧑‍💻  Solo Dev    ', desc: '1 agent, focused, low token cost',           maxAgents: 1, cost: '~1x' },
  { label: '👥  Small Team  ', desc: '3 agents (Lead + 2 specialists)',              maxAgents: 3, cost: '~3x' },
  { label: '🚀  Full Team   ', desc: '6 agents (Lead + 5 specialists)',              maxAgents: 6, cost: '~6x' },
  { label: '🏭  Enterprise  ', desc: '9 agents (Lead + 8 specialists, max parallelism)', maxAgents: 9, cost: '~9x' },
];

// ── Interactive arrow-key menu ────────────────────────────────
function drawMenu(teams, selected, lineCount) {
  const lines = [chalk.bold('? ') + 'Select your agent team:'];
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    const cursor = i === selected ? chalk.cyan('❯') : ' ';
    const label  = i === selected ? chalk.bold(t.label) : chalk.dim(t.label);
    lines.push(`  ${cursor} ${label} ${chalk.dim('— ' + t.desc)}  ${chalk.yellow(t.cost)}`);
  }
  if (lineCount > 0) process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
  process.stdout.write(lines.join('\n') + '\n');
  return lines.length;
}

function promptTeamSelection() {
  if (opts.maxAgents !== undefined || !process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let selected = 1;
    let lineCount = drawMenu(TEAMS, selected, 0);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function onKey(key) {
      if (key === '\x1b[A') { selected = Math.max(0, selected - 1); lineCount = drawMenu(TEAMS, selected, lineCount); }
      else if (key === '\x1b[B') { selected = Math.min(TEAMS.length - 1, selected + 1); lineCount = drawMenu(TEAMS, selected, lineCount); }
      else if (key === '\r' || key === '\n') {
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
        const team = TEAMS[selected];
        process.stdout.write(chalk.bold('✔ ') + 'Agent team: ' + chalk.cyan(team.label.trim()) + chalk.dim('  (' + team.desc + ')') + '\n');
        resolve(team);
      } else if (key === '\x03') {
        process.stdin.setRawMode(false);
        process.exit(0);
      }
    }
    process.stdin.on('data', onKey);
  });
}

// ── Project path prompt ───────────────────────────────────────
function promptProjectPath() {
  // --project flag takes priority
  if (opts.project !== undefined) {
    const resolved = path.resolve(opts.project);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.yellow(`  ⚠ Path not found: ${resolved}`));
      return Promise.resolve(process.cwd());
    }
    console.log(chalk.bold('✔ ') + 'Project: ' + chalk.cyan(resolved));
    return Promise.resolve(resolved);
  }

  if (!process.stdin.isTTY) return Promise.resolve(process.cwd());

  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const cwd = process.cwd();
    rl.question(chalk.bold('? ') + `Project path ${chalk.dim('(Enter = ' + path.basename(cwd) + ')')}: `, (answer) => {
      rl.close();
      const raw = answer.trim();
      if (!raw) {
        console.log(chalk.bold('✔ ') + 'Project: ' + chalk.cyan(cwd));
        resolve(cwd);
        return;
      }
      const resolved = path.resolve(raw);
      if (!fs.existsSync(resolved)) {
        console.log(chalk.yellow(`  ⚠ Directory not found, using current dir`));
        resolve(cwd);
      } else {
        console.log(chalk.bold('✔ ') + 'Project: ' + chalk.cyan(resolved));
        resolve(resolved);
      }
    });
  });
}

// ── Entry point ───────────────────────────────────────────────
async function main() {
  console.log(chalk.bold.hex('#e3c69a')('ClaudeBoard v3 ✦'));
  console.log(chalk.dim('Visual orchestrator for Claude Code agent teams'));
  console.log('');

  const team = await promptTeamSelection();

  let maxAgents;
  if (opts.maxAgents !== undefined) maxAgents = parseInt(opts.maxAgents, 10) || 3;
  else if (team) maxAgents = team.maxAgents;
  else maxAgents = 3;

  const projectPath = await promptProjectPath();

  const { setConfig } = require(path.join(__dirname, '..', 'src', 'store'));
  const configUpdate = { maxAgents, projectPath };
  if (opts.webhook) configUpdate.webhook = opts.webhook;
  setConfig(configUpdate);

  console.log('');

  const { createServer } = require(path.join(__dirname, '..', 'src', 'server'));
  createServer({ port, maxAgents, projectPath, webhook: opts.webhook, openBrowser });

  console.log(chalk.dim('Press Ctrl+C to stop'));
}

main();
