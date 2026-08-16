#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(base, child, logs) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`dashboard exited before health check (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // The server may still be loading its tracker and project state.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dashboard health timeout\n${logs.join('')}`);
}

async function request(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const port = await freePort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-gol-197-home-'));
const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-gol-197-projects-'));
const ideas = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-gol-197-ideas-'));
const logs = [];
const child = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    GOLEM_HOME: home,
    GOLEM_PROJECTS_ROOT: projects,
    GOLEM_IDEAS_ROOT: ideas,
    GOLEM_ROOT: repoRoot,
    GOLEM_CHANNEL_URL: 'http://127.0.0.1:9',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => logs.push(String(chunk)));
child.stderr.on('data', (chunk) => logs.push(String(chunk)));

const base = `http://127.0.0.1:${port}`;
try {
  await waitForHealth(base, child, logs);

  const listed = await request(base, 'GET', '/api/roles');
  assert.equal(listed.status, 200);
  const explorer = listed.payload.find((role) => role.name === 'explorer');
  assert.deepEqual(Object.keys(explorer.exec).sort(), ['harness', 'model', 'name', 'provider', 'thinking']);

  const invalid = await request(base, 'PUT', '/api/roles/explorer', { exec: { thinking: 'invalid' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.payload.error, /invalid role preset for "explorer": thinking must be one of/);
  const afterInvalid = await request(base, 'GET', '/api/roles');
  assert.equal(afterInvalid.payload.find((role) => role.name === 'explorer').exec.thinking, 'medium');

  const saved = await request(base, 'PUT', '/api/roles/explorer', {
    exec: { model: 'dashboard-roundtrip', thinking: 'high' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.exec.model, 'dashboard-roundtrip');
  assert.equal(saved.payload.exec.thinking, 'high');
  const afterSave = await request(base, 'GET', '/api/roles');
  assert.equal(afterSave.payload.find((role) => role.name === 'explorer').exec.model, 'dashboard-roundtrip');

  const original = afterSave.payload.find((role) => role.name === 'explorer');
  const builtin = await request(base, 'PUT', '/api/roles/explorer', {
    color: '#000000',
    glyph: 'XX',
    exec: { thinking: 'medium' },
  });
  assert.equal(builtin.status, 200);
  assert.equal(builtin.payload.color, original.color);
  assert.equal(builtin.payload.glyph, original.glyph);

  const deletedBuiltin = await request(base, 'DELETE', '/api/roles/explorer');
  assert.equal(deletedBuiltin.status, 409);
  assert.match(deletedBuiltin.payload.error, /cannot delete builtin role/);

  const created = await request(base, 'POST', '/api/roles', {
    name: 'dashboard-test',
    exec: { provider: 'test-provider', model: 'test-model', thinking: 'low' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.exec.harness, 'pi');
  assert.equal(created.payload.exec.thinking, 'low');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'GET lists complete execution presets',
      'invalid preset is readable, rejected, and not persisted',
      'valid preset round-trips through PUT and GET',
      'builtin identity remains fixed and builtin delete returns 409',
      'POST creates a validated preset with defaults',
    ],
  }, null, 2));
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projects, { recursive: true, force: true });
  fs.rmSync(ideas, { recursive: true, force: true });
}
