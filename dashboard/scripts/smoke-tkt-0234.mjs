// TKT-0234: fullscreen-mermaid interaction smoke.
//
// The fullscreen overlay's Esc handler must close ONLY the overlay — not the
// ticket drawer. The drawer registers its own Esc handler on window (bubble)
// that unmounts the whole ticket subtree (and the mermaid block with it); the
// overlay listens on document in the CAPTURE phase and calls
// stopImmediatePropagation so the drawer's (and the annotation rail's) Esc
// listeners never fire. This smoke locks that contract, ID-safe SVG cloning,
// zoom, scrolling/panning, and the × / click-outside close paths — without
// needing the Mermaid network. It injects a deliberately oversized fake SVG
// and drives the real attach → open path via the td-annotate.jsx test hooks.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const BASE_URL = process.env.DASHBOARD_BASE_URL || 'http://dashboard.golem.localhost:7420';

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__tdAttachMermaidFullscreen, { timeout: 10000 });

  // Mount a minimal ticket-like fixture in the real dashboard document. This
  // keeps the smoke isolated from live projects and proves the same native DOM
  // path that TdAnnotate uses after Mermaid renders a ticket body.
  await page.evaluate(() => {
    const drawer = document.createElement('section');
    drawer.className = 'drawer-ticket';
    const root = document.createElement('div');
    root.className = 'td-md';
    drawer.appendChild(root);
    document.body.appendChild(drawer);
    window.__mermaidFsDrawerEscCount = 0;
    window.addEventListener('keydown', () => { window.__mermaidFsDrawerEscCount += 1; });
    const block = document.createElement('div');
    block.className = 'mermaid';
    block.innerHTML = '<svg id="source-diagram" style="max-width:4800px" viewBox="0 0 4800 2000"><style>#source-diagram .shape { fill: rgb(238, 224, 255); stroke: rgb(96, 64, 200); stroke-width: 12px; }</style><rect class="shape" width="4800" height="2000"/><text x="120" y="240" font-size="96">oversized fake diagram</text></svg>';
    root.appendChild(block);
    if (!window.__tdAttachMermaidFullscreen) throw new Error('test hook __tdAttachMermaidFullscreen missing');
    window.__tdAttachMermaidFullscreen(root);
  });
  await wait(100);
  assert.ok(await has('.mermaid-fs-btn'), 'expand button attached to the mermaid block');

  // ── Esc closes the overlay but NOT the drawer ──────────────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-btn').click());
  await wait(150);
  assert.ok(await has('.mermaid-fs-overlay'), 'overlay opens on expand click');
  assert.ok(await has('.drawer-ticket'), 'drawer is mounted while overlay is up');
  const initialViewport = await page.evaluate(() => {
    const clone = document.querySelector('.mermaid-fs-canvas svg');
    const stage = document.querySelector('.mermaid-fs-stage');
    return {
      rootId: clone.id,
      fill: getComputedStyle(clone.querySelector('.shape')).fill,
      controls: Array.from(document.querySelectorAll('.mermaid-fs-toolbar button')).map((b) => b.getAttribute('aria-label') || b.textContent),
      zoom: document.querySelector('.mermaid-fs-zoom-level').textContent,
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
    };
  });
  assert.ok(initialViewport.rootId.startsWith('mermaid-fs-'), 'clone has a private, non-duplicated SVG id');
  assert.equal(initialViewport.fill, 'rgb(238, 224, 255)', 'ID-scoped Mermaid styles survive in the fullscreen clone');
  assert.deepEqual(initialViewport.controls, ['Zoom out', 'Zoom in', 'Fit', '100%'], 'fullscreen controls are available');
  assert.ok(Number.parseInt(initialViewport.zoom, 10) < 100, 'large diagram starts fitted to the viewport');

  // ── Zoom + scroll/pan expose the full native-size diagram ─────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-reset').click());
  await wait(100);
  const oversized = await page.evaluate(() => {
    const stage = document.querySelector('.mermaid-fs-stage');
    return { scrollWidth: stage.scrollWidth, clientWidth: stage.clientWidth, scrollHeight: stage.scrollHeight, clientHeight: stage.clientHeight, zoom: document.querySelector('.mermaid-fs-zoom-level').textContent };
  });
  assert.equal(oversized.zoom, '100%', '100% control restores native-size view');
  assert.ok(oversized.scrollWidth > oversized.clientWidth, 'native-size diagram overflows horizontally and can scroll');
  assert.ok(oversized.scrollHeight > oversized.clientHeight, 'native-size diagram overflows vertically and can scroll');
  const stageBox = await page.locator('.mermaid-fs-stage').boundingBox();
  await page.evaluate(() => document.querySelector('.mermaid-fs-stage').scrollTo(0, 0));
  await page.mouse.move(stageBox.x + stageBox.width * 0.65, stageBox.y + stageBox.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width * 0.35, stageBox.y + stageBox.height * 0.35);
  await page.mouse.up();
  const panned = await page.evaluate(() => {
    const stage = document.querySelector('.mermaid-fs-stage');
    return { left: stage.scrollLeft, top: stage.scrollTop };
  });
  assert.ok(panned.left > 0 && panned.top > 0, 'dragging pans the oversized diagram');
  await page.evaluate(() => {
    const stage = document.querySelector('.mermaid-fs-stage');
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120, clientX: stage.clientWidth / 2, clientY: stage.clientHeight / 2 }));
  });
  await wait(50);
  assert.ok(Number.parseInt(await page.locator('.mermaid-fs-zoom-level').textContent(), 10) > 100, 'Ctrl/⌘ wheel zooms at the pointer');
  await page.evaluate(() => document.querySelector('.mermaid-fs-fit').click());
  await wait(50);
  assert.ok(Number.parseInt(await page.locator('.mermaid-fs-zoom-level').textContent(), 10) < 100, 'Fit returns to an overview');

  await page.keyboard.press('Escape');
  await wait(300);
  assert.ok(!(await has('.mermaid-fs-overlay')), 'overlay is gone after Esc');
  assert.ok(await has('.drawer-ticket'), 'drawer is STILL mounted after Esc (Esc did not close the ticket)');
  assert.ok(await has('.td-md'), '.td-md still mounted after Esc (ticket subtree not unmounted)');
  assert.ok(await has('.mermaid-fs-btn'), 'expand button still present after Esc (re-openable)');
  assert.equal(await page.evaluate(() => window.__mermaidFsDrawerEscCount), 0, 'Esc did not reach the drawer-style bubble listener');

  // ── Re-open works after an Esc close ───────────────────────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-btn').click());
  await wait(150);
  assert.ok(await has('.mermaid-fs-overlay'), 'overlay re-opens after Esc close');

  // ── × button closes the overlay, drawer stays ──────────────────────────
  await page.evaluate(() => document.querySelector('.mermaid-fs-close').click());
  await wait(300);
  assert.ok(!(await has('.mermaid-fs-overlay')), 'overlay gone after × click');
  assert.ok(await has('.drawer-ticket'), 'drawer still mounted after × close');

  // ── Click-outside closes the overlay, drawer stays ──────────────────────
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

  console.log(JSON.stringify({ ok: true, fixture: 'oversized mermaid' }, null, 2));
} finally {
  await cleanup();
}
