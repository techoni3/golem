// TKT-0237: collapsible rail comments — collapsed-by-default, guarded toggle,
// real touch targets. Journey smoke: creates a scratch ticket with one LONG
// and one SHORT comment via REST, opens the rail, and verifies the clamp +
// toggle + the reply-click auto-expand regression + selection guard + touch
// targets. Archives the scratch ticket in finally.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const PROJECT = 'golem-1eba80';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (path, body) => fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let ticketId = null;
try {
  // ── Setup via REST: scratch ticket + one LONG + one SHORT comment ────────
  const ticket = await post('/tickets', {
    project_id: PROJECT, kind: 'task', created_by: 'smoke',
    title: 'SMOKE-0237 scratch',
    body: 'Scratch ticket for the TKT-0237 collapsible-comments smoke.\n\nA couple of paragraphs so the body renders.',
  });
  ticketId = ticket.id;
  assert.ok(ticketId, 'created scratch ticket');
  const longBody = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog and keeps on running.`).join('\n\n');
  const longC = await post(`/tickets/${encodeURIComponent(ticketId)}/comments`, { author: 'you', body: longBody, tag: 'note' });
  const shortC = await post(`/tickets/${encodeURIComponent(ticketId)}/comments`, { author: 'you', body: 'Short comment.\nOnly two lines.', tag: 'note' });
  assert.ok(longC.id && shortC.id, 'added long + short comments');

  // ── Open the ticket page, open the rail ──────────────────────────────────
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticketId)}`, { waitUntil: 'networkidle' });
  await wait(800);
  await page.waitForSelector('.td-annotate-wrap', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#anno-fab').click());
  await wait(400);
  await page.waitForSelector('.anno-card', { timeout: 5000 });
  await wait(300);

  // ── 1. Long card collapsed by default; 2. short card not collapsible ──────
  const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.anno-card')).map((c) => {
    const content = c.querySelector('.anno-card-content');
    const hint = c.querySelector('.anno-expand-hint');
    return {
      collapsible: c.getAttribute('data-collapsible'),
      aria: c.getAttribute('aria-expanded'),
      clientHeight: content ? content.clientHeight : null,
      scrollHeight: content ? content.scrollHeight : null,
      clamped: content ? content.classList.contains('clamped') : null,
      hint: hint ? hint.textContent.trim() : null,
      body: (c.querySelector('.body')?.textContent || '').slice(0, 12),
    };
  }));
  const longCard = cards.find((c) => c.body.startsWith('Line 1'));
  const shortCard = cards.find((c) => c.body.startsWith('Short'));
  assert.ok(longCard, 'long comment card mounted');
  assert.ok(shortCard, 'short comment card mounted');
  assert.equal(longCard.collapsible, '1', 'long card has data-collapsible');
  assert.equal(longCard.aria, 'false', 'long card aria-expanded=false (collapsed by default)');
  assert.ok(longCard.clientHeight <= 152, `long card clamped (clientHeight ${longCard.clientHeight} <= 152)`);
  assert.ok(longCard.scrollHeight > 200, `long card overflows (scrollHeight ${longCard.scrollHeight} > 200)`);
  assert.ok(longCard.clamped, 'long card content has .clamped');
  assert.ok(longCard.hint && longCard.hint.startsWith('⌄'), `long card hint starts with ⌄ (got ${longCard.hint})`);
  assert.ok(!shortCard.collapsible, 'short card has no data-collapsible');
  assert.ok(!shortCard.clamped, 'short card not clamped');
  assert.ok(!shortCard.hint, 'short card has no hint');

  // ── 3. Toggle: click body → expanded; click again → collapsed ────────────
  await page.evaluate(() => { const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1')); c.querySelector('.body').click(); });
  await wait(150);
  let st = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1'));
    const content = c.querySelector('.anno-card-content');
    return { aria: c.getAttribute('aria-expanded'), clientHeight: content.clientHeight, scrollHeight: content.scrollHeight };
  });
  assert.equal(st.aria, 'true', 'long card aria-expanded=true after click');
  assert.ok(st.clientHeight >= st.scrollHeight - 2, `expanded shows all (clientHeight ${st.clientHeight} >= scrollHeight ${st.scrollHeight} - 2)`);
  await page.evaluate(() => { const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1')); c.querySelector('.body').click(); });
  await wait(150);
  st = await page.evaluate(() => Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1')).getAttribute('aria-expanded'));
  assert.equal(st, 'false', 'long card collapsed again after second click');

  // ── 4. The regression: collapsed card + Reply → composer opens AND auto-expands ──
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1'));
    if (c.getAttribute('aria-expanded') === 'true') c.querySelector('.body').click(); // collapse first
  });
  await wait(150);
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1'));
    c.querySelector('.acts button').click(); // Reply = first .acts button
  });
  await wait(200);
  const reply = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1'));
    return { aria: c.getAttribute('aria-expanded'), composer: !!c.querySelector('.anno-composer textarea'), clamped: c.querySelector('.anno-card-content').classList.contains('clamped') };
  });
  assert.ok(reply.composer, 'reply composer textarea appears after Reply');
  assert.equal(reply.aria, 'true', 'card auto-expanded on Reply (NOT collapsed — the regression)');
  assert.ok(!reply.clamped, 'card not clamped while replying');
  await page.evaluate(() => { const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1')); c.querySelector('.anno-composer .cancel')?.click(); });
  await wait(150);

  // ── 5. Edit on the short card → textarea visible, no clamp while editing ─
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Short'));
    Array.from(c.querySelectorAll('.acts button'))[1].click(); // Edit = second button
  });
  await wait(200);
  const edit = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => x.querySelector('.anno-edit textarea'));
    return { edit: !!c?.querySelector('.anno-edit textarea'), clamped: c?.querySelector('.anno-card-content').classList.contains('clamped') };
  });
  assert.ok(edit.edit, 'edit textarea appears after Edit');
  assert.ok(!edit.clamped, 'short card not clamped while editing');
  await page.evaluate(() => { const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => x.querySelector('.anno-edit textarea')); c.querySelector('.anno-edit .cancel').click(); });
  await wait(150);

  // ── 6. Selection guard: select body text, then click — must NOT toggle ───
  // Deterministic (per the plan's anti-flakiness fallback): selectAllChildren
  // then a real click; onCardClick sees a non-collapsed selection and returns.
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1'));
    if (c.getAttribute('aria-expanded') !== 'true') c.querySelector('.body').click();
  });
  await wait(150);
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1'));
    const b = c.querySelector('.body');
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.selectAllChildren(b);
    b.click();
  });
  await wait(150);
  const selAria = await page.evaluate(() => Array.from(document.querySelectorAll('.anno-card')).find((x) => (x.querySelector('.body')?.textContent || '').startsWith('Line 1')).getAttribute('aria-expanded'));
  assert.equal(selAria, 'true', 'card still expanded after selection+click (selection guard prevented toggle)');

  // ── 7. Touch targets: every .acts button hit height >= 24 ────────────────
  const targets = await page.evaluate(() => Array.from(document.querySelectorAll('.anno-card .acts button')).map((b) => { const r = b.getBoundingClientRect(); return { h: r.height, label: b.textContent.trim() }; }));
  assert.ok(targets.length >= 8, `found acts buttons across cards (got ${targets.length})`);
  for (const t of targets) assert.ok(t.h >= 24, `acts button "${t.label}" hit height >= 24 (got ${t.h})`);

  // ── 8. Zero pageerror events ─────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({ ok: true, ticketId, cards: cards.length, targets: targets.length }, null, 2));
} finally {
  if (ticketId) { try { await patch(`/tickets/${encodeURIComponent(ticketId)}`, { state: 'archived' }); } catch {} }
  await cleanup();
}