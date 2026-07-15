// GOL-470 — isolated browser journey for board-card recency ordering.
//
// The fixtures use the quarantined smoke project through _scratch.mjs. The
// browser observes the actual dashboard WebSocket update after each PATCH, so
// this covers both initial render ordering and a live card moving to the top.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { acquireChrome } from './_chrome.mjs';
import { createScratchTicket, archiveTicket } from './_scratch.mjs';

const STATES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'archived'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'golem-470-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
mkdirSync(home, { recursive: true });
mkdirSync(projects, { recursive: true });

const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
process.env.GOLEM_SMOKE_API = base;

const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    GOLEM_HOME: home,
    GOLEM_PROJECTS_ROOT: projects,
    GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`dashboard did not become healthy at ${base}`);
}

function cardIdsInColumn(page, state) {
  return page.evaluate((column) => Array.from(
    document.querySelectorAll(`.kanban-col[data-col="${column}"] .ticket`),
  ).map((card) => card.dataset.ticketId), state);
}

async function assertColumnsNewestFirst(page, fixtures, label) {
  for (const state of STATES) {
    const cards = await cardIdsInColumn(page, state);
    const expected = [fixtures.get(state).newer.id, fixtures.get(state).older.id];
    assert.deepEqual(cards, expected, `${label} ${state} is newest updated first`);
  }
}

async function stopServer() {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, wait(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

let chrome;
const created = [];
try {
  await waitForHealth();

  const fixtures = { work: new Map(), spec: new Map() };
  for (const [fixtureName, kind] of [['work', 'work-item'], ['spec', 'spec']]) {
    for (const state of STATES) {
      const olderCreated = await createScratchTicket({
        kind,
        title: `GOL-470 ${fixtureName} ${state} older`,
        body: `GOL-470 ${fixtureName} ${state} older fixture`,
      });
      const older = state === 'todo' ? olderCreated : await request(`/api/tickets/${encodeURIComponent(olderCreated.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ state, actor: 'smoke' }),
      });
      created.push(older.id);
      // The server owns updated_at. Crossing a clock tick ensures this journey
      // proves recency rather than accidentally relying on source/rank order.
      await wait(20);
      const newerCreated = await createScratchTicket({
        kind,
        title: `GOL-470 ${fixtureName} ${state} newer`,
        body: `GOL-470 ${fixtureName} ${state} newer fixture`,
      });
      const newer = state === 'todo' ? newerCreated : await request(`/api/tickets/${encodeURIComponent(newerCreated.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ state, actor: 'smoke' }),
      });
      created.push(newer.id);
      fixtures[fixtureName].set(state, { older, newer });
    }
  }

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Tracker: the archived toggle makes all six board columns visible.
  await page.goto(`${base}/tracker?archived=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction((id) => !!document.querySelector(`.ticket[data-ticket-id="${id}"]`), fixtures.work.get('archived').newer.id);
  await assertColumnsNewestFirst(page, fixtures.work, 'Tracker');

  // Display-only sorting must not change the existing drag/drop state path.
  const draggedWork = fixtures.work.get('blocked').newer;
  const source = page.locator(`.ticket[data-ticket-id="${draggedWork.id}"]`);
  const target = page.locator('.kanban-col[data-col="review"]');
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && targetBox, 'drag source and target columns are visible');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2 + 8, { steps: 3 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 25 });
  await page.mouse.up();
  await page.waitForFunction(async (id) => {
    const ticket = await (await fetch(`/api/tickets/${id}`)).json();
    return ticket.state === 'review';
  }, draggedWork.id);
  assert.equal((await request(`/api/tickets/${encodeURIComponent(draggedWork.id)}`)).state, 'review', 'drag/drop still persists the ticket state transition');

  // A real PATCH broadcasts ticket-updated. The changed card must move from
  // second to first without a reload, proving live recency ordering.
  const movedWork = fixtures.work.get('todo').older;
  await request(`/api/tickets/${encodeURIComponent(movedWork.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: 'GOL-470 work todo moved by WebSocket', actor: 'smoke' }),
  });
  await page.waitForFunction(([state, id]) =>
    document.querySelector(`.kanban-col[data-col="${state}"] .ticket`)?.dataset.ticketId === id,
  ['todo', movedWork.id]);
  assert.equal((await cardIdsInColumn(page, 'todo'))[0], movedWork.id, 'Tracker ticket-updated moves the changed card to the top');

  // Malformed legacy payloads cannot be authored through the API (updated_at
  // is server-owned), so exercise the live board store exactly where a bad
  // delta would land. Both cards must fall below valid timestamps and use id
  // as their deterministic tie-breaker.
  const malformedOrder = await page.evaluate((ids) => {
    const tickets = window.Store.getState().trackerTickets;
    const first = tickets.get(ids[0]);
    const second = tickets.get(ids[1]);
    window.Store.upsertTrackerTicket({ ...first, updated_at: 'not-a-date' });
    window.Store.upsertTrackerTicket({ ...second, updated_at: null });
    return [first.id, second.id].sort();
  }, [fixtures.work.get('todo').newer.id, movedWork.id]);
  await page.waitForFunction(([state, expected]) => {
    const ids = Array.from(document.querySelectorAll(`.kanban-col[data-col="${state}"] .ticket`))
      .map((card) => card.dataset.ticketId);
    return ids.slice(-expected.length).join('|') === expected.join('|');
  }, ['todo', malformedOrder]);
  assert.deepEqual((await cardIdsInColumn(page, 'todo')).slice(-2), malformedOrder, 'Tracker puts invalid or missing timestamps last with an id tie-breaker');

  // Specs use the same TicketColumns component through a distinct board route.
  await page.goto(`${base}/specs`, { waitUntil: 'networkidle' });
  await page.locator('.specs-board .tracker-toggle input').check();
  await page.waitForFunction((id) => !!document.querySelector(`.ticket[data-ticket-id="${id}"]`), fixtures.spec.get('archived').newer.id);
  await assertColumnsNewestFirst(page, fixtures.spec, 'Specs');

  const movedSpec = fixtures.spec.get('todo').older;
  await request(`/api/tickets/${encodeURIComponent(movedSpec.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: 'GOL-470 spec todo moved by WebSocket', actor: 'smoke' }),
  });
  await page.waitForFunction(([state, id]) =>
    document.querySelector(`.kanban-col[data-col="${state}"] .ticket`)?.dataset.ticketId === id,
  ['todo', movedSpec.id]);
  assert.equal((await cardIdsInColumn(page, 'todo'))[0], movedSpec.id, 'Specs ticket-updated moves the changed card to the top');

  assert.deepEqual(pageErrors, [], `browser emitted no page errors: ${pageErrors.join(' | ')}`);
  console.log('GOL-470 board recency browser journey passed');
} finally {
  for (const id of created) await archiveTicket(id);
  await chrome?.cleanup();
  await stopServer();
  rmSync(scratch, { recursive: true, force: true });
}
