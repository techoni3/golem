// Browser journey for semantic commentable descendants. Uses the quarantined
// scratch project so nested anchor rows never touch a real board.

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
  title: 'nested comment anchors',
  body: [
    '# Nested anchor fixture',
    '',
    '- Parent item text',
    '    - Nested item text',
    '    - Nested sibling text',
    '- Outer sibling text and context.',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| First row | Alpha |',
    '| Second row | Beta |',
  ].join('\n'),
});
let chrome;

try {
  chrome = await acquireChrome();
  const page = chrome.browser.contexts()[0]?.pages()[0] ?? await chrome.browser.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticket.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md [data-block-id]');

  const shape = await page.evaluate(() => {
    const root = document.querySelector('.td-md');
    const list = [...root.querySelectorAll('ul,ol')].find((candidate) => candidate.querySelector('li li'));
    const nestedList = list && [...list.querySelectorAll('ul,ol')].find((candidate) => candidate.querySelector('li'));
    const nestedItem = nestedList && [...nestedList.children].find((candidate) => candidate.matches('li'));
    const outerSibling = [...(list?.children || [])].find((candidate) => candidate.textContent.includes('Outer sibling text'));
    const table = root.querySelector('table');
    const rows = [...(table?.querySelectorAll('tr') || [])];
    const describe = (element) => element && ({
      id: element.dataset.blockId,
      tag: element.tagName,
      text: element.textContent.replace(/\s+/g, ' ').trim(),
      rect: (() => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })(),
    });
    return {
      list: describe(list),
      nestedItem: describe(nestedItem),
      outerSibling: describe(outerSibling),
      table: describe(table),
      rows: rows.map(describe),
    };
  });

  assert.ok(shape.list?.id, 'list container receives a block id');
  assert.ok(shape.nestedItem?.id, 'nested list item receives a block id');
  assert.match(shape.nestedItem.id, /\/list#\d+\/item#\d+$/, 'nested item id records its list path');
  assert.ok(shape.table?.id, 'table receives a block id');
  assert.ok(shape.rows.length >= 3, 'table header and rows are commentable');
  assert.match(shape.rows[1].id, /\/row#\d+$/, 'table row id records its table path');

  const listComment = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: 'smoke', body: 'List surface fixture', quote: shape.list.text,
      block_id: shape.list.id, anchor_kind: 'block',
    }),
  });
  const nestedComment = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: 'smoke', body: 'Nested item fixture', quote: shape.nestedItem.text,
      block_id: shape.nestedItem.id, anchor_kind: 'block',
    }),
  });
  const rowComment = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: 'smoke', body: 'Table row fixture', quote: shape.rows[1].text,
      block_id: shape.rows[1].id, anchor_kind: 'block',
    }),
  });
  const textComment = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: 'smoke', body: 'Text selection fixture', quote: 'Outer sibling text',
      prefix: '', suffix: '', block_id: shape.outerSibling.id, anchor_kind: 'text',
    }),
  });
  const reply = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments/${encodeURIComponent(nestedComment.id)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ author: 'smoke', body: 'Reply inherits the item anchor.' }),
  });

  assert.equal(listComment.anchor_kind, 'block', 'list comment persists block anchor kind');
  assert.equal(nestedComment.anchor_kind, 'block', 'nested item comment persists block anchor kind');
  assert.equal(rowComment.anchor_kind, 'block', 'row comment persists block anchor kind');
  assert.equal(textComment.anchor_kind, 'text', 'text comment persists text anchor kind');
  assert.equal(reply.anchor_kind, 'block', 'replies inherit the parent anchor kind');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md [data-block-id]');
  await wait(300);

  const inspect = () => page.evaluate(({ ids }) => {
    const byId = (id) => [...document.querySelectorAll('.td-md [data-block-id]')]
      .find((candidate) => candidate.dataset.blockId === id);
    const list = byId(ids.list);
    const nestedItem = byId(ids.nestedItem);
    const row = byId(ids.row);
    const outerSibling = byId(ids.outerSibling);
    return {
      listClass: list?.className || '',
      nestedClass: nestedItem?.className || '',
      rowClass: row?.className || '',
      nestedOwnTextMarks: nestedItem?.querySelectorAll(`mark.anno[data-id="${ids.nestedComment}"]`).length || 0,
      rowOwnTextMarks: row?.querySelectorAll(`mark.anno[data-id="${ids.rowComment}"]`).length || 0,
      textMarks: outerSibling?.querySelectorAll(`mark.anno[data-id="${ids.textComment}"]`).length || 0,
      textMarkText: outerSibling?.querySelector(`mark.anno[data-id="${ids.textComment}"]`)?.textContent || '',
      textHasBlockDecoration: outerSibling?.classList.contains('anno-block-comment') || false,
      blockHover: document.querySelector('.td-md [data-block-id].block-hover')?.dataset.blockId || '',
    };
  }, {
    ids: {
      row: shape.rows[1].id,
      list: shape.list.id,
      nestedItem: shape.nestedItem.id,
      outerSibling: shape.outerSibling.id,
      nestedComment: nestedComment.id,
      rowComment: rowComment.id,
      textComment: textComment.id,
    },
  });

  const initial = await inspect();
  assert.match(initial.listClass, /anno-block-comment/, 'list surface receives block decoration');
  assert.match(initial.nestedClass, /anno-block-comment/, 'nested list item receives block decoration');
  assert.match(initial.rowClass, /anno-block-comment/, 'table row receives block decoration');
  assert.equal(initial.nestedOwnTextMarks, 0, 'nested block comment does not create an inline mark');
  assert.equal(initial.rowOwnTextMarks, 0, 'row block comment does not create an inline mark');
  assert.equal(initial.textMarks, 1, 'text comment still creates an inline mark');
  assert.equal(initial.textMarkText, 'Outer sibling text', 'text comment marks only the selected quote');
  assert.equal(initial.textHasBlockDecoration, false, 'text comment does not paint its context block');

  const nestedPoint = await page.evaluate((id) => {
    const block = [...document.querySelectorAll('.td-md [data-block-id]')].find((candidate) => candidate.dataset.blockId === id);
    const r = block.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, shape.nestedItem.id);
  assert.ok(Number.isFinite(nestedPoint.x) && Number.isFinite(nestedPoint.y), 'nested item has a usable hit point');
  await page.mouse.move(nestedPoint.x, nestedPoint.y);
  await wait(80);
  const nestedHover = await inspect();
  assert.equal(nestedHover.blockHover, shape.nestedItem.id, 'text-line hit chooses the nested list item');

  const listChildren = await page.evaluate((listId) => {
    const list = [...document.querySelectorAll('.td-md [data-block-id]')].find((candidate) => candidate.dataset.blockId === listId);
    return [...(list?.children || [])].filter((child) => child.matches('li')).map((child) => {
      const r = child.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
  }, shape.list.id);
  const listRect = await page.evaluate((id) => {
    const list = [...document.querySelectorAll('.td-md [data-block-id]')].find((candidate) => candidate.dataset.blockId === id);
    const r = list.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, shape.list.id);
  let gutterPoint = null;
  for (let x = listRect.left + 2; x < listRect.left + 28 && !gutterPoint; x += 4) {
    for (let y = listRect.top + 2; y < listRect.bottom - 2; y += 6) {
      if (!listChildren.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) {
        gutterPoint = { x, y };
        break;
      }
    }
  }
  assert.ok(gutterPoint, 'list has a parent-owned gutter point');
  await page.mouse.move(gutterPoint.x, gutterPoint.y);
  await wait(80);
  const gutterHover = await inspect();
  assert.equal(gutterHover.blockHover, shape.list.id, 'list gutter hit chooses the parent list');

  const rowPoint = await page.evaluate((id) => {
    const row = [...document.querySelectorAll('.td-md [data-block-id]')].find((candidate) => candidate.dataset.blockId === id);
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, shape.rows[1].id);
  assert.ok(Number.isFinite(rowPoint.x) && Number.isFinite(rowPoint.y), 'table row has a usable hit point');
  await page.mouse.move(rowPoint.x, rowPoint.y);
  await wait(80);
  const rowHover = await inspect();
  assert.equal(rowHover.blockHover, shape.rows[1].id, 'table hit chooses the table row');

  assert.deepEqual(pageErrors, [], `no page errors (got ${pageErrors.join(' | ')})`);
  console.log(JSON.stringify({
    ok: true,
    list: shape.list.id,
    nestedItem: shape.nestedItem.id,
    row: shape.rows[1].id,
    anchors: { block: [listComment.id, nestedComment.id, rowComment.id], text: textComment.id },
  }, null, 2));
} finally {
  try { await archiveTicket(ticket.id); } catch {}
  if (chrome) await chrome.cleanup();
}
