// TKT-0651: finalisation readiness endpoint + spec drawer button.
// Creates one complete spec and one incomplete spec, validates both via REST,
// then clicks Finalise in headless Chrome for pass and concerns paths.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const ORIGIN = 'http://dashboard.golem.localhost:7420';
const API = `${ORIGIN}/api`;
const PROJECT = 'golem-1eba80';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => {
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(json)}`);
  return json;
});
const patch = (path, body) => fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const get = (path) => fetch(`${API}${path}`).then((r) => r.json());

const marker = `SMOKE-0651-${Date.now().toString(36)}`;
const completeBody = `# ${marker} complete spec

## 1. Context

Context.

## 2. Behaviour

### Login success

The user can log in successfully.

- Password reset flow

## 3. Decisions

- Open question answered by decision.

## 5. Open questions

- Should SSO ship now? deferred to later.`;

const incompleteBody = `# ${marker} incomplete spec

## 1. Context

Context.

## 2. Behaviour

### Export dashboard

The dashboard can export data.

### Import dashboard

The dashboard can import data.

## 5. Open questions

- Which format should import use?`;

const made = [];
const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

try {
  const complete = await post('/tickets', { project_id: PROJECT, kind: 'spec', created_by: 'smoke', title: `${marker} complete`, body: completeBody });
  made.push(complete.id);
  await patch(`/tickets/${encodeURIComponent(complete.id)}`, { state: 'in_progress', actor: 'smoke' });
  const c1 = await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', parent_id: complete.id, title: `${marker} Login success child`, body: 'covers login success' });
  const c2 = await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', parent_id: complete.id, title: `${marker} Password reset flow child`, body: 'covers password reset flow' });
  made.push(c1.id, c2.id);

  const incomplete = await post('/tickets', { project_id: PROJECT, kind: 'spec', created_by: 'smoke', title: `${marker} incomplete`, body: incompleteBody });
  made.push(incomplete.id);
  await patch(`/tickets/${encodeURIComponent(incomplete.id)}`, { state: 'in_progress', actor: 'smoke' });
  const i1 = await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', parent_id: incomplete.id, title: `${marker} Export dashboard child`, body: 'covers export dashboard' });
  made.push(i1.id);

  const pass = await post(`/tickets/${encodeURIComponent(complete.id)}/validate-finalisation`, {});
  assert.equal(pass.result, 'pass', `complete spec passes (${JSON.stringify(pass)})`);
  assert.deepEqual(pass.notes, [], 'complete spec has no notes');

  const concerns = await post(`/tickets/${encodeURIComponent(incomplete.id)}/validate-finalisation`, {});
  assert.equal(concerns.result, 'concerns', `incomplete spec returns concerns (${JSON.stringify(concerns)})`);
  assert.ok(concerns.notes.some((n) => /Import dashboard/.test(n)), 'concerns mention unmatched behaviour');
  assert.ok(concerns.notes.some((n) => /Open question/.test(n)), 'concerns mention unresolved open question');

  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(complete.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-finalise-btn');
  await page.click('.td-finalise-btn');
  await wait(900);
  const completeAfter = await get(`/tickets/${encodeURIComponent(complete.id)}`);
  assert.equal(completeAfter.state, 'review', 'pass button moves spec to review');

  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(incomplete.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-finalise-btn');
  await page.click('.td-finalise-btn');
  await wait(1200);
  const incompleteAfter = await get(`/tickets/${encodeURIComponent(incomplete.id)}`);
  assert.equal(incompleteAfter.state, 'in_progress', 'concerns button leaves spec in_progress');
  assert.ok(incompleteAfter.comments.some((c) => c.tag === 'risk' && /Finalisation concerns/.test(c.body)), 'concerns button posts risk comment');

  const nonSpec = await post(`/tickets/${encodeURIComponent(c1.id)}/validate-finalisation`, {});
  assert.equal(nonSpec.result, 'fail', 'non-spec validation returns fail');

  assert.deepEqual(pageerrors, [], `no page errors: ${pageerrors.join('\n')}`);
  console.log(JSON.stringify({
    ok: true,
    complete: { id: complete.id, endpoint: pass, stateAfterButton: completeAfter.state },
    incomplete: { id: incomplete.id, endpoint: concerns, stateAfterButton: incompleteAfter.state, riskComments: incompleteAfter.comments.filter((c) => c.tag === 'risk').length },
    nonSpec,
  }, null, 2));
} finally {
  for (const id of made) {
    try { await patch(`/tickets/${encodeURIComponent(id)}`, { state: 'archived', actor: 'smoke' }); } catch {}
  }
  await cleanup();
}
