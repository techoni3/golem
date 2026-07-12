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
const shimModule = await import(shimUrl);
assert.deepEqual(Object.keys(shimModule), ['default'], 'OpenCode plugin module exposes only its callable plugin export');
const { default: opencodeShim } = shimModule;
const { readNativeSessions } = await import(nativeUrl);
const { renewEndpointLease } = await import(pathToFileURL(path.resolve('lib/session-facts.js')).href + `?t=${Date.now()}`);

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

const hooks = await opencodeShim({
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
renewEndpointLease({ canonical_id: resumed.id, owner_token: 'journey-channel', host: '127.0.0.1', port: 12345 });

const native = await readNativeSessions(() => true);
const live = native.find((s) => s.session_id === resumed.id);
assert.ok(live, 'dashboard native-session discovery sees resumed opencode session');
assert.equal(live.alive, true);
assert.equal(live.harness, 'opencode');
assert.equal(live.status, 'idle');

const siblingA = {
  id: 'ses_sibling_a',
  directory: projectDir,
  title: 'Sibling A',
  time: { created: Date.now(), updated: Date.now() },
};
const siblingB = {
  id: 'ses_sibling_b',
  directory: projectDir,
  title: 'Sibling B',
  time: { created: Date.now(), updated: Date.now() },
};
for (const info of [siblingA, siblingB]) {
  await hooks.event({ event: { type: 'session.created', properties: { info } } });
}
await eventually(() => {
  const bridges = JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'opencode-bridges.json'), 'utf8')).bridges;
  assert.equal(bridges.filter((b) => b.opencode_pid === process.pid && b.session_id === siblingA.id).length, 1, 'first sibling keeps exactly one bridge row');
  assert.equal(bridges.filter((b) => b.opencode_pid === process.pid && b.session_id === siblingB.id).length, 1, 'second sibling keeps exactly one bridge row');
});

const bridgeFile = path.join(process.env.GOLEM_HOME, 'opencode-bridges.json');
const sessionsFile = path.join(process.env.GOLEM_HOME, 'sessions.json');
const bridgeRegistry = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
bridgeRegistry.bridges = bridgeRegistry.bridges.filter((b) => b.session_id !== siblingA.id);
fs.writeFileSync(bridgeFile, JSON.stringify(bridgeRegistry, null, 2));
const sessionRegistry = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
sessionRegistry.sessions = sessionRegistry.sessions.filter((s) => s.session_id !== siblingA.id);
fs.writeFileSync(sessionsFile, JSON.stringify(sessionRegistry, null, 2));
await hooks['chat.message']({ sessionID: siblingA.id });
assert.equal(JSON.parse(fs.readFileSync(bridgeFile, 'utf8')).bridges.some((b) => b.session_id === siblingA.id), false, 'chat.message does not fabricate a busy bridge update');
assert.equal(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).sessions.some((s) => s.session_id === siblingA.id), false, 'chat.message does not fabricate a busy session update');
await hooks.event({ event: { type: 'session.status', properties: { sessionID: siblingA.id, status: { type: 'idle' } } } });
assert.ok(JSON.parse(fs.readFileSync(bridgeFile, 'utf8')).bridges.some((b) => b.session_id === siblingA.id), 'real session status self-heals known bridge');
assert.ok(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).sessions.some((s) => s.session_id === siblingA.id), 'real session status self-heals known registry row');

await hooks.event({ event: { type: 'session.created', properties: { info: child } } });
await hooks['chat.message']({ sessionID: child.id });
assert.equal(JSON.parse(fs.readFileSync(bridgeFile, 'utf8')).bridges.some((b) => b.session_id === child.id), false, 'child event cannot create a bridge row');
assert.equal(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).sessions.some((s) => s.session_id === child.id), false, 'child event cannot create a session row');

const childGolemArgs = { id: 'GOL-410', body: 'child write' };
await hooks['tool.execute.before']({ tool: 'golem_ticket_comment', sessionID: child.id, callID: 'call-child-golem' }, { args: childGolemArgs });
assert.equal(childGolemArgs.__golem_session_id, resumed.id, 'child golem call injects its top-level session id');
assert.equal(childGolemArgs.__golem_call_id, 'call-child-golem', 'child golem call injects its diagnostic call id');

const bareGolemArgs = { id: 'GOL-410', body: 'top-level write' };
await hooks['tool.execute.before']({ tool: 'ticket_comment', sessionID: resumed.id, callID: 'call-bare-golem' }, { args: bareGolemArgs });
assert.equal(bareGolemArgs.__golem_session_id, resumed.id, 'bare golem tool receives injected top-level id');

const foreignArgs = { command: 'true' };
await hooks['tool.execute.before']({ tool: 'bash', sessionID: resumed.id, callID: 'call-foreign' }, { args: foreignArgs });
assert.equal(Object.hasOwn(foreignArgs, '__golem_session_id'), false, 'foreign tools never receive golem identity args');

const unresolvedChild = { id: 'ses_child_unknown_parent', parentID: 'ses_missing_parent', directory: projectDir };
await hooks.event({ event: { type: 'session.created', properties: { info: unresolvedChild } } });
const unresolvedArgs = { id: 'GOL-410', body: 'must not inject' };
await hooks['tool.execute.before']({ tool: 'golem_ticket_comment', sessionID: unresolvedChild.id, callID: 'call-unknown-parent' }, { args: unresolvedArgs });
assert.equal(Object.hasOwn(unresolvedArgs, '__golem_session_id'), false, 'unresolvable child ancestry injects nothing');

const failing = {
  id: 'ses_registration_retry',
  directory: projectDir,
  title: 'Registration retry',
  time: { created: Date.now(), updated: Date.now() },
};
const bridgeLock = `${bridgeFile}.lock`;
fs.mkdirSync(bridgeLock);
try {
  await hooks.event({ event: { type: 'session.created', properties: { info: failing } } });
} finally {
  fs.rmSync(bridgeLock, { recursive: true, force: true });
}
await eventually(() => {
  const log = fs.readFileSync(path.join(process.env.GOLEM_HOME, 'logs', 'opencode-shim.log'), 'utf8');
  assert.match(log, /\[init\].*pid=.*dir=.*hooks=.*v=/, 'init marker is durable');
  assert.match(log, /\[session\.created\].*session=ses_sibling_a/, 'session.created marker is durable');
  assert.match(log, /\[registered\].*ses_sibling_a port=/, 'registered marker is durable');
  assert.match(log, /\[bridge register\].*failed to acquire/, 'registration failure is logged');
  const bridges = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')).bridges;
  assert.ok(bridges.some((b) => b.session_id === failing.id), 'registration retries after a caught lock failure');
});

const cancelled = {
  id: 'ses_registration_cancelled',
  directory: projectDir,
  title: 'Cancelled registration',
  time: { created: Date.now(), updated: Date.now() },
};
fs.mkdirSync(bridgeLock);
try {
  await hooks.event({ event: { type: 'session.created', properties: { info: cancelled } } });
} finally {
  fs.rmSync(bridgeLock, { recursive: true, force: true });
}
await hooks.event({ event: { type: 'session.deleted', properties: { info: cancelled } } });
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(JSON.parse(fs.readFileSync(bridgeFile, 'utf8')).bridges.some((b) => b.session_id === cancelled.id), false, 'deleted session is not resurrected by a pending retry');
assert.ok(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).sessions.find((s) => s.session_id === cancelled.id)?.ended_at, 'deleted session remains ended after pending retry');

fs.mkdirSync(bridgeLock);
try {
  await hooks.event({ event: { type: 'session.status', properties: { sessionID: siblingB.id, status: { type: 'busy' } } } });
} finally {
  fs.rmSync(bridgeLock, { recursive: true, force: true });
}
assert.match(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'logs', 'opencode-shim.log'), 'utf8'), /\[bridge update\].*failed to acquire/, 'recurring update failure is logged and does not escape');

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
assert.equal(nativeWithoutBridge.some((s) => s.session_id === 'ses_missing_bridge_dead'), false, 'opencode session without bridge and without live channel is dead');

const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-oc-log-rotation-'));
process.env.GOLEM_HOME = path.join(tmp3, 'golem-home');
const logDir = path.join(process.env.GOLEM_HOME, 'logs');
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'opencode-shim.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));
fs.writeFileSync(path.join(logDir, 'opencode-shim.log.1'), 'old rotation');
const rotationResume = {
  id: 'ses_rotation_resume_retry',
  directory: projectDir,
  title: 'Rotation resume retry',
  time: { created: Date.now(), updated: Date.now() },
};
const rotationBridgeLock = path.join(process.env.GOLEM_HOME, 'opencode-bridges.json.lock');
fs.mkdirSync(rotationBridgeLock, { recursive: true });
const shimUrl3 = pathToFileURL(path.resolve('shims/opencode/index.js')).href + `?t=${Date.now()}-rotation`;
const { default: opencodeShim3 } = await import(shimUrl3);
await opencodeShim3({
  directory: projectDir,
  client: {
    session: {
      list: async () => ({ data: [rotationResume] }),
      status: async () => ({ data: { [rotationResume.id]: { type: 'idle' } } }),
      prompt: async () => ({ data: {} }),
    },
  },
});
setTimeout(() => fs.rmSync(rotationBridgeLock, { recursive: true, force: true }), 1100);
assert.equal(fs.statSync(path.join(logDir, 'opencode-shim.log.1')).size, 5 * 1024 * 1024 + 1, 'oversized log rotates and replaces prior backup');
assert.match(fs.readFileSync(path.join(logDir, 'opencode-shim.log'), 'utf8'), /\[init\]/, 'new log begins with init marker after rotation');
await eventually(() => {
  const log = fs.readFileSync(path.join(logDir, 'opencode-shim.log'), 'utf8');
  assert.match(log, /\[bridge update\].*failed to acquire/, 'resume seed failure is logged');
  const bridges = JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'opencode-bridges.json'), 'utf8')).bridges;
  assert.ok(bridges.some((b) => b.session_id === rotationResume.id), 'resume seed retries after a caught lock failure');
}, 5000);

const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-oc-resume-cancel-'));
process.env.GOLEM_HOME = path.join(tmp4, 'golem-home');
const cancelledResume = {
  id: 'ses_cancelled_resume_retry',
  directory: projectDir,
  title: 'Cancelled resume retry',
  time: { created: Date.now(), updated: Date.now() },
};
const cancelledBridgeLock = path.join(process.env.GOLEM_HOME, 'opencode-bridges.json.lock');
fs.mkdirSync(cancelledBridgeLock, { recursive: true });
const shimUrl4 = pathToFileURL(path.resolve('shims/opencode/index.js')).href + `?t=${Date.now()}-resume-cancel`;
const { default: opencodeShim4 } = await import(shimUrl4);
const cancelledHooks = await opencodeShim4({
  directory: projectDir,
  client: {
    session: {
      list: async () => ({ data: [cancelledResume] }),
      status: async () => ({ data: { [cancelledResume.id]: { type: 'idle' } } }),
      prompt: async () => ({ data: {} }),
    },
  },
});
const cancelledLog = path.join(process.env.GOLEM_HOME, 'logs', 'opencode-shim.log');
await eventually(() => assert.match(fs.readFileSync(cancelledLog, 'utf8'), /\[bridge update\].*failed to acquire/), 5000);
fs.rmSync(cancelledBridgeLock, { recursive: true, force: true });
await cancelledHooks.event({ event: { type: 'session.deleted', properties: { info: cancelledResume } } });
await new Promise((resolve) => setTimeout(resolve, 300));
const cancelledBridgesFile = path.join(process.env.GOLEM_HOME, 'opencode-bridges.json');
const cancelledSessionsFile = path.join(process.env.GOLEM_HOME, 'sessions.json');
const cancelledBridges = fs.existsSync(cancelledBridgesFile) ? JSON.parse(fs.readFileSync(cancelledBridgesFile, 'utf8')).bridges : [];
assert.equal(cancelledBridges.some((b) => b.session_id === cancelledResume.id), false, 'deleted resumed session is not resurrected by seed retry');
assert.ok(JSON.parse(fs.readFileSync(cancelledSessionsFile, 'utf8')).sessions.find((s) => s.session_id === cancelledResume.id)?.ended_at, 'deleted resumed session remains ended after seed retry');

console.log('opencode resume + shim resilience journey passed (10 shim behaviors)');
