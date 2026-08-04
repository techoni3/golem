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
  getTypedDelivery,
  interruptTypedDelivery,
  normalizeTypedWorkerInbox,
  parseTypedDeliveryResponse,
  releaseTypedDeliveryClaim,
  requireTypedDeliveryRecovery,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  typedDeliveryResult,
} from '../lib/typed-worker-endpoint.js';
import {
  countTypedDeliveryTombstones,
  pruneTypedDeliveryTombstones,
  readTypedDeliveryTombstone,
  upsertTypedDeliveryTombstone,
} from '../lib/typed-delivery-tombstones.js';

const canonicalId = 'typed-worker-journey';
const ownerToken = 'typed-worker-owner-token';
let inbox = normalizeTypedWorkerInbox();
const tombstoneTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-tombstones-'));
const tombstoneFile = path.join(tombstoneTemp, 'typed-delivery-tombstones.db');

function envelope(envelope_id, content, overrides = {}) {
  const created_at = overrides.created_at ?? new Date().toISOString();
  return {
    protocol_version: 1,
    envelope_id,
    content,
    target_session_id: canonicalId,
    kind: 'ticket_dispatch',
    created_at,
    expires_at: overrides.expires_at ?? new Date(Date.parse(created_at) + 60_000).toISOString(),
    attempt_id: overrides.attempt_id ?? `attempt-${envelope_id}`,
    ...overrides,
  };
}

async function accept(envelope) {
  const claim = claimTypedDelivery(inbox, envelope, {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId, { file: tombstoneFile }),
  });
  if (claim.duplicate) return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
  if (claim.busy) return { ok: false, accepted: false, http_status: 409, error: 'worker is busy' };
  const { delivery } = acceptTypedDelivery(inbox, envelope.envelope_id, { turnId: `turn-${envelope.envelope_id}` });
  upsertTypedDeliveryTombstone(canonicalId, delivery, { file: tombstoneFile });
  return typedDeliveryResult(delivery, { httpStatus: 202, attemptId: envelope.attempt_id });
}

const endpoint = await startTypedWorkerEndpoint({
  canonicalId,
  ownerToken,
  deliveryReady: () => !inbox.in_flight_envelope_id,
  acceptDelivery: accept,
  maxBodyBytes: 512,
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

  const missingVersion = await post({ ...envelope('missing-version', 'x'), protocol_version: undefined });
  assert.equal(missingVersion.response.status, 400, 'typed envelopes must name the supported protocol version');

  const missingTarget = await post({ ...envelope('missing-target', 'x'), target_session_id: undefined });
  assert.equal(missingTarget.response.status, 400, 'typed envelopes require their canonical target');
  const expired = await post(envelope('expired', 'x', { created_at: new Date(Date.now() - 120_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal(expired.response.status, 400, 'expired typed envelopes never reach the native adapter');

  const oversized = await post({ envelope_id: 'too-large', content: 'x'.repeat(512) });
  assert.equal(oversized.response.status, 400, 'oversized envelopes are rejected before adapter delivery');

  const firstEnvelope = envelope('first', 'first message');
  const first = await post(firstEnvelope);
  assert.equal(first.response.status, 202);
  assert.equal(first.body.delivery_state, 'accepted');
  assert.equal(inbox.deliveries[0].lifecycle_state, 'accepted');

  // Simulate a lost response: the native turn has accepted attempt A, while
  // the shared queue repeats the immutable envelope under current attempt B.
  const replay = await post({ ...firstEnvelope, content: 'different retry bytes', attempt_id: 'attempt-first-retry' });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true, 'a duplicate envelope never creates a second turn');
  assert.equal(replay.body.attempt_id, 'attempt-first-retry', 'duplicate response correlates to the current retry attempt');
  assert.equal(replay.body.accepted_attempt_id, firstEnvelope.attempt_id, 'first acceptance lineage remains immutable across a lost-response retry');
  assert.ok(parseTypedDeliveryResponse({ typed_worker: true, body: JSON.stringify(replay.body) }, { envelopeId: firstEnvelope.envelope_id, attemptId: 'attempt-first-retry' }), 'the dashboard accepts the retry-correlated duplicate response');
  assert.equal(replay.body.turn_id, first.body.turn_id);

  const secondEnvelope = envelope('second', 'must wait');
  const busy = await post(secondEnvelope);
  assert.equal(busy.response.status, 409, 'a second FIFO delivery is held while the first is active');

  settleTypedDelivery(inbox, 'first', { turnId: first.body.turn_id, completionStatus: 'completed' });
  upsertTypedDeliveryTombstone(canonicalId, getTypedDelivery(inbox, 'first'), { file: tombstoneFile });
  assert.equal(inbox.in_flight_envelope_id, null);
  const second = await post({ ...secondEnvelope, content: 'second message' });
  assert.equal(second.response.status, 202, 'delivery resumes at the next idle boundary');
  interruptTypedDelivery(inbox, 'second', { turnId: second.body.turn_id, completionStatus: 'aborted' });
  upsertTypedDeliveryTombstone(canonicalId, getTypedDelivery(inbox, 'second'), { file: tombstoneFile });
  const interruptedReplay = await post({ ...secondEnvelope, content: 'retry must not run' });
  assert.equal(interruptedReplay.body.duplicate, true);
  assert.equal(interruptedReplay.body.delivery_state, 'interrupted', 'accepted interrupted work is not replayed');

  const recoveryEnvelope = envelope('recovery', 'outcome unknown');
  const recoveryClaim = claimTypedDelivery(inbox, recoveryEnvelope);
  requireTypedDeliveryRecovery(inbox, recoveryClaim.delivery.envelope_id, { error: 'transport outcome unknown' });
  assert.equal(inbox.deliveries.find((row) => row.envelope_id === 'recovery')?.lifecycle_state, 'recovery_required');

  const probeInbox = normalizeTypedWorkerInbox();
  const preaccept = envelope('released-before-accept', 'safe retry', { attempt_id: 'attempt-a' });
  claimTypedDelivery(probeInbox, preaccept);
  assert.equal(releaseTypedDeliveryClaim(probeInbox, preaccept.envelope_id, { attemptId: 'wrong' }).released, false, 'a delayed attempt cannot release another claim');
  assert.equal(releaseTypedDeliveryClaim(probeInbox, preaccept.envelope_id, { attemptId: 'attempt-a', error: 'native validation refused' }).released, true);
  const reclaimed = claimTypedDelivery(probeInbox, { ...preaccept, attempt_id: 'attempt-b' });
  assert.equal(reclaimed.duplicate, false, 'a synchronously refused pre-acceptance claim is replayable');
  acceptTypedDelivery(probeInbox, preaccept.envelope_id);
  settleTypedDelivery(probeInbox, preaccept.envelope_id);
  const claimedOnly = envelope('claimed-only', 'must accept first');
  claimTypedDelivery(probeInbox, claimedOnly);
  assert.throws(() => settleTypedDelivery(probeInbox, claimedOnly.envelope_id), /cannot settle from claimed/, 'the lifecycle graph rejects claimed-to-terminal shortcuts');
  releaseTypedDeliveryClaim(probeInbox, claimedOnly.envelope_id, { attemptId: claimedOnly.attempt_id });
  assert.equal(parseTypedDeliveryResponse({ typed_worker: true, body: JSON.stringify({ accepted: true, envelope_id: 'wrong', attempt_id: 'attempt-a', accepted_attempt_id: 'attempt-a', delivery_state: 'accepted' }) }, { envelopeId: 'expected', attemptId: 'attempt-a' }), null, 'typed acceptance is correlated to the expected envelope and attempt');

  for (let n = 0; n < 258; n += 1) {
    const old = envelope(`tombstone-${n}`, `old ${n}`);
    claimTypedDelivery(probeInbox, old);
    acceptTypedDelivery(probeInbox, old.envelope_id);
    settleTypedDelivery(probeInbox, old.envelope_id);
    upsertTypedDeliveryTombstone(canonicalId, getTypedDelivery(probeInbox, old.envelope_id), { file: tombstoneFile });
  }
  const oldReplay = claimTypedDelivery(probeInbox, envelope('tombstone-0', 'must never run twice'), {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId, { file: tombstoneFile }),
  });
  assert.equal(oldReplay.duplicate, true, 'replay protection survives the bounded inspection history');
  assert.equal(oldReplay.delivery.lifecycle_state, 'settled');
  assert.equal(probeInbox.deliveries.length, 256, 'rich supervisor history stays bounded');
  assert.equal(countTypedDeliveryTombstones({ file: tombstoneFile }), 260, 'compact durable tombstones hold replay identity outside the JSON registry');
  assert.equal(pruneTypedDeliveryTombstones({ file: tombstoneFile, now: Date.now() + 120_000 }), 260, 'expired tombstones are pruned instead of growing the supervisor registry forever');
  assert.equal(countTypedDeliveryTombstones({ file: tombstoneFile }), 0, 'tombstone storage remains bounded by valid envelope lifetime');

  const schemaTwo = normalizeTypedWorkerInbox({
    schema: 2,
    last_accepted_envelope_id: 'accepted-before-retained-history',
    deliveries: [
      { envelope_id: 'recent-only', target_session_id: canonicalId, attempt_id: 'recent-attempt', state: 'completed', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
    ],
  });
  const fenced = claimTypedDelivery(schemaTwo, envelope('accepted-before-retained-history', 'must be fenced', {
    created_at: '2000-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }));
  assert.equal(fenced.fenced, true, 'schema-2 replay identity older than retained history is fenced before native delivery');
  const { CodexSupervisor } = await import('../lib/codex-supervisor.js');
  const legacySupervisor = new CodexSupervisor({
    canonicalId: 'legacy-upgrade-worker',
    registryFile: path.join(tombstoneTemp, 'legacy-supervisors.json'),
    tombstoneFile,
  });
  legacySupervisor.migrateTypedDeliveryTombstones({
    schema: 2,
    deliveries: [{
      envelope_id: 'retained-schema-two-acceptance', target_session_id: 'legacy-upgrade-worker',
      attempt_id: 'schema-two-attempt', state: 'completed', created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
  });
  assert.equal(
    readTypedDeliveryTombstone('legacy-upgrade-worker', 'retained-schema-two-acceptance', { file: tombstoneFile })?.accepted_attempt_id,
    'schema-two-attempt',
    'supervisor upgrade migrates retained schema-2 acceptance lineage into durable tombstones before readiness',
  );

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-worker-'));
  const priorGolemHome = process.env.GOLEM_HOME;
  process.env.GOLEM_HOME = path.join(temp, 'home');
  fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'config.json'), JSON.stringify({ events: { subscriptionDigestEnabled: true } }));
  const tracker = openTrackerDb(path.join(temp, 'tracker.db'));
  try {
    const { readEndpointLeases, releaseEndpointLeases, renewEndpointLease, upsertSessionFact } = await import(pathToFileURL(path.resolve('lib/session-facts.js')).href + `?typed=${Date.now()}`);
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
    upsertSessionFact({
      canonical_id: canonicalId,
      continuation_key: 'pi-native:typed-worker-journey',
      harness: 'pi',
      locator: { raw_session_id: canonicalId },
      status: 'idle',
      capabilities: { typed_worker: true, typed_worker_protocol: 1 },
    });
    releaseEndpointLeases(ownerToken, { canonicalId });
    assert.equal(readEndpointLeases({ includeExpired: true }).some((lease) => lease.canonical_id === canonicalId), false, 'a clean endpoint release removes only the live lease');

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

    const lostResponse = tracker.createDispatchEnvelope(ticket.id, { session_id: 'typed-lost-response', actor: 'test' });
    tracker.recordTypedEnvelopeLifecycle(lostResponse.id, { state: 'claimed', attempt_id: 'attempt-a' });
    const recoveredAcceptance = tracker.recordTypedEnvelopeLifecycle(lostResponse.id, {
      state: 'accepted', attempt_id: 'attempt-b', accepted_attempt_id: 'attempt-a',
    });
    assert.equal(recoveredAcceptance.delivery_attempt_id, 'attempt-b', 'tracker records the current retry correlation');
    assert.equal(recoveredAcceptance.accepted_attempt_id, 'attempt-a', 'tracker preserves immutable first-accept lineage after a lost response');

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
          body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }),
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
        body: JSON.stringify({ accepted: false, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, delivery_state: 'claimed' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: preacceptSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await preacceptDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(preacceptQueued.id).status, 'pending', 'pre-acceptance refusal releases the shared queue row');
    assert.equal(tracker.getEnvelope(preacceptQueued.envelope_id).delivery_state, 'pending');

    const mismatchSession = 'typed-mismatch';
    const mismatchTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed response mismatch', created_by: 'test' });
    const mismatchQueued = tracker.queueDispatch(mismatchTicket.id, { session_id: mismatchSession, payload: 'must remain pending', actor: 'test' });
    const mismatchDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: mismatchSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: true, status: 202, typed_worker: true,
        body: JSON.stringify({ accepted: true, envelope_id: 'wrong-envelope', attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: mismatchSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await mismatchDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(mismatchQueued.id).status, 'pending', 'a response for another envelope cannot settle this queue row');
    assert.equal(tracker.getEnvelope(mismatchQueued.envelope_id).delivery_state, 'pending');

    const capabilitySession = 'typed-capable-unready';
    const capabilityTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed lease remains generic while unready', created_by: 'test' });
    const capabilityQueued = tracker.queueDispatch(capabilityTicket.id, { session_id: capabilitySession, payload: 'hold without spool', actor: 'test' });
    renewEndpointLease({ canonical_id: capabilitySession, owner_token: 'reload-owner', host: endpoint.host, port: endpoint.port, kind: 'typed-worker', harness: 'pi' });
    releaseEndpointLeases('reload-owner', { canonicalId: capabilitySession });
    assert.equal(readEndpointLeases({ includeExpired: true }).some((lease) => lease.canonical_id === capabilitySession), false, 'reload has released its old typed lease before rebind');
    const capabilityDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: capabilitySession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('an unready typed lease must not receive delivery'); },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [],
      listEndpointLeases: async () => [],
      listSessionFacts: async () => [{
        canonical_id: capabilitySession,
        harness: 'pi',
        status: 'idle',
        capabilities: { typed_worker: true, typed_worker_protocol: 1 },
      }],
    });
    await capabilityDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(capabilityQueued.id).status, 'pending', 'typed capability persists when its live lease is temporarily unready');
    assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'pi-inbox', capabilitySession)), false, 'typed-capable Pi never falls back to a new legacy spool');

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
        body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'recovery_required' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: recoverySession, kind: 'typed-worker', delivery_ready: true }],
    });
    await recoveryDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(recoveryQueued.id).status, 'delivered', 'recovery-required work leaves the shared queue instead of replaying');
    assert.equal(tracker.getEnvelope(recoveryQueued.envelope_id).delivery_state, 'recovery_required');

    const digestSession = 'typed-subscription';
    const digestTopic = 'test/typed-subscription';
    const subscription = tracker.subscribe({ session_id: digestSession, topic: digestTopic, cursor_seq: 0 });
    const digestEvent = tracker.recordEvent({ topic: digestTopic, type: 'typed_subscription_event', actor: 'test' });
    const digestDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: digestSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('typed digest uses the durable control adapter'); },
      pushControlEnvelope: async ({ envelope }) => ({
        ok: false, status: 503, typed_worker: true, typed_attempt_id: 'digest-attempt',
        body: JSON.stringify({ accepted: true, envelope_id: envelope.id, attempt_id: 'digest-attempt', accepted_attempt_id: 'digest-attempt', delivery_state: 'recovery_required' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: digestSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await digestDrainer.tick();
    assert.equal(tracker.listSubscriptions({ session_id: digestSession })[0].cursor_seq, digestEvent.id, 'a correlated accepted non-2xx digest advances its durable cursor instead of replaying');
    assert.equal(tracker.getEnvelope(tracker.raw().prepare("SELECT id FROM message_envelopes WHERE kind = 'subscription_digest' ORDER BY created_at DESC LIMIT 1").get().id).delivery_state, 'recovery_required');

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
        body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'settled' }),
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

    // A busy turn can last longer than the endpoint's protocol TTL. The row is
    // held, then the exact durable envelope is renewed before it is rendered
    // into a typed publish request.
    const ttlBusySession = 'typed-ttl-busy';
    let ttlBusyStatus = 'busy';
    let busyRenewedMetadata = null;
    const ttlBusyTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed TTL busy hold', created_by: 'test' });
    const ttlBusyQueued = tracker.queueDispatch(ttlBusyTicket.id, { session_id: ttlBusySession, payload: 'wait longer than TTL', actor: 'test' });
    tracker.raw().prepare("UPDATE message_envelopes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ttlBusyQueued.envelope_id);
    const ttlBusyDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: ttlBusySession, harness: 'pi', alive: true, status: ttlBusyStatus }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => {
        busyRenewedMetadata = metadata;
        return { ok: true, status: 202, typed_worker: true, body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }) };
      },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: ttlBusySession, kind: 'typed-worker', delivery_ready: true }],
    });
    await ttlBusyDrainer.tick();
    assert.equal(busyRenewedMetadata, null, 'busy hold does not create an expired competing typed turn');
    ttlBusyStatus = 'idle';
    await ttlBusyDrainer.tick();
    assert.ok(Date.parse(busyRenewedMetadata.expires_at) > Date.now(), 'busy-held envelope is durably renewed before typed publish');
    assert.equal(tracker.getEnvelope(ttlBusyQueued.envelope_id).expires_at, busyRenewedMetadata.expires_at, 'endpoint metadata uses the tracker-persisted renewed expiry');

    // The same renewal applies when a wave gate, rather than a native busy
    // turn, holds FIFO work beyond its initial TTL.
    const ttlWaveSession = 'typed-ttl-wave';
    let waveHeld = true;
    let waveRenewedMetadata = null;
    const originalWaveGate = tracker.waveGateForTicket;
    tracker.waveGateForTicket = () => (waveHeld ? { blocked: true, wave: 2, min_open_wave: 1 } : { blocked: false });
    try {
      const ttlWaveTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed TTL wave hold', created_by: 'test' });
      const ttlWaveQueued = tracker.queueDispatch(ttlWaveTicket.id, { session_id: ttlWaveSession, payload: 'wave wait longer than TTL', actor: 'test' });
      tracker.raw().prepare("UPDATE message_envelopes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ttlWaveQueued.envelope_id);
      const ttlWaveDrainer = initDispatchDrainer({
        tracker,
        state: { nativeSessions: () => [{ session_id: ttlWaveSession, harness: 'pi', alive: true, status: 'idle' }] },
        chat: { record: () => {} },
        pushBrief: async (_content, _sessionId, metadata) => {
          waveRenewedMetadata = metadata;
          return { ok: true, status: 202, typed_worker: true, body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }) };
        },
        buildDispatchBrief: (ticket) => ticket.title,
        broadcastWS: () => {},
        listChannels: async () => [{ session_id: ttlWaveSession, kind: 'typed-worker', delivery_ready: true }],
      });
      await ttlWaveDrainer.tick();
      assert.equal(waveRenewedMetadata, null, 'wave-held work is not published with an expired envelope');
      waveHeld = false;
      await ttlWaveDrainer.tick();
      assert.ok(Date.parse(waveRenewedMetadata.expires_at) > Date.now(), 'wave release renews envelope expiry before typed publish');
      assert.equal(tracker.getEnvelope(ttlWaveQueued.envelope_id).expires_at, waveRenewedMetadata.expires_at);
    } finally {
      tracker.waveGateForTicket = originalWaveGate;
    }

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
  fs.rmSync(tombstoneTemp, { recursive: true, force: true });
}

console.log('typed worker endpoint journey: ok');
