import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initDispatchDrainer } from '../dashboard/server/dispatch-queue.js';
import { openTrackerDb } from '../dashboard/server/tracker-db.js';
import {
  acceptTypedDelivery,
  claimTypedDelivery,
  closeTypedWorkerEndpoint,
  interruptTypedDelivery,
  normalizeTypedWorkerInbox,
  requireTypedDeliveryRecovery,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  typedDeliveryResult,
} from '../lib/typed-worker-endpoint.js';

const canonicalId = 'typed-worker-journey';
const ownerToken = 'typed-worker-owner-token';
let inbox = normalizeTypedWorkerInbox();

async function accept(envelope) {
  const claim = claimTypedDelivery(inbox, envelope);
  if (claim.duplicate) return typedDeliveryResult(claim.delivery, { duplicate: true });
  if (claim.busy) return { ok: false, accepted: false, http_status: 409, error: 'worker is busy' };
  const { delivery } = acceptTypedDelivery(inbox, envelope.envelope_id, { turnId: `turn-${envelope.envelope_id}` });
  return typedDeliveryResult(delivery, { httpStatus: 202 });
}

const endpoint = await startTypedWorkerEndpoint({
  canonicalId,
  ownerToken,
  deliveryReady: () => !inbox.in_flight_envelope_id,
  acceptDelivery: accept,
  maxBodyBytes: 256,
});
const base = `http://${endpoint.host}:${endpoint.port}`;

async function post(envelope, { owner = ownerToken, sender = 'dashboard' } = {}) {
  const response = await fetch(`${base}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': sender,
      'x-golem-target-session': canonicalId,
      'x-golem-endpoint-owner': owner,
    },
    body: JSON.stringify(envelope),
  });
  return { response, body: await response.json() };
}

try {
  const health = await fetch(`${base}/healthz?session_id=${canonicalId}&owner_token=${ownerToken}`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).delivery_ready, true);
  assert.equal((await fetch(`${base}/healthz?session_id=${canonicalId}&owner_token=wrong`)).status, 404, 'health does not disclose a stale owner lease');

  const rejected = await post({ envelope_id: 'bad-auth', content: 'x' }, { owner: 'wrong' });
  assert.equal(rejected.response.status, 403, 'stale endpoint owner cannot publish');

  const missingVersion = await post({ envelope_id: 'missing-version', content: 'x', target_session_id: canonicalId });
  assert.equal(missingVersion.response.status, 400, 'typed envelopes must name the supported protocol version');

  const oversized = await post({ envelope_id: 'too-large', content: 'x'.repeat(512) });
  assert.equal(oversized.response.status, 400, 'oversized envelopes are rejected before adapter delivery');

  const first = await post({ protocol_version: 1, envelope_id: 'first', content: 'first message', target_session_id: canonicalId });
  assert.equal(first.response.status, 202);
  assert.equal(first.body.delivery_state, 'accepted');
  assert.equal(inbox.deliveries[0].lifecycle_state, 'accepted');

  const replay = await post({ protocol_version: 1, envelope_id: 'first', content: 'different retry bytes', target_session_id: canonicalId });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true, 'a duplicate envelope never creates a second turn');
  assert.equal(replay.body.turn_id, first.body.turn_id);

  const busy = await post({ protocol_version: 1, envelope_id: 'second', content: 'must wait', target_session_id: canonicalId });
  assert.equal(busy.response.status, 409, 'a second FIFO delivery is held while the first is active');

  settleTypedDelivery(inbox, 'first', { turnId: first.body.turn_id, completionStatus: 'completed' });
  assert.equal(inbox.in_flight_envelope_id, null);
  const second = await post({ protocol_version: 1, envelope_id: 'second', content: 'second message', target_session_id: canonicalId });
  assert.equal(second.response.status, 202, 'delivery resumes at the next idle boundary');
  interruptTypedDelivery(inbox, 'second', { turnId: second.body.turn_id, completionStatus: 'aborted' });
  const interruptedReplay = await post({ protocol_version: 1, envelope_id: 'second', content: 'retry must not run', target_session_id: canonicalId });
  assert.equal(interruptedReplay.body.duplicate, true);
  assert.equal(interruptedReplay.body.delivery_state, 'interrupted', 'accepted interrupted work is not replayed');

  const recoveryEnvelope = { envelope_id: 'recovery', content: 'outcome unknown', target_session_id: canonicalId };
  const recoveryClaim = claimTypedDelivery(inbox, recoveryEnvelope);
  requireTypedDeliveryRecovery(inbox, recoveryClaim.delivery.envelope_id, { error: 'transport outcome unknown' });
  assert.equal(inbox.deliveries.find((row) => row.envelope_id === 'recovery')?.lifecycle_state, 'recovery_required');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-worker-'));
  const priorGolemHome = process.env.GOLEM_HOME;
  process.env.GOLEM_HOME = path.join(temp, 'home');
  const tracker = openTrackerDb(path.join(temp, 'tracker.db'));
  try {
    const { renewEndpointLease } = await import(pathToFileURL(path.resolve('lib/session-facts.js')).href + `?typed=${Date.now()}`);
    const { readChannels } = await import(pathToFileURL(path.resolve('dashboard/server/channels.js')).href + `?typed=${Date.now()}`);
    renewEndpointLease({
      canonical_id: canonicalId,
      owner_token: ownerToken,
      host: endpoint.host,
      port: endpoint.port,
      kind: 'typed-worker',
      harness: 'pi',
    });
    const liveLease = (await readChannels()).find((channel) => channel.session_id === canonicalId);
    assert.equal(liveLease?.typed_worker, true, 'a versioned typed lease is discovered through the generic channel registry');
    assert.equal(liveLease?.delivery_ready, false, 'the live readiness gate reflects the adapter state without recording activity');
    assert.equal(Object.keys(liveLease).includes('owner_token'), false, 'the endpoint owner credential never leaks to a public channel row');

    const ticket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed lifecycle', created_by: 'test' });
    const envelope = tracker.createDispatchEnvelope(ticket.id, { session_id: canonicalId, actor: 'test' });
    const claimed = tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'claimed', attempt_id: 'attempt-1' });
    assert.equal(claimed.delivery_state, 'claimed');
    const accepted = tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'accepted', attempt_id: 'attempt-1' });
    assert.equal(accepted.delivery_state, 'accepted');
    const settled = tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'settled', attempt_id: 'attempt-1' });
    assert.equal(settled.delivery_state, 'settled');
    assert.throws(
      () => tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'claimed', attempt_id: 'attempt-2' }),
      /illegal transition/,
      'settled work cannot be replayed through a second attempt',
    );

    const retryable = tracker.createDispatchEnvelope(ticket.id, { session_id: 'typed-retry', actor: 'test' });
    tracker.recordTypedEnvelopeLifecycle(retryable.id, { state: 'claimed', attempt_id: 'attempt-a' });
    tracker.recordTypedEnvelopeLifecycle(retryable.id, { state: 'pending', attempt_id: 'attempt-a', error: 'pre-acceptance refusal' });
    const reclaimed = tracker.recordTypedEnvelopeLifecycle(retryable.id, { state: 'claimed', attempt_id: 'attempt-b' });
    assert.equal(reclaimed.delivery_attempt_id, 'attempt-b', 'pre-acceptance failures remain replayable');

    let status = 'idle';
    let pushes = 0;
    const queueTicketOne = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed FIFO one', created_by: 'test' });
    const queueTicketTwo = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed FIFO two', created_by: 'test' });
    const queuedOne = tracker.queueDispatch(queueTicketOne.id, { session_id: canonicalId, payload: 'one', actor: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const queuedTwo = tracker.queueDispatch(queueTicketTwo.id, { session_id: canonicalId, payload: 'two', actor: 'test' });
    const drainer = initDispatchDrainer({
      tracker,
      // The migration seam is intentional: a Pi harness with a typed lease
      // must use this generic route, never publish a new pi-inbox record.
      state: { nativeSessions: () => [{ session_id: canonicalId, harness: 'pi', alive: true, status }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => {
        pushes += 1;
        return {
          ok: true,
          status: 202,
          typed_worker: true,
          body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, delivery_state: 'accepted' }),
        };
      },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: canonicalId, kind: 'typed-worker', delivery_ready: true }],
    });
    await drainer.tick();
    assert.equal(pushes, 1, 'shared drainer publishes only the FIFO head for a typed worker');
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(queuedOne.id).status, 'delivered');
    assert.equal(tracker.getEnvelope(queuedOne.envelope_id).delivery_state, 'accepted');
    assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'pi-inbox', canonicalId)), false, 'a typed Pi lease creates no second pi-inbox publication');
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(queuedTwo.id).status, 'pending');

    const preacceptSession = 'typed-preaccept';
    const preacceptTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed preaccept retry', created_by: 'test' });
    const preacceptQueued = tracker.queueDispatch(preacceptTicket.id, { session_id: preacceptSession, payload: 'retry safely', actor: 'test' });
    const preacceptDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: preacceptSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: false,
        status: 409,
        typed_worker: true,
        body: JSON.stringify({ accepted: false, envelope_id: metadata.envelope_id, delivery_state: 'claimed' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: preacceptSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await preacceptDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(preacceptQueued.id).status, 'pending', 'pre-acceptance refusal releases the shared queue row');
    assert.equal(tracker.getEnvelope(preacceptQueued.envelope_id).delivery_state, 'pending');

    const recoverySession = 'typed-recovery';
    const recoveryTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed recovery hold', created_by: 'test' });
    const recoveryQueued = tracker.queueDispatch(recoveryTicket.id, { session_id: recoverySession, payload: 'do not replay', actor: 'test' });
    const recoveryDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: recoverySession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: false,
        status: 503,
        typed_worker: true,
        body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, delivery_state: 'recovery_required' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: recoverySession, kind: 'typed-worker', delivery_ready: true }],
    });
    await recoveryDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(recoveryQueued.id).status, 'delivered', 'recovery-required work leaves the shared queue instead of replaying');
    assert.equal(tracker.getEnvelope(recoveryQueued.envelope_id).delivery_state, 'recovery_required');

    const settledSession = 'typed-fast-settle';
    const settledTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed fast settle', created_by: 'test' });
    const settledQueued = tracker.queueDispatch(settledTicket.id, { session_id: settledSession, payload: 'already settled', actor: 'test' });
    const settledDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: settledSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: true,
        status: 202,
        typed_worker: true,
        body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, delivery_state: 'settled' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: settledSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await settledDrainer.tick();
    const settledEnvelope = tracker.getEnvelope(settledQueued.envelope_id);
    assert.equal(settledEnvelope.delivery_state, 'settled', 'a fast native terminal result retains the preceding acceptance boundary');
    assert.ok(settledEnvelope.accepted_at, 'a fast terminal result still persists correlated acceptance first');

    const busyTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed busy hold', created_by: 'test' });
    const busyQueued = tracker.queueDispatch(busyTicket.id, { session_id: canonicalId, payload: 'busy', actor: 'test' });
    status = 'busy';
    const busyDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: canonicalId, alive: true, status }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('busy typed target must not receive a push'); },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: canonicalId, kind: 'typed-worker', delivery_ready: true }],
    });
    await busyDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(busyQueued.id).status, 'pending', 'busy target retains the shared queue row');

    const offlineTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed offline hold', created_by: 'test' });
    const offlineQueued = tracker.queueDispatch(offlineTicket.id, { session_id: 'typed-offline', payload: 'offline', actor: 'test' });
    const offlineDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('offline typed target must not receive a push'); },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [],
    });
    await offlineDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(offlineQueued.id).status, 'pending', 'offline target retains shared work before expiry');
  } finally {
    tracker.close();
    if (priorGolemHome == null) delete process.env.GOLEM_HOME; else process.env.GOLEM_HOME = priorGolemHome;
    fs.rmSync(temp, { recursive: true, force: true });
  }
} finally {
  await closeTypedWorkerEndpoint(endpoint.server);
}

console.log('typed worker endpoint journey: ok');
