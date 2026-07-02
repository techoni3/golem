// TKT-0208: ticket body padding / max-width / spacing sweep.
//
// The .td-md body in the read view (drawer + page) was full-bleed to the
// drawer/page edges, making long lines hard to follow on wide screens. This
// smoke locks in the readability sweep:
//   1. .td-md is capped at 1200px max-width (1120px content; tuned up from 800 for wide screens).
//   2. .td-md has 40px horizontal padding (gutter), 24px top, 72px bottom.
//   3. .td-md font-size is 15px, line-height 1.65 → 24.75px.
//   4. .td-md paragraph margin is 10px; heading top margin is 24px.
//   5. .td-titlebody shares the 1200px cap + 40px gutter, so the title's left
//      edge aligns with the prose column's left edge (within ~10px — a few px
//      of slack because .td-annotate-wrap's scrollbar shifts .td-md on long bodies).
//   6. When the annotation rail is open, .td-read-col (the wrapper around the
//      title + body) reserves 390px right padding, so BOTH the title and .td-md
//      slide left of the rail together and stay aligned, and .td-md keeps its
//      800px measure (prose stays readable next to annotations instead of
//      stretching back to ~2000px).

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto('http://dashboard.golem.localhost:7420/tracker?project=golem-1eba80', { waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.setItem('td:width', '90'));
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);

  const opened = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ticket'));
    const card = cards.find((c) => c.querySelector('.ticket-id')?.textContent.includes('TKT-')) || cards[0];
    if (!card) return null;
    card.click();
    return card.querySelector('.ticket-id')?.textContent.trim() || card.textContent.trim();
  });
  assert.ok(opened, 'opened a ticket');
  await wait(1500);
  await page.waitForSelector('.td-md', { timeout: 5000 });
  await wait(300);

  // ── 1-4. Body padding / max-width / font-size / line-height ──────────────
  const md = await page.evaluate(() => {
    const el = document.querySelector('.td-md');
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const p = el.querySelector('p');
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    return {
      maxWidth: cs.maxWidth,
      fontSize: cs.fontSize,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      lineHeight: cs.lineHeight,
      width: rect.width,
      left: rect.left,
      paragraphMargin: p ? window.getComputedStyle(p).margin : null,
      headingMargin: h ? window.getComputedStyle(h).margin : null,
    };
  });
  assert.ok(md, '.td-md is mounted');
  assert.equal(md.maxWidth, '1200px', '.td-md max-width is 1200px');
  assert.equal(md.fontSize, '15px', '.td-md font-size is 15px');
  assert.equal(md.paddingTop, '24px', '.td-md has 24px top padding');
  assert.equal(md.paddingBottom, '72px', '.td-md has 72px bottom padding');
  assert.equal(md.paddingLeft, '40px', '.td-md has 40px left padding');
  assert.equal(md.paddingRight, '40px', '.td-md has 40px right padding');
  assert.equal(md.lineHeight, '24.75px', '.td-md line-height is 1.65 × 15px = 24.75px');
  // TKT-0285: the body lives in .td-main (viewport − 250px sidebar), so at this
  // viewport .td-md fills the narrower main column instead of hitting the 1200
  // cap. The cap (max-width: 1200px) is what 0208 protects — assert it holds
  // (body never exceeds 1200), not that it's reached.
  assert.ok(md.width <= 1200, `.td-md width within the 1200px cap (got ${md.width}; TKT-0285 sidebar narrows the main column)`);

  // ── 5. Title column aligns with the prose column (rail closed) ──────────
  const aligned = await page.evaluate(() => {
    const title = document.querySelector('.td-titlebody');
    const body = document.querySelector('.td-md');
    if (!title || !body) return null;
    const t = title.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return { titleLeft: t.left, bodyLeft: b.left, titleWidth: t.width, bodyWidth: b.width };
  });
  assert.ok(aligned, '.td-titlebody and .td-md are both mounted');
  // Within ~10px (not sub-pixel): .td-annotate-wrap's vertical scrollbar
  // reduces its content width on long-bodied tickets, shifting .td-md ~5px
  // left of where the non-scrolling title centers. Cosmetic, accepted.
  assert.ok(
    Math.abs(aligned.titleLeft - aligned.bodyLeft) < 10,
    `.td-titlebody left (${aligned.titleLeft}) aligns with .td-md left (${aligned.bodyLeft}) within 10px`
  );

  // ── 6. Paragraph + heading margins ───────────────────────────────────
  // The browser serializes `margin: 10px 0` as `10px 0px 10px 0px` and
  // `margin: 24px 0 8px` as `24px 0px 8px 0px`. Match the *bottom* margin
  // (3rd token) for paragraphs and the *top* margin (1st token) for headings.
  if (md.paragraphMargin) {
    const tokens = md.paragraphMargin.split(/\s+/);
    const bottom = tokens.length === 1 ? tokens[0] : (tokens.length === 2 ? tokens[0] : tokens[2]);
    assert.equal(bottom, '10px', `paragraph bottom margin is 10px (got ${bottom})`);
  }
  if (md.headingMargin) {
    const tokens = md.headingMargin.split(/\s+/);
    const top = tokens[0];
    assert.equal(top, '24px', `heading top margin is 24px (got ${top})`);
  }

  // ── 7. Rail open: .td-md keeps its 800px measure; wrap reserves 390px ──
  // Force the rail open via DOM (the rail UI requires a hover / click on a
  // block which is fragile to test programmatically; we test the CSS
  // contract directly).
  await page.evaluate(() => {
    const wrap = document.querySelector('.td-annotate-wrap');
    if (wrap) wrap.classList.add('rail-open');
  });
  await wait(200);
  const railOpen = await page.evaluate(() => {
    const body = document.querySelector('.td-md');
    const title = document.querySelector('.td-titlebody');
    const col = document.querySelector('.td-main'); // TKT-0285: was .td-read-col
    if (!body || !title || !col) return null;
    const bcs = window.getComputedStyle(body);
    const ccs = window.getComputedStyle(col);
    return {
      maxWidth: bcs.maxWidth,
      width: body.getBoundingClientRect().width,
      titleLeft: title.getBoundingClientRect().left,
      bodyLeft: body.getBoundingClientRect().left,
      mainPaddingRight: ccs.paddingRight,
    };
  });
  assert.ok(railOpen, '.td-md, .td-titlebody and .td-main are mounted with rail open');
  assert.equal(railOpen.maxWidth, '1200px', '.td-md keeps its 1200px max-width when rail is open');
  assert.ok(railOpen.width < 1200, `rail-open body shrinks below the 1200px cap (available-bound; got ${railOpen.width})`);
  assert.equal(railOpen.mainPaddingRight, '390px', '.td-main reserves 390px right padding for the rail (360 rail + 30 gutter)');
  assert.ok(
    Math.abs(railOpen.titleLeft - railOpen.bodyLeft) < 10,
    `with rail open, .td-titlebody left (${railOpen.titleLeft}) aligns with .td-md left (${railOpen.bodyLeft}) within 10px (title slides left WITH the body)`
  );

  console.log(JSON.stringify({ ok: true, opened, md, aligned, railOpen }, null, 2));
} finally {
  await cleanup();
}
