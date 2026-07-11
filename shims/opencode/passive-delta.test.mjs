#!/usr/bin/env node
// GOL-424 OpenCode journey: a real chat.message mutation consumes a passive
// batch without a prompt call; a dashboard actionable brief reaches the same
// shim through the existing channel -> /push delivery seam.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openTrackerDb } from '../../dashboard/server/tracker-db.js';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const dashboardServer = path.join(repo, 'dashboard', 'server', 'index.js');
const channelServer = path.join(repo, 'mcp', 'channel', 'index.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-424-opencode-'));
const home = path.join(dir, 'home');
const dbPath = path.join(dir, 'tracker.db');
const projectDir = path.join(dir, 'project');
const hooksDir = path.join(dir, 'hooks');
const sessionID = 'ses_gol_424_opencode';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let dashboard;
let channel;

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function eventually(check, message) {
  const deadline = Date.now() + 10_000;
  let error;
  while (Date.now() < deadline) {
    try { return await check(); } catch (err) { error = err; await sleep(50); }
  }
  throw new Error(`${message}: ${error?.message || error || 'timed out'}`);
}

async function dashboardUrl() {
  const file = path.join(home, 'dashboard.json');
  return eventually(() => {
    const url = JSON.parse(fs.readFileSync(file, 'utf8')).url;
    assert.ok(url);
    return url;
  }, 'temporary dashboard did not self-register');
}

async function channelUrl() {
  const file = path.join(home, 'channels.json');
  return eventually(() => {
    const row = JSON.parse(fs.readFileSync(file, 'utf8')).channels.find((entry) => entry.session_id === sessionID);
    assert.ok(row?.host && row?.port);
    return `http://${row.host}:${row.port}`;
  }, 'OpenCode channel did not register');
}

async function passiveClaim(base, id) {
  const response = await fetch(`${base}/api/passive-deltas/${encodeURIComponent(id)}/claim`, {
    method: 'POST', headers: { 'X-Golem-Caller-Session': id },
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# GOL-424 test project\n');
  fs.writeFileSync(path.join(hooksDir, 'session-register.sh'), '#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(path.join(hooksDir, 'journal-route.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const dashboardPort = await port();
  dashboard = spawn(process.execPath, [dashboardServer], {
    env: { ...process.env, GOLEM_HOME: home, GOLEM_TRACKER_DB: dbPath, PORT: String(dashboardPort), HOST: '127.0.0.1', GOLEM_PROJECTS_ROOT: path.join(dir, 'projects'), GOLEM_IDEAS_ROOT: path.join(dir, 'ideas') },
    stdio: 'ignore',
  });
  const base = await dashboardUrl();
  await eventually(async () => assert.ok((await fetch(`${base}/api/health`)).ok), 'temporary dashboard did not become healthy');

  process.env.GOLEM_HOME = home;
  process.env.GOLEM_DASHBOARD_URL = base;
  process.env.GOLEM_HOOKS_DIR = hooksDir;
  const { default: opencodeShim } = await import(pathToFileURL(path.join(repo, 'shims', 'opencode', 'index.js')).href + `?gol424=${Date.now()}`);
  const promptCalls = [];
  const promptAttempts = [];
  let rejectActionPrompt = false;
  const hooks = await opencodeShim({
    directory: projectDir,
    client: {
      session: {
        list: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        prompt: async () => { throw new Error('bridge must use promptAsync acceptance, never prompt'); },
        promptAsync: async (input) => {
          promptAttempts.push(input);
          if (rejectActionPrompt) throw new Error('OpenCode rejected actionable prompt');
          promptCalls.push(input);
          return { data: undefined, response: { ok: true } };
        },
      },
    },
  });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: sessionID, directory: projectDir, title: 'GOL-424 OpenCode', time: { created: Date.now(), updated: Date.now() } } } } });
  await eventually(() => {
    const row = JSON.parse(fs.readFileSync(path.join(home, 'opencode-bridges.json'), 'utf8')).bridges.find((entry) => entry.session_id === sessionID);
    assert.ok(row?.port);
  }, 'OpenCode bridge did not register');

  channel = spawn(process.execPath, [channelServer], {
    cwd: repo,
    env: { ...process.env, GOLEM_HOME: home, GOLEM_DASHBOARD_URL: base, GOLEM_CEO_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', GOLEM_CHANNEL_PORT: '0', GOLEM_CHANNEL_HEARTBEAT_MS: '50' },
    stdio: 'ignore',
  });
  await channelUrl();

  let tracker = openTrackerDb(dbPath);
  const ticket = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-424 OpenCode prompt', body: '', created_by: 'human', assignee: sessionID });
  tracker.recordEvent({ ticket_id: ticket.id, project_id: ticket.project_id, type: 'phase_change', actor: 'writer-session', data: { from: 'queued', to: 'building' } });
  tracker.close();
  tracker = null;

  const beforePassiveChat = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions.find((row) => row.session_id === sessionID);
  assert.equal(beforePassiveChat?.status, 'idle', 'real OpenCode status starts idle before passive injection');
  const outgoing = { message: { role: 'user' }, parts: [{ type: 'text', text: 'real user request' }] };
  await hooks['chat.message']({ sessionID }, outgoing);
  assert.equal(promptCalls.length, 0, 'passive chat.message injection makes no session.prompt/noReply turn');
  assert.equal(outgoing.parts.length, 2, 'existing submitted user message gains exactly one text part');
  assert.match(outgoing.parts[1].text, /^Since your last turn:/, 'OpenCode user message receives the canonical passive delta');
  const afterPassiveChat = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions.find((row) => row.session_id === sessionID);
  assert.deepEqual(afterPassiveChat, beforePassiveChat, 'passive chat.message creates no synthetic busy/status registry write');
  assert.equal((await passiveClaim(base, sessionID)).batch, null, 'OpenCode commits only after mutating the outgoing message object');

  tracker = openTrackerDb(dbPath);
  tracker.recordEvent({ ticket_id: ticket.id, project_id: ticket.project_id, type: 'phase_change', actor: 'writer-session', data: { from: 'building', to: 'built' } });
  tracker.close();
  tracker = null;
  const dispatched = await fetch(`${base}/api/tickets/${ticket.id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionID, sender_id: 'dispatcher-session' }),
  });
  const dispatchBody = await dispatched.json();
  assert.equal(dispatchBody.delivered, true, 'dashboard dispatch reaches the OpenCode channel delivery seam');
  await eventually(() => assert.equal(promptCalls.length, 1), 'OpenCode bridge did not receive the actionable /push brief');
  const actionText = promptCalls[0]?.body?.parts?.[0]?.text || '';
  assert.equal(promptCalls[0]?.throwOnError, true, 'bridge waits for the SDK promptAsync acceptance result');
  assert.match(actionText, /<channel source="golem" kind="brief"/, 'OpenCode actionable brief stays in the existing /push turn');
  assert.match(actionText, /Since your last turn:/, 'OpenCode actionable brief carries pending passive context');
  assert.equal((await passiveClaim(base, sessionID)).batch, null, 'successful OpenCode actionable delivery settles the passive batch');

  await hooks.event({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } });
  const beforeRejectedAction = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions.find((row) => row.session_id === sessionID);
  tracker = openTrackerDb(dbPath);
  const rejectedTicket = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-424 rejected OpenCode action', body: '', created_by: 'human', assignee: sessionID });
  tracker.recordEvent({ ticket_id: rejectedTicket.id, project_id: rejectedTicket.project_id, type: 'phase_change', actor: 'writer-session', data: { from: 'queued', to: 'building' } });
  tracker.close();
  tracker = null;
  rejectActionPrompt = true;
  const rejectedDispatch = await fetch(`${base}/api/tickets/${rejectedTicket.id}/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionID, sender_id: 'dispatcher-session' }),
  });
  const rejectedBody = await rejectedDispatch.json();
  assert.equal(rejectedBody.delivered, false, 'dashboard treats rejected OpenCode prompt as an undelivered opportunity');
  await eventually(() => assert.equal(promptAttempts.length, 2), 'bridge attempted the rejecting prompt before responding non-2xx');
  assert.equal(promptCalls.length, 1, 'rejected prompt is never recorded as an accepted actionable turn');
  assert.match(promptAttempts.at(-1)?.body?.parts?.[0]?.text || '', /Since your last turn:/, 'rejected action had claimed passive context before delivery failed');
  const afterRejectedAction = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions.find((row) => row.session_id === sessionID);
  assert.deepEqual(afterRejectedAction, beforeRejectedAction, 'rejected actionable prompt does not mark bridge/session busy');
  const replay = await passiveClaim(base, sessionID);
  assert.match(replay.batch?.body || '', /^Since your last turn:/, 'dashboard releases the passive batch after OpenCode rejects the actionable prompt');
  await fetch(`${base}/api/passive-deltas/${sessionID}/release`, {
    method: 'POST', headers: { 'X-Golem-Caller-Session': sessionID, 'Content-Type': 'application/json' }, body: JSON.stringify({ lease_id: replay.lease_id }),
  });

  console.log('PASS GOL-424 OpenCode passive message + actionable journey');
} finally {
  try { dashboard?.kill('SIGTERM'); } catch {}
  try { channel?.kill('SIGTERM'); } catch {}
  await sleep(100);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
