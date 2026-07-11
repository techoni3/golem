#!/usr/bin/env node
// GOL-423 journey: deterministic tracker slots survive replay/restart and land
// only on a real Claude Code prompt or successful actionable dispatch.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { openTrackerDb } from '../server/tracker-db.js';
import { initDispatchDrainer } from '../server/dispatch-queue.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dashboardServer = path.join(repo, 'dashboard', 'server', 'index.js');
const passiveHook = path.join(repo, 'substrate', 'hooks', 'passive-delta.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-423-'));
const home = path.join(dir, 'home');
const dbPath = path.join(dir, 'tracker.db');
const v14DbPath = path.join(dir, 'v14-tracker.db');
const queueFaultDbPath = path.join(dir, 'queue-fault-tracker.db');
const projectDir = path.join(dir, 'project');
const projectsDir = path.join(dir, 'projects');
const dashboardPort = 7800 + crypto.randomInt(400);
const base = `http://127.0.0.1:${dashboardPort}`;
const requests = [];
let tracker;
let dashboard;
let channel;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (ticket, type, data, actor = 'writer-session', extra = {}) => tracker.recordEvent({
  ticket_id: ticket.id,
  project_id: ticket.project_id,
  type,
  actor,
  data,
  ...extra,
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function request(method, pathname, body = undefined, caller = null) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (caller) headers['x-golem-caller-session'] = caller;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('temporary dashboard did not become healthy');
}

async function assertGeneratedChannelRuntime() {
  const generated = path.join(repo, 'plugin', 'mcp', 'channel', 'index.js');
  const generatedIdentity = path.join(repo, 'plugin', 'mcp', 'channel', 'identity.js');
  assert.ok(fs.existsSync(generatedIdentity), 'CC render includes identity.js required by generated channel runtime');
  const runtimeHome = path.join(dir, 'generated-channel-home');
  const child = spawn(process.execPath, [generated], {
    cwd: repo,
    env: { ...process.env, GOLEM_HOME: runtimeHome, GOLEM_CHANNEL_PORT: '0', GOLEM_CEO_SESSION_ID: 'generated-runtime-session', GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !/\[golem-channel\] http:\/\//.test(stderr) && child.exitCode == null) await sleep(25);
    assert.equal(child.exitCode, null, `generated channel imports and stays live: ${stderr}`);
    assert.match(stderr, /\[golem-channel\] http:\/\//, 'generated channel reaches runtime listen after imports');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await sleep(50);
  }
}

async function assertQueuedBookkeepingFaultSettlement() {
  const sessionId = 'queue-bookkeeping-session';
  const queueTracker = openTrackerDb(queueFaultDbPath);
  let drainer;
  try {
    const ticket = queueTracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 queued bookkeeping fault', body: '', created_by: 'human', assignee: sessionId });
    queueTracker.recordEvent({ ticket_id: ticket.id, project_id: ticket.project_id, type: 'phase_change', actor: 'writer-session', data: { from: 'queued', to: 'building' } });
    const envelope = queueTracker.createDispatchEnvelope(ticket.id, { session_id: sessionId, actor: 'sender-session', sender_id: 'sender-session' });
    queueTracker.setEnvelopePayload(envelope.id, { content: 'queued fault brief', envelope_id: envelope.id, recipient_session_id: sessionId });
    const row = queueTracker.queueDispatch(ticket.id, { session_id: sessionId, payload: 'queued fault brief', envelope_id: envelope.id, actor: 'sender-session' });
    queueTracker.raw().exec(`CREATE TRIGGER fault_queue_envelope_delivery BEFORE UPDATE OF delivered_at ON message_envelopes
      WHEN NEW.recipient_session_id = '${sessionId}'
      BEGIN SELECT RAISE(ABORT, 'fault injected queue bookkeeping'); END;`);
    const pushes = [];
    drainer = initDispatchDrainer({
      tracker: queueTracker,
      state: { nativeSessions: () => [{ session_id: sessionId, alive: true, status: 'idle' }] },
      chat: { record() {} },
      listChannels: async () => [{ session_id: sessionId }],
      buildDispatchBrief: () => 'queued fault brief',
      broadcastWS() {},
      pushBrief: async (content) => { pushes.push(content); return { ok: true, status: 202 }; },
    });
    await drainer.tick();
    const queuedPush = pushes.find((content) => content.includes('queued fault brief'));
    assert.ok(queuedPush, 'queued drainer reached its channel before injected bookkeeping failure');
    assert.match(queuedPush, /Since your last turn:/, 'queued delivery carried the claimed passive batch');
    assert.equal(queueTracker.getEnvelope(envelope.id)?.delivered_at, null, 'queued envelope bookkeeping was deterministically faulted after channel delivery');
    assert.equal(queueTracker.claimPassiveDelta(sessionId).batch, null, 'queued bookkeeping failure commits rather than replays delivered passive context');
  } finally {
    try { drainer?.close(); } catch {}
    try { queueTracker.close(); } catch {}
  }
}

try {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# GOL-423 smoke\n');
  fs.mkdirSync(home, { recursive: true });
  const hookConfig = JSON.parse(fs.readFileSync(path.join(repo, 'substrate', 'hooks', 'hooks.json'), 'utf8'));
  assert.match(JSON.stringify(hookConfig.hooks?.UserPromptSubmit || []), /passive-delta\.sh/, 'UserPromptSubmit wires the passive hook beside journaling');

  const v14 = new Database(v14DbPath);
  v14.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'work-item', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'todo', phase TEXT, priority TEXT, labels TEXT NOT NULL DEFAULT '[]',
      stream_id TEXT, parent_id TEXT, wave INTEGER, assignee TEXT, created_by TEXT NOT NULL DEFAULT 'human',
      dispatched_to TEXT, dispatched_at TEXT, source_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      rank INTEGER NOT NULL DEFAULT 0, state_changed_at TEXT, done_at TEXT, archived_at TEXT,
      pseq INTEGER, display_id TEXT
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
      quote TEXT, prefix TEXT, suffix TEXT, section TEXT, section_id TEXT,
      tag TEXT NOT NULL DEFAULT 'note', status TEXT NOT NULL DEFAULT 'open',
      dispatch_state TEXT NOT NULL DEFAULT 'undispatched', parent_id TEXT, block_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('schema_version', '14');
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, topic TEXT NOT NULL,
      classes_filter TEXT NOT NULL, status TEXT NOT NULL, cursor_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT, reason TEXT,
      UNIQUE(session_id, topic)
    );
    INSERT INTO subscriptions VALUES ('legacy-manual', 'legacy-session', 'ticket/LEG-1', '["tracker"]', 'active', 0, '2000-01-01T00:00:00.000Z', NULL, 'manual');
  `);
  v14.close();
  const migrated = openTrackerDb(v14DbPath);
  assert.equal(migrated.raw().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '15', 'v14 database migrates to v15');
  assert.ok(migrated.raw().prepare('PRAGMA table_info(subscriptions)').all().some((column) => column.name === 'manual'), 'v14 subscription gains manual origin column');
  assert.equal(migrated.raw().prepare("SELECT manual FROM subscriptions WHERE id = 'legacy-manual'").get().manual, 1, 'v14 manual subscription is backfilled');
  assert.ok(migrated.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'passive_cursors'").get(), 'v14 migration creates passive cursor storage');
  migrated.close();

  tracker = openTrackerDb(dbPath);
  assert.equal(tracker.raw().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '15', 'GOL-423 advances past occupied schema v14');

  const parent = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'spec', title: 'SMOKE GOL-423 parent', body: '', created_by: 'human', assignee: 'parent-session' });
  const main = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 primary', body: '', created_by: 'human', parent_id: parent.id, assignee: 'main-session' });
  tracker.subscribe({ session_id: 'manual-ticket', topic: `ticket/${main.display_id}`, reason: 'manual' });
  tracker.subscribe({ session_id: 'manual-spec', topic: `spec/${parent.display_id}/tree`, reason: 'manual' });
  tracker.subscribe({ session_id: 'auto-only', topic: `ticket/${main.display_id}`, reason: 'ticket_assignee' });
  tracker.createDispatchEnvelope(main.id, { session_id: 'envelope-target', actor: 'actor-session', sender_id: 'actor-session' });
  tracker.createDispatchEnvelope(parent.id, { session_id: 'parent-envelope-target', actor: 'parent-envelope-sender', sender_id: 'parent-envelope-sender' });

  event(main, 'phase_change', { from: 'queued', to: 'building' }, 'actor-session');
  tracker.addComment(main.id, { author: 'commenter', body: 'ordinary prose must remain passive-history only' });
  event(main, 'phase_change', { from: 'building', to: 'mirror-only' }, 'actor-session', { topic: `spec/${parent.display_id}/tree` });
  event(main, 'phase_change', { from: 'building', to: 'activity-only' }, 'actor-session', { class: 'activity' });
  event(main, 'phase_change', { from: 'building', to: 'built' }, 'actor-session');
  event(main, 'phase_change', { from: 'built', to: 'verified' }, 'actor-session');
  event(main, 'phase_change', { from: 'verified', to: 'done' }, 'actor-session');

  const primary = tracker.claimPassiveDelta('main-session');
  assert.match(primary.batch?.body || '', new RegExp(`- ${main.display_id}`), 'current assignee receives canonical ticket delta');
  assert.match(primary.batch?.body || '', /phase: queued → done/, 'phase coalesces first baseline to latest value');
  assert.match(primary.batch?.body || '', /result: built; PASS; done/, 'result retains built, PASS, and terminal done');
  assert.doesNotMatch(primary.batch?.body || '', /commenter|mirror-only|activity-only/, 'comments, mirrored rows, and activity telemetry are excluded');
  tracker.releasePassiveDelta('main-session', primary.lease_id);
  for (const sessionId of ['manual-ticket', 'manual-spec', 'envelope-target', 'parent-session', 'parent-envelope-sender', 'parent-envelope-target']) {
    const claim = tracker.claimPassiveDelta(sessionId);
    assert.match(claim.batch?.body || '', new RegExp(main.display_id), `${sessionId} is a durable explicit relationship recipient`);
    tracker.releasePassiveDelta(sessionId, claim.lease_id);
  }
  assert.equal(tracker.claimPassiveDelta('actor-session').batch, null, 'actor never receives its own passive delta');
  assert.equal(tracker.claimPassiveDelta('auto-only').batch, null, 'automatic subscription is not a passive recipient route');

  const fail = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 result', body: '', created_by: 'human', assignee: 'fail-session' });
  event(fail, 'phase_change', { from: 'building', to: 'built' });
  event(fail, 'phase_change', { from: 'built', to: 'verified' });
  event(fail, 'phase_change', { from: 'verified', to: 'rejected' });
  event(fail, 'phase_change', { from: 'rejected', to: 'done' });
  const failure = tracker.claimPassiveDelta('fail-session');
  assert.match(failure.batch?.body || '', /result: built; FAIL; done/, 'FAIL remains the strongest verdict after done');
  tracker.releasePassiveDelta('fail-session', failure.lease_id);

  const net = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 net zero', body: '', created_by: 'human', assignee: 'net-session' });
  event(net, 'phase_change', { from: 'building', to: 'blocked' });
  event(net, 'phase_change', { from: 'blocked', to: 'building' });
  event(net, 'assigned', { from: 'alpha', to: 'beta' });
  event(net, 'assigned', { from: 'beta', to: 'alpha' });
  const netSlots = tracker.raw().prepare('SELECT category FROM passive_slots WHERE session_id = ? AND ticket_id = ?').all('net-session', net.id);
  assert.deepEqual(netSlots, [], 'phase, assignment, and blocker net-zero slots are deleted');

  const categories = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 categories', body: '', created_by: 'human', assignee: 'category-session' });
  event(categories, 'phase_change', { from: 'queued', to: 'building' });
  event(categories, 'assigned', { from: 'prior-session', to: 'category-session' });
  event(categories, 'phase_change', { from: 'building', to: 'blocked' });
  const categoryClaim = tracker.claimPassiveDelta('category-session');
  assert.match(categoryClaim.batch?.body || '', /phase: queued → blocked/, 'phase category is projected');
  assert.match(categoryClaim.batch?.body || '', /assignment: prior-session → category-session/, 'assignment category is projected');
  assert.match(categoryClaim.batch?.body || '', /blocker: clear → blocked/, 'blocker category is projected without prose parsing');
  tracker.releasePassiveDelta('category-session', categoryClaim.lease_id);

  const capTickets = [];
  for (let i = 0; i < 22; i++) {
    const ticket = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: `SMOKE GOL-423 cap ${i}`, body: '', created_by: 'human', assignee: 'cap-session' });
    capTickets.push(ticket);
    event(ticket, 'phase_change', { from: 'queued', to: 'building' });
  }
  const capFirst = tracker.claimPassiveDelta('cap-session');
  assert.equal(capFirst.batch?.ticket_count, 20, 'first passive batch is capped at 20 ticket groups');
  assert.ok(Buffer.byteLength(capFirst.batch?.body || '', 'utf8') <= 4096, 'first passive batch is capped at 4096 bytes');
  tracker.releasePassiveDelta('cap-session', capFirst.lease_id);
  const capBody = capFirst.batch.body;
  tracker.close();
  tracker = openTrackerDb(dbPath);
  const capReplay = tracker.claimPassiveDelta('cap-session');
  assert.equal(capReplay.replayed, true, 'released pending batch survives tracker restart');
  assert.equal(capReplay.batch?.body, capBody, 'replayed batch is byte-for-byte identical');
  tracker.commitPassiveDelta('cap-session', capReplay.lease_id);
  const capOverflow = tracker.claimPassiveDelta('cap-session');
  assert.equal(capOverflow.batch?.ticket_count, 2, 'overflow remains pending for the next batch');
  tracker.commitPassiveDelta('cap-session', capOverflow.lease_id);

  const concurrent = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 concurrent', body: '', created_by: 'human', assignee: 'concurrent-session' });
  event(concurrent, 'phase_change', { from: 'queued', to: 'building' });
  const firstClaim = tracker.claimPassiveDelta('concurrent-session');
  event(concurrent, 'phase_change', { from: 'building', to: 'built' });
  tracker.commitPassiveDelta('concurrent-session', firstClaim.lease_id);
  const concurrentReplay = tracker.claimPassiveDelta('concurrent-session');
  assert.match(concurrentReplay.batch?.body || '', /phase: queued → built/, 'commit preserves updates that raced after the claim boundary');
  tracker.commitPassiveDelta('concurrent-session', concurrentReplay.lease_id);

  const releaseRace = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 release CAS', body: '', created_by: 'human', assignee: 'release-session' });
  event(releaseRace, 'phase_change', { from: 'queued', to: 'building' });
  const staleRelease = tracker.claimPassiveDelta('release-session');
  tracker.raw().prepare("UPDATE passive_cursors SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ?").run('release-session');
  const renewedRelease = tracker.claimPassiveDelta('release-session');
  assert.notEqual(renewedRelease.lease_id, staleRelease.lease_id, 'expired claim receives a new lease before stale release runs');
  assert.throws(() => tracker.releasePassiveDelta('release-session', staleRelease.lease_id), /lease does not match/, 'stale release cannot clear the renewed lease');
  assert.equal(tracker.raw().prepare('SELECT lease_id FROM passive_cursors WHERE session_id = ?').get('release-session').lease_id, renewedRelease.lease_id, 'renewed lease remains after deterministic stale-release interleaving');
  tracker.releasePassiveDelta('release-session', renewedRelease.lease_id);

  await assertQueuedBookkeepingFaultSettlement();

  const rest = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 REST', body: '', created_by: 'human', assignee: 'rest-session' });
  event(rest, 'phase_change', { from: 'queued', to: 'building' });
  const hookTicket = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 hook', body: '', created_by: 'human', assignee: 'hook-session' });
  event(hookTicket, 'phase_change', { from: 'queued', to: 'building' });
  const action = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 action', body: '', created_by: 'human', assignee: 'action-session' });
  event(action, 'phase_change', { from: 'queued', to: 'building' });
  const failedAction = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 failed action', body: '', created_by: 'human', assignee: 'failure-action-session' });
  event(failedAction, 'phase_change', { from: 'queued', to: 'building' });
  const notifySuccess = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 notify', body: '', created_by: 'human', assignee: 'notify-session' });
  event(notifySuccess, 'phase_change', { from: 'queued', to: 'building' });
  const notifyFailure = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 notify failure', body: '', created_by: 'human', assignee: 'notify-failure-session' });
  event(notifyFailure, 'phase_change', { from: 'queued', to: 'building' });
  const notifyBookkeepingFault = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 notify bookkeeping fault', body: '', created_by: 'human', assignee: 'notify-bookkeeping-session' });
  event(notifyBookkeepingFault, 'phase_change', { from: 'queued', to: 'building' });
  const dispatchBookkeepingFault = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 dispatch bookkeeping fault', body: '', created_by: 'human', assignee: 'dispatch-bookkeeping-session' });
  event(dispatchBookkeepingFault, 'phase_change', { from: 'queued', to: 'building' });
  const replyBookkeepingFault = tracker.createTicket({ project_id: 'smoketests-000000', kind: 'work-item', title: 'SMOKE GOL-423 reply bookkeeping fault', body: '', created_by: 'human', assignee: 'reply-bookkeeping-session' });
  event(replyBookkeepingFault, 'phase_change', { from: 'queued', to: 'building' });
  const replyBookkeepingEnvelope = tracker.createDispatchEnvelope(replyBookkeepingFault.id, { session_id: 'reply-caller-session', actor: 'reply-bookkeeping-session', sender_id: 'reply-bookkeeping-session' });
  tracker.close();

  channel = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const channelPort = await listen(channel);
  fs.writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ version: 1, channels: [
    { session_id: 'action-session', pid: process.pid, host: '127.0.0.1', port: channelPort },
    { session_id: 'failure-action-session', pid: process.pid, host: '127.0.0.1', port: 1 },
    { session_id: 'notify-session', pid: process.pid, host: '127.0.0.1', port: channelPort },
    { session_id: 'notify-failure-session', pid: process.pid, host: '127.0.0.1', port: 1 },
    { session_id: 'notify-bookkeeping-session', pid: process.pid, host: '127.0.0.1', port: channelPort },
    { session_id: 'dispatch-bookkeeping-session', pid: process.pid, host: '127.0.0.1', port: channelPort },
    { session_id: 'reply-bookkeeping-session', pid: process.pid, host: '127.0.0.1', port: channelPort },
  ] }, null, 2));
  dashboard = spawn(process.execPath, [dashboardServer], {
    env: { ...process.env, PORT: String(dashboardPort), HOST: '127.0.0.1', GOLEM_HOME: home, GOLEM_TRACKER_DB: dbPath, GOLEM_PROJECTS_ROOT: projectsDir, GOLEM_IDEAS_ROOT: path.join(dir, 'ideas') },
    stdio: 'ignore',
  });
  await waitForHealth();
  await assertGeneratedChannelRuntime();

  assert.equal((await request('POST', '/api/passive-deltas/rest-session/claim')).status, 403, 'passive claim rejects a missing trusted caller header');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/claim', undefined, 'foreign-session')).status, 403, 'passive claim rejects a foreign caller session');
  const restClaim = await request('POST', '/api/passive-deltas/rest-session/claim', undefined, 'rest-session');
  assert.equal(restClaim.status, 200, 'REST claim succeeds for intended session');
  assert.ok(restClaim.body?.lease_id && restClaim.body?.batch?.body, 'REST claim returns lease and batch');
  const restBusy = await request('POST', '/api/passive-deltas/rest-session/claim', undefined, 'rest-session');
  assert.equal(restBusy.status, 409, 'concurrent REST claim is held by one lease');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/release', { lease_id: restClaim.body.lease_id })).status, 403, 'passive release rejects a missing trusted caller header');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/release', { lease_id: restClaim.body.lease_id }, 'foreign-session')).status, 403, 'passive release rejects a foreign caller session');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/release', { lease_id: restClaim.body.lease_id }, 'rest-session')).status, 200, 'REST release retains pending batch');
  const restReplay = await request('POST', '/api/passive-deltas/rest-session/claim', undefined, 'rest-session');
  assert.equal(restReplay.body?.batch?.body, restClaim.body?.batch?.body, 'REST replay reuses pending bytes');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/commit', { lease_id: restReplay.body.lease_id })).status, 403, 'passive commit rejects a missing trusted caller header');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/commit', { lease_id: restReplay.body.lease_id }, 'foreign-session')).status, 403, 'passive commit rejects a foreign caller session');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/commit', { lease_id: restReplay.body.lease_id }, 'rest-session')).body?.committed, true, 'REST commit advances cursor');
  assert.equal((await request('POST', '/api/passive-deltas/rest-session/claim', undefined, 'rest-session')).body?.batch, null, 'committed REST batch is consumed');

  const beforeHookPushes = requests.length;
  const hookRun = spawnSync('bash', [passiveHook], {
    cwd: projectDir,
    input: JSON.stringify({ session_id: 'hook-session', cwd: projectDir }),
    encoding: 'utf8',
    timeout: 4000,
    env: { ...process.env, GOLEM_HOME: home, GOLEM_DASHBOARD_URL: base, CLAUDE_CODE_SESSION_ID: 'hook-session' },
  });
  assert.equal(hookRun.status, 0, `Claude Code hook fails open: ${hookRun.stderr}`);
  const hookOutput = JSON.parse(hookRun.stdout);
  assert.match(hookOutput?.hookSpecificOutput?.additionalContext || '', /^Since your last turn:/, 'hook injects passive context into the real human prompt');
  assert.equal(requests.length, beforeHookPushes, 'hook injection never creates a channel push turn');
  assert.equal((await request('POST', '/api/passive-deltas/hook-session/claim', undefined, 'hook-session')).body?.batch, null, 'hook commits after serializing additionalContext');

  const outageStarted = Date.now();
  const outage = spawnSync('bash', [passiveHook], {
    cwd: projectDir,
    input: JSON.stringify({ session_id: 'outage-session', cwd: projectDir }),
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env, GOLEM_HOME: home, GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1', CLAUDE_CODE_SESSION_ID: 'outage-session' },
  });
  assert.equal(outage.status, 0, 'dashboard outage keeps UserPromptSubmit fail-open');
  assert.equal(outage.stdout, '', 'dashboard outage injects no malformed context');
  assert.ok(Date.now() - outageStarted < 1000, 'dashboard outage returns quickly');

  const delivered = await request('POST', `/api/tickets/${action.id}/dispatch`, { session_id: 'action-session', sender_id: 'dispatcher-session' });
  assert.equal(delivered.body?.delivered, true, 'actionable dispatch reached its existing channel');
  assert.match(requests.at(-1)?.body || '', /Since your last turn:/, 'actionable brief appends the same passive batch');
  assert.equal((await request('POST', '/api/passive-deltas/action-session/claim', undefined, 'action-session')).body?.batch, null, 'successful delivery opportunity commits passive batch');

  const notified = await request('POST', '/api/messages/notify', { project_id: 'smoketests-000000', session_id: 'notify-session', sender_id: 'notify-sender', text: 'explicit notification' });
  assert.equal(notified.body?.ok, true, 'reachable notification is delivered');
  assert.match(requests.at(-1)?.body || '', /Since your last turn:/, 'notification appends pending passive delta');
  assert.equal((await request('POST', '/api/passive-deltas/notify-session/claim', undefined, 'notify-session')).body?.batch, null, 'successful notification commits passive batch');

  const notificationFailure = await request('POST', '/api/messages/notify', { project_id: 'smoketests-000000', session_id: 'notify-failure-session', sender_id: 'notify-sender', text: 'failed notification' });
  assert.equal(notificationFailure.body?.ok, false, 'failed notification reports failed delivery');
  const retainedNotification = await request('POST', '/api/passive-deltas/notify-failure-session/claim', undefined, 'notify-failure-session');
  assert.match(retainedNotification.body?.batch?.body || '', /^Since your last turn:/, 'failed notification releases and retains passive batch');
  await request('POST', '/api/passive-deltas/notify-failure-session/release', { lease_id: retainedNotification.body?.lease_id }, 'notify-failure-session');

  // One real SQLite trigger faults the shared post-push envelope bookkeeping
  // across the notification, immediate-dispatch, and correlated-reply paths.
  // Each path must still commit its already-delivered passive batch.
  const faultDb = new Database(dbPath);
  faultDb.exec(`CREATE TRIGGER fault_passive_envelope_bookkeeping BEFORE UPDATE OF delivered_at ON message_envelopes
    WHEN NEW.recipient_session_id IN ('notify-bookkeeping-session', 'dispatch-bookkeeping-session', 'reply-bookkeeping-session')
    BEGIN SELECT RAISE(ABORT, 'fault injected envelope bookkeeping'); END;`);
  faultDb.close();

  const notifyBookkeeping = await request('POST', '/api/messages/notify', { project_id: 'smoketests-000000', session_id: 'notify-bookkeeping-session', sender_id: 'notify-sender', text: 'fault notification' });
  assert.equal(notifyBookkeeping.status, 400, 'notification surfaces its injected post-push bookkeeping failure');
  assert.match(requests.at(-1)?.body || '', /Since your last turn:/, 'notification channel delivery happened before its bookkeeping failure');
  assert.equal((await request('POST', '/api/passive-deltas/notify-bookkeeping-session/claim', undefined, 'notify-bookkeeping-session')).body?.batch, null, 'notification bookkeeping failure does not replay delivered passive context');

  const dispatchBookkeeping = await request('POST', `/api/tickets/${dispatchBookkeepingFault.id}/dispatch`, { session_id: 'dispatch-bookkeeping-session', sender_id: 'dispatcher-session' });
  assert.equal(dispatchBookkeeping.status, 500, 'immediate dispatch surfaces its injected post-push bookkeeping failure');
  assert.match(requests.at(-1)?.body || '', /Since your last turn:/, 'immediate dispatch channel delivery happened before its bookkeeping failure');
  assert.equal((await request('POST', '/api/passive-deltas/dispatch-bookkeeping-session/claim', undefined, 'dispatch-bookkeeping-session')).body?.batch, null, 'immediate dispatch bookkeeping failure does not replay delivered passive context');

  const replyBookkeeping = await request('POST', `/api/message-envelopes/${replyBookkeepingEnvelope.id}/reply`, { kind: 'brief', text: 'fault reply' }, 'reply-caller-session');
  assert.equal(replyBookkeeping.status, 403, 'correlated reply surfaces its injected post-push bookkeeping failure');
  assert.match(requests.at(-1)?.body || '', /Since your last turn:/, 'correlated reply channel delivery happened before its bookkeeping failure');
  assert.equal((await request('POST', '/api/passive-deltas/reply-bookkeeping-session/claim', undefined, 'reply-bookkeeping-session')).body?.batch, null, 'correlated reply bookkeeping failure does not replay delivered passive context');

  const failed = await request('POST', `/api/tickets/${failedAction.id}/dispatch`, { session_id: 'failure-action-session', sender_id: 'dispatcher-session' });
  assert.equal(failed.body?.delivered, false, 'failed actionable channel remains a failed delivery');
  const retained = await request('POST', '/api/passive-deltas/failure-action-session/claim', undefined, 'failure-action-session');
  assert.match(retained.body?.batch?.body || '', /^Since your last turn:/, 'failed delivery releases and retains passive batch');
  await request('POST', '/api/passive-deltas/failure-action-session/release', { lease_id: retained.body?.lease_id }, 'failure-action-session');

  console.log('PASS GOL-423 passive delta + Claude Code journey');
} finally {
  try { tracker?.close(); } catch {}
  try { dashboard?.kill('SIGTERM'); } catch {}
  try { channel?.close(); } catch {}
  await sleep(100);
  fs.rmSync(dir, { recursive: true, force: true });
}
