// TKT-0266: tickets assignment is not clearly working.
//
// Journey smoke covering the five asks:
//   1. Durable session-name assignees — a session_labels row persists the
//      friendly name; the board card + ticket detail show it (even after the
//      session goes offline). Keyed off nativeSessions (not dispatchable) so a
//      named session without a channel still gets a persisted name.
//   2. Rotating gear on actively-worked tickets — in_progress + busy live
//      assignee → gear on the card; idle → gear gone; offline → gear gone.
//   3. Color-coded kind pills — work-item/fix/question/spec/decision each get
//      a distinct hue on both the board card and the drawer header.
//   4. Done column in reverse-chronological order — most recently done first.
//   5. Agent proactiveness is plugin text only (no dashboard assertion here).
//
// Rig: reuses the fake-session pattern from smoke-tkt-0245.mjs — an injected
// ~/.claude/sessions/<pid>.json with the smoke's OWN live pid becomes a live
// native session. No fake channel is needed (labels don't require
// dispatchability). The registry file carries a `name` so the label writer
// persists it. Cleanup is surgical: ONLY the fake registry file is removed.

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
const FAKE_SESSION = 'smoke-0266-agent';
const FAKE_NAME = 'smoke:agent:alpha';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const REGISTRY_FILE = path.join(SESSIONS_DIR, `${process.pid}.json`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) =>
  fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (p, body) =>
  fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
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
    name: FAKE_NAME,
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(doc));
}

// Board helpers — find a card by ticket id, return a DOM handle descriptor.
const cardAssigneeText = (id) =>
  `(() => {
    const c = document.querySelector('[data-ticket-id="${id}"]');
    if (!c) return null;
    const a = c.querySelector('.ticket-assignee');
    return a ? a.textContent.trim() : null;
  })()`;
const cardHasGear = (id) =>
  `(() => {
    const c = document.querySelector('[data-ticket-id="${id}"]');
    return !!(c && c.querySelector('.gear-working'));
  })()`;
const cardKindPillStyle = (id) =>
  `(() => {
    const c = document.querySelector('[data-ticket-id="${id}"]');
    if (!c) return null;
    const p = c.querySelector('.tracker-kind-pill');
    if (!p) return null;
    const cs = getComputedStyle(p);
    return { color: cs.color, background: cs.backgroundColor, border: cs.borderColor, kind: p.getAttribute('data-kind') };
  })()`;
const drawerKindPillStyle = () =>
  `(() => {
    const p = document.querySelector('.td-kind-pill');
    if (!p) return null;
    const cs = getComputedStyle(p);
    return { color: cs.color, background: cs.backgroundColor, border: cs.borderColor, kind: p.getAttribute('data-kind') };
  })()`;
const doneColumnOrder = () =>
  `(() => {
    const col = document.querySelector('[data-col="done"]');
    if (!col) return [];
    return Array.from(col.querySelectorAll('[data-ticket-id]')).map((e) => e.getAttribute('data-ticket-id'));
  })()`;

let ticketA = null, ticketB = null, ticketC = null;
const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

try {
  // ── 1. Rig: registry file (busy, named) ───────────────────────────────────
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  writeRegistry('busy');

  // Poll until the server's 3s refresh discovers the fake session (busy). The
  // label writer runs in the same refreshNativeSessions tick, so once the
  // session is visible here its label is already persisted to session_labels.
  const sessionsSeen = await poll(
    () => get('/native-sessions'),
    (list) => Array.isArray(list) && list.some((s) => s.session_id === FAKE_SESSION && s.status === 'busy'),
    12_000,
  );
  const fake = sessionsSeen.find((s) => s.session_id === FAKE_SESSION);
  assert.ok(fake, 'fake session discovered in native-sessions');
  assert.equal(fake.status, 'busy', `fake session status busy (got ${fake.status})`);
  assert.equal(fake.name, FAKE_NAME, `fake session name persisted in-memory (got ${fake.name})`);

  // Cross-check the label landed in session_labels via the DB-backed detail
  // endpoint — assign a throwaway ticket, then read it back. Actually, we
  // verify the label via the real ticket below; here just confirm the session
  // is alive + named.
  assert.ok(fake.alive, 'fake session is alive (own pid)');

  // ── 2. Create scratch tickets A (work-item), B (fix), C (question) ────────
  ticketA = await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0266 A', body: 'Scratch A.' });
  ticketB = await post('/tickets', { project_id: PROJECT, kind: 'fix', created_by: 'smoke', title: 'SMOKE-0266 B', body: 'Scratch B.' });
  ticketC = await post('/tickets', { project_id: PROJECT, kind: 'question', created_by: 'smoke', title: 'SMOKE-0266 C', body: 'Scratch C.' });
  assert.ok(ticketA.id && ticketB.id && ticketC.id, 'created scratch tickets A, B, C');
  assert.equal(ticketA.kind, 'work-item', 'A is work-item');
  assert.equal(ticketB.kind, 'fix', 'B is fix');
  assert.equal(ticketC.kind, 'question', 'C is question');

  // ── 3. PATCH A: assignee = fake session, state = in_progress ──────────────
  // Wait ≤10s (the plan) — the session is already discovered, so assign now.
  await patch(`/tickets/${encodeURIComponent(ticketA.id)}`, { assignee: FAKE_SESSION, state: 'in_progress' });

  // Durable label: GET A detail → assignee_label === FAKE_NAME.
  const detailA = await poll(
    () => get(`/tickets/${encodeURIComponent(ticketA.id)}`),
    (t) => t.assignee === FAKE_SESSION && t.state === 'in_progress',
    5_000,
  );
  assert.equal(detailA.assignee, FAKE_SESSION, 'A assigned to fake session');
  assert.equal(detailA.state, 'in_progress', 'A is in_progress');
  assert.equal(detailA.assignee_label, FAKE_NAME, `A assignee_label is the durable name (got ${detailA.assignee_label})`);
  // The label is the friendly name, NOT the uuid stub.
  assert.ok(!/smoke-0266-agent/.test(detailA.assignee_label || ''), 'assignee_label is not the raw session id');

  // ── 3b. Board (headless): A's card shows the durable name ─────────────────
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(800);
  await page.waitForSelector(`[data-ticket-id="${ticketA.id}"]`, { timeout: 8000 });
  await wait(400);
  const aAssignee = await page.evaluate(cardAssigneeText(ticketA.id));
  assert.ok(aAssignee, 'A card has a .ticket-assignee row');
  assert.ok(aAssignee.includes(FAKE_NAME), `A card assignee text contains the durable name (got "${aAssignee}")`);
  assert.ok(!/smoke-0266-agent/.test(aAssignee), `A card assignee text does NOT contain the raw session id (got "${aAssignee}")`);

  // ── 4. Gear live: A's card has .gear-working (busy + in_progress) ─────────
  const gearBusy = await page.evaluate(cardHasGear(ticketA.id));
  assert.ok(gearBusy, 'A card has .gear-working while assignee is busy');

  // Flip registry to idle → gear gone (poll ≤10s for the 3s refresh + WS).
  writeRegistry('idle');
  await poll(() => page.evaluate(cardHasGear(ticketA.id)), (g) => g === false, 12_000);
  const gearIdle = await page.evaluate(cardHasGear(ticketA.id));
  assert.equal(gearIdle, false, 'A card gear gone after assignee flips to idle');

  // Set B (unassigned) to in_progress → no gear on B (no assignee → not worked).
  await patch(`/tickets/${encodeURIComponent(ticketB.id)}`, { state: 'in_progress' });
  await poll(
    () => page.evaluate(cardAssigneeText(ticketB.id)),
    (t) => !!t,
    5_000,
  );
  const gearB = await page.evaluate(cardHasGear(ticketB.id));
  assert.equal(gearB, false, 'B card has no gear (unassigned, even though in_progress)');

  // ── 5. Durability after death: delete the registry → session offline ──────
  fs.rmSync(REGISTRY_FILE, { force: true });
  // Wait for the server to drop the session (next 3s tick), then reload board.
  await poll(
    () => get('/native-sessions'),
    (list) => Array.isArray(list) && !list.some((s) => s.session_id === FAKE_SESSION),
    12_000,
  );
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);
  await page.waitForSelector(`[data-ticket-id="${ticketA.id}"]`, { timeout: 8000 });
  await wait(400);
  const aAssigneeAfter = await page.evaluate(cardAssigneeText(ticketA.id));
  assert.ok(aAssigneeAfter.includes(FAKE_NAME), `A card still shows the durable name after session death (got "${aAssigneeAfter}")`);
  const gearDead = await page.evaluate(cardHasGear(ticketA.id));
  assert.equal(gearDead, false, 'A card has no gear after session death (offline)');

  // Cross-check via REST: the detail still carries the persisted label.
  const detailA2 = await get(`/tickets/${encodeURIComponent(ticketA.id)}`);
  assert.equal(detailA2.assignee_label, FAKE_NAME, `A detail assignee_label persists after session death (got ${detailA2.assignee_label})`);

  // ── 6. Kind pills: pairwise different colors on board + drawer ───────────
  // Re-write the registry so the session is alive again (for a clean state on
  // the board; not strictly required for the kind-pill check but keeps the
  // board populated with the fake session for any later reuse).
  writeRegistry('busy');
  await page.reload({ waitUntil: 'networkidle' });
  await wait(700);
  await page.waitForSelector(`[data-ticket-id="${ticketA.id}"]`, { timeout: 8000 });
  const ka = await page.evaluate(cardKindPillStyle(ticketA.id));
  const kb = await page.evaluate(cardKindPillStyle(ticketB.id));
  const kc = await page.evaluate(cardKindPillStyle(ticketC.id));
  assert.ok(ka && kb && kc, 'all three board kind pills found');
  assert.equal(ka.kind, 'work-item', 'A board pill data-kind=work-item');
  assert.equal(kb.kind, 'fix', 'B board pill data-kind=fix');
  assert.equal(kc.kind, 'question', 'C board pill data-kind=question');
  // Pairwise different color AND background.
  assert.notEqual(ka.color, kb.color, 'A vs B kind pill color differs');
  assert.notEqual(ka.color, kc.color, 'A vs C kind pill color differs');
  assert.notEqual(kb.color, kc.color, 'B vs C kind pill color differs');
  assert.notEqual(ka.background, kb.background, 'A vs B kind pill background differs');
  assert.notEqual(ka.background, kc.background, 'A vs C kind pill background differs');
  assert.notEqual(kb.background, kc.background, 'B vs C kind pill background differs');

  // Drawer kind pill matches the board for the same kind (open A's page view).
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticketA.id)}`, { waitUntil: 'networkidle' });
  await wait(700);
  await page.waitForSelector('.td-kind-pill', { timeout: 8000 });
  const da = await page.evaluate(drawerKindPillStyle());
  assert.ok(da, 'drawer .td-kind-pill found');
  assert.equal(da.kind, 'work-item', 'drawer pill data-kind=work-item');
  assert.equal(da.color, ka.color, 'drawer A kind pill color matches board A');
  assert.equal(da.background, ka.background, 'drawer A kind pill background matches board A');

  // ── 7. Done ordering: mark A done, then B done → B above A in Done column ─
  // Go back to the board first.
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(600);
  await patch(`/tickets/${encodeURIComponent(ticketA.id)}`, { state: 'done' });
  // Wait a moment so B's done_at is strictly newer than A's (ms-precision ISO).
  await wait(1200);
  await patch(`/tickets/${encodeURIComponent(ticketB.id)}`, { state: 'done' });
  // Wait for both cards to land in the Done column via WS deltas.
  await poll(
    () => page.evaluate(doneColumnOrder()),
    (order) => Array.isArray(order) && order.includes(ticketA.id) && order.includes(ticketB.id),
    8_000,
  );
  const doneOrder = await page.evaluate(doneColumnOrder());
  const ia = doneOrder.indexOf(ticketA.id);
  const ib = doneOrder.indexOf(ticketB.id);
  assert.ok(ia >= 0 && ib >= 0, `both A and B are in the Done column (got ${JSON.stringify(doneOrder)})`);
  assert.ok(ib < ia, `B appears above A in the Done column (B index ${ib} < A index ${ia}; order ${JSON.stringify(doneOrder)})`);

  // ── 8. Zero pageerrors ───────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({
    ok: true,
    ticketA: ticketA.id,
    ticketB: ticketB.id,
    ticketC: ticketC.id,
    assigneeLabel: detailA.assignee_label,
    assigneeLabelAfterDeath: detailA2.assignee_label,
    gearBusy, gearIdle, gearDead,
    kindPills: { board: { a: ka, b: kb, c: kc }, drawer: da },
    doneOrder,
  }, null, 2));
} finally {
  // Archive scratch tickets (best-effort).
  for (const t of [ticketA, ticketB, ticketC]) {
    if (t && t.id) { try { await patch(`/tickets/${encodeURIComponent(t.id)}`, { state: 'archived' }); } catch {} }
  }
  // Cleanup rig: remove ONLY the fake registry file (no channels.json edit was made).
  try { fs.rmSync(REGISTRY_FILE, { force: true }); } catch {}
  await cleanup();
}