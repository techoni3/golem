// TKT-0648: comment-dispatch UI. Creates a scratch spec assigned to a live
// session, drives the ticket drawer comment rail, and verifies:
//   1. Save alone leaves the comment undispatched and creates no dispatch row.
//   2. Save & dispatch enqueues/delivers one comment dispatch.
//   3. Save & batch-dispatch sends all undispatched comments with one batch_id.
//   4. Badge count matches DB dispatch_state='undispatched'.
//   5. A target-session reply flips the original comment chip to addressed via WS.

import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { acquireChrome } from './_chrome.mjs';

const ORIGIN = 'http://dashboard.golem.localhost:7420';
const API = `${ORIGIN}/api`;
const PROJECT = 'golem-1eba80';
const DB_PATH = path.join(os.homedir(), '.golem', 'tracker.db');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const patch = (p, body) => fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());

async function firstDispatchTarget() {
  const rows = await get(`/sessions/dispatchable?project=${encodeURIComponent(PROJECT)}`);
  const picked = rows.find((s) => s.reachable !== false) || rows[0];
  assert.ok(picked?.session_id, 'at least one dispatchable session exists');
  return picked;
}

async function openComposer(page) {
  await page.evaluate(() => {
    if (!document.querySelector('#anno-rail.open')) document.querySelector('#anno-fab')?.click();
  });
  await wait(200);
  await page.evaluate(() => Array.from(document.querySelectorAll('.rail-btn')).find((b) => b.textContent.includes('+ New'))?.click());
  await page.waitForSelector('#anno-list .anno-composer textarea');
}

async function saveComment(page, text, { dispatch = false } = {}) {
  await openComposer(page);
  await page.fill('#anno-list .anno-composer textarea', text);
  await page.evaluate((wantDispatch) => {
    const buttons = Array.from(document.querySelectorAll('#anno-list .anno-composer button'));
    const label = wantDispatch ? 'Save & dispatch' : 'Comment';
    const btn = buttons.find((b) => b.textContent.trim() === label);
    if (!btn) throw new Error(`button not found: ${label}`);
    btn.click();
  }, dispatch);
  await wait(900);
}

function dbRows(ticketId) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return {
      comments: db.prepare('SELECT id, body, dispatch_state FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC').all(ticketId),
      dispatches: db.prepare('SELECT comment_id, batch_id, status, delivered_at, addressed_at FROM comment_dispatches WHERE ticket_id = ? ORDER BY created_at ASC, id ASC').all(ticketId),
      undispatched: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE ticket_id = ? AND dispatch_state = 'undispatched'").get(ticketId).n,
    };
  } finally {
    db.close();
  }
}

const target = await firstDispatchTarget();
const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let spec = null;
try {
  spec = await post('/tickets', {
    project_id: PROJECT,
    kind: 'spec',
    created_by: 'smoke',
    assignee: target.session_id,
    title: `SMOKE-0648 comment dispatch ${Date.now().toString(36)}`,
    body: '# Smoke spec\n\nBody paragraph for comment-dispatch UI smoke.',
  });
  assert.ok(spec.id, 'created scratch spec');

  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#anno-fab');

  await saveComment(page, 'SMOKE-0648 save-only comment');
  let afterSave = dbRows(spec.id);
  assert.equal(afterSave.undispatched, 1, 'Save alone creates exactly one undispatched comment');
  assert.equal(afterSave.dispatches.length, 0, 'Save alone creates no comment_dispatches rows');

  await saveComment(page, 'SMOKE-0648 save-and-dispatch comment', { dispatch: true });
  let afterSingle = dbRows(spec.id);
  const single = afterSingle.comments.find((c) => c.body.includes('save-and-dispatch'));
  assert.ok(single, 'single dispatched comment exists');
  assert.notEqual(single.dispatch_state, 'undispatched', 'Save & dispatch moves this comment out of undispatched');
  assert.ok(afterSingle.dispatches.some((d) => d.comment_id === single.id && d.batch_id == null), 'single dispatch row has no batch_id');

  await saveComment(page, 'SMOKE-0648 batch comment A');
  await saveComment(page, 'SMOKE-0648 batch comment B');
  await wait(400);
  const badgeBeforeBatch = await page.evaluate(() => document.querySelector('.td-comment-dispatch-badge')?.textContent.trim() || '');
  assert.match(badgeBeforeBatch, /undispatched:\s*3/, `badge count matches DB before batch (${badgeBeforeBatch})`);

  await page.click('.td-comment-batch-dispatch');
  await wait(1200);
  let afterBatch = dbRows(spec.id);
  assert.equal(afterBatch.undispatched, 0, 'Batch dispatch clears all undispatched comments');
  const batchRows = afterBatch.dispatches.filter((d) => d.batch_id != null);
  assert.equal(batchRows.length, 3, 'batch dispatch includes all three undispatched comments');
  assert.equal(new Set(batchRows.map((d) => d.batch_id)).size, 1, 'batch dispatch uses one shared batch_id');

  await post(`/tickets/${encodeURIComponent(spec.id)}/comments/${encodeURIComponent(single.id)}/reply`, {
    author: target.session_id,
    body: 'SMOKE-0648 addressed reply',
  });
  await page.waitForFunction((id) => {
    return !!document.querySelector(`.anno-card[data-id="${id}"] .anno-dispatch-chip.addressed`);
  }, single.id, { timeout: 5000 });
  const afterReply = dbRows(spec.id);
  const singleDispatch = afterReply.dispatches.find((d) => d.comment_id === single.id);
  assert.equal(singleDispatch.status, 'addressed', 'target-session reply marks dispatch addressed');
  assert.ok(singleDispatch.addressed_at, 'addressed_at is stamped');

  assert.deepEqual(pageerrors, [], `no page errors: ${pageerrors.join('\n')}`);
  console.log(JSON.stringify({
    ok: true,
    specId: spec.id,
    target: target.session_id,
    saveOnly: afterSave.comments.find((c) => c.body.includes('save-only'))?.dispatch_state,
    singleDispatch: { comment_id: single.id, state: single.dispatch_state },
    batch: { count: batchRows.length, batch_id: batchRows[0]?.batch_id },
    addressed: { comment_id: single.id, status: singleDispatch.status },
  }, null, 2));
} finally {
  if (spec?.id) {
    try { await patch(`/tickets/${encodeURIComponent(spec.id)}`, { state: 'archived', actor: 'smoke' }); } catch {}
  }
  await cleanup();
}
