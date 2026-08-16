#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectIdFor } from '../../lib/project-id.js';
import { readWorkers, claimWorker, updateWorker } from '../../lib/worker-registry.js';
import { killWorker } from '../../lib/worker-manager.js';
import { processIdsInGroup, hasSession } from '../../lib/tmux-driver.js';
import { resolveRoleExecution } from '../../lib/role-preset.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboard = path.join(repo, 'dashboard/server/index.js');
const channel = path.join(repo, 'mcp/channel/index.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-t3-'));
const home = path.join(temp, 'home');
const config = path.join(temp, 'config');
const golemHome = path.join(config, 'golem');
const project = path.join(temp, 'project');
const projectsRoot = path.join(temp, 'projects');
const bin = path.join(temp, 'bin');
const fakeWorker = path.join(bin, 'golemtest-t3-worker.mjs');
const db = path.join(temp, 'tracker.db');
const socket = `golemtest-t3-${process.pid}`;
const callerId = 'golemtest-t3-caller';
const originalEnv = { ...process.env };
let dashboardChild;
let client;
let transport;
let workerName = null;

fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(golemHome, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(project, '.git'), { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
const projectRoot = fs.realpathSync(project);
const projectId = projectIdFor(projectRoot);
fs.writeFileSync(path.join(golemHome, 'projects.json'), JSON.stringify({
  version: 1,
  projects: [{ id: 'golemtest-t3-project', name: 'golemtest-t3-project', path: projectRoot }],
}, null, 2));

// This is a real process in a real tmux pty. It publishes the minimum
// authenticated session-facts/lease surface that a Pi process publishes, and
// accepts the dashboard's role/brief routes so the MCP journey can dispatch to
// it without touching a human session.
fs.writeFileSync(fakeWorker, `#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const home = process.env.GOLEM_HOME;
const name = process.argv[process.argv.indexOf('--name') + 1];
const role = process.argv[process.argv.indexOf('--role') + 1];
const shouldRegister = name !== 'golemtest-t3-timeout';
const sessionId = 'golemtest-t3-worker-' + process.pid;
const ownerToken = 'golemtest-t3-owner-' + process.pid;
const factsFile = path.join(home, 'session-facts.json');
const leasesFile = path.join(home, 'endpoint-leases.json');
const projectPath = process.env.GOLEM_TEST_PROJECT_PATH || process.cwd();
let server;
let stopping = false;

function readRegistry(file, key) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && Array.isArray(value[key])) return { version: 1, [key]: value[key] };
  } catch {}
  return { version: 1, [key]: [] };
}
function writeRegistry(file, value) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function put(file, key, row) {
  const registry = readRegistry(file, key);
  registry[key] = registry[key].filter((entry) => entry.canonical_id !== row.canonical_id);
  registry[key].push(row);
  writeRegistry(file, registry);
}
function remove(file, key) {
  const registry = readRegistry(file, key);
  registry[key] = registry[key].filter((entry) => entry.canonical_id !== sessionId);
  writeRegistry(file, registry);
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => resolve(text));
  });
}
async function stop() {
  if (stopping) return;
  stopping = true;
  remove(factsFile, 'facts');
  remove(leasesFile, 'leases');
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.once(signal, stop);

server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/healthz') {
    return json(res, 200, { canonical_id: sessionId, owner_token: ownerToken, consumer_ready: true, delivery_ready: true });
  }
  if (req.method === 'POST' && ['/role', '/brief', '/push'].includes(url.pathname)) {
    await readBody(req);
    return json(res, 202, { ok: true, session_id: sessionId });
  }
  return json(res, 404, { error: 'not found' });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  if (!shouldRegister) return;
  const now = new Date().toISOString();
  put(factsFile, 'facts', {
    canonical_id: sessionId,
    harness: 'pi',
    locator: { raw_session_id: sessionId },
    continuation_key: sessionId,
    project_path: projectPath,
    name,
    role,
    status: 'idle',
    model: 'deepseek-v4-flash:0731',
    provider: 'ollama-cloud',
    observed_at: now,
    revision: 1,
  });
  put(leasesFile, 'leases', {
    canonical_id: sessionId,
    owner_token: ownerToken,
    host: '127.0.0.1',
    port,
    pid: process.pid,
    harness: 'pi',
    kind: 'worker-test',
    consumer_ready: true,
    delivery_ready: true,
    renewed_at: now,
    expires_at: new Date(Date.now() + 45_000).toISOString(),
  });
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDashboard(timeoutMs = 15000) {
  const file = path.join(golemHome, 'dashboard.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc.url) {
        const response = await fetch(`${doc.url}/api/tickets`);
        if (response.ok) return doc;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('dashboard did not become ready');
}

function toolText(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = toolText(result);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { result, text, json };
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

try {
  const port = await availablePort();
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    GOLEM_HOME: golemHome,
    GOLEM_TRACKER_DB: db,
    GOLEM_PROJECTS_ROOT: projectsRoot,
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  };
  Object.assign(process.env, {
    ...env,
    GOLEM_WORKER_CLI: fakeWorker,
    GOLEM_TEST_PROJECT_PATH: projectRoot,
    GOLEM_TMUX_SOCKET: socket,
    GOLEM_WORKER_READY_TIMEOUT_MS: '1500',
    GOLEM_WORKER_POLL_MS: '100',
    GOLEM_WORKER_REQUEST_TIMEOUT_MS: '1000',
  });

  dashboardChild = spawn(process.execPath, [dashboard], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  dashboardChild.stderr.on('data', (chunk) => process.stderr.write(`[t3-dashboard] ${chunk}`));
  const dashboardDoc = await waitForDashboard();

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [channel],
    cwd: repo,
    env: {
      ...env,
      GOLEM_CEO_SESSION_ID: callerId,
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      GOLEM_WORKER_CLI: fakeWorker,
      GOLEM_TMUX_SOCKET: socket,
      GOLEM_WORKER_READY_TIMEOUT_MS: '1500',
      GOLEM_WORKER_POLL_MS: '100',
      GOLEM_WORKER_REQUEST_TIMEOUT_MS: '1000',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'golemtest-t3-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const listedTools = await client.listTools();
  const toolNames = new Set(listedTools.tools.map((tool) => tool.name));
  assert.equal(toolNames.has('session_spawn'), true, 'session_spawn is registered');
  assert.equal(toolNames.has('session_kill'), true, 'session_kill is registered');
  assert.equal(toolNames.has('sessions_dispatchable'), true, 'existing dispatchable tool remains registered');

  const unknownRole = await callTool('session_spawn', { role: 'golemtest-t3-unknown' });
  assert.equal(unknownRole.result.isError, true, unknownRole.text);
  assert.equal(unknownRole.json.code, 'GOLEM_UNKNOWN_ROLE');
  assert.equal(unknownRole.json.retryable, false);
  assert.match(unknownRole.json.message, /unknown role/);

  const timeoutSpawn = await callTool('session_spawn', {
    role: 'explorer', project: projectRoot, name: 'golemtest-t3-timeout',
  });
  assert.equal(timeoutSpawn.result.isError, true, timeoutSpawn.text);
  assert.equal(timeoutSpawn.json.code, 'GOLEM_WORKER_TIMEOUT');
  assert.match(timeoutSpawn.json.message, /did not become dispatchable/);
  const timeoutKill = await callTool('session_kill', { name: 'golemtest-t3-timeout' });
  assert.equal(timeoutKill.result.isError, undefined, timeoutKill.text);
  assert.equal(timeoutKill.json.state, 'dead');

  const spawned = await callTool('session_spawn', {
    role: 'explorer', project: projectRoot, name: 'golemtest-t3-worker',
  });
  assert.equal(spawned.result.isError, undefined, spawned.text);
  assert.equal(spawned.json.name, 'golemtest-t3-worker');
  assert.match(spawned.json.session_id, /^golemtest-t3-worker-/);
  assert.equal(spawned.json.role, 'explorer');
  assert.equal(spawned.json.model, 'deepseek-v4-flash:0731');
  assert.equal(spawned.json.attach_hint, 'golem attach golemtest-t3-worker');
  workerName = spawned.json.name;

  const dispatchable = await callTool('sessions_dispatchable', { project: projectId });
  assert.equal(dispatchable.result.isError, undefined, dispatchable.text);
  const workerRow = dispatchable.json.find((row) => row.session_id === spawned.json.session_id);
  assert.ok(workerRow, 'spawned worker appears in sessions_dispatchable');
  assert.equal(workerRow.worker_tmux_session, workerName);
  assert.equal(workerRow.worker_state, 'live');
  assert.equal(workerRow.worker_attach_hint, `golem attach ${workerName}`);
  assert.equal(workerRow.worker?.tmux_session, workerName);

  const ticket = await callTool('ticket_create', {
    project: projectId,
    title: 'golemtest-t3 dispatch journey',
    body: 'The MCP worker journey must dispatch to the spawned worker.',
    kind: 'task',
  });
  assert.equal(ticket.result.isError, undefined, ticket.text);
  const dispatched = await callTool('ticket_dispatch', {
    id: ticket.json.display_id || ticket.json.id,
    session_id: spawned.json.session_id,
    note: 'golemtest-t3 dispatch',
  });
  assert.equal(dispatched.result.isError, undefined, dispatched.text);

  const selfClaim = claimWorker({
    role: 'explorer', projectId, projectRoot, cwd: projectRoot,
    name: 'golemtest-t3-self', preset: resolveRoleExecution('explorer'),
  });
  updateWorker(selfClaim.worker_id, { session_id: callerId, state: 'live' });
  const spoofedSelfKill = await callTool('session_kill', {
    name: 'golemtest-t3-self',
    __golem_session_id: 'golemtest-t3-spoofed-caller',
  });
  assert.equal(spoofedSelfKill.result.isError, true, spoofedSelfKill.text);
  assert.match(spoofedSelfKill.text, /injected caller identity conflicts with the launcher binding/);
  assert.equal(readWorkers().find((row) => row.name === 'golemtest-t3-self')?.state, 'live');

  const selfKill = await callTool('session_kill', { name: 'golemtest-t3-self' });
  assert.equal(selfKill.result.isError, true, selfKill.text);
  assert.equal(selfKill.json.code, 'GOLEM_WORKER_SELF_KILL');
  assert.match(selfKill.json.message, /caller's own session/);
  assert.equal(readWorkers().find((row) => row.name === 'golemtest-t3-self')?.state, 'live');

  const killed = await callTool('session_kill', { name: workerName });
  assert.equal(killed.result.isError, undefined, killed.text);
  assert.equal(killed.json.state, 'dead');
  assert.deepEqual(killed.json.survivors, []);
  assert.deepEqual(processIdsInGroup(spawned.json.pid), []);
  assert.equal(hasSession(workerName), false);
  const afterKill = await callTool('sessions_dispatchable', { project: projectId });
  assert.equal(afterKill.json.some((row) => row.session_id === spawned.json.session_id), false);

  console.log(JSON.stringify({
    contracts: ['session_spawn', 'session_kill', 'sessions_dispatchable'],
    spawned: {
      name: spawned.json.name,
      session_id: spawned.json.session_id,
      role: spawned.json.role,
      model: spawned.json.model,
      attach_hint: spawned.json.attach_hint,
    },
    dispatchable_worker_fields: {
      worker_tmux_session: workerRow.worker_tmux_session,
      worker_state: workerRow.worker_state,
      worker_attach_hint: workerRow.worker_attach_hint,
    },
    dispatched: true,
    self_kill: selfKill.json.code,
    killed: { state: killed.json.state, survivors: killed.json.survivors },
    dashboard: dashboardDoc.url,
  }));
} finally {
  if (client) await client.close().catch(() => {});
  if (transport) await transport.close().catch(() => {});
  for (const row of readWorkers()) {
    if (!/^golemtest-t3-/.test(row.name)) continue;
    try {
      if (row.state !== 'dead') await killWorker(row.name, { callerId: 'golemtest-t3-cleanup' });
    } catch {}
  }
  await stopChild(dashboardChild);
  fs.rmSync(temp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
}
