// TKT-0519: per-project display ids + smoke quarantine + resolve button.
// Verifies: migration invariants (REST), allocation (consecutive SMO-n via the
// helper, golem untouched), UI (GOL- card + drawer header + search), and the
// Part A resolve journey. Uses _scratch.mjs for fixtures; headless Chrome for UI.

import { acquireChrome } from './_chrome.mjs';
import { createScratchTicket, archiveTicket, SMOKE_PROJECT } from './_scratch.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const GOLEM = 'golem-1eba80';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
const patch = (p, body) => fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const poll = async (fn, pred, ms) => { const d = Date.now() + ms; while (Date.now() < d) { const v = await fn(); if (pred(v)) return v; await wait(150); } return fn(); };

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

const created = [];
try {
  // ── 1. Migration invariants (REST) ────────────────────────────────────────
  const all = await get('/tickets');
  assert.ok(Array.isArray(all) && all.length > 0, 'tickets returned');
  const nullDisp = all.filter((t) => !t.display_id).length;
  const nullPseq = all.filter((t) => t.pseq == null).length;
  assert.equal(nullDisp, 0, `zero NULL display_id (got ${nullDisp})`);
  assert.equal(nullPseq, 0, `zero NULL pseq (got ${nullPseq})`);
  const golemSmoke = all.filter((t) => t.project_id === GOLEM && (t.created_by === 'smoke' || /^SMOKE-/.test(t.title || ''))).length;
  assert.equal(golemSmoke, 0, `zero smoke tickets in golem (got ${golemSmoke})`);
  const t484 = await get('/tickets/TKT-0484');
  assert.equal(t484.project_id, SMOKE_PROJECT, `TKT-0484 quarantined to smoketests (got ${t484.project_id})`);

  // ── 2. Allocation: two scratch tickets → consecutive SMO-n; golem untouched ──
  const golemBefore = (await get(`/tickets?project=${GOLEM}`)).length;
  const s1 = await createScratchTicket({ title: '0519-alloc-A', body: 'allocation check A' });
  const s2 = await createScratchTicket({ title: '0519-alloc-B', body: 'allocation check B' });
  created.push(s1.id, s2.id);
  assert.ok(s1.display_id && /^SMO-\d+$/.test(s1.display_id), `s1 display_id SMO-n (got ${s1.display_id})`);
  assert.ok(s2.display_id && /^SMO-\d+$/.test(s2.display_id), `s2 display_id SMO-n (got ${s2.display_id})`);
  assert.equal(s2.pseq, s1.pseq + 1, `consecutive pseq (s1=${s1.pseq}, s2=${s2.pseq})`);
  const golemAfter = (await get(`/tickets?project=${GOLEM}`)).length;
  assert.equal(golemAfter, golemBefore, `golem ticket count untouched by smoke allocation (was ${golemBefore}, now ${golemAfter})`);

  // ── 3. UI: a golem card shows GOL-…; drawer header + More meta; search ─────
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(700);
  // Find a golem card with a GOL- display id.
  let golCard = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ticket'));
    const g = cards.find((c) => /^GOL-\d+$/.test(c.querySelector('.ticket-id')?.textContent || ''));
    return g ? { displayId: g.querySelector('.ticket-id').textContent, ticketId: g.getAttribute('data-ticket-id') } : null;
  });
  assert.ok(golCard, 'a golem card shows a GOL- display id on the tracker board');
  // Open its drawer → header shows display_id, More meta shows the canonical TKT id.
  await page.evaluate((id) => window.Router.openTicket(id), golCard.ticketId);
  await wait(700);
  await page.waitForSelector('.td-id', { timeout: 5000 });
  let headerId = await page.evaluate(() => document.querySelector('.td-id')?.textContent || '');
  assert.ok(/^GOL-\d+$/.test(headerId), `drawer header shows the display id (got "${headerId}")`);
  // Expand the More meta → the Canonical id row shows the TKT id.
  await page.evaluate(() => document.querySelector('.td-meta-toggle')?.click());
  await wait(300);
  let canonical = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.td-meta-row'));
    const r = rows.find((x) => /Canonical id/.test(x.querySelector('.td-meta-key')?.textContent || ''));
    return r ? (r.querySelector('.mono')?.textContent || '') : null;
  });
  assert.ok(/^TKT-\d+$/.test(canonical || ''), `More meta shows the canonical TKT id (got "${canonical}")`);
  // Board search by display id → the card filters in.
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(600);
  await page.fill('.tracker-search', golCard.displayId);
  await wait(250);
  let found = await page.evaluate((id) => !!document.querySelector(`.ticket[data-ticket-id="${id}"]`), golCard.ticketId);
  assert.ok(found, `typing the display id into board search filters the card in`);
  await page.fill('.tracker-search', '');
  await wait(200);
  // Close the drawer if open.
  await page.evaluate(() => { const c = document.querySelector('.drawer-ticket .drawer-close'); if (c) c.click(); });

  // ── 4. Part A journey: resolve a question ticket ──────────────────────────
  const q = await createScratchTicket({ kind: 'question', title: '0519-resolve-q', body: 'A stale question.', assignee: 'human' });
  created.push(q.id);
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(q.id)}`, { waitUntil: 'networkidle' });
  await wait(800);
  await page.waitForSelector('.td-question-return', { timeout: 5000 });
  // Type an answer + click Resolve.
  await page.fill('.td-qr-input', 'Resolved — the asker is gone.');
  await wait(200);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.td-qr-actions .orch-btn'));
    const r = btns.find((b) => /Resolve/.test(b.textContent));
    if (r) r.click();
  });
  await wait(500);
  // Assert: state=done, the question block is gone, the answer posted as a comment.
  const after = await poll(() => get(`/tickets/${encodeURIComponent(q.id)}`), (t) => t.state === 'done', 5000);
  assert.equal(after.state, 'done', `Resolve → ticket state done (got ${after.state})`);
  assert.ok((after.comments || []).some((c) => /Resolved — the asker is gone/.test(c.body)), 'the answer posted as a comment');
  const blockGone = await page.evaluate(() => !document.querySelector('.td-question-return'));
  assert.ok(blockGone, 'the Answer-&-return block is gone after Resolve');

  // ── 5. Zero pageerror ─────────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({ ok: true, s1: s1.display_id, s2: s2.display_id, golCard: golCard.displayId, canonical, resolved: after.state }, null, 2));
} finally {
  for (const id of created) { try { await archiveTicket(id); } catch {} }
  await cleanup();
}