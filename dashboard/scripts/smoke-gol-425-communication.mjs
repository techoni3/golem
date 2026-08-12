#!/usr/bin/env node
// GOL-425 isolated browser journey. Uses a temporary dashboard/DB and the
// shared ephemeral-headless helper; it never writes a real project or tracker.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { acquireChrome } from './_chrome.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '..', 'server', 'index.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-425-communication-'));
const home = path.join(temp, 'home');
const projects = path.join(temp, 'projects');
const dbPath = path.join(temp, 'tracker.db');
const port = 8300 + crypto.randomInt(500);
const base = `http://127.0.0.1:${port}`;
let server;
let chrome;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
async function waitForServer() {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('temporary GOL-425 dashboard did not become healthy');
}
async function createTicket(title) {
  return request('/api/tickets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: 'health-demo', kind: 'task', title, body: '', created_by: 'smoke' }),
  });
}
async function expectBadRequest(pathname) {
  const response = await fetch(`${base}${pathname}`);
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 400, `${pathname} rejects invalid communication filters`);
  assert.equal(typeof body?.error, 'string', `${pathname} returns a validation error`);
}

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(projects, 'health-demo'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'health-demo', 'CLAUDE.md'), '# GOL-425 isolated smoke\n');
  // A non-CC registry row is alive from bounded recent activity, without a
  // channel/process dependency. It gives the Agents page a real local badge.
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [
    { session_id: 'health-session', name: 'Health Agent', status: 'idle', harness: 'other',
      project_path: path.join(projects, 'health-demo'), boot_time: new Date().toISOString(), last_seen_at: new Date().toISOString() },
    { session_id: 'recovered-escalation-session', name: 'Recovered Escalation Agent', status: 'idle', harness: 'other',
      project_path: path.join(projects, 'health-demo'), boot_time: new Date().toISOString(), last_seen_at: new Date().toISOString() },
  ] }, null, 2));
  server = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GOLEM_HOME: home, GOLEM_TRACKER_DB: dbPath, GOLEM_PROJECTS_ROOT: projects, GOLEM_IDEAS_ROOT: path.join(temp, 'ideas') },
    stdio: 'ignore',
  });
  await waitForServer();

  const [redTicket, amberTicket, historyTicket, queuedTicket, deliveryFailureTicket, acknowledgedEscalationTicket] = await Promise.all([
    createTicket('GOL-425 escalation evidence'),
    createTicket('GOL-425 awaiting evidence'),
    createTicket('GOL-425 acknowledged history'),
    createTicket('GOL-425 queued evidence'),
    createTicket('GOL-425 delivery failure evidence'),
    createTicket('GOL-425 acknowledged escalation evidence'),
  ]);
  const now = Date.now();
  const iso = (delta) => new Date(now + delta).toISOString();
  const db = new Database(dbPath);
  const insertEnvelope = db.prepare(`INSERT INTO message_envelopes
    (id, root_id, parent_id, ticket_id, project_id, sender_id, reply_to_session_id, recipient_session_id, sender_session_id, target_session_id, kind, payload, status, created_at, delivery_attempted_at, delivery_opportunity_at, delivery_error, ack_deadline_at, acknowledged_at, ping_envelope_id, escalation_envelope_id)
    VALUES (@id, @root_id, @parent_id, @ticket_id, @project_id, 'human', 'human', @recipient_session_id, 'human', @recipient_session_id, @kind, '{}', @status, @created_at, @delivery_attempted_at, @delivery_opportunity_at, @delivery_error, @ack_deadline_at, @acknowledged_at, @ping_envelope_id, @escalation_envelope_id)`);
  const root = (id, ticket, patch = {}) => insertEnvelope.run({
    id, root_id: id, parent_id: null, ticket_id: ticket.id, project_id: ticket.project_id,
    recipient_session_id: 'health-session', kind: 'ticket_dispatch', status: 'delivered', created_at: iso(-20_000),
    delivery_attempted_at: iso(-19_000), delivery_opportunity_at: iso(-19_000), delivery_error: null,
    ack_deadline_at: iso(30_000), acknowledged_at: null, ping_envelope_id: null, escalation_envelope_id: null, ...patch,
  });
  root('env-red', redTicket, { ack_deadline_at: iso(-12_000), ping_envelope_id: 'env-red-ping', escalation_envelope_id: 'env-red-escalation' });
  insertEnvelope.run({ id: 'env-red-ping', root_id: 'env-red', parent_id: 'env-red', ticket_id: redTicket.id, project_id: redTicket.project_id, recipient_session_id: 'health-session', kind: 'ack_ping', status: 'delivered', created_at: iso(-11_000), delivery_attempted_at: iso(-10_000), delivery_opportunity_at: iso(-10_000), delivery_error: null, ack_deadline_at: null, acknowledged_at: null, ping_envelope_id: null, escalation_envelope_id: null });
  insertEnvelope.run({ id: 'env-red-escalation', root_id: 'env-red', parent_id: 'env-red', ticket_id: redTicket.id, project_id: redTicket.project_id, recipient_session_id: 'human', kind: 'escalation', status: 'delivery_failed', created_at: iso(-9_000), delivery_attempted_at: iso(-8_000), delivery_opportunity_at: null, delivery_error: 'sender channel unavailable', ack_deadline_at: null, acknowledged_at: null, ping_envelope_id: null, escalation_envelope_id: null });
  root('env-amber', amberTicket);
  root('env-history', historyTicket, { acknowledged_at: iso(-4_000), ack_deadline_at: iso(-3_000) });
  db.prepare(`INSERT INTO message_acknowledgements (envelope_id, recipient_session_id, kind, summary, acknowledged_at)
    VALUES ('env-history', 'health-session', 'brief', 'acknowledged', ?)`).run(iso(-4_000));
  root('env-queued', queuedTicket, { status: 'queued', delivery_attempted_at: null, delivery_opportunity_at: null, ack_deadline_at: null });
  db.prepare(`INSERT INTO dispatch_queue (id, ticket_id, project_id, session_id, note, workspace, envelope_id, status, created_at)
    VALUES ('queue-health', ?, ?, 'health-session', NULL, NULL, 'env-queued', 'pending', ?)`)
    .run(queuedTicket.id, queuedTicket.project_id, iso(-2_000));
  root('env-delivery-failure', deliveryFailureTicket, {
    status: 'delivery_failed', delivery_opportunity_at: null, delivery_error: 'target channel unavailable',
  });
  root('env-escalation-acknowledged', acknowledgedEscalationTicket, {
    recipient_session_id: 'recovered-escalation-session', ack_deadline_at: iso(-12_000),
    ping_envelope_id: 'env-escalation-acknowledged-ping', escalation_envelope_id: 'env-escalation-acknowledged-child',
  });
  insertEnvelope.run({ id: 'env-escalation-acknowledged-ping', root_id: 'env-escalation-acknowledged', parent_id: 'env-escalation-acknowledged', ticket_id: acknowledgedEscalationTicket.id, project_id: acknowledgedEscalationTicket.project_id, recipient_session_id: 'recovered-escalation-session', kind: 'ack_ping', status: 'delivered', created_at: iso(-11_000), delivery_attempted_at: iso(-10_000), delivery_opportunity_at: iso(-10_000), delivery_error: null, ack_deadline_at: null, acknowledged_at: null, ping_envelope_id: null, escalation_envelope_id: null });
  insertEnvelope.run({ id: 'env-escalation-acknowledged-child', root_id: 'env-escalation-acknowledged', parent_id: 'env-escalation-acknowledged', ticket_id: acknowledgedEscalationTicket.id, project_id: acknowledgedEscalationTicket.project_id, recipient_session_id: 'human', kind: 'escalation', status: 'delivered', created_at: iso(-9_000), delivery_attempted_at: iso(-8_000), delivery_opportunity_at: iso(-8_000), delivery_error: null, ack_deadline_at: null, acknowledged_at: iso(-7_000), ping_envelope_id: null, escalation_envelope_id: null });
  db.prepare(`INSERT INTO message_acknowledgements (envelope_id, recipient_session_id, kind, summary, acknowledged_at)
    VALUES ('env-escalation-acknowledged-child', 'human', 'brief', 'seen', ?)`).run(iso(-7_000));
  db.close();

  const summary = await request('/api/communication-health');
  assert.equal(summary.health.level, 'red', 'failed escalation makes health red');
  assert.equal(summary.health.red, 2, 'failed escalation and plain delivery failure both count red');
  assert.equal(summary.health.needs_attention, 1, 'unacknowledged escalation is the only needs-you root');
  assert.equal(summary.health.queued, 1, 'queued root is counted but not itself unhealthy');
  const needs = await request('/api/message-envelopes?state=needs_attention');
  assert.deepEqual(needs.items.map((item) => item.id), ['env-red'], 'needs-attention list is derived from escalation facts');
  const history = await request('/api/message-envelopes?state=history&fact=acknowledged');
  assert.deepEqual(history.items.map((item) => item.id), ['env-history'], 'history fact filter returns acknowledged evidence');
  const detail = await request('/api/message-envelopes/env-red-escalation');
  assert.equal(detail.id, 'env-red', 'detail resolves a child envelope to its dispatch root');
  assert.ok(detail.facts.some((fact) => fact.label === 'Escalation delivery failed'), 'detail has a display-safe escalation failure fact');
  assert.equal(Object.hasOwn(detail, 'payload'), false, 'detail does not expose a raw message payload');
  const acknowledgedEscalation = await request(`/api/message-envelopes?ticket=${encodeURIComponent(acknowledgedEscalationTicket.id)}&state=in_flight&fact=escalation`);
  assert.equal(acknowledgedEscalation.items.length, 1, 'acknowledged escalation remains an in-flight factual timeline');
  assert.equal(acknowledgedEscalation.items[0].severity, 'pinged', 'acknowledged escalation downshifts to pinged amber');
  assert.equal(acknowledgedEscalation.items[0].needs_attention, false, 'acknowledged escalation is not Needs You');
  assert.ok(acknowledgedEscalation.items[0].facts.some((fact) => fact.label === 'Escalation delivered'), 'timeline retains escalation delivery evidence');
  assert.ok(acknowledgedEscalation.items[0].facts.some((fact) => /Acknowledged for escalation/.test(fact.label)), 'timeline retains escalation acknowledgement evidence');
  const acknowledgedTicket = await request(`/api/tickets/${encodeURIComponent(acknowledgedEscalationTicket.id)}`);
  assert.deepEqual(acknowledgedTicket.active_unacked_dispatches.map((warning) => warning.severity), ['pinged'], 'local ticket badge data is amber, never escalated');
  const validFiltered = await request(`/api/message-envelopes?ticket=${encodeURIComponent(acknowledgedEscalationTicket.id)}&state=in_flight&fact=escalation&from=${encodeURIComponent(iso(-30_000))}&to=${encodeURIComponent(iso(30_000))}&limit=1`);
  assert.deepEqual(validFiltered.items.map((item) => item.id), ['env-escalation-acknowledged'], 'valid state/fact/time/limit filters remain precise');
  await expectBadRequest('/api/message-envelopes?state=unknown');
  await expectBadRequest('/api/message-envelopes?fact=unknown');
  await expectBadRequest('/api/message-envelopes?from=not-a-timestamp');
  await expectBadRequest(`/api/message-envelopes?from=${encodeURIComponent(iso(1_000))}&to=${encodeURIComponent(iso(-1_000))}`);
  await expectBadRequest('/api/message-envelopes?limit=0');
  await expectBadRequest('/api/communication-health?limit=501');

  chrome = await acquireChrome();
  const context = chrome.browser.contexts()[0] || await chrome.browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${base}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="communication-health-indicator"].severity-red', { timeout: 15_000 });
  assert.match(await page.locator('[data-testid="communication-health-indicator"]').textContent(), /1 needs attention · 1 delivery failure/, 'mixed red health names both attention and delivery failure counts');
  await page.waitForSelector('.agent-card .unacked-dispatch-badge.severity-escalated', { timeout: 15_000 });
  const recoveredAgent = page.locator('.agent-card').filter({ hasText: 'Recovered Escalation Agent' });
  await recoveredAgent.locator('.unacked-dispatch-badge.severity-pinged').waitFor({ timeout: 15_000 });
  assert.equal(await recoveredAgent.locator('.unacked-dispatch-badge.severity-escalated').count(), 0, 'acknowledged escalation has no red local agent badge');
  await page.goto(`${base}/tracker`, { waitUntil: 'domcontentloaded' });
  const recoveredTicketCard = page.locator(`.ticket[data-ticket-id="${acknowledgedEscalationTicket.id}"]`);
  await recoveredTicketCard.locator('.unacked-dispatch-badge.severity-pinged').waitFor({ timeout: 15_000 });
  assert.equal(await recoveredTicketCard.locator('.unacked-dispatch-badge.severity-escalated').count(), 0, 'acknowledged escalation has no red local ticket badge');
  await page.goto(`${base}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="communication-health-indicator"].severity-red', { timeout: 15_000 });
  assert.equal(await page.locator('[data-testid="project-communication-panel"]').count(), 0, 'communication adds no project panel');
  await page.locator('[data-testid="communication-health-indicator"]').click();
  await page.waitForSelector('[data-testid="communication-drawer"].open');
  await page.waitForSelector('[data-envelope-id="env-red"]');
  assert.match(await page.locator('[data-envelope-id="env-red"]').textContent(), /Escalation delivery failed/, 'desktop drawer exposes the factual progression');

  await page.locator('[data-testid="communication-filter-in_flight"]').click();
  await page.waitForSelector('[data-envelope-id="env-amber"]');
  assert.match(await page.locator('[data-envelope-id="env-amber"]').getAttribute('class'), /severity-awaiting/, 'awaiting local timeline state remains subtle amber');
  await page.waitForSelector('[data-envelope-id="env-escalation-acknowledged"]');
  assert.match(await page.locator('[data-envelope-id="env-escalation-acknowledged"]').getAttribute('class'), /severity-pinged/, 'acknowledged escalation drawer row is amber, not red');
  assert.match(await page.locator('[data-envelope-id="env-escalation-acknowledged"]').textContent(), /Acknowledged for escalation/, 'drawer preserves acknowledged escalation evidence');
  await page.locator('[data-testid="communication-filter-history"]').click();
  await page.waitForSelector('[data-envelope-id="env-history"]');
  const ticketHref = await page.locator('[data-envelope-id="env-history"] [data-testid="communication-ticket-link"]').getAttribute('href');
  const sessionHref = await page.locator('[data-envelope-id="env-history"] [data-testid="communication-session-link"]').getAttribute('href');
  assert.match(ticketHref || '', /^\/tickets\//, 'timeline ticket link is a real ticket route');
  assert.match(sessionHref || '', /\?ns=health-session$/, 'timeline session link is a real session overlay route');

  await page.locator('[data-testid="communication-filter-needs_attention"]').click();
  await page.waitForSelector('[data-testid="communication-dismiss"]');
  await page.locator('[data-testid="communication-dismiss"]').click();
  // The drawer only reloads through the server's WS invalidation; no optimistic
  // local removal or timer is used here.
  await page.waitForSelector('[data-testid="communication-empty"]', { timeout: 10_000 });
  await page.locator('[data-testid="communication-filter-history"]').click();
  await page.waitForSelector('[data-envelope-id="env-red"]');
  assert.match(await page.locator('[data-envelope-id="env-red"]').textContent(), /Attention dismissed/, 'dismissal hides attention but preserves evidence in History');

  await page.locator('[aria-label="Close communication health"]').click();
  await page.waitForSelector('[data-testid="communication-drawer"]:not(.open)');
  await page.goto(`${base}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="communication-health-indicator"].severity-red', { timeout: 15_000 });
  const deliveryFailureLabel = await page.locator('[data-testid="communication-health-indicator"]').textContent();
  assert.match(deliveryFailureLabel, /^\s*1 delivery failure\s*$/, 'red health with zero Needs You is labelled as a delivery failure');
  assert.doesNotMatch(deliveryFailureLabel, /needs attention/i, 'delivery-only red health does not claim Needs You');
  await page.locator('[data-testid="communication-health-indicator"]').click();
  await page.waitForSelector('[data-testid="communication-drawer"].open');
  assert.equal(await page.locator('[data-testid="communication-filter-needs_attention"]').getAttribute('aria-selected'), 'true', 'drawer defaults to Needs attention');
  await page.waitForSelector('[data-testid="communication-empty"]', { timeout: 10_000 });
  await page.locator('[data-testid="communication-filter-in_flight"]').click();
  await page.waitForSelector('[data-envelope-id="env-delivery-failure"]');
  assert.match(await page.locator('[data-envelope-id="env-delivery-failure"]').getAttribute('class'), /severity-failed/, 'delivery-only failure stays in In flight with failed severity');
  await page.locator('[aria-label="Close communication health"]').click();
  await page.waitForSelector('[data-testid="communication-drawer"]:not(.open)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="communication-health-indicator"]', { timeout: 15_000 });
  await page.locator('[data-testid="communication-health-indicator"]').click();
  await page.waitForSelector('[data-testid="communication-drawer"].open');
  const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  assert.equal(noHorizontalOverflow, true, 'mobile communication drawer does not overflow the viewport');
  assert.deepEqual(pageErrors, [], `no desktop/mobile page errors: ${pageErrors.join('; ')}`);
  console.log('PASS GOL-425 communication health API + desktop/mobile headless journey');
} finally {
  try { await chrome?.cleanup(); } catch {}
  try { server?.kill('SIGTERM'); } catch {}
  await sleep(100);
  fs.rmSync(temp, { recursive: true, force: true });
}
