// GOL-101: comment dispatch actually delivers, fails loudly, and stale
// subscriptions get reaped.
//
// Journey-level against the running dashboard + a real live session channel.
// Fixtures live in the quarantined smoke project and are archived in `finally`.
//
// Target session: GOLEM_SMOKE_TARGET_SESSION, else the first reachable session
// in the golem project (same convention as smoke-tkt-0649.mjs). The delivered
// briefs are visible on that session's golem channel during the run.
import { strict as assert } from 'node:assert';
import { createScratchTicket, archiveTicket } from './_scratch.mjs';

const API = 'http://dashboard.golem.localhost:7420/api';
const GOLEM_PROJECT = 'golem-38ab8a';
const DEAD_SESSION = `ses_smoke_gone_${Date.now().toString(36)}`;

const req = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (p, b) => req('POST', p, b);
const get = async (p) => (await req('GET', p)).body;

const targets = await get(`/sessions/dispatchable?project=${encodeURIComponent(GOLEM_PROJECT)}`);
const target = process.env.GOLEM_SMOKE_TARGET_SESSION
  || (targets.find((s) => s.reachable !== false) || targets[0])?.session_id;
assert.ok(target, 'a reachable session is required — start a golem session in this project');

const marker = `SMOKE-GOL101-${Date.now().toString(36)}`;
const created = [];
const topics = [];
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
  console.log(`  ok — ${name}`);
};

const addComments = async (ticketId, n, prefix) => {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const { body } = await post(`/tickets/${encodeURIComponent(ticketId)}/comments`, {
      author: 'human', body: `${marker} ${prefix} ${i}`, block_id: `${prefix}#${i}`,
    });
    out.push(body);
  }
  return out;
};
const statesOf = async (ticketId) => {
  const t = await get(`/tickets/${encodeURIComponent(ticketId)}`);
  return (t.comments || []).map((c) => c.dispatch_state);
};

try {
  // ---- 1. work-item comment dispatch (was rejected as spec-only) -----------
  const wi = await createScratchTicket({ kind: 'work-item', title: `${marker} work item`, body: 'work item body' });
  created.push(wi.id);
  await addComments(wi.id, 2, 'wi');
  const wiBatch = await post(`/tickets/${encodeURIComponent(wi.id)}/comments/batch-dispatch`, { session_id: target });
  check('work-item batch dispatch is accepted and delivered', () => {
    assert.equal(wiBatch.status, 200, `expected 200, got ${wiBatch.status} ${JSON.stringify(wiBatch.body)}`);
    assert.equal(wiBatch.body.delivered, true, 'delivered');
    assert.equal(wiBatch.body.channel?.ok, true, 'channel push succeeded');
    assert.equal(wiBatch.body.dispatches.length, 2, 'both comments enqueued');
  });
  const wiStates = await statesOf(wi.id);
  check('delivered comments leave the undispatched queue', () => {
    assert.deepEqual(wiStates, ['dispatched', 'dispatched'], `states were ${wiStates}`);
  });

  // ---- 2. an active ticket subscription no longer swallows delivery -------
  const subbed = await createScratchTicket({ kind: 'spec', title: `${marker} subscribed spec`, body: 'spec body' });
  created.push(subbed.id);
  const topic = `ticket/${subbed.display_id || subbed.id}`;
  topics.push(topic);
  const sub = await post('/bus/subscribe', { session_id: target, topic, classes: ['tracker'], reason: 'smoke-gol-101' });
  assert.equal(sub.status, 201, 'subscription created');
  await addComments(subbed.id, 2, 'sub');
  const subBatch = await post(`/tickets/${encodeURIComponent(subbed.id)}/comments/batch-dispatch`, { session_id: target });
  check('an active ticket subscription does not suppress the brief', () => {
    assert.equal(subBatch.status, 200, `expected 200, got ${subBatch.status} ${JSON.stringify(subBatch.body)}`);
    assert.equal(subBatch.body.delivered, true, 'delivered despite the subscription');
    assert.equal(subBatch.body.channel?.ok, true, 'channel push actually happened');
    assert.notEqual(subBatch.body.delivery, 'subscription', 'no subscription short-circuit');
  });

  // ---- 3. undeliverable batch fails loudly and rolls back -----------------
  const failing = await createScratchTicket({ kind: 'spec', title: `${marker} undeliverable spec`, body: 'spec body' });
  created.push(failing.id);
  await addComments(failing.id, 3, 'fail');
  const dead = await post(`/tickets/${encodeURIComponent(failing.id)}/comments/batch-dispatch`, { session_id: DEAD_SESSION });
  check('an undeliverable batch returns 502 instead of claiming success', () => {
    assert.equal(dead.status, 502, `expected 502, got ${dead.status} ${JSON.stringify(dead.body)}`);
    assert.equal(dead.body.delivered, false, 'delivered:false');
    assert.match(String(dead.body.error), /not delivered/i, 'error names the failure');
    assert.equal(dead.body.rolled_back, 3, 'all three dispatches rolled back');
  });
  const failedStates = await statesOf(failing.id);
  check('a failed batch leaves every comment undispatched', () => {
    assert.deepEqual(failedStates, ['undispatched', 'undispatched', 'undispatched'], `states were ${failedStates}`);
  });
  const retry = await post(`/tickets/${encodeURIComponent(failing.id)}/comments/batch-dispatch`, { session_id: target });
  check('a rolled-back batch is retryable against a live session', () => {
    assert.equal(retry.status, 200, `expected 200, got ${retry.status} ${JSON.stringify(retry.body)}`);
    assert.equal(retry.body.delivered, true, 'retry delivered');
    assert.equal(retry.body.dispatches.length, 3, 'all three comments re-enqueued');
  });

  // ---- 4. the standalone single-comment path ------------------------------
  const single = await createScratchTicket({ kind: 'fix', title: `${marker} single-dispatch fix`, body: 'fix body' });
  created.push(single.id);
  const [one, two] = await addComments(single.id, 2, 'one');
  const okOne = await post(`/comments/${encodeURIComponent(one.id)}/dispatch`, { session_id: target });
  check('single comment dispatch delivers on a non-spec ticket', () => {
    assert.equal(okOne.status, 200, `expected 200, got ${okOne.status} ${JSON.stringify(okOne.body)}`);
    assert.equal(okOne.body.delivered, true, 'delivered');
    assert.equal(okOne.body.channel?.ok, true, 'channel push succeeded');
  });
  const badTwo = await post(`/comments/${encodeURIComponent(two.id)}/dispatch`, { session_id: DEAD_SESSION });
  const singleStates = await statesOf(single.id);
  check('an undeliverable single dispatch 502s and leaves its comment undispatched', () => {
    assert.equal(badTwo.status, 502, `expected 502, got ${badTwo.status} ${JSON.stringify(badTwo.body)}`);
    assert.equal(badTwo.body.rolled_back, 1, 'the one dispatch rolled back');
    assert.equal(singleStates.filter((s) => s === 'undispatched').length, 1, `states were ${singleStates}`);
  });

  // ---- 5. the subscription reaper ----------------------------------------
  const deadTopic = `ticket/${subbed.display_id || subbed.id}`;
  const deadSub = await post('/bus/subscribe', { session_id: DEAD_SESSION, topic: deadTopic, classes: ['tracker'], reason: 'smoke-gol-101' });
  assert.equal(deadSub.status, 201, 'dead-session subscription created');
  // Scoped to the fixture session — a fleet-wide forced reap would suspend
  // every absent owner's subscriptions on the shared dashboard, and only
  // Claude Code re-activates them automatically.
  const reap = await post('/bus/subscriptions/reap', { force: true, session_id: DEAD_SESSION });
  const after = await get('/bus/subscriptions');
  const deadRows = after.filter((s) => s.session_id === DEAD_SESSION);
  const liveRows = after.filter((s) => s.session_id === target && s.topic === topic);
  check('the reaper suspends a gone session subscriptions', () => {
    assert.equal(reap.status, 200, `expected 200, got ${reap.status}`);
    assert.ok(reap.body.suspended >= 1, `expected >=1 suspended, got ${reap.body.suspended}`);
    assert.ok(deadRows.length > 0 && deadRows.every((s) => s.status === 'suspended'), `dead rows: ${JSON.stringify(deadRows)}`);
  });
  check('the reaper leaves a live session subscriptions active', () => {
    assert.ok(liveRows.length > 0, 'the live subscription still exists');
    assert.ok(liveRows.every((s) => s.status === 'active'), `live rows: ${JSON.stringify(liveRows)}`);
  });

  console.log(`\nPASS — ${checks.length} checks, target ${target}`);
} finally {
  for (const t of topics) {
    await post('/bus/unsubscribe', { session_id: target, topic: t, reason: 'smoke-cleanup' });
    await post('/bus/unsubscribe', { session_id: DEAD_SESSION, topic: t, reason: 'smoke-cleanup' });
  }
  for (const id of created) await archiveTicket(id);
}
