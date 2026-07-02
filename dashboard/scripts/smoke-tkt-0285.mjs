// TKT-0285: ticket fields sidebar — props move left, body re-centers, drawer
// widths 3→2 toggle. Journey smoke (WEB-ASSETS ONLY — no dashboard restart; a
// browser reload picks up the changes).
//
// Verifies:
//   1. Page view (2560×1330): .td-side is left of .td-main; .td-md (body) is
//      centered within .td-main (|left-gutter − right-gutter| < 2).
//   2. Sticky: scroll .td-scroll down ~800px on a long body → .td-side stays
//      at the scroll container's top (didn't scroll away).
//   3. A sidebar control still PATCHes (State → in_progress).
//   4. Drawer width toggle: the 3-button group is gone (exactly one .td-width-btn);
//      a seeded localStorage 'td:width'='30' coerces to '50' on reload → drawer
//      width 50vw + stored '50'; click → 90vw + persisted; click again → 50vw.
//   5. Stacked fallback (900×800, drawer 50%): .td-layout children stack (side
//      above main) + .td-side is position: static.
//   6. Zero pageerror.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const PROJECT = 'golem-1eba80';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (path, body) => fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path) => fetch(`${API}${path}`).then((r) => r.json());
const poll = async (path, pred, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await get(path); if (pred(v)) return v; await wait(150); }
  return get(path);
};

// TKT-0354: the dispatch block must not overflow the sidebar. Returns the
// sidebar's horizontal overflow + whether the actions row (Now|When-idle toggle
// + Dispatch/Queue button) sits fully inside the sidebar rect.
const sideOverflow = () => page.evaluate(() => {
  const side = document.querySelector('.td-side');
  if (!side) return null;
  const s = side.getBoundingClientRect();
  const inside = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.right <= s.right + 0.5 && r.left >= s.left - 0.5; };
  return {
    scrollWidth: side.scrollWidth,
    clientWidth: side.clientWidth,
    overflow: side.scrollWidth > side.clientWidth + 1,
    actionsInside: inside(document.querySelector('.td-dispatch-actions')),
    toggleInside: inside(document.querySelector('.td-dispatch-mode')),
    goInside: inside(document.querySelector('.td-dispatch-go')),
  };
});

// A body tall enough that .td-scroll can scroll ~800px (sticky needs travel).
const LONG_BODY = Array.from({ length: 24 }, (_, i) =>
  `## Section ${i + 1}\n\nThis is paragraph ${i + 1} of a long scratch body used to exercise the sticky sidebar. The quick brown fox jumps over the lazy dog; the drawer must scroll well past 800px so the sticky .td-side has scroll travel to engage.`,
).join('\n\n');

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let ticketId = null;
try {
  // ── Scratch ticket with a long body ──────────────────────────────────────
  ticketId = (await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0285 sidebar', body: `# SMOKE-0285 scratch\n\n${LONG_BODY}` })).id;
  assert.ok(ticketId, 'created scratch ticket');

  // ── 1. Page view: sidebar left of main, body centered within main ──────────
  await page.setViewportSize({ width: 2560, height: 1330 });
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticketId)}`, { waitUntil: 'networkidle' });
  await wait(800);
  let lay = await page.evaluate(() => {
    const side = document.querySelector('.td-side');
    const main = document.querySelector('.td-main');
    const md = document.querySelector('.td-md');
    if (!side || !main || !md) return null;
    const s = side.getBoundingClientRect(), m = main.getBoundingClientRect(), d = md.getBoundingClientRect();
    return { sideRight: s.right, mainLeft: m.left, mainRight: m.right, mdLeft: d.left, mdRight: d.right };
  });
  assert.ok(lay, '.td-side + .td-main + .td-md mounted (page view)');
  assert.ok(lay.sideRight <= lay.mainLeft + 1, `sidebar is left of main (sideRight ${lay.sideRight} <= mainLeft ${lay.mainLeft})`);
  const leftGutter = lay.mdLeft - lay.mainLeft;
  const rightGutter = lay.mainRight - lay.mdRight;
  assert.ok(Math.abs(leftGutter - rightGutter) < 2, `body centered within main (left gutter ${leftGutter.toFixed(1)} ≈ right gutter ${rightGutter.toFixed(1)})`);

  // ── 1b. (TKT-0354) sidebar dispatch block doesn't overflow the page-view sidebar ──
  let ov1 = await sideOverflow();
  assert.ok(ov1, '.td-side present (page view)');
  assert.ok(!ov1.overflow, `page-view sidebar no horizontal overflow (scrollWidth ${ov1.scrollWidth} <= clientWidth ${ov1.clientWidth}+1)`);
  assert.ok(ov1.actionsInside && ov1.toggleInside && ov1.goInside, `page-view dispatch actions inside the sidebar (actions=${ov1.actionsInside} toggle=${ov1.toggleInside} go=${ov1.goInside})`);

  // ── 2. Sticky (TKT-0285 consult cns-995f1f F1): at a typical laptop viewport
  // (1440×800) with a long body, the sidebar must stay pinned at the scroll
  // top after 800px of scroll. The buggy code (flex-shrink capped .td-layout to
  // the scroll viewport) let the sidebar scroll away here — the smoke originally
  // tested at 2560×1330, the one viewport where it barely survived. ──────────
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.reload({ waitUntil: 'networkidle' });
  await wait(700);
  await page.evaluate(() => { document.querySelector('.td-scroll').scrollTop = 800; });
  await wait(200);
  let sticky = await page.evaluate(() => {
    const scroll = document.querySelector('.td-scroll');
    const side = document.querySelector('.td-side');
    return { sideTop: side.getBoundingClientRect().top, scrollTop: scroll.getBoundingClientRect().top, scrollTopVal: scroll.scrollTop };
  });
  assert.ok(sticky.scrollTopVal >= 700, `scrolled down ~800px (scrollTop ${sticky.scrollTopVal})`);
  assert.ok(Math.abs(sticky.sideTop - sticky.scrollTop) < 30, `sticky sidebar stays at the scroll top after 800px at 1440×800 (sideTop ${sticky.sideTop.toFixed(1)} ≈ scrollTop ${sticky.scrollTop.toFixed(1)})`);

  // ── 3. Sidebar control PATCH still lands (State → in_progress) ────────────
  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.td-side .td-prop-label'));
    const lab = labels.find((l) => /State/i.test(l.textContent));
    lab.parentElement.querySelector('.ps-trigger').click();
  });
  await wait(200);
  await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('.ps-option'));
    const o = opts.find((b) => /in_progress/.test(b.textContent));
    if (o) o.click();
  });
  await wait(300);
  const afterState = await poll(`/tickets/${encodeURIComponent(ticketId)}`, (t) => t.state === 'in_progress');
  assert.equal(afterState.state, 'in_progress', `sidebar State PATCH landed (got ${afterState.state})`);

  // ── 4. Drawer width toggle + localStorage '30'→'50' coercion ──────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(400);
  // Seed the removed '30' preset, then reload so tdLoadWidth() coerces it on mount.
  await page.evaluate(() => { try { localStorage.setItem('td:width', '30'); } catch {} });
  await page.reload({ waitUntil: 'networkidle' });
  await wait(500);
  await page.evaluate((id) => window.Router.openTicket(id), ticketId);
  await wait(800);
  // exactly one width button (the 3-button group is gone)
  let btnCount = await page.evaluate(() => document.querySelectorAll('.td-width-btn').length);
  assert.equal(btnCount, 1, `exactly one width-toggle button (the 3-group is gone; got ${btnCount})`);
  // '30' coerced to '50' → drawer width 50vw + stored '50'
  let w50 = await page.evaluate(() => ({
    width: document.querySelector('.drawer-ticket')?.getBoundingClientRect().width ?? null,
    stored: localStorage.getItem('td:width'),
  }));
  assert.equal(w50.stored, '50', `stored '30' coerced to '50' (got ${w50.stored})`);
  assert.ok(Math.abs(w50.width - 0.5 * 1440) < 20, `drawer width ≈ 50vw after coercion (got ${w50.width})`);
  // (TKT-0354) drawer 50% — dispatch block doesn't overflow the sidebar
  let ov50 = await sideOverflow();
  assert.ok(ov50 && !ov50.overflow, `drawer 50% sidebar no horizontal overflow (scrollWidth ${ov50?.scrollWidth} <= clientWidth ${ov50?.clientWidth}+1)`);
  assert.ok(ov50.actionsInside && ov50.toggleInside && ov50.goInside, `drawer 50% dispatch actions inside the sidebar (actions=${ov50.actionsInside} toggle=${ov50.toggleInside} go=${ov50.goInside})`);
  // click → 90vw + persisted
  await page.evaluate(() => document.querySelector('.td-width-btn').click());
  await wait(300);
  let w90 = await page.evaluate(() => ({
    width: document.querySelector('.drawer-ticket')?.getBoundingClientRect().width ?? null,
    stored: localStorage.getItem('td:width'),
  }));
  assert.equal(w90.stored, '90', `click → '90' persisted (got ${w90.stored})`);
  assert.ok(Math.abs(w90.width - 0.9 * 1440) < 30, `drawer width ≈ 90vw (got ${w90.width})`);
  // (TKT-0354) drawer 90% — dispatch block doesn't overflow the sidebar
  let ov90 = await sideOverflow();
  assert.ok(ov90 && !ov90.overflow, `drawer 90% sidebar no horizontal overflow (scrollWidth ${ov90?.scrollWidth} <= clientWidth ${ov90?.clientWidth}+1)`);
  assert.ok(ov90.actionsInside && ov90.toggleInside && ov90.goInside, `drawer 90% dispatch actions inside the sidebar (actions=${ov90.actionsInside} toggle=${ov90.toggleInside} go=${ov90.goInside})`);
  // click again → 50vw
  await page.evaluate(() => document.querySelector('.td-width-btn').click());
  await wait(300);
  let w50b = await page.evaluate(() => ({ stored: localStorage.getItem('td:width') }));
  assert.equal(w50b.stored, '50', `click again → '50' (got ${w50b.stored})`);

  // ── 5. Stacked fallback: viewport 900×800, drawer 50% → side stacks ──────
  await page.setViewportSize({ width: 900, height: 800 });
  await wait(500);
  let stacked = await page.evaluate(() => {
    const side = document.querySelector('.td-side');
    const main = document.querySelector('.td-main');
    if (!side || !main) return null;
    const s = side.getBoundingClientRect(), m = main.getBoundingClientRect();
    return { pos: getComputedStyle(side).position, sideBottom: s.bottom, mainTop: m.top };
  });
  assert.ok(stacked, '.td-side + .td-main present at 900×800');
  assert.equal(stacked.pos, 'static', `.td-side is position: static in the stacked fallback (got ${stacked.pos})`);
  assert.ok(stacked.sideBottom <= stacked.mainTop + 1, `side stacks above main (sideBottom ${stacked.sideBottom.toFixed(1)} <= mainTop ${stacked.mainTop.toFixed(1)})`);

  // ── 6. Zero pageerror ─────────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({
    ok: true,
    ticketId,
    leftGutter: leftGutter.toFixed(1),
    rightGutter: rightGutter.toFixed(1),
    stickySideTop: sticky.sideTop.toFixed(1),
    widthAfterCoerce: w50.width,
    widthAfterClick: w90.width,
    stackedPos: stacked.pos,
    overflowPage: ov1?.overflow,
    overflow50: ov50?.overflow,
    overflow90: ov90?.overflow,
  }, null, 2));
} finally {
  if (ticketId) { try { await patch(`/tickets/${encodeURIComponent(ticketId)}`, { state: 'archived' }); } catch {} }
  await cleanup();
}