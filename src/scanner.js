// src/scanner.js
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claudeboard', 'dist', 'build',
  '.next', 'coverage', '.turbo', 'out', '.cache',
]);

const MAX_DEPTH = 3;
const MAX_ENTRIES_PER_DIR = 50;

function buildFileTree(dir, depth = 0, prefix = '') {
  if (depth >= MAX_DEPTH) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const filtered = entries
    .filter(e => !EXCLUDE_DIRS.has(e.name) && !e.name.startsWith('.'))
    .slice(0, MAX_ENTRIES_PER_DIR);

  const lines = [];
  filtered.forEach((entry, idx) => {
    const isLast = idx === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    lines.push(prefix + connector + entry.name + (entry.isDirectory() ? '/' : ''));

    if (entry.isDirectory()) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      lines.push(...buildFileTree(path.join(dir, entry.name), depth + 1, childPrefix));
    }
  });

  return lines;
}

function detectTechStack(pkgJson, projectDir) {
  const stack = [];

  if (pkgJson) {
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

    if (deps['next'])             stack.push('Next.js');
    else if (deps['react'])       stack.push('React');
    if (deps['vue'])              stack.push('Vue');
    if (deps['svelte'])           stack.push('Svelte');
    if (deps['@angular/core'])    stack.push('Angular');
    if (deps['express'])          stack.push('Express');
    if (deps['fastify'])          stack.push('Fastify');
    if (deps['koa'])              stack.push('Koa');
    if (deps['@nestjs/core'])     stack.push('NestJS');
    if (deps['typescript'] || deps['ts-node']) stack.push('TypeScript');
    if (deps['tailwindcss'])      stack.push('Tailwind CSS');
    if (deps['prisma'] || deps['@prisma/client']) stack.push('Prisma');
    if (deps['mongoose'])         stack.push('MongoDB/Mongoose');
    if (deps['sequelize'])        stack.push('Sequelize');
    if (deps['graphql'])          stack.push('GraphQL');
    if (deps['electron'])         stack.push('Electron');
    if (deps['jest'] || deps['vitest']) stack.push('Testing');
  }

  // Detect from files in root
  try {
    const files = fs.readdirSync(projectDir);
    if (files.some(f => f.endsWith('.py') || f === 'requirements.txt' || f === 'pyproject.toml'))
      stack.push('Python');
    if (files.some(f => f.endsWith('.rs') || f === 'Cargo.toml'))
      stack.push('Rust');
    if (files.some(f => f.endsWith('.go') || f === 'go.mod'))
      stack.push('Go');
    if (files.some(f => f.endsWith('.java') || f === 'pom.xml'))
      stack.push('Java');
    if (files.some(f => f === 'Gemfile'))
      stack.push('Ruby');
    if (files.some(f => f === 'composer.json'))
      stack.push('PHP');
  } catch { /* ignore */ }

  // Dedupe
  return [...new Set(stack)];
}

function scanProject() {
  const projectDir = process.cwd();

  // Check for existing PRD
  let existingPrd = null;
  try {
    const prdPath = path.join(projectDir, '.claudeboard', 'prd.md');
    if (fs.existsSync(prdPath)) {
      existingPrd = fs.readFileSync(prdPath, 'utf-8');
    }
  } catch { /* ignore */ }

  // Read package.json
  let pkgJson = null;
  let projectName = path.basename(projectDir);
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkgJson.name) projectName = pkgJson.name;
    }
  } catch { /* ignore */ }

  // Read README (cap at 3 KB)
  let readme = null;
  try {
    const readmePath = path.join(projectDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      readme = fs.readFileSync(readmePath, 'utf-8').slice(0, 3000);
    }
  } catch { /* ignore */ }

  // Read .claudeboard/context.md if present (cap at 8 KB)
  let contextMd = null;
  try {
    const contextPath = path.join(projectDir, '.claudeboard', 'context.md');
    if (fs.existsSync(contextPath)) {
      contextMd = fs.readFileSync(contextPath, 'utf-8').slice(0, 8000);
    }
  } catch { /* ignore */ }

  // Build file tree
  const treeLines = buildFileTree(projectDir);
  const fileTree = treeLines.join('\n') || '(empty directory)';

  // Detect tech stack
  const techStack = detectTechStack(pkgJson, projectDir);

  return {
    isNewProject: existingPrd === null,
    existingPrd,
    fileTree,
    techStack,
    projectName,
    readme,
    contextMd,
    pkgDescription: pkgJson?.description || null,
  };
}

module.exports = { scanProject };
