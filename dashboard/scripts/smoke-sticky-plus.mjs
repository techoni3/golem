// Sticky block-hover "+" button: when the cursor crosses a block boundary
// (e.g. from a table row up to the table), the button must stay on the block
// it was shown for during the settle window (BLOCK_PLUS_SETTLE_MS) instead of
// being yanked to the new block — otherwise it becomes a moving target the
// user has to chase. After the settle window, it re-attaches to the new block.
import { acquireChrome } from './_chrome.mjs';
import assert from 'node:assert/strict';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://dashboard.golem.localhost:7420/tickets/TKT-0161', { waitUntil: 'networkidle' });
await wait(2500);

const plusPos = () => page.evaluate(() => {
  const p = document.getElementById('anno-block-plus');
  if (!p || p.style.display !== 'flex') return null;
  const r = p.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top) };
});

// The user's scenario: a table row nested inside a table block.
const hasBlocks = await page.evaluate(() => {
  return !!document.querySelector('.td-md tr[data-block-id]')
    && !!document.querySelector('.td-md table[data-block-id]');
});
assert.equal(hasBlocks, true, 'fixture ticket has a table row + table block');

// 1. Hover the row → button appears at the row.
await page.evaluate(() => document.querySelector('.td-md tr[data-block-id]')?.scrollIntoView({ block: 'center' }));
await wait(400);
const rowPt = await page.evaluate(() => {
  const r = document.querySelector('.td-md tr[data-block-id]').getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2 };
});
await page.mouse.move(rowPt.x, rowPt.y);
await wait(900); // 500ms show delay + margin
const atRow = await plusPos();
assert.ok(atRow, 'button appears on the row');

// 2. Cross to the table → button must STAY at the row position during settle.
const tablePt = await page.evaluate(() => {
  const r = document.querySelector('.td-md table[data-block-id]').getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2 };
});
await page.mouse.move(tablePt.x, tablePt.y);
await wait(200); // inside the 800ms settle window
const duringSettle = await plusPos();
assert.ok(duringSettle, 'button stays visible while crossing');
assert.ok(Math.abs(duringSettle.y - atRow.y) < 4, 'button stays on the row during the settle window');

// 3. Past the settle window → button re-attaches to the table.
await wait(900);
const afterSettle = await plusPos();
assert.ok(afterSettle, 'button still visible after settle');
assert.ok(Math.abs(afterSettle.y - duringSettle.y) > 4, 'button re-attaches to the table after the settle window');

await cleanup();
console.log('sticky block-hover + button: PASS');
