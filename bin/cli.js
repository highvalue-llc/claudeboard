#!/usr/bin/env node
// bin/cli.js
const { program } = require('commander');
const path = require('path');
const chalk = require('chalk');

program
  .name('claudeboard')
  .description('Visual orchestrator for Claude Code agent teams')
  .version('3.0.0')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--open <bool>', 'Open browser automatically', 'true')
  .option('--webhook <url>', 'Webhook URL for notifications (must be https://)')
  .option('--max-agents <number>', 'Max parallel agents', '3')
  .parse(process.argv);

const opts = program.opts();
const port = parseInt(opts.port, 10) || 3000;
const openBrowser = opts.open !== 'false';
const maxAgents = parseInt(opts.maxAgents, 10) || 3;

const { createServer } = require(path.join(__dirname, '..', 'src', 'server'));

console.log(chalk.bold.hex('#e3c69a')('ClaudeBoard v3'));
console.log(chalk.dim('Visual orchestrator for Claude Code agent teams'));
console.log('');

createServer({ port, maxAgents, webhook: opts.webhook, openBrowser });

console.log(chalk.dim('Press Ctrl+C to stop'));
