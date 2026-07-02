// TKT-0234: fullscreen-mermaid Esc regression + close-path smoke.
//
// The fullscreen overlay's Esc handler must close ONLY the overlay — not the
// ticket drawer. The drawer registers its own Esc handler on window (bubble)
// that unmounts the whole ticket subtree (and the mermaid block with it); the
// overlay listens on document in the CAPTURE phase and calls
// stopImmediatePropagation so the drawer's (and the annotation rail's) Esc
// listeners never fire. This smoke locks that contract plus the × and
// click-outside close paths + re-open — without needing the mermaid network:
// it injects a .mermaid block with a fake SVG and drives the real
// attach → open → Esc/×/click-out path via the td-annotate.jsx test hooks.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);

try {
  await page.goto('http://dashboard.golem.localhost:7420/tracker?project=golem-1eba80', { waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.setItem('td:width', '90'));
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);

  // Open the first ticket.
  const opened = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.ticket'))
      .find((c) => c.querySelector('.ticket-id')?.textContent.includes('TKT-')) || document.querySelector('.ticket');
    if (!card) return null;
    card.click();
    return card.querySelector('.ticket-id')?.textContent.trim() || 'ticket';
  });
  assert.ok(opened, 'opened a ticket');
  await wait(1500);
  await page.waitForSelector('.td-md', { timeout: 5000 });
  await wait(300);

  // Inject a .mermaid block with a fake SVG (no mermaid network needed), then
  // drive the real attach path via the test hook.
  await page.evaluate(() => {
    const root = document.querySelector('.td-md');
    if (!root) throw new Error('no .td-md');
    const block = document.createElement('div');
    block.className = 'mermaid';
    block.innerHTML = '<svg viewBox="0 0 200 100"><rect width="200" height="100" fill="#3a3a3a"/><text x="10" y="55" fill="#fff" font-size="16">fake diagram</text></svg>';
    root.appendChild(block);
    if (!window.__tdAttachMermaidFullscreen) throw new Error('test hook __tdAttachMermaidFullscreen missing');
    window.__tdAttachMermaidFullscreen(root);
  });
  await wait(100);
  assert.ok(await has('.mermaid-fs-btn'), 'expand button attached to the mermaid block');

  // ── 1. Esc closes the overlay but NOT the drawer ────────────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-btn').click());
  await wait(150);
  assert.ok(await has('.mermaid-fs-overlay'), 'overlay opens on expand click');
  assert.ok(await has('.drawer-ticket'), 'drawer is mounted while overlay is up');
  await page.keyboard.press('Escape');
  await wait(300);
  assert.ok(!(await has('.mermaid-fs-overlay')), 'overlay is gone after Esc');
  assert.ok(await has('.drawer-ticket'), 'drawer is STILL mounted after Esc (Esc did not close the ticket)');
  assert.ok(await has('.td-md'), '.td-md still mounted after Esc (ticket subtree not unmounted)');
  assert.ok(await has('.mermaid-fs-btn'), 'expand button still present after Esc (re-openable)');

  // ── 2. Re-open works after an Esc close ────────────────────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-btn').click());
  await wait(150);
  assert.ok(await has('.mermaid-fs-overlay'), 'overlay re-opens after Esc close');

  // ── 3. × button closes the overlay, drawer stays ───────────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-close').click());
  await wait(300);
  assert.ok(!(await has('.mermaid-fs-overlay')), 'overlay gone after × click');
  assert.ok(await has('.drawer-ticket'), 'drawer still mounted after × close');

  // ── 4. Click-outside closes the overlay, drawer stays ───────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-btn').click());
  await wait(150);
  assert.ok(await has('.mermaid-fs-overlay'), 'overlay re-opens for click-outside test');
  await page.evaluate(() => {
    const ov = document.querySelector('.mermaid-fs-overlay');
    ov.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await wait(300);
  assert.ok(!(await has('.mermaid-fs-overlay')), 'overlay gone after click-outside');
  assert.ok(await has('.drawer-ticket'), 'drawer still mounted after click-outside close');

  console.log(JSON.stringify({ ok: true, opened }, null, 2));
} finally {
  await cleanup();
}