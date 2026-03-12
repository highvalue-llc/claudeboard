#!/usr/bin/env node
// bin/init-context.js — copies context template to .claudeboard/context.md in the current project
const fs = require('fs');
const path = require('path');

const targetDir = path.join(process.cwd(), '.claudeboard');
const targetFile = path.join(targetDir, 'context.md');
const templateFile = path.join(__dirname, '..', 'src', 'context-template.md');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

if (fs.existsSync(targetFile)) {
  console.log(`Already exists: ${targetFile}`);
  console.log('Edit it directly to customize your project context.');
  process.exit(0);
}

fs.copyFileSync(templateFile, targetFile);
console.log(`Created: ${targetFile}`);
console.log('Edit .claudeboard/context.md to add your project brand guidelines and design tokens.');
