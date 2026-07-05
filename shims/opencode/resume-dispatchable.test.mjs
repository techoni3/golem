#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-oc-resume-'));
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# test project\n');
process.env.GOLEM_HOME = path.join(tmp, 'golem-home');

const shimUrl = pathToFileURL(path.resolve('shims/opencode/index.js')).href + `?t=${Date.now()}`;
const nativeUrl = pathToFileURL(path.resolve('dashboard/server/native-sessions.js')).href + `?t=${Date.now()}`;
const { default: opencodeShim } = await import(shimUrl);
const { readNativeSessions } = await import(nativeUrl);

const resumed = {
  id: 'ses_resume_dispatchable',
  directory: projectDir,
  title: 'Resumed dispatchable session',
  time: { created: Date.now() - 10_000, updated: Date.now() },
};
const stale = {
  id: 'ses_old_not_loaded',
  directory: projectDir,
  title: 'Old stored session',
  time: { created: Date.now() - 20_000, updated: Date.now() - 20_000 },
};
const staleHistoryOnly = {
  id: 'ses_history_not_resurrected',
  directory: projectDir,
  title: 'Days-old stored session',
  time: { created: Date.now() - 10 * 24 * 60 * 60 * 1000, updated: Date.now() - 10 * 24 * 60 * 60 * 1000 },
};
const child = {
  id: 'ses_child_ignored',
  parentID: resumed.id,
  directory: projectDir,
  title: 'Child session',
  time: { created: Date.now(), updated: Date.now() },
};

await opencodeShim({
  directory: projectDir,
  client: {
    session: {
      list: async () => ({ data: [stale, resumed, child] }),
      status: async () => ({ data: { [resumed.id]: { type: 'idle' } } }),
      prompt: async () => ({ data: {} }),
    },
  },
});

async function eventually(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { return fn(); }
    catch (err) { last = err; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw last;
}

await eventually(() => {
  const sessions = JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'sessions.json'), 'utf8')).sessions;
  const row = sessions.find((s) => s.session_id === resumed.id);
  assert.ok(row, 'resumed session registered without a poke');
  assert.equal(row.harness, 'opencode');
  assert.equal(row.status, 'idle');
  assert.equal(row.project_path, projectDir);
  assert.equal(sessions.some((s) => s.session_id === stale.id), false, 'inactive stored sessions are not registered when status map is present');
  assert.equal(sessions.some((s) => s.session_id === child.id), false, 'child sessions are not registered as dispatch targets');

  const bridges = JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'opencode-bridges.json'), 'utf8')).bridges;
  const bridge = bridges.find((b) => b.session_id === resumed.id);
  assert.ok(bridge?.port, 'resumed session has a bridge endpoint');
});

fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'channels.json'), JSON.stringify({
  version: 1,
  channels: [{
    session_id: resumed.id,
    name: resumed.title,
    pid: process.pid,
    host: '127.0.0.1',
    port: 12345,
    harness: 'opencode',
    started_at: new Date().toISOString(),
  }],
}, null, 2));

const native = await readNativeSessions(() => true);
const live = native.find((s) => s.session_id === resumed.id);
assert.ok(live, 'dashboard native-session discovery sees resumed opencode session');
assert.equal(live.alive, true);
assert.equal(live.harness, 'opencode');
assert.equal(live.status, 'idle');

const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-oc-history-'));
const projectDir2 = path.join(tmp2, 'project');
fs.mkdirSync(projectDir2, { recursive: true });
fs.writeFileSync(path.join(projectDir2, 'AGENTS.md'), '# test project 2\n');
process.env.GOLEM_HOME = path.join(tmp2, 'golem-home');
const shimUrl2 = pathToFileURL(path.resolve('shims/opencode/index.js')).href + `?t=${Date.now()}-history`;
const nativeUrl2 = pathToFileURL(path.resolve('dashboard/server/native-sessions.js')).href + `?t=${Date.now()}-history`;
const { default: opencodeShim2 } = await import(shimUrl2);
const { readNativeSessions: readNativeSessions2 } = await import(nativeUrl2);

await opencodeShim2({
  directory: projectDir2,
  client: {
    session: {
      list: async () => ({ data: [{ ...staleHistoryOnly, directory: projectDir2 }] }),
      status: async () => ({ data: {} }),
      prompt: async () => ({ data: {} }),
    },
  },
});

await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'sessions.json')), false, 'empty status map does not resurrect stale history');

fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'sessions.json'), JSON.stringify({
  version: 1,
  sessions: [{
    session_id: 'ses_missing_bridge_dead',
    project_path: projectDir2,
    harness: 'opencode',
    status: 'idle',
    boot_time: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  }],
}, null, 2));
const nativeWithoutBridge = await readNativeSessions2(() => true);
assert.equal(nativeWithoutBridge.some((s) => s.session_id === 'ses_missing_bridge_dead'), false, 'opencode session without bridge is dead');

console.log('opencode resume dispatchable smoke passed');
