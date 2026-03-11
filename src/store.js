// src/store.js
const fs = require('fs');
const path = require('path');

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB — hard cap on stored agent output

function getBoardDir() {
  // Always relative to process.cwd() — never a system directory
  return path.join(process.cwd(), '.claudeboard');
}

function ensureDir() {
  const dir = getBoardDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJSON(filename, defaultVal = []) {
  const dir = ensureDir();
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return defaultVal;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return defaultVal; }
}

function writeJSON(filename, data) {
  const dir = ensureDir();
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

// Tasks CRUD
function getTasks() { return readJSON('tasks.json', []); }
function saveTasks(tasks) { writeJSON('tasks.json', tasks); }

function createTask(task) {
  const tasks = getTasks();
  const newTask = {
    id: Date.now().toString(),
    title: String(task.title || 'Untitled').slice(0, 200),
    description: String(task.description || '').slice(0, 2000),
    successCriteria: String(task.successCriteria || '').slice(0, 1000),
    priority: task.priority || 'medium',
    status: 'backlog',
    agentId: null,
    output: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(newTask);
  saveTasks(tasks);
  return newTask;
}

function updateTask(id, updates) {
  const tasks = getTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;

  // Enforce 1 MB cap on stored output
  if (typeof updates.output === 'string' && Buffer.byteLength(updates.output, 'utf-8') > MAX_OUTPUT_BYTES) {
    updates.output = updates.output.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated at 1 MB]';
  }

  tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() };
  saveTasks(tasks);
  return tasks[idx];
}

function getTask(id) { return getTasks().find(t => t.id === id) || null; }

// Agents CRUD
function getAgents() { return readJSON('agents.json', []); }
function saveAgents(agents) { writeJSON('agents.json', agents); }

function createAgent(agent) {
  const agents = getAgents();
  const newAgent = { id: Date.now().toString(), ...agent, createdAt: new Date().toISOString() };
  agents.push(newAgent);
  saveAgents(agents);
  return newAgent;
}

function updateAgent(id, updates) {
  const agents = getAgents();
  const idx = agents.findIndex(a => a.id === id);
  if (idx === -1) return null;
  agents[idx] = { ...agents[idx], ...updates };
  saveAgents(agents);
  return agents[idx];
}

function removeAgent(id) {
  saveAgents(getAgents().filter(a => a.id !== id));
}

// Config — read-only from code; write only via CLI flags at startup
function getConfig() { return readJSON('config.json', {}); }
function setConfig(updates) {
  const config = getConfig();
  const newConfig = { ...config, ...updates };
  writeJSON('config.json', newConfig);
  return newConfig;
}

// PRD
function savePRD(content) {
  const dir = ensureDir();
  fs.writeFileSync(path.join(dir, 'prd.md'), String(content).slice(0, 500 * 1024)); // cap at 500 KB
}
function getPRD() {
  const dir = ensureDir();
  const p = path.join(dir, 'prd.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

module.exports = {
  getTasks, saveTasks, createTask, updateTask, getTask,
  getAgents, createAgent, updateAgent, removeAgent,
  getConfig, setConfig,
  savePRD, getPRD,
};
