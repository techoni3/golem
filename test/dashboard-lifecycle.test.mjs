#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli', 'golem.js');
const serverEntry = path.join(repo, 'dashboard', 'server', 'index.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-dashboard-'));
const home = path.join(temp, 'home');
const golemHome = path.join(temp, 'golem');
const configHome = path.join(temp, 'config');
const projectsRoot = path.join(temp, 'projects');
const ideasRoot = path.join(temp, 'ideas');
const trackerDb = path.join(temp, 'tracker.db');
const children = new Set();
const originalEnv = { ...process.env };

fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(golemHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });
fs.mkdirSync(ideasRoot, { recursive: true });

const baseEnv = {
  ...process.env,
  HOME: home,
  GOLEM_HOME: golemHome,
  XDG_CONFIG_HOME: configHome,
  GOLEM_TRACKER_DB: trackerDb,
  GOLEM_PROJECTS_ROOT: projectsRoot,
  GOLEM_IDEAS_ROOT: ideasRoot,
  GOLEM_ROOT: repo,
  GOLEM_CHANNEL_URL: 'http://127.0.0.1:1',
  HOST: '127.0.0.1',
  GOLEM_CEO_LIVE_MS: '1000',
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function spawnDashboard(port, { args = [], env = {} } = {}) {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [serverEntry, ...args], {
    cwd: repo,
    env: { ...baseEnv, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.output = () => `${stdout}${stderr}`;
  child.once('exit', () => children.delete(child));
  return child;
}

function spawnUnrelatedNode() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: repo,
    env: baseEnv,
    stdio: 'ignore',
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForHealth(port, child = null, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`dashboard pid ${child.pid} exited with ${child.exitCode}: ${child.output?.() || ''}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dashboard port ${port} did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch {}
  try { await waitForExit(child, 5_000); } catch {
    try { child.kill('SIGKILL'); } catch {}
    await waitForExit(child, 2_000).catch(() => {});
  }
}

async function stopPid(pid) {
  if (!pid || pid === process.pid || !isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function readDashboardDoc() {
  return JSON.parse(fs.readFileSync(path.join(golemHome, 'dashboard.json'), 'utf8'));
}

async function isHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function runRestart(port) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [cli, 'dashboard:restart', '--port', String(port)], {
      cwd: repo,
      env: { ...baseEnv, PORT: '1', GOLEM_DASHBOARD_STARTUP_TIMEOUT_MS: '15000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const sharedDashboardWasHealthy = await isHealthy(7420);

try {
  // 1. A second server on the same port fails and names the process holding it.
  const occupiedPort = await freePort();
  const first = spawnDashboard(occupiedPort);
  await waitForHealth(occupiedPort, first);
  const second = spawnDashboard(occupiedPort);
  const secondExit = await waitForExit(second);
  assert.equal(secondExit.code, 1, second.output());
  assert.match(second.output(), new RegExp(`port ${occupiedPort} is already in use`));
  assert.match(second.output(), new RegExp(`pid ${first.pid}`), second.output());
  await waitForHealth(occupiedPort, first);
  const explicitPort = await freePort();
  const explicit = spawnDashboard(occupiedPort, { args: ['--port', String(explicitPort)] });
  await waitForHealth(explicitPort, explicit);
  assert.equal(isAlive(explicit.pid), true);
  console.log(JSON.stringify({
    port_conflict: 'second start refused',
    holder_pid: first.pid,
    second_exit: secondExit.code,
    explicit_port_override: explicitPort,
    one_server_healthy: true,
  }));
  await stopChild(explicit);
  await stopChild(first);

  // 2. Start a stray on another explicit port, then a recorded dashboard on the
  // restart port. The unrelated node process must survive the exact sweep.
  const strayPort = await freePort();
  const restartPort = await freePort();
  const stray = spawnDashboard(strayPort);
  await waitForHealth(strayPort, stray);
  const recorded = spawnDashboard(restartPort);
  await waitForHealth(restartPort, recorded);
  assert.equal(readDashboardDoc().pid, recorded.pid);
  const unrelated = spawnUnrelatedNode();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isAlive(unrelated.pid), true);

  const restart = await runRestart(restartPort);
  assert.equal(restart.code, 0, `${restart.stdout}\n${restart.stderr}`);
  assert.match(restart.stdout, new RegExp(`pid=${stray.pid}`), restart.stdout);
  assert.match(restart.stdout, new RegExp(`pid=${recorded.pid}`), restart.stdout);
  const restartedDoc = readDashboardDoc();
  await waitForHealth(restartPort);
  assert.notEqual(restartedDoc.pid, stray.pid);
  assert.notEqual(restartedDoc.pid, recorded.pid);
  assert.equal(isAlive(stray.pid), false);
  assert.equal(isAlive(recorded.pid), false);
  assert.equal(isAlive(unrelated.pid), true, 'unrelated node process must survive the dashboard sweep');
  if (sharedDashboardWasHealthy) assert.equal(await isHealthy(7420), true, 'the shared dashboard must not be swept');
  console.log(JSON.stringify({
    restart_sweep: 'recorded and stray dashboard processes stopped',
    stopped_pids: [recorded.pid, stray.pid],
    restarted_pid: restartedDoc.pid,
    unrelated_pid_survived: unrelated.pid,
    restart_healthy: true,
  }));
} finally {
  for (const child of [...children]) await stopChild(child);
  try {
    const doc = readDashboardDoc();
    await stopPid(doc.pid);
  } catch {}
  Object.assign(process.env, originalEnv);
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Dashboard lifecycle journey passed: taken-port refusal, exact pid reporting, stray sweep, explicit alternate ports, and unrelated-node preservation');
