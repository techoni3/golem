// TKT-0233: ticket field UX sweep — PopSelect controls, properties panel,
// inline title edit. Journey smoke: creates a scratch ticket via REST, opens
// the page view, and verifies the panel placement/alignment (one left edge for
// title/props/prose), the PopSelect journey (open → select → PATCH lands),
// keyboard nav, inline title edit, and that no native <select> remains in the
// read surface. Archives the scratch ticket in finally.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const PROJECT = 'golem-1eba80';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (path, body) => fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path) => fetch(`${API}${path}`).then((r) => r.json());
const poll = async (path, pred, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await get(path); if (pred(v)) return v; await wait(150); }
  return get(path);
};
// Find a .td-prop by its label text, return a handle to its trigger.
const propTrigger = (labelRe) => `(() => {
  const labels = Array.from(document.querySelectorAll('.td-prop-label'));
  const lab = labels.find((l) => ${labelRe}.test(l.textContent));
  return lab ? !!lab.parentElement.querySelector('.ps-trigger') : false;
})()`;

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let ticketId = null;
try {
  // ── Scratch ticket ───────────────────────────────────────────────────────
  const ticket = await post('/tickets', { project_id: PROJECT, kind: 'task', created_by: 'smoke', title: 'SMOKE-0233 scratch', body: 'Scratch ticket for the TKT-0233 field-UX smoke.\n\nA couple of paragraphs so the body renders.' });
  ticketId = ticket.id;
  assert.ok(ticketId, 'created scratch ticket');

  // ── Open the page view ──────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticketId)}`, { waitUntil: 'networkidle' });
  await wait(800);
  await page.waitForSelector('.td-props', { timeout: 5000 });
  await wait(300);

  // ── 1. Sidebar placement (TKT-0285: .td-props moved into a left .td-side) ──
  const geom = await page.evaluate(() => {
    const side = document.querySelector('.td-side');
    const main = document.querySelector('.td-main');
    const md = document.querySelector('.td-md');
    const stateProp = Array.from(document.querySelectorAll('.td-side .td-prop-label'))
      .find((l) => /State/i.test(l.textContent))?.parentElement;
    return {
      hasSide: !!side,
      hasMain: !!main,
      mdMounted: !!md,
      sideRight: side?.getBoundingClientRect().right,
      mainLeft: main?.getBoundingClientRect().left,
      sideHasState: !!stateProp?.querySelector('.ps-trigger'),
      actionTray: !!document.querySelector('.td-action-tray'),
    };
  });
  assert.ok(geom.hasSide && geom.hasMain, '.td-side + .td-main mounted');
  assert.ok(geom.mdMounted, '.td-md (body) mounted in main');
  assert.ok(geom.sideRight <= geom.mainLeft + 1, `sidebar is left of main (sideRight ${geom.sideRight} <= mainLeft ${geom.mainLeft})`);
  assert.ok(geom.sideHasState, '.td-side contains the State control');
  assert.ok(!geom.actionTray, 'no .td-action-tray in the DOM');

  // ── 2. PopSelect journey: State trigger → listbox → in_progress → PATCH ──
  assert.ok(await page.evaluate(propTrigger('/State/i')), 'State prop has a .ps-trigger');
  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.td-prop-label'));
    const lab = labels.find((l) => /State/i.test(l.textContent));
    lab.parentElement.querySelector('.ps-trigger').click();
  });
  await wait(200);
  assert.ok(await page.evaluate(() => !!document.querySelector('[role="listbox"]')), 'listbox opens on trigger click');
  assert.ok(await page.evaluate(() => { const m = document.querySelector('.ps-menu'); return m && parseInt(getComputedStyle(m).zIndex, 10) >= 90; }), 'menu z-index >= 90');
  await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('.ps-option'));
    const o = opts.find((b) => /in_progress/.test(b.textContent));
    if (o) o.click();
  });
  await wait(300);
  assert.ok(!(await page.evaluate(() => !!document.querySelector('[role="listbox"]'))), 'listbox closes after select');
  const afterState = await poll(`/tickets/${encodeURIComponent(ticketId)}`, (t) => t.state === 'in_progress');
  assert.equal(afterState.state, 'in_progress', 'PATCH landed: state = in_progress');

  // ── 3. Keyboard: Priority trigger → Enter → ArrowDown → Enter → PATCH ────
  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.td-prop-label'));
    const lab = labels.find((l) => /Priority/i.test(l.textContent));
    lab.parentElement.querySelector('.ps-trigger').focus();
  });
  await page.keyboard.press('Enter');
  await wait(150);
  assert.ok(await page.evaluate(() => !!document.querySelector('[role="listbox"]')), 'listbox opens on Enter');
  await page.keyboard.press('ArrowDown');
  await wait(80);
  await page.keyboard.press('Enter');
  await wait(300);
  const afterPrio = await poll(`/tickets/${encodeURIComponent(ticketId)}`, (t) => !!(t.priority && t.priority.length));
  assert.ok(afterPrio.priority, `keyboard select landed a priority (got ${afterPrio.priority})`);

  // ── 4. Inline title edit: click h2 → input (same font-size) → type → Enter ─
  const h2Size = await page.evaluate(() => { const h = document.querySelector('.td-title'); return h ? getComputedStyle(h).fontSize : null; });
  await page.evaluate(() => document.querySelector('.td-title').click());
  await wait(250);
  const inputInfo = await page.evaluate(() => { const i = document.querySelector('.td-title-input'); return i ? { fs: getComputedStyle(i).fontSize, mounted: true } : null; });
  assert.ok(inputInfo && inputInfo.mounted, 'title input appears on h2 click');
  assert.equal(inputInfo.fs, h2Size, `title input font-size matches h2 (${inputInfo.fs} vs ${h2Size}) — no layout jump`);
  // The input is auto-focused (startTitleEdit focuses it). Select-all so typing
  // replaces the pre-filled old title (not appends), then type + Enter.
  await page.evaluate(() => document.querySelector('.td-title-input')?.select());
  await page.keyboard.type('SMOKE-0233 renamed');
  await page.keyboard.press('Enter');
  await wait(300);
  const afterTitle = await poll(`/tickets/${encodeURIComponent(ticketId)}`, (t) => t.title === 'SMOKE-0233 renamed');
  assert.equal(afterTitle.title, 'SMOKE-0233 renamed', `inline title edit landed (got "${afterTitle.title}")`);

  // ── 4b. Esc on the title input reverts + does NOT close the drawer (TKT-0233) ──
  // The title input's Esc handler must stopPropagation so the drawer's window
  // Esc listener (which unmounts the ticket) never fires — same regression class
  // as the mermaid fullscreen (cns-4079ba). Click the h2 → input → Esc.
  await page.evaluate(() => document.querySelector('.td-title').click());
  await wait(200);
  assert.ok(await page.evaluate(() => !!document.querySelector('.td-title-input')), 'title input re-appears on click');
  await page.keyboard.press('Escape');
  await wait(250);
  assert.ok(await page.evaluate(() => !!document.querySelector('.td-md')), 'drawer STILL mounted after Esc on title input (Esc did NOT close the ticket)');
  assert.ok(await page.evaluate(() => location.pathname.includes('/tickets/')), 'URL still on /tickets/<id> after Esc on title input (page view: Esc must not history.back())');
  assert.ok(!(await page.evaluate(() => !!document.querySelector('.td-title-input'))), 'title input closed after Esc (edit reverted, not lost)');

  // ── 5. No native <select> in the read surface ────────────────────────────
  const native = await page.evaluate(() => document.querySelectorAll('.td-props select, .td-qr-select').length);
  assert.equal(native, 0, 'no native <select> in the read surface');

  // ── 6. Zero pageerror ────────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({ ok: true, ticketId, state: afterState.state, priority: afterPrio.priority, title: afterTitle.title }, null, 2));
} finally {
  if (ticketId) { try { await patch(`/tickets/${encodeURIComponent(ticketId)}`, { state: 'archived' }); } catch {} }
  await cleanup();
}