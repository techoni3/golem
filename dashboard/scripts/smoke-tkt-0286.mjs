// TKT-0286: dispatch queue visibility — journey smoke.
//
// Reuses the TKT-0245 fake-session rig (registry file with the smoke's own
// live pid + a fake channel receiver + channels.json entry): the fake session
// is "busy" so dispatches queue (mode when_idle) instead of delivering. The
// queue-wide surfaces then render off that rig:
//   1. API: GET /api/dispatch-queue (no args) → both queued rows, FIFO, each
//      enriched with ticket_title + session_label; ?session= filter works.
//   2. Agents page: the fake session's card shows "⏳ 2 queued"; its peek
//      drawer's Dispatch queue section lists both tickets with Cancel.
//   3. Board: the queued ticket's card shows the ⏳ glyph; a plain (never
//      dispatched) ticket doesn't.
//   4. Live cancel: click Cancel on the first queue row in the drawer → the
//      list shows only the second within ~3s (WS signal, no reload); the
//      cancelled ticket's board card loses the ⏳.
//   5. Offline orphans: delete the fake registry file → within ~10s the
//      Agents page shows "Queued for offline sessions" with the remaining
//      row, labeled via the persisted session_labels ('smoke:agent:queue').
//   6. Zero pageerror.
// Cleanup is surgical: cancel the remaining queue row via API, archive the
// scratch tickets, remove the rig (registry file + channels.json entry + the
// fake channel server).

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
const FAKE_SESSION = 'smoke-0286-fake';
const FAKE_NAME = 'smoke:agent:queue';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CHANNELS_FILE = path.join(os.homedir(), '.config', 'golem', 'channels.json');
const REGISTRY_FILE = path.join(SESSIONS_DIR, `${process.pid}.json`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
const del = (p) => fetch(`${API}${p}`, { method: 'DELETE' }).then((r) => r.json());
const patch = (p, body) => fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const poll = async (fn, pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (pred(v)) return v; await wait(150); }
  return fn();
};

// --- Rig helpers (adapted from smoke-tkt-0245.mjs) -------------------------
function writeRegistry(status) {
  const doc = {
    pid: process.pid,
    sessionId: FAKE_SESSION,
    cwd: REPO_ABS,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status,
    name: FAKE_NAME, // TKT-0286: so state.js upserts session_labels → the offline-orphans label resolves.
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(doc));
}
function readChannelsDoc() { try { return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')); } catch { return { version: 1, channels: [] }; } }
function writeChannelsDoc(doc) { const tmp = `${CHANNELS_FILE}.tmp.${process.pid}.${Date.now()}`; fs.writeFileSync(tmp, JSON.stringify(doc, null, 2)); fs.renameSync(tmp, CHANNELS_FILE); }
function appendFakeChannel(port) {
  const doc = readChannelsDoc();
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  const filtered = channels.filter((c) => c.session_id !== FAKE_SESSION);
  filtered.push({ session_id: FAKE_SESSION, name: FAKE_NAME, pid: process.pid, host: '127.0.0.1', port, version: '0.1.0', started_at: new Date().toISOString() });
  writeChannelsDoc({ ...doc, channels: filtered });
}
function removeFakeChannel() {
  const doc = readChannelsDoc();
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  const filtered = channels.filter((c) => c.session_id !== FAKE_SESSION);
  if (filtered.length !== channels.length) writeChannelsDoc({ ...doc, channels: filtered });
}

// --- Fake channel server: records POST /brief (unused by this smoke, but
//     required for the session to be dispatchable — channels.json intersects
//     native-sessions). Kept identical to 0245 so the rig is honest.
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

const created = [];
let ticketA = null, ticketB = null, ticketC = null;
try {
  // ── 1. Rig: fake channel server + registry (busy) + channels.json ────────
  await new Promise((resolve) => fakeChannel.listen(0, '127.0.0.1', resolve));
  const channelPort = fakeChannel.address().port;

  // Pre-clean: cancel any leftover pending rows for the fake session from a
  // prior (failed) run — FIFO would otherwise block this run's queue/delivery.
  const leftovers = await get(`/dispatch-queue?session=${encodeURIComponent(FAKE_SESSION)}`);
  for (const row of Array.isArray(leftovers) ? leftovers : []) {
    try { await del(`/dispatch-queue/${encodeURIComponent(row.id)}`); } catch {}
  }

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  writeRegistry('busy');
  appendFakeChannel(channelPort);

  // ── 2. Scratch tickets A + B (queued) + C (plain, never dispatched) ─────
  ticketA = (await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0286 A', body: 'First scratch ticket for the dispatch-queue smoke.' })).id; created.push(ticketA);
  ticketB = (await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0286 B', body: 'Second scratch ticket for the dispatch-queue smoke.' })).id; created.push(ticketB);
  ticketC = (await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0286 C plain', body: 'Plain — never dispatched.' })).id; created.push(ticketC);
  assert.ok(ticketA && ticketB && ticketC, 'created scratch tickets A + B + C');

  // ── 3. Poll dispatchable until the fake session appears busy ─────────────
  await poll(
    () => get(`/sessions/dispatchable?project=${PROJECT}`),
    (list) => Array.isArray(list) && list.some((s) => s.session_id === FAKE_SESSION && s.status === 'busy'),
    10_000,
  );

  // ── 4. Queue A + B (mode when_idle while busy → they queue, not deliver) ──
  for (const id of [ticketA, ticketB]) {
    const r = await post(`/tickets/${encodeURIComponent(id)}/dispatch`, { session_id: FAKE_SESSION, mode: 'when_idle' });
    assert.equal(r.queued, true, `queue ${id}: queued:true (got ${r.queued})`);
  }
  // Give the fake session a refresh cycle (3s) so state.js upserts the
  // session_labels row (needed for the offline-orphans label in step 5).
  await wait(3500);

  // ── 5. API: GET /api/dispatch-queue (no args) + ?session= filter ──────────
  const allQ = await get('/dispatch-queue');
  assert.ok(Array.isArray(allQ), 'GET /dispatch-queue returns an array');
  const mine = allQ.filter((r) => r.session_id === FAKE_SESSION);
  assert.equal(mine.length, 2, `both scratch tickets queued for the fake session (got ${mine.length})`);
  // FIFO by created_at — A was queued first.
  assert.deepEqual(mine.map((r) => r.ticket_id), [ticketA, ticketB], 'queue order is FIFO (A then B)');
  assert.ok(mine.every((r) => typeof r.ticket_title === 'string' && r.ticket_title.length > 0), 'each row is enriched with ticket_title');
  assert.ok(mine.every((r) => r.session_label === FAKE_NAME), `each row is enriched with session_label="${FAKE_NAME}"`);
  // ?session= filter
  const bySession = await get(`/dispatch-queue?session=${encodeURIComponent(FAKE_SESSION)}`);
  assert.equal(bySession.length, 2, '?session= filter returns both rows');

  // ── 6. Agents page: card chip + peek drawer queue list ───────────────────
  await page.goto(`${ORIGIN}/agents`, { waitUntil: 'networkidle' });
  await wait(700);
  // The fake session is busy → Working section. Find its card by name.
  let chip = await page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.native-session-card')).find((c) => c.textContent.includes(name));
    return card ? (card.querySelector('.native-session-queue-chip')?.textContent || null) : null;
  }, FAKE_NAME);
  assert.ok(chip && /2 queued/.test(chip), `fake session card shows "⏳ 2 queued" (got "${chip}")`);

  // Open the peek drawer for the fake session (URL overlay ?ns=).
  await page.evaluate((sid) => window.openNativeSessionDrawer(sid), FAKE_SESSION);
  await wait(800);
  await page.waitForSelector('.nsd-queue-row', { timeout: 5000 });
  let drawerRows = await page.evaluate(() => Array.from(document.querySelectorAll('.nsd-queue-row')).map((row) => ({
    id: row.querySelector('.nsd-queue-ticket .mono')?.textContent || '',
    hasCancel: !!row.querySelector('.nsd-queue-cancel'),
  })));
  assert.equal(drawerRows.length, 2, `peek drawer queue section lists both rows (got ${drawerRows.length})`);
  assert.deepEqual(drawerRows.map((r) => r.id), [ticketA, ticketB], 'drawer queue order is FIFO (A then B)');
  assert.ok(drawerRows.every((r) => r.hasCancel), 'each drawer queue row has a Cancel button');

  // ── 7. Board: A shows ⏳, C (plain) doesn't ────────────────────────────────
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(700);
  let boardGlyphs = await page.evaluate(({ a, c }) => ({
    aHas: !!document.querySelector(`.ticket[data-ticket-id="${a}"] .ticket-queue-glyph`),
    cHas: !!document.querySelector(`.ticket[data-ticket-id="${c}"] .ticket-queue-glyph`),
  }), { a: ticketA, c: ticketC });
  assert.ok(boardGlyphs.aHas, 'queued ticket A shows the ⏳ glyph on the board');
  assert.ok(!boardGlyphs.cHas, 'plain (never-dispatched) ticket C has no ⏳ glyph');

  // ── 8. Live cancel: cancel A in the drawer → list shows only B (WS) ───────
  await page.goto(`${ORIGIN}/agents`, { waitUntil: 'networkidle' });
  await wait(500);
  await page.evaluate((sid) => window.openNativeSessionDrawer(sid), FAKE_SESSION);
  await wait(800);
  await page.waitForSelector('.nsd-queue-row', { timeout: 5000 });
  // Click Cancel on the FIRST row (A).
  await page.evaluate(() => document.querySelector('.nsd-queue-row .nsd-queue-cancel')?.click());
  // The dispatch-queue-updated WS signal refetches the drawer's queue; poll for 1 row.
  let afterCancel = null;
  for (let i = 0; i < 30; i++) {
    afterCancel = await page.evaluate(() => Array.from(document.querySelectorAll('.nsd-queue-row .nsd-queue-ticket .mono')).map((m) => m.textContent));
    if (afterCancel.length === 1) break;
    await wait(200);
  }
  assert.deepEqual(afterCancel, [ticketB], `after cancelling A, the drawer shows only B (got ${JSON.stringify(afterCancel)})`);

  // A's board card loses the ⏳ (its ticket-updated broadcast cleared pending_dispatch).
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(700);
  let boardAfter = await page.evaluate(({ a, b }) => ({
    aHas: !!document.querySelector(`.ticket[data-ticket-id="${a}"] .ticket-queue-glyph`),
    bHas: !!document.querySelector(`.ticket[data-ticket-id="${b}"] .ticket-queue-glyph`),
  }), { a: ticketA, b: ticketB });
  assert.ok(!boardAfter.aHas, 'A loses the ⏳ after its dispatch is cancelled');
  assert.ok(boardAfter.bHas, 'B still has the ⏳ (still queued)');

  // ── 9. Offline orphans: delete the registry file → B shows in orphans ─────
  fs.rmSync(REGISTRY_FILE, { force: true });
  // Navigate to /agents and poll for the offline-orphans section (the 3s
  // native-sessions refresh drops the fake session from the alive list; B
  // — still queued — becomes an orphan labeled via session_labels).
  await page.goto(`${ORIGIN}/agents`, { waitUntil: 'networkidle' });
  let orphan = null;
  for (let i = 0; i < 50; i++) {
    orphan = await page.evaluate(() => {
      const section = document.querySelector('.agents-section-orphans');
      if (!section) return null;
      // TKT-0369: the orphans section may list OTHER stale rows (e.g. a user's
      // test dispatch to a non-existent session) — find B among ALL the rows,
      // don't assume it's the first.
      const rows = Array.from(section.querySelectorAll('.orphan-row'));
      const ticketIds = Array.from(section.querySelectorAll('.orphan-ticket-link .mono')).map((e) => e.textContent || '');
      const labels = Array.from(section.querySelectorAll('.orphan-session-label')).map((e) => e.textContent || '');
      return { hasSection: true, rowCount: rows.length, ticketIds, labels };
    });
    if (orphan && orphan.ticketIds.includes(ticketB)) break;
    await wait(200);
  }
  assert.ok(orphan && orphan.ticketIds.includes(ticketB), `offline-orphans section shows the still-queued ticket B (rows: ${orphan ? orphan.ticketIds.join(',') : 'none'})`);
  const bIdx = orphan ? orphan.ticketIds.indexOf(ticketB) : -1;
  assert.ok(bIdx >= 0 && orphan.labels[bIdx] === FAKE_NAME, `orphan row for B labeled via persisted session_labels (got "${bIdx >= 0 ? orphan.labels[bIdx] : '—'}")`);

  // ── 10. Zero pageerrors ──────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({
    ok: true,
    ticketA, ticketB, ticketC,
    queueRows: mine.length,
    drawerRows: drawerRows.length,
    orphanLabel: bIdx >= 0 ? orphan.labels[bIdx] : null,
  }, null, 2));
} finally {
  // Cancel any remaining pending queue rows for the fake session (B if step 9 ran).
  try {
    const pend = await get(`/dispatch-queue?session=${encodeURIComponent(FAKE_SESSION)}`);
    for (const row of Array.isArray(pend) ? pend : []) {
      try { await del(`/dispatch-queue/${encodeURIComponent(row.id)}`); } catch {}
    }
  } catch {}
  for (const id of created) { try { await patch(`/tickets/${encodeURIComponent(id)}`, { state: 'archived' }); } catch {} }
  try { fs.rmSync(REGISTRY_FILE, { force: true }); } catch {}
  try { removeFakeChannel(); } catch {}
  try { fakeChannel.close(); } catch {}
  await cleanup();
}