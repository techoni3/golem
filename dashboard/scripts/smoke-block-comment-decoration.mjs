// Browser journey for block-level comment decoration. Uses the quarantined
// scratch project so the anchor and comment rows never touch a real board.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { acquireChrome } from './_chrome.mjs';
import { archiveTicket, createScratchTicket } from './_scratch.mjs';

const ORIGIN = process.env.GOLEM_SMOKE_ORIGIN || 'http://dashboard.golem.localhost:7420';
const API = `${ORIGIN}/api`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync('/tmp/golem-ui-smoke', { recursive: true });

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

const ticket = await createScratchTicket({
  title: 'block comment decoration',
  body: '# Margin rail fixture\n\nAnchor block text.\n\nLegacy inline target.',
});
const created = [ticket.id];
const blockId = 'margin-rail-fixture#1';
let chrome;

try {
  const blockComment = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: 'smoke',
      body: 'Block comment fixture',
      quote: 'Anchor block text.',
      block_id: blockId,
    }),
  });
  const legacyComment = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: 'smoke',
      body: 'Legacy inline fixture',
      quote: 'Legacy inline target.',
    }),
  });

  chrome = await acquireChrome();
  const page = chrome.browser.contexts()[0]?.pages()[0] ?? await chrome.browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticket.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md [data-block-id]');
  await wait(500);

  const inspect = () => page.evaluate(({ blockId: wantedBlockId, blockCommentId, legacyCommentId }) => {
    const block = [...document.querySelectorAll('.td-md [data-block-id]')]
      .find((candidate) => candidate.dataset.blockId === wantedBlockId);
    const style = block ? getComputedStyle(block) : null;
    const cards = [...document.querySelectorAll('#anno-list .anno-card')].map((card) => card.dataset.id);
    return {
      theme: document.documentElement.dataset.theme || 'dark',
      blockFound: !!block,
      blockClasses: block?.className || '',
      blockCommentIds: block?.dataset.annoBlockIds || '',
      blockHasOwnMark: !!block?.querySelector(`mark.anno[data-id="${blockCommentId}"]`),
      legacyMarkCount: document.querySelectorAll(`mark.anno[data-id="${legacyCommentId}"]`).length,
      backgroundImage: style?.backgroundImage || '',
      boxShadow: style?.boxShadow || '',
      cardOrder: cards,
    };
  }, { blockId, blockCommentId: blockComment.id, legacyCommentId: legacyComment.id });

  const initial = await inspect();
  assert.equal(initial.blockFound, true, 'block anchor is rendered');
  assert.match(initial.blockClasses, /anno-block-comment/, 'block anchor receives block-level comment class');
  assert.ok(initial.blockCommentIds.split(/\s+/).includes(blockComment.id), 'block anchor records its comment id');
  assert.equal(initial.blockHasOwnMark, false, 'block comment does not create an inline mark');
  assert.equal(initial.legacyMarkCount, 1, 'comment without a block anchor keeps inline mark fallback');
  assert.match(initial.backgroundImage, /gradient/i, 'Margin rail wash is visible');
  assert.notEqual(initial.boxShadow, 'none', 'Margin rail is visible as an inset rail');
  assert.ok(initial.cardOrder.indexOf(blockComment.id) < initial.cardOrder.indexOf(legacyComment.id), 'block anchor participates in document comment order');

  await page.locator('#anno-fab').click();
  await wait(200);
  await page.locator(`.anno-card[data-id="${blockComment.id}"]`).click();
  await wait(100);
  const focused = await inspect();
  assert.match(focused.blockClasses, /is-active/, 'focusing the block comment marks the block active');

  await page.evaluate(() => localStorage.setItem('golem.tweaks.theme', 'loam'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md [data-block-id]');
  await wait(400);
  const loam = await inspect();
  assert.equal(loam.theme, 'loam', 'Loam theme loads');
  assert.match(loam.backgroundImage, /gradient/i, 'Margin rail remains visible in Loam');
  assert.notEqual(loam.boxShadow, 'none', 'Margin rail remains visible in Loam');
  await page.screenshot({ path: '/tmp/golem-ui-smoke/block-comment-decoration-loam.png', fullPage: true });

  await page.evaluate(() => localStorage.setItem('golem.tweaks.theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md [data-block-id]');
  await wait(400);
  const dark = await inspect();
  assert.equal(dark.theme, 'dark', 'Dark theme loads');
  assert.match(dark.backgroundImage, /gradient/i, 'Margin rail remains visible in Dark');
  assert.notEqual(dark.boxShadow, 'none', 'Margin rail remains visible in Dark');
  await page.screenshot({ path: '/tmp/golem-ui-smoke/block-comment-decoration-dark.png', fullPage: true });
  assert.deepEqual(pageErrors, [], `no page errors (got ${pageErrors.join(' | ')})`);

  console.log(JSON.stringify({ ok: true, blockId, blockComment: blockComment.id, legacyComment: legacyComment.id, themes: ['loam', 'dark'] }, null, 2));
} finally {
  try { await archiveTicket(ticket.id); } catch {}
  if (chrome) await chrome.cleanup();
}
