// TKT-0245: asynchronous dispatch — queue-when-idle journey smoke.
//
// The trick that makes this journey-testable WITHOUT a real Claude session:
// registry + CLI rows are merged by native-sessions.js, so an injected
// ~/.claude/sessions/<pid>.json with a LIVE pid (the smoke's own process.pid)
// becomes a dispatchable session. A tiny fake channel server impersonates the
// session's channel server (records POST /brief). The drainer delivers the
// queued brief when the session's status flips to idle.
//
// Journey:
//   1. Rig: fake channel server + registry file (busy) + channels.json entry.
//   2. Create a scratch ticket.
//   3. Poll dispatchable until the fake session appears with status busy.
//   4. Queue a dispatch (mode 'when_idle') → queued:true, pending_dispatch set,
//      assignee flipped, dispatched_at null.
//   5. Wait 12s → fake channel received nothing (busy never delivered).
//   6. Flip registry to idle → drainer delivers exactly ONE brief; ticket
//      dispatched_to/at set; pending_dispatch gone.
//   7. Cancel path: queue a second dispatch, cancel it, flip to idle, wait 8s
//      → channel count STILL 1 (cancelled never deliver).
//   8. Zero pageerror events.
//
// Cleanup is surgical: ONLY the fake registry file + the fake channels.json
// entry are removed; other sessions' registrations are live state.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import { strict as assert } from 'node:assert';
import { acquireChrome } from './_chrome.mjs';
import { channelsJsonPath } from '../../lib/golem-home.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ABS = path.resolve(__dirname, '..', '..');
const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const PROJECT = 'golem-1eba80';
const FAKE_SESSION = 'smoke-0245-fake';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CHANNELS_FILE = channelsJsonPath();
const REGISTRY_FILE = path.join(SESSIONS_DIR, `${process.pid}.json`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) =>
  fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
const del = (p) => fetch(`${API}${p}`, { method: 'DELETE' }).then((r) => r.json());
const patch = (p, body) =>
  fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const poll = async (fn, pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (pred(v)) return v;
    await wait(150);
  }
  return fn();
};

// --- Rig helpers -----------------------------------------------------------
function writeRegistry(status) {
  const doc = {
    pid: process.pid,
    sessionId: FAKE_SESSION,
    cwd: REPO_ABS,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status,
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(doc));
}

function readChannelsDoc() {
  try {
    return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  } catch {
    return { version: 1, channels: [] };
  }
}

function writeChannelsDoc(doc) {
  const tmp = `${CHANNELS_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, CHANNELS_FILE);
}

function appendFakeChannel(port) {
  const doc = readChannelsDoc();
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  // Idempotent: drop any prior smoke entry, then append.
  const filtered = channels.filter((c) => c.session_id !== FAKE_SESSION);
  filtered.push({
    session_id: FAKE_SESSION,
    name: 'smoke-0245',
    pid: process.pid,
    host: '127.0.0.1',
    port,
    version: '0.1.0',
    started_at: new Date().toISOString(),
  });
  writeChannelsDoc({ ...doc, channels: filtered });
}

function removeFakeChannel() {
  const doc = readChannelsDoc();
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  const filtered = channels.filter((c) => c.session_id !== FAKE_SESSION);
  if (filtered.length !== channels.length) {
    writeChannelsDoc({ ...doc, channels: filtered });
  }
}

// --- Fake channel server: records only POST /brief -------------------------
const receivedBriefs = [];
const fakeChannel = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/brief') {
      receivedBriefs.push({ method: req.method, path: req.url, body });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kind: 'brief' }));
  });
});

let ticketId = null;
const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

try {
  // ── 1. Rig: fake channel server on an ephemeral port ─────────────────────
  await new Promise((resolve) => fakeChannel.listen(0, '127.0.0.1', resolve));
  const channelPort = fakeChannel.address().port;

  // ── 1b. Pre-clean: cancel any leftover pending dispatches for the fake
  // session from a previous (failed) smoke run. A leftover pending row would
  // be FIFO-ahead of this run's row, so the drainer delivers it first and the
  // 60s per-session cooldown then blocks this run's delivery within the poll
  // window. The queue lives in SQLite and survives restarts, so this is
  // mandatory cleanup, not optional.
  const leftovers = await get(`/dispatch-queue?session_id=${encodeURIComponent(FAKE_SESSION)}`);
  for (const row of Array.isArray(leftovers) ? leftovers : []) {
    try { await del(`/dispatch-queue/${encodeURIComponent(row.id)}`); } catch {}
  }

  // ── 2. Rig: registry file (busy) + channels.json entry ───────────────────
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  writeRegistry('busy');
  appendFakeChannel(channelPort);

  // ── 3. Scratch ticket ────────────────────────────────────────────────────
  const ticket = await post('/tickets', {
    project_id: PROJECT, kind: 'task', created_by: 'smoke',
    title: 'SMOKE-0245 scratch', body: 'Scratch ticket for the TKT-0245 async dispatch smoke.',
  });
  ticketId = ticket.id;
  assert.ok(ticketId, 'created scratch ticket');

  // ── 4. Open the page view (catch pageerrors during the journey) ──────────
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticketId)}`, { waitUntil: 'networkidle' });
  await wait(800);

  // ── 5. Poll dispatchable until the fake session appears with status busy ──
  const dispatchable = await poll(
    () => get(`/sessions/dispatchable?project=${PROJECT}`),
    (list) => Array.isArray(list) && list.some((s) => s.session_id === FAKE_SESSION && s.status === 'busy'),
    10_000,
  );
  const fake = dispatchable.find((s) => s.session_id === FAKE_SESSION);
  assert.ok(fake, 'fake session is dispatchable');
  assert.equal(fake.status, 'busy', `fake session status is busy (got ${fake.status})`);

  // ── 6. Queue a dispatch (when_idle) ──────────────────────────────────────
  const qres = await post(`/tickets/${encodeURIComponent(ticketId)}/dispatch`, {
    session_id: FAKE_SESSION, mode: 'when_idle',
  });
  assert.equal(qres.queued, true, `dispatch response queued:true (got ${qres.queued})`);
  assert.ok(qres.queue_id, 'dispatch response has queue_id');
  assert.ok(qres.ticket, 'dispatch response has ticket');
  assert.equal(qres.ticket.assignee, FAKE_SESSION, 'assignee flipped to fake session');
  assert.ok(!qres.ticket.dispatched_at, 'dispatched_at still null (not yet delivered)');

  // ── 6b. Ticket detail has pending_dispatch ───────────────────────────────
  const detailAfterQueue = await get(`/tickets/${encodeURIComponent(ticketId)}`);
  assert.ok(detailAfterQueue.pending_dispatch, 'ticket detail has pending_dispatch');
  assert.equal(detailAfterQueue.pending_dispatch.session_id, FAKE_SESSION, 'pending_dispatch.session_id');
  assert.equal(detailAfterQueue.pending_dispatch.status, 'pending', 'pending_dispatch.status = pending');

  // ── 6c. The page view shows the pending row (no pageerror) ───────────────
  await page.reload({ waitUntil: 'networkidle' });
  await wait(600);
  await page.waitForSelector('.td-dispatch-pending', { timeout: 5000 });
  const pendingText = await page.evaluate(() => document.querySelector('.td-dispatch-pending-line')?.textContent || '');
  assert.ok(/Queued for/.test(pendingText), `pending row renders "Queued for …" (got "${pendingText}")`);

  // ── 7. Wait 12s → fake channel received nothing (busy never delivered) ───
  await wait(12_000);
  assert.equal(receivedBriefs.length, 0, `busy session: no brief delivered (got ${receivedBriefs.length})`);

  // ── 8. Flip registry to idle → drainer delivers exactly ONE brief ────────
  writeRegistry('idle');
  const deliveredDetail = await poll(
    () => get(`/tickets/${encodeURIComponent(ticketId)}`),
    (t) => !!t.dispatched_to && !!t.dispatched_at && !t.pending_dispatch,
    20_000,
  );
  assert.equal(deliveredDetail.dispatched_to, FAKE_SESSION, 'dispatched_to set after delivery');
  assert.ok(deliveredDetail.dispatched_at, 'dispatched_at set after delivery');
  assert.ok(!deliveredDetail.pending_dispatch, 'pending_dispatch gone after delivery');

  // The brief POST may still be in-flight right after the DB write — give it a
  // moment to land, then assert exactly one brief containing the ticket id.
  await poll(() => Promise.resolve(receivedBriefs.length), (n) => n >= 1, 3_000);
  assert.equal(receivedBriefs.length, 1, `exactly one brief delivered (got ${receivedBriefs.length})`);
  assert.ok(
    receivedBriefs[0].body.includes(ticketId),
    `brief body contains the ticket id (got: ${receivedBriefs[0].body.slice(0, 120)})`,
  );

  // ── 8b. Page view re-renders back to the dispatch row (pending gone) ─────
  await page.reload({ waitUntil: 'networkidle' });
  await wait(500);
  assert.ok(
    !(await page.evaluate(() => !!document.querySelector('.td-dispatch-pending'))),
    'page view: pending row gone after delivery',
  );

  // ── 9. Cancel path: queue a second dispatch, cancel it, flip to idle ─────
  writeRegistry('busy');
  // Wait for busy to propagate so the dispatch queues (not falls through to now).
  await poll(
    () => get(`/sessions/dispatchable?project=${PROJECT}`),
    (list) => Array.isArray(list) && list.some((s) => s.session_id === FAKE_SESSION && s.status === 'busy'),
    10_000,
  );
  const q2 = await post(`/tickets/${encodeURIComponent(ticketId)}/dispatch`, {
    session_id: FAKE_SESSION, mode: 'when_idle',
  });
  assert.equal(q2.queued, true, 'second dispatch queued');
  const qid2 = q2.queue_id;
  const detail2 = await get(`/tickets/${encodeURIComponent(ticketId)}`);
  assert.ok(detail2.pending_dispatch, 'second dispatch: pending_dispatch present');

  // Cancel it.
  const canc = await del(`/dispatch-queue/${encodeURIComponent(qid2)}`);
  assert.equal(canc.ok, true, 'cancel response ok:true');
  const detail3 = await poll(
    () => get(`/tickets/${encodeURIComponent(ticketId)}`),
    (t) => !t.pending_dispatch,
    5_000,
  );
  assert.ok(!detail3.pending_dispatch, 'pending_dispatch gone after cancel');

  // Flip to idle, wait 8s → channel count STILL 1 (cancelled never deliver).
  writeRegistry('idle');
  await wait(8_000);
  assert.equal(receivedBriefs.length, 1, `cancelled dispatch never delivered (channel count still 1, got ${receivedBriefs.length})`);

  // ── 10. Zero pageerrors ──────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({
    ok: true,
    ticketId,
    queueId: qres.queue_id,
    deliveredTo: deliveredDetail.dispatched_to,
    deliveredAt: deliveredDetail.dispatched_at,
    briefsReceived: receivedBriefs.length,
    briefSnippet: receivedBriefs[0]?.body?.slice(0, 100),
    cancelledQueueId: qid2,
  }, null, 2));
} finally {
  // Cancel any pending dispatch for the fake session (this run's row if the
  // smoke failed before delivery) so a retry doesn't start FIFO-blocked behind
  // a leftover. Best-effort — a row already delivered/cancelled is a no-op.
  try {
    const pend = await get(`/dispatch-queue?session_id=${encodeURIComponent(FAKE_SESSION)}`);
    for (const row of Array.isArray(pend) ? pend : []) {
      try { await del(`/dispatch-queue/${encodeURIComponent(row.id)}`); } catch {}
    }
  } catch {}
  // Archive scratch ticket.
  if (ticketId) { try { await patch(`/tickets/${encodeURIComponent(ticketId)}`, { state: 'archived' }); } catch {} }
  // Cleanup rig: remove the fake registry file + the fake channels.json entry
  // (ONLY the fake entry — other sessions' registrations are live state).
  try { fs.rmSync(REGISTRY_FILE, { force: true }); } catch {}
  try { removeFakeChannel(); } catch {}
  try { fakeChannel.close(); } catch {}
  await cleanup();
}