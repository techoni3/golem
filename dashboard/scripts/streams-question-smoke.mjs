#!/usr/bin/env node
// WS6 verification — drives the Streams panel + question→answer→return loop in a
// real headless browser against a FRESH dashboard server, fully isolated from
// the user's live :7420 dashboard and the real tracker DB.
//
//   PORT               = 7617 (free high port, never 7420)
//   HOST               = 127.0.0.1
//   GOLEM_TRACKER_DB   = temp DB file (never the real ~/.config tracker.db)
//   XDG_CONFIG_HOME    = temp dir (empty channels.json → no live channel)
//   GOLEM_PROJECTS_ROOT= temp dir holding ONE project dir with a CLAUDE.md, so
//                        the dashboard discovers a project to render.
//
// Browser: playwright-core driving the system Google Chrome (no ms-playwright
// download). @babel/standalone + playwright-core resolve from a temp install
// dir (PW6_DEPS_DIR, default /tmp/_ws6check).
//
// Assertions (all must pass):
//   1. Project view renders the Streams panel: the sequential stream + its 2
//      member tickets + the "▶ next" marker on the first open ticket.
//   2. "+ New stream" form creates a stream → it appears in the panel.
//   3. Consolidated board "Needs my answer" toggle → only the question ticket.
//   4. Question drawer: "Answer & return" area + "Return to" select render; a
//      comment posts; clicking Return to a (route-injected) live session fires
//      the dispatch and the durable dispatched_to reflects.
//   5. Zero console / page errors. Screenshots written to _artifacts/.
//
//   node dashboard/scripts/streams-question-smoke.mjs

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');
const ARTIFACTS = path.resolve(__dirname, '_artifacts');

const PORT = 7617;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TAG = crypto.randomBytes(6).toString('hex');
const TMP_DB = path.join(os.tmpdir(), `golem-ws6-smoke-${TAG}.db`);
const TMP_XDG = fs.mkdtempSync(path.join(os.tmpdir(), `golem-ws6-xdg-${TAG}-`));
const TMP_PROJECTS = path.join(TMP_XDG, 'projects');
const PROJECT_DIR = path.join(TMP_PROJECTS, 'ws6-demo');

const DEPS_DIR = process.env.PW6_DEPS_DIR || '/tmp/_ws6check';
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function cleanupFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(TMP_XDG, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Seed a project dir the dashboard will discover. ──
fs.mkdirSync(PROJECT_DIR, { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, 'CLAUDE.md'), '# WS6 Demo\n\nA throwaway project for the WS6 smoke test.\n');

const require6 = createRequire(path.join(DEPS_DIR, 'noop.js'));
const { chromium } = require6('playwright-core');

const child = spawn('node', [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST,
    GOLEM_TRACKER_DB: TMP_DB,
    XDG_CONFIG_HOME: TMP_XDG,
    LOG_LEVEL: 'warn',
    GOLEM_PROJECTS_ROOT: TMP_PROJECTS,
    GOLEM_IDEAS_ROOT: path.join(TMP_XDG, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childExited = false;
child.on('exit', () => { childExited = true; });
child.stderr.on('data', (d) => {
  const s = d.toString();
  if (/EADDRINUSE|fatal|Error:/i.test(s)) process.stderr.write(`[child] ${s}`);
});

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) throw new Error('child exited before becoming healthy');
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('server did not become healthy in time');
}

async function jget(p) {
  const r = await fetch(`${BASE}${p}`);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function jsend(method, p, payload) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const BOGUS_SESSION = 'ws6-bogus-session-0001';

async function run() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await waitForHealth();
  check('server: /api/health ok', true);

  // ── Discover the seeded project + its contract project_id. ──
  const projs = await jget('/api/projects');
  const demo = (projs.body ?? []).find((p) => p.id === 'ws6-demo');
  check('project discovered (id=ws6-demo)', !!demo, demo ? `project_id ${demo.project_id}` : 'not found');
  if (!demo) throw new Error('seed project not discovered — cannot continue');
  const PID = demo.project_id;

  // ── Seed: a sequential stream + 2 member tickets + a question ticket. ──
  const mkStream = await jsend('POST', '/api/streams', {
    project_id: PID, name: 'Onboarding flow', mode: 'sequential', description: 'Build sign-up end to end',
  });
  check('POST /api/streams: 201 sequential stream', mkStream.status === 201 && mkStream.body?.mode === 'sequential', `status ${mkStream.status}`);
  const streamId = mkStream.body?.id;

  // Ticket A (created first → lower seq → "next" candidate), state todo.
  const tA = await jsend('POST', '/api/tickets', {
    project_id: PID, kind: 'work-item', title: 'Design the sign-up form', stream_id: streamId, state: 'todo',
  });
  // Ticket B (later seq), state todo.
  const tB = await jsend('POST', '/api/tickets', {
    project_id: PID, kind: 'work-item', title: 'Wire the backend handler', stream_id: streamId, state: 'todo',
  });
  check('POST /api/tickets: 2 stream members created', tA.status === 201 && tB.status === 201, `A ${tA.status} B ${tB.status}`);

  // The question ticket FOR the human (created_by = the bogus session that asked).
  const tQ = await jsend('POST', '/api/tickets', {
    project_id: PID, kind: 'question', assignee: 'human', created_by: BOGUS_SESSION,
    title: 'Which auth provider should we use?', body: 'Supabase vs custom?', state: 'todo',
  });
  check('POST /api/tickets: question-for-human created', tQ.status === 201 && tQ.body?.kind === 'question', `status ${tQ.status}`);
  const qId = tQ.body?.id;
  const aId = tA.body?.id;

  // ── Browser ──
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));

  // Route-inject the dispatchable list so the drawer's "Return to" select is
  // populated with our bogus session — the real /dispatch endpoint then runs
  // durably (channel offline, which is the asserted path). All OTHER requests
  // pass through untouched.
  await ctx.route('**/api/sessions/dispatchable**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { session_id: BOGUS_SESSION, name: 'asker-session', label: 'asker-session', status: 'active', project_id: PID, channel_url: null },
      ]),
    });
  });

  // ───────────────────────── 1. Streams panel ─────────────────────────
  await page.goto(`${BASE}/#project/ws6-demo/agents`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pv-streams', { timeout: 10000 });
  const streamPanel = await page.$('.pv-streams');
  check('1. Streams panel renders', !!streamPanel);

  const streamCard = await page.waitForSelector('.sp-stream', { timeout: 8000 }).catch(() => null);
  check('1. a stream card renders', !!streamCard);

  const memberCount = await page.$$eval('.sp-stream .sp-ticket', (els) => els.length);
  check('1. stream shows its 2 member tickets', memberCount === 2, `found ${memberCount}`);

  const modeText = await page.$eval('.sp-mode-pill', (el) => el.textContent.trim()).catch(() => '');
  check('1. mode badge reads "sequential"', modeText === 'sequential', `got "${modeText}"`);

  // "▶ next" marker is on the FIRST open ticket (ticket A, lowest seq).
  const nextTicketId = await page.$eval('.sp-ticket.sp-next', (el) => el.getAttribute('data-ticket-id')).catch(() => null);
  check('1. "next" marker on the first open sequential ticket', nextTicketId === aId, `marked ${nextTicketId}, expected ${aId}`);
  const nextTagVisible = await page.$('.sp-ticket.sp-next .sp-next-tag');
  check('1. "▶ next" tag rendered', !!nextTagVisible);

  await page.screenshot({ path: path.join(ARTIFACTS, 'streams-panel.png'), fullPage: true });

  // ───────────────────── 2. Create a new stream ──────────────────────
  await page.click('.pv-streams-tools .orch-btn');
  await page.waitForSelector('.sp-new-form', { timeout: 5000 });
  await page.fill('.sp-new-name', 'Billing');
  await page.selectOption('.sp-new-mode', 'parallel');
  await page.fill('.sp-new-desc', 'Stripe integration');
  await page.click('.sp-new-actions .orch-btn.primary');
  // The new stream lands via the stream-updated WS delta; wait for 2 stream cards.
  await page.waitForFunction(() => document.querySelectorAll('.sp-stream').length >= 2, { timeout: 8000 }).catch(() => {});
  const streamCount = await page.$$eval('.sp-stream', (els) => els.length);
  check('2. new stream appears in the panel', streamCount >= 2, `stream cards: ${streamCount}`);
  const apiStreams = await jget(`/api/streams?project=${encodeURIComponent(PID)}`);
  check('2. new stream persisted (Billing/parallel)',
    (apiStreams.body ?? []).some((s) => s.name === 'Billing' && s.mode === 'parallel'),
    `streams: ${(apiStreams.body ?? []).map((s) => s.name).join(', ')}`);

  // ─────────────── 3. Board "Needs my answer" quick filter ────────────
  await page.goto(`${BASE}/#tracker`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tracker-board', { timeout: 8000 });
  // Before toggling: more than one card visible (3 work-items + 1 question).
  const beforeCount = await page.$$eval('.tracker-kanban .ticket', (els) => els.length);
  check('3. board shows multiple tickets pre-filter', beforeCount >= 2, `cards: ${beforeCount}`);

  await page.click('.tracker-needs-answer input');
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('.tracker-kanban .ticket');
    return cards.length === 1;
  }, { timeout: 6000 }).catch(() => {});
  const filteredCount = await page.$$eval('.tracker-kanban .ticket', (els) => els.length);
  check('3. "Needs my answer" → exactly 1 card', filteredCount === 1, `cards: ${filteredCount}`);
  const filteredId = await page.$eval('.tracker-kanban .ticket', (el) => el.getAttribute('data-ticket-id')).catch(() => null);
  check('3. the single card is the question ticket', filteredId === qId, `card ${filteredId}, expected ${qId}`);
  const badgeOnCard = await page.$('.tracker-kanban .ticket .tracker-answer-badge');
  check('3. question card shows "needs answer" badge', !!badgeOnCard);

  // ───────── 4. Question drawer: answer & return loop ─────────
  await page.click('.tracker-kanban .ticket');
  await page.waitForSelector('.drawer-ticket.open .td-question-return', { timeout: 8000 });
  check('4. "Answer & return" area renders for the question', true);
  const headerBadge = await page.$('.drawer-ticket.open .td-answer-badge');
  check('4. drawer header shows "needs answer" badge', !!headerBadge);
  const returnSelect = await page.$('.td-qr-select');
  check('4. "Return to" select renders', !!returnSelect);

  // The select should default to the asker (bogus session is the route-injected
  // live session and matches created_by).
  await page.waitForFunction((sid) => {
    const sel = document.querySelector('.td-qr-select');
    return sel && sel.value === sid;
  }, BOGUS_SESSION, { timeout: 5000 }).catch(() => {});
  const defaulted = await page.$eval('.td-qr-select', (el) => el.value).catch(() => '');
  check('4. "Return to" defaults to the asker session', defaulted === BOGUS_SESSION, `value "${defaulted}"`);

  // Type an answer and click "Answer & return" (posts comment THEN dispatches).
  await page.fill('.td-qr-input', 'Use Supabase — fastest path to auth + RLS.');
  // Capture the affordance state (composer + Return-to select + actions) BEFORE
  // the action — once returned the ticket leaves the question-for-human state.
  await page.screenshot({ path: path.join(ARTIFACTS, 'question-loop.png'), fullPage: true });
  await page.click('.td-qr-actions .orch-btn.primary');

  // Wait for the durable dispatch to reflect: dispatched_to === bogus session.
  let dispatched = false;
  for (let i = 0; i < 40; i++) {
    const got = await jget(`/api/tickets/${qId}`);
    if (got.body?.dispatched_to === BOGUS_SESSION) { dispatched = true; break; }
    await sleep(150);
  }
  check('4. dispatch fired — dispatched_to is the bogus session (durable)', dispatched, `(channel offline expected)`);

  // The answer comment must have posted regardless of channel reachability.
  const finalTicket = await jget(`/api/tickets/${qId}`);
  const hasAnswer = (finalTicket.body?.comments ?? []).some((c) => /Supabase/.test(c.body || ''));
  check('4. answer comment posted', hasAnswer, `comments: ${(finalTicket.body?.comments ?? []).length}`);

  // ───────────────────── 5. No runtime/console errors ────────────────
  // Filter benign noise: WS reconnect chatter / favicon 404s are not app bugs.
  const realConsole = consoleErrors.filter((t) =>
    !/favicon|WebSocket|ws:|net::ERR|Failed to load resource/i.test(t));
  check('5. zero page (runtime) errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('5. zero console errors', realConsole.length === 0, realConsole.join(' | '));

  await browser.close();
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  failures++;
  console.log(`[FAIL] unexpected exception — ${err && err.stack ? err.stack : err}`);
} finally {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(400);
  if (!childExited) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  cleanupFiles();
  if (failures === 0) {
    console.log('\nALL CHECKS PASSED');
  } else {
    console.log(`\n${failures} CHECK(S) FAILED`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
