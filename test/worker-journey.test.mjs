#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-t2-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const registrationDir = path.join(temp, 'registrations');
const lockState = path.join(temp, 'lock-state');
const socket = `golemtest-t2-${process.pid}`;
const projectId = projectIdFor(project);
const originalEnv = {};
const envKeys = [
  'GOLEM_HOME', 'HOME', 'PATH', 'GOLEM_DASHBOARD_URL', 'GOLEM_TMUX_SOCKET',
  'GOLEM_TEST_REGISTRATION_DIR', 'GOLEM_TEST_PROJECT_ID', 'GOLEM_WORKER_READY_TIMEOUT_MS',
  'GOLEM_WORKER_POLL_MS', 'GOLEM_WORKER_REQUEST_TIMEOUT_MS', 'GOLEM_TMUX_BIN',
  'GOLEM_TMUX_CAPTURE', 'GOLEM_FAKE_NO_REGISTER', 'GOLEM_TEST_SELF_KILL_TRIGGER', 'GOLEM_TEST_CLI',
  'XDG_CONFIG_HOME',
];
for (const key of envKeys) originalEnv[key] = process.env[key];

fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(registrationDir, { recursive: true });
fs.mkdirSync(lockState, { recursive: true });
fs.mkdirSync(path.join(state, 'renders', 'pi'), { recursive: true });
fs.writeFileSync(path.join(state, 'renders', 'pi', 'golem.ts'), '// test bridge placeholder\n');

const fakePi = path.join(bin, 'pi');
fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
const nameIndex = args.indexOf('--name');
const name = nameIndex >= 0 ? args[nameIndex + 1] : null;
if (!name) process.exit(17);
const registrationDir = process.env.GOLEM_TEST_REGISTRATION_DIR;
if (process.env.GOLEM_FAKE_NO_REGISTER !== '1') {
  fs.writeFileSync(path.join(registrationDir, name + '.json'), JSON.stringify({
    session_id: 'golemtest-t2-session-' + name,
    name,
    role: null,
    harness: 'pi',
    project_id: process.env.GOLEM_TEST_PROJECT_ID,
    status: 'idle',
  }));
}
const selfKillTrigger = process.env.GOLEM_TEST_SELF_KILL_TRIGGER;
const selfKillResult = selfKillTrigger ? selfKillTrigger + '.result' : null;
let selfKillStarted = false;
function runSelfKill() {
  if (!selfKillTrigger || selfKillStarted || fs.existsSync(selfKillResult) || !fs.existsSync(selfKillTrigger)) return;
  selfKillStarted = true;
  const env = { ...process.env };
  for (const key of ['GOLEM_CALLER_SESSION_ID', 'GOLEM_CEO_SESSION_ID', 'GOLEM_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'PI_SESSION_ID']) delete env[key];
  const result = spawnSync(process.execPath, [process.env.GOLEM_TEST_CLI, 'kill', name], {
    cwd: process.cwd(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.writeFileSync(selfKillResult, JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
}
process.stdout.write('[golemtest-t2 worker ' + name + '] ready\\n');
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
setInterval(runSelfKill, 25);
setInterval(() => {}, 1000);
`, { mode: 0o700 });

Object.assign(process.env, {
  GOLEM_HOME: state,
  HOME: path.join(temp, 'home'),
  PATH: `${bin}${path.delimiter}${originalEnv.PATH ?? ''}`,
  GOLEM_TMUX_SOCKET: socket,
  GOLEM_TEST_REGISTRATION_DIR: registrationDir,
  GOLEM_TEST_PROJECT_ID: projectId,
  GOLEM_TEST_CLI: cli,
  GOLEM_WORKER_READY_TIMEOUT_MS: '1200',
  GOLEM_WORKER_POLL_MS: '50',
  GOLEM_WORKER_REQUEST_TIMEOUT_MS: '500',
  XDG_CONFIG_HOME: path.join(temp, 'xdg'),
});

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

let server;
let recycled;

function dashboardRows() {
  const assignments = dashboardRows.assignments ?? new Map();
  let rows = [];
  for (const file of fs.readdirSync(registrationDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(registrationDir, file), 'utf8'));
      rows.push({ ...row, role: assignments.get(row.session_id) ?? row.role });
    } catch {}
  }
  return rows;
}
dashboardRows.assignments = new Map();

async function startDashboard() {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/health') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/sessions/dispatchable' && request.method === 'GET') {
      const wanted = url.searchParams.get('project');
      response.end(JSON.stringify(dashboardRows().filter((row) => !wanted || row.project_id === wanted)));
      return;
    }
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/role$/);
    if (match && request.method === 'POST') {
      const body = JSON.parse(await readBody(request) || '{}');
      dashboardRows.assignments.set(decodeURIComponent(match[1]), body.role ?? null);
      response.end(JSON.stringify({ ok: true, saved: true }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GOLEM_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function claimChild() {
  const moduleUrl = pathToFileURL(path.join(repo, 'lib', 'worker-registry.js')).href;
  const code = `import { claimWorker } from ${JSON.stringify(moduleUrl)};
const row = claimWorker({ role: 'golemtest-t2', projectId: 'lock-project', preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null } });
console.log(row.name);`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: repo,
      env: { ...process.env, GOLEM_HOME: lockState },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (codeValue, signal) => resolve({ code: codeValue, signal, stdout: stdout.trim(), stderr }));
  });
}

try {
  await startDashboard();
  const { createRole, readRoleRegistry } = await import('../lib/session-role.js');
  const { claimWorker, readWorkers, updateWorker } = await import('../lib/worker-registry.js');
  const {
    killWorker,
    listWorkerViews,
    peekWorker,
    spawnWorker,
  } = await import('../lib/worker-manager.js');
  const {
    hasSession,
    killSession,
    processIdsInGroup,
  } = await import('../lib/tmux-driver.js');

  createRole({
    name: 'golemtest-t2',
    exec: {
      harness: 'pi',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:0731',
      thinking: 'medium',
      name: null,
    },
  });
  assert.ok(readRoleRegistry().some((row) => row.name === 'golemtest-t2'));

  const claimed = await Promise.all(Array.from({ length: 5 }, () => claimChild()));
  assert.ok(claimed.every((result) => result.code === 0), JSON.stringify(claimed));
  const claimedNames = claimed.map((result) => result.stdout);
  assert.equal(new Set(claimedNames).size, 5, JSON.stringify(claimedNames));
  assert.deepEqual(readWorkers({ file: path.join(lockState, 'workers.json') }).map((row) => row.name).sort(), claimedNames.slice().sort());
  console.log(JSON.stringify({ lock_claims: claimedNames.sort() }));

  const cliSpawn = await runCli(['spawn', 'golemtest-t2', '--name', 'golemtest-t2-cli', '--project', project]);
  assert.equal(cliSpawn.status, 0, cliSpawn.stderr);
  const cliSpawned = JSON.parse(cliSpawn.stdout);
  assert.equal(cliSpawned.state, 'live');
  assert.equal(cliSpawned.name, 'golemtest-t2-cli');

  const spawned = await Promise.all(Array.from({ length: 5 }, () => spawnWorker({ role: 'golemtest-t2', project })));
  const names = spawned.map((worker) => worker.name);
  const tmuxNames = spawned.map((worker) => worker.tmux_session);
  assert.equal(new Set(names).size, 5, JSON.stringify(names));
  assert.equal(new Set(tmuxNames).size, 5, JSON.stringify(tmuxNames));
  assert.ok(spawned.every((worker) => worker.state === 'live' && worker.dispatchable));
  console.log(JSON.stringify({ parallel_workers: names.sort(), tmux_sessions: tmuxNames.sort() }));

  const directListed = await listWorkerViews({ project });
  assert.ok(directListed.every((worker) => worker.dispatchable));
  const cliList = await runCli(['list', '--project', project]);
  assert.equal(cliList.status, 0, cliList.stderr);
  const listed = JSON.parse(cliList.stdout);
  assert.equal(listed.length, 6);
  assert.ok(listed.every((worker) => worker.dispatchable && worker.model === 'deepseek-v4-flash:0731'));
  console.log(JSON.stringify({ cli_list_count: listed.length, statuses: listed.map((worker) => worker.status).sort() }));

  const cliPeek = await runCli(['peek', names[0], '--project', project, '--lines', '3']);
  assert.equal(cliPeek.status, 0, cliPeek.stderr);
  assert.match(cliPeek.stdout, /golemtest-t2 worker/);
  assert.equal(hasSession(names[0]), true);
  console.log(JSON.stringify({ peek_name: names[0], peek_contains_ready: true }));

  const selfKill = await assert.rejects(
    () => killWorker(names[1], { projectId, callerId: spawned[1].session_id }),
    /refusing to kill the caller's own session/,
  );
  assert.equal(selfKill, undefined);
  assert.equal(hasSession(names[1]), true);
  console.log(JSON.stringify({ self_kill: 'refused', target_preserved: true }));

  const cliKill = await runCli(['kill', names[0], '--project', project]);
  assert.equal(cliKill.status, 0, cliKill.stderr);
  const killedByCli = JSON.parse(cliKill.stdout);
  assert.equal(killedByCli.state, 'dead');
  assert.deepEqual(processIdsInGroup(spawned[0].pid), []);
  assert.equal(hasSession(names[0]), false);
  console.log(JSON.stringify({ cli_kill: names[0], state: killedByCli.state, survivors: processIdsInGroup(spawned[0].pid) }));

  for (const worker of spawned.slice(1)) {
    const killed = await killWorker(worker.name, { projectId });
    assert.equal(killed.state, 'dead');
    assert.deepEqual(processIdsInGroup(worker.pid), []);
    assert.equal(hasSession(worker.name), false);
  }
  const cliKilled = await killWorker(cliSpawned.name, { projectId });
  assert.equal(cliKilled.state, 'dead');
  assert.deepEqual(processIdsInGroup(cliSpawned.pid), []);
  assert.equal(hasSession(cliSpawned.name), false);
  console.log(JSON.stringify({ teardown: 'all six worker process groups empty', survivors: [] }));

  const recycledDead = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: project,
    detached: true,
    stdio: 'ignore',
  });
  recycled = recycledDead;
  await new Promise((resolve, reject) => {
    recycledDead.once('spawn', resolve);
    recycledDead.once('error', reject);
  });
  assert.ok(recycledDead.pid > 0);
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid));
  const deadClaim = claimWorker({
    role: 'golemtest-t2',
    projectId,
    projectRoot: project,
    cwd: project,
    name: 'golemtest-t2-dead',
    preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null },
  });
  updateWorker(deadClaim.worker_id, {
    state: 'dead',
    pid: recycledDead.pid,
    session_id: 'golemtest-t2-session-dead',
  });
  const deadKillProbe = path.join(temp, 'golemtest-t2-dead-kill-called');
  const deadTmux = path.join(bin, 'golemtest-t2-dead-tmux');
  fs.writeFileSync(deadTmux, `#!/bin/sh
printf 'called\\n' > ${JSON.stringify(deadKillProbe)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = deadTmux;
  const deadResult = await killWorker(deadClaim.name, { projectId });
  assert.equal(deadResult.state, 'dead');
  assert.equal(fs.existsSync(deadKillProbe), false, 'dead rows must not invoke tmux or process teardown');
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid));
  delete process.env.GOLEM_TMUX_BIN;

  const staleClaim = claimWorker({
    role: 'golemtest-t2',
    projectId,
    projectRoot: project,
    cwd: project,
    name: 'golemtest-t2-stale',
    preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null },
  });
  updateWorker(staleClaim.worker_id, {
    state: 'failed',
    pid: recycledDead.pid,
    session_id: 'golemtest-t2-session-stale',
  });
  const staleResult = await killWorker(staleClaim.name, { projectId });
  assert.equal(staleResult.state, 'dead');
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid), 'recycled unrelated pgid must not be signalled');
  console.log(JSON.stringify({ stale_pgid: recycledDead.pid, stale_kill: 'no signal', unrelated_group_alive: true }));
  recycledDead.kill('SIGTERM');
  await new Promise((resolve) => recycledDead.once('exit', resolve));
  recycled = null;

  const missingSocketTmux = path.join(bin, 'golemtest-t2-missing-socket-tmux');
  fs.writeFileSync(missingSocketTmux, `#!/bin/sh
echo 'error connecting to golem socket (No such file or directory)' >&2
exit 1
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = missingSocketTmux;
  assert.equal(killSession('golemtest-t2-missing-socket'), false);
  delete process.env.GOLEM_TMUX_BIN;
  console.log(JSON.stringify({ missing_socket: 'treated as already stopped' }));

  const fakeTmux = path.join(bin, 'golemtest-t2-tmux');
  const attachCapture = path.join(temp, 'golemtest-t2-attach-argv.txt');
  fs.writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(attachCapture)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = fakeTmux;
  process.env.GOLEM_TMUX_CAPTURE = attachCapture;
  const cliAttach = await runCli(['attach', cliSpawned.name, '--project', project]);
  assert.equal(cliAttach.status, 0, cliAttach.stderr);
  const attachArgs = fs.readFileSync(attachCapture, 'utf8').trim().split('\n');
  assert.deepEqual(attachArgs.slice(0, 2), ['-L', socket]);
  assert.equal(attachArgs[2], '-f');
  assert.equal(attachArgs[3], path.join(repo, 'lib', 'golem-tmux.conf'));
  assert.deepEqual(attachArgs.slice(-3), ['attach-session', '-t', cliSpawned.name]);
  delete process.env.GOLEM_TMUX_BIN;
  delete process.env.GOLEM_TMUX_CAPTURE;
  console.log(JSON.stringify({ cli_attach: cliSpawned.name, attached_without_mutation: true }));

  process.env.GOLEM_FAKE_NO_REGISTER = '1';
  process.env.GOLEM_WORKER_READY_TIMEOUT_MS = '250';
  const failedName = 'golemtest-t2-failed';
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: failedName, project }),
    /did not become dispatchable within/,
  );
  const failed = readWorkers().find((worker) => worker.name === failedName);
  assert.equal(failed.state, 'failed');
  assert.equal(hasSession(failedName), true);
  assert.match(await peekWorker(failedName, { projectId, lines: 3 }), /golemtest-t2 worker/);
  console.log(JSON.stringify({ failed_spawn: failedName, state: failed.state, tmux_left_for_peek: true }));
  await killWorker(failedName, { projectId });
  assert.deepEqual(processIdsInGroup(failed.pid), []);
  assert.equal(hasSession(failedName), false);

  delete process.env.GOLEM_FAKE_NO_REGISTER;
  process.env.GOLEM_WORKER_READY_TIMEOUT_MS = '1200';
  const selfKillTrigger = path.join(temp, 'golemtest-t2-self-kill-trigger');
  process.env.GOLEM_TEST_SELF_KILL_TRIGGER = selfKillTrigger;
  const selfWorker = await spawnWorker({ role: 'golemtest-t2', name: 'golemtest-t2-self', project });
  const selfKillResult = selfKillTrigger + '.result';
  fs.writeFileSync(selfKillTrigger, 'run\n');
  await waitForFile(selfKillResult);
  const selfAttempt = JSON.parse(fs.readFileSync(selfKillResult, 'utf8'));
  assert.notEqual(selfAttempt.status, 0, JSON.stringify(selfAttempt));
  assert.match(`${selfAttempt.stdout || ''}${selfAttempt.stderr || ''}`, /refusing to kill the caller's own session/, JSON.stringify(selfAttempt));
  assert.equal(hasSession(selfWorker.name), true);
  assert.ok(processIdsInGroup(selfWorker.pid).length > 0);
  console.log(JSON.stringify({ self_kill_without_env: 'refused', target_preserved: true }));
  await killWorker(selfWorker.name, { projectId, callerId: null });
  assert.deepEqual(processIdsInGroup(selfWorker.pid), []);
  assert.equal(hasSession(selfWorker.name), false);
  delete process.env.GOLEM_TEST_SELF_KILL_TRIGGER;

  console.log('Worker journey passed: locked naming, detached tmux workers, dispatchable readiness, list/peek/kill, attach argv, stale-pgid guard, no-env self-kill guard, missing-socket handling, failed inspection, and zero-survivor teardown');
} finally {
  if (recycled && recycled.exitCode === null) {
    try {
      recycled.kill('SIGKILL');
      await new Promise((resolve) => recycled.once('exit', resolve));
    } catch {}
  }
  recycled = null;
  delete process.env.GOLEM_TMUX_BIN;
  delete process.env.GOLEM_TMUX_CAPTURE;
  const { killWorker: cleanupKill } = await import('../lib/worker-manager.js').catch(() => ({ killWorker: null }));
  if (cleanupKill) {
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(state, 'workers.json'), 'utf8')).workers || [];
      for (const row of rows.filter((worker) => ['spawning', 'live', 'failed'].includes(worker.state))) {
        await cleanupKill(row.name, { projectId, callerId: null }).catch(() => {});
      }
    } catch {}
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
