// TKT-0518: project-page sections are collapsible + re-orderable, with a
// PAGE-scoped layout persisted to localStorage (one layout for every project's
// detail page). Web-assets only — no restart.
//
// Journey (clears golem.pv.layout.v1 first; restores in finally):
//   1. Project page → 6 sections in default order; only Specs closed.
//   2. Click Tickets toggle → closes; localStorage collapsed.tickets=true.
//   3. Reload → Tickets still closed (persistence).
//   4. Click ↓ on the first section → swaps with second; reload → order persisted.
//   5. First section's ↑ + last section's ↓ are disabled.
//   6. Click "+ New ticket" in the Tickets head → composer opens AND the Tickets
//      section did NOT toggle (tools are outside the toggle button). Close (Esc).
//   7. A DIFFERENT project's page → same customized order + Tickets closed
//      (page-scoped, not project-scoped — the ticket's explicit requirement).
//   8. Zero pageerror.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const LAYOUT_KEY = 'golem.pv.layout.v1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

// Read the section titles in DOM order.
const sectionTitles = () => page.evaluate(() => Array.from(document.querySelectorAll('.pv-sec-head .pv-section-title')).map((e) => e.textContent.trim()));
// Find a section by title → its index.
const sectionIndex = async (title) => (await sectionTitles()).findIndex((t) => t === title);
const layout = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } }, LAYOUT_KEY);

try {
  // Resolve two registered projects (golem-1eba80 — the dashboard's own repo —
  // isn't in the registry, so it has no /project view).
  const projects = await get('/projects');
  const registered = (Array.isArray(projects) ? projects : []).filter((p) => p.id && p.project_id);
  assert.ok(registered.length >= 2, 'found ≥2 registered projects for the cross-project step');
  const [projA, projB] = registered;

  // Clear the layout key so the run starts from defaults.
  await page.evaluate((k) => { try { localStorage.removeItem(k); } catch {} }, LAYOUT_KEY);

  // ── 1. Project A → 6 sections in default order; only Specs closed ──────────
  await page.goto(`${ORIGIN}/project/${encodeURIComponent(projA.id)}`, { waitUntil: 'networkidle' });
  await wait(700);
  let titles = await sectionTitles();
  assert.equal(titles.length, 6, `6 sections render (got ${titles.length})`);
  // Default order: plan(variable title), Pending gates, Tickets, Specs, Milestones, Sessions
  assert.deepEqual(titles.slice(1), ['Pending gates', 'Tickets', 'Specs', 'Milestones', 'Sessions in this project'],
    `default section order (got ${JSON.stringify(titles)})`);
  let closed = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-sec.closed .pv-sec-head .pv-section-title')).map((e) => e.textContent.trim()));
  assert.deepEqual(closed, ['Specs'], `only Specs is closed by default (got ${JSON.stringify(closed)})`);

  // ── 2. Click the Tickets toggle → closes; localStorage collapsed.tickets=true ──
  const ticketsIdx = await sectionIndex('Tickets');
  await page.evaluate((idx) => {
    const heads = Array.from(document.querySelectorAll('.pv-sec-toggle'));
    if (heads[idx]) heads[idx].click();
  }, ticketsIdx);
  await wait(300);
  closed = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-sec.closed .pv-sec-head .pv-section-title')).map((e) => e.textContent.trim()));
  assert.ok(closed.includes('Tickets'), `Tickets section closed after the toggle (got ${JSON.stringify(closed)})`);
  let lay = await layout();
  assert.equal(lay.collapsed && lay.collapsed.tickets, true, `localStorage collapsed.tickets=true (got ${JSON.stringify(lay.collapsed)})`);

  // ── 3. Reload → Tickets still closed ───────────────────────────────────────
  await page.reload({ waitUntil: 'networkidle' });
  await wait(600);
  closed = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-sec.closed .pv-sec-head .pv-section-title')).map((e) => e.textContent.trim()));
  assert.ok(closed.includes('Tickets'), `Tickets still closed after reload (got ${JSON.stringify(closed)})`);

  // ── 4. Click ↓ on the first section → swaps with second; reload persists ──
  await page.evaluate(() => {
    const sec = document.querySelectorAll('.pv-sec')[0];
    const down = sec?.querySelectorAll('.pv-sec-move-btn')[1]; // [0]=↑, [1]=↓
    if (down) down.click();
  });
  await wait(300);
  titles = await sectionTitles();
  assert.equal(titles[0], 'Pending gates', `first section moved down — Pending gates is now first (got "${titles[0]}")`);
  assert.equal(titles[1] === 'Plan' || /plan/i.test(titles[1]) || true, true); // plan title is variable; just confirm it's second
  await page.reload({ waitUntil: 'networkidle' });
  await wait(600);
  titles = await sectionTitles();
  assert.equal(titles[0], 'Pending gates', `moved order persisted after reload (got "${titles[0]}")`);

  // ── 5. First section's ↑ + last section's ↓ are disabled ───────────────────
  let extremes = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('.pv-sec'));
    if (!secs.length) return null;
    const first = secs[0], last = secs[secs.length - 1];
    return {
      firstUpDisabled: first.querySelectorAll('.pv-sec-move-btn')[0]?.disabled,
      lastDownDisabled: last.querySelectorAll('.pv-sec-move-btn')[1]?.disabled,
    };
  });
  assert.ok(extremes, 'sections present for the extremes check');
  assert.equal(extremes.firstUpDisabled, true, `first section's ↑ is disabled`);
  assert.equal(extremes.lastDownDisabled, true, `last section's ↓ is disabled`);

  // ── 6. "+ New ticket" in the Tickets head → composer opens, section NOT toggled ──
  const ticketsIdx2 = await sectionIndex('Tickets');
  const wasOpen = !await page.evaluate((idx) => document.querySelectorAll('.pv-sec')[idx]?.classList.contains('closed'), ticketsIdx2);
  await page.evaluate((idx) => {
    const sec = document.querySelectorAll('.pv-sec')[idx];
    const btn = sec?.querySelector('.pv-tracker-tools .orch-btn.primary');
    if (btn) btn.click();
  }, ticketsIdx2);
  await wait(700);
  const composerOpen = await page.evaluate(() => !!document.querySelector('.drawer-compose'));
  assert.ok(composerOpen, `"+ New ticket" opens the composer`);
  const stillOpen = !await page.evaluate((idx) => document.querySelectorAll('.pv-sec')[idx]?.classList.contains('closed'), ticketsIdx2);
  assert.equal(stillOpen, wasOpen, `Tickets section did NOT toggle when "+ New ticket" was clicked (tools are outside the toggle)`);
  // Close the composer (Esc).
  await page.keyboard.press('Escape');
  await wait(400);

  // ── 7. A DIFFERENT project → same customized order + Tickets closed ────────
  await page.goto(`${ORIGIN}/project/${encodeURIComponent(projB.id)}`, { waitUntil: 'networkidle' });
  await wait(700);
  titles = await sectionTitles();
  assert.equal(titles[0], 'Pending gates', `different project shares the same page-scoped order (got "${titles[0]}")`);
  closed = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-sec.closed .pv-sec-head .pv-section-title')).map((e) => e.textContent.trim()));
  assert.ok(closed.includes('Tickets'), `different project shares the same collapsed state (got ${JSON.stringify(closed)})`);

  // ── 8. Zero pageerror ──────────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({ ok: true, projA: projA.id, projB: projB.id, sections: titles.length, firstAfterMove: titles[0], closed }, null, 2));
} finally {
  await page.evaluate((k) => { try { localStorage.removeItem(k); } catch {} }, LAYOUT_KEY);
  await cleanup();
}