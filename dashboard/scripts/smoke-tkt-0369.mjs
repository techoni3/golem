// TKT-0369: an alive session whose channel MCP died must stay visible in the
// dispatch dropdown (reachable:false), and a queued dispatch to it must HOLD
// pending (not burn) until the channel re-registers — then auto-deliver.
// Plus the UI shows an "unreachable · will queue" hint and defaults the mode
// to When-idle. Modeled on the TKT-0245 fake-session rig.
//
// Journey:
//   1. Fake alive+idle session A with NO channels.json entry + a scratch ticket.
//   2. GET /api/sessions/dispatchable → A present, reachable:false, channel_url:null.
//   3. POST /tickets/:id/dispatch {mode:'when_idle'} → queued:true + a pending row.
//   4. Wait ≥2 drainer ticks (~12s) → row STILL pending, last_error empty, ticket
//      NOT dispatched (dispatched_to unset). (locks Part 2b — the TKT-0339 burn.)
//   5. Start a fake channel receiver + append A's channels.json entry → poll
//      ~15s → row delivered, the brief arrived, ticket dispatched to A.
//   6. UI (headless): a second unreachable session B live → open the scratch
//      ticket's drawer → B's picker option shows "unreachable · will queue";
//      selecting B sets the mode toggle to When-idle.
//   7. Zero pageerror. Cleanup: archive scratch, remove fake registry files,
//      remove ONLY our channels.json entries, kill the receiver.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import { strict as assert } from 'node:assert';
import { acquireChrome } from './_chrome.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ABS = path.resolve(__dirname, '..', '..');
const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const PROJECT = 'golem-1eba80';
// Per-run unique session ids + registry filenames so the drainer's 60s
// per-session cooldown (lastDeliveredAt — in-memory, persists across smoke runs
// on the same dashboard) can't block a re-run's delivery: each run delivers to a
// fresh session_id. (This is the same class of flake the 0245 smoke's pre-clean
// solved for FIFO-leftover rows.)
const RUN = Date.now().toString(36);
const FAKE_A = `0369-aaaa-fake-${RUN}`; // label "session 0369-aa"
const FAKE_B = `0369-bbbb-fake-${RUN}`; // label "session 0369-bb"
const FAKE_RE = /^0369-(aaaa|bbbb)-fake-/; // pre-clean any prior-run litter
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CHANNELS_FILE = path.join(os.homedir(), '.config', 'golem', 'channels.json');
const REG_A = path.join(SESSIONS_DIR, `${process.pid}.0369a.${RUN}.json`);
const REG_B = path.join(SESSIONS_DIR, `${process.pid}.0369b.${RUN}.json`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (p, body) => fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
const del = (p) => fetch(`${API}${p}`, { method: 'DELETE' }).then((r) => r.json());
const poll = async (fn, pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (pred(v)) return v; await wait(150); }
  return fn();
};

function writeRegistry(file, sessionId, status) {
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd: REPO_ABS, startedAt: Date.now(), updatedAt: Date.now(), status }));
}
function readChannelsDoc() { try { return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')); } catch { return { version: 1, channels: [] }; } }
function writeChannelsDoc(doc) { const tmp = `${CHANNELS_FILE}.tmp.${process.pid}.${Date.now()}`; fs.writeFileSync(tmp, JSON.stringify(doc, null, 2)); fs.renameSync(tmp, CHANNELS_FILE); }
function appendChannel(sessionId, port) {
  const doc = readChannelsDoc();
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  const filtered = channels.filter((c) => c.session_id !== sessionId);
  filtered.push({ session_id: sessionId, name: sessionId, pid: process.pid, host: '127.0.0.1', port, version: '0.1.0', started_at: new Date().toISOString() });
  writeChannelsDoc({ ...doc, channels: filtered });
}
function removeChannel(sessionId) {
  const doc = readChannelsDoc();
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  const filtered = channels.filter((c) => c.session_id !== sessionId);
  if (filtered.length !== channels.length) writeChannelsDoc({ ...doc, channels: filtered });
}

// Fake channel receiver: records POST /brief.
const receivedBriefs = [];
const fakeChannel = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/brief') receivedBriefs.push({ body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kind: 'brief' }));
  });
});

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let ticketId = null;
const created = [];
try {
  // ── Pre-clean: cancel ANY leftover 0369-fake pending rows + channels entries
  // (prior runs' litter — unique per-run ids mean THIS run's ids have no rows
  // yet, but a crashed prior run might have left rows/entries behind). ─────────
  const allPend = await get('/dispatch-queue');
  for (const row of Array.isArray(allPend) ? allPend : []) {
    if (FAKE_RE.test(row.session_id || '')) { try { await del(`/dispatch-queue/${encodeURIComponent(row.id)}`); } catch {} }
  }
  {
    const doc = readChannelsDoc();
    const channels = Array.isArray(doc.channels) ? doc.channels : [];
    const filtered = channels.filter((c) => !FAKE_RE.test(c.session_id || ''));
    if (filtered.length !== channels.length) writeChannelsDoc({ ...doc, channels: filtered });
  }
  for (const f of [REG_A, REG_B]) { try { fs.rmSync(f, { force: true }); } catch {} }

  // ── 1. Fake alive+idle session A with NO channel + a scratch ticket ──────
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  writeRegistry(REG_A, FAKE_A, 'idle');
  ticketId = (await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0369 unreach', body: 'scratch for the unreachable-session smoke.' })).id;
  created.push(ticketId);
  assert.ok(ticketId, 'created scratch ticket');

  // ── 2. dispatchable shows A with reachable:false, channel_url:null ───────
  const disp = await poll(
    () => get(`/sessions/dispatchable?project=${PROJECT}`),
    (list) => Array.isArray(list) && list.some((s) => s.session_id === FAKE_A),
    10_000,
  );
  const a = disp.find((s) => s.session_id === FAKE_A);
  assert.ok(a, 'fake session A is listed in dispatchable (NOT silently dropped)');
  assert.equal(a.reachable, false, 'A reachable:false (no channel registered)');
  assert.equal(a.channel_url, null, 'A channel_url:null');

  // ── 3. POST dispatch when_idle → queued:true (no fall-through despite idle) ──
  const qres = await post(`/tickets/${encodeURIComponent(ticketId)}/dispatch`, { session_id: FAKE_A, mode: 'when_idle' });
  assert.equal(qres.queued, true, `when_idle to an idle-but-unreachable session queues (got queued=${qres.queued})`);
  const detailAfterQueue = await get(`/tickets/${encodeURIComponent(ticketId)}`);
  assert.ok(detailAfterQueue.pending_dispatch, 'ticket detail has pending_dispatch after queue');

  // ── 4. Wait ≥2 drainer ticks → row STILL pending, ticket NOT dispatched ───
  await wait(12_000);
  const rowsA = await get(`/dispatch-queue?session=${encodeURIComponent(FAKE_A)}`);
  const pendingRow = Array.isArray(rowsA) ? rowsA.find((r) => r.ticket_id === ticketId) : null;
  assert.ok(pendingRow, 'the queued row is STILL pending after 12s (held, not burned)');
  assert.equal(pendingRow.status, 'pending', `row status pending (got ${pendingRow.status})`);
  assert.ok(!pendingRow.last_error, `row last_error empty (got "${pendingRow.last_error}")`);
  const detailHeld = await get(`/tickets/${encodeURIComponent(ticketId)}`);
  assert.ok(!detailHeld.dispatched_to, 'ticket NOT dispatched while the channel is down (dispatched_to unset)');
  assert.equal(receivedBriefs.length, 0, 'no brief pushed while unreachable');

  // ── 5. Start the fake channel + register A → row delivers, brief arrives ──
  await new Promise((resolve) => fakeChannel.listen(0, '127.0.0.1', resolve));
  const channelPort = fakeChannel.address().port;
  appendChannel(FAKE_A, channelPort);
  const delivered = await poll(
    () => get(`/tickets/${encodeURIComponent(ticketId)}`),
    (t) => !!t.dispatched_to && t.dispatched_to === FAKE_A && !t.pending_dispatch,
    20_000,
  );
  assert.equal(delivered.dispatched_to, FAKE_A, 'ticket dispatched to A after the channel re-registered');
  assert.ok(!delivered.pending_dispatch, 'pending_dispatch gone after delivery');
  await poll(() => Promise.resolve(receivedBriefs.length), (n) => n >= 1, 3_000);
  assert.equal(receivedBriefs.length, 1, `exactly one brief delivered to the receiver (got ${receivedBriefs.length})`);
  assert.ok(receivedBriefs[0].body.includes(ticketId), 'the delivered brief contains the ticket id');

  // ── 6. UI: a second unreachable session B → picker hint + When-idle default ──
  writeRegistry(REG_B, FAKE_B, 'idle'); // B is alive+idle, NO channel → unreachable
  // Wait for state.js (3s) to pick up B so the drawer's dispatchable fetch includes it.
  await poll(
    () => get(`/sessions/dispatchable?project=${PROJECT}`),
    (list) => Array.isArray(list) && list.some((s) => s.session_id === FAKE_B && s.reachable === false),
    10_000,
  );
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticketId)}`, { waitUntil: 'networkidle' });
  await wait(800);
  // Wait for the drawer's dispatchable fetch to land — the PopSelect trigger is
  // disabled while dispatchable is empty, so a click before the fetch completes
  // is a no-op (the menu never opens).
  await poll(
    () => page.evaluate(() => {
      const t = document.querySelector('.td-side .td-prop-dispatch .ps-trigger');
      return !!(t && !t.disabled);
    }),
    (ok) => !!ok,
    10_000,
  );
  // Open the dispatch PopSelect + poll for B's option. The options can render a
  // tick after the menu container (a portal/render race) — a poll catches that
  // without re-opening (and Escape is off-limits: on the page view it triggers
  // history.back and unmounts the drawer).
  await page.click('.td-side .td-prop-dispatch .ps-trigger');
  await page.waitForSelector('.ps-menu', { timeout: 8000 });
  const bLabel = `session ${FAKE_B.slice(0, 8)}`;
  const bOpt = await poll(
    () => page.evaluate((label) => {
      const opt = Array.from(document.querySelectorAll('.ps-option')).find((o) => (o.querySelector('.ps-option-label')?.textContent || '') === label);
      if (!opt) return null;
      return { hint: opt.querySelector('.ps-hint')?.textContent || null, labels: Array.from(document.querySelectorAll('.ps-option')).map((o) => o.querySelector('.ps-option-label')?.textContent || '') };
    }, bLabel),
    (v) => !!v,
    6000,
  );
  assert.ok(bOpt && bOpt.hint && /unreachable · will queue/.test(bOpt.hint), `B's picker option shows "unreachable · will queue" (got "${bOpt ? bOpt.hint : null}"; labels: ${bOpt ? bOpt.labels.join('|') : '—'})`);
  // Select B → the mode toggle should default to When-idle.
  await page.evaluate((label) => {
    const opt = Array.from(document.querySelectorAll('.ps-option')).find((o) => (o.querySelector('.ps-option-label')?.textContent || '') === label);
    if (opt) opt.click();
  }, bLabel);
  await wait(300);
  const modeState = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.td-dispatch-mode-btn'));
    const whenIdle = btns.find((b) => /When idle/.test(b.textContent));
    const go = document.querySelector('.td-dispatch-go');
    return { whenIdlePressed: whenIdle ? whenIdle.getAttribute('aria-pressed') : null, goLabel: go?.textContent || null };
  });
  assert.equal(modeState.whenIdlePressed, 'true', `selecting an unreachable target defaults the mode to When-idle (aria-pressed=${modeState.whenIdlePressed})`);
  assert.ok(/Queue/.test(modeState.goLabel || ''), `dispatch button reads "Queue" for When-idle (got "${modeState.goLabel}")`);
  // Close the PopSelect if still open.
  await page.evaluate(() => { document.querySelector('.ps-menu')?.remove(); });

  // ── 7. Zero pageerror ────────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({
    ok: true,
    ticketId,
    reachableA: a.reachable,
    heldPendingStatus: pendingRow.status,
    heldLastError: pendingRow.last_error,
    deliveredTo: delivered.dispatched_to,
    briefsReceived: receivedBriefs.length,
    bHint: bOpt.hint,
    whenIdlePressed: modeState.whenIdlePressed,
  }, null, 2));
} finally {
  for (const sid of [FAKE_A, FAKE_B]) {
    try { const pend = await get(`/dispatch-queue?session=${encodeURIComponent(sid)}`); for (const row of Array.isArray(pend) ? pend : []) { try { await del(`/dispatch-queue/${encodeURIComponent(row.id)}`); } catch {} } } catch {}
    try { removeChannel(sid); } catch {}
  }
  for (const id of created) { try { await patch(`/tickets/${encodeURIComponent(id)}`, { state: 'archived' }); } catch {} }
  for (const f of [REG_A, REG_B]) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fakeChannel.close(); } catch {}
  await cleanup();
}