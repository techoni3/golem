// Shared loopback endpoint and delivery-lifecycle contract for native Golem
// workers. Harness adapters own primitive translation; this module owns only
// authenticated transport, bounded envelope validation, and durable lifecycle
// helpers. It intentionally does not know about Pi, Codex RPC, or the tracker.
import crypto from 'node:crypto';
import http from 'node:http';

export const TYPED_WORKER_PROTOCOL_VERSION = 1;
export const DEFAULT_TYPED_WORKER_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_TYPED_DELIVERY_HISTORY_LIMIT = 256;

export const TypedDeliveryLifecycleState = Object.freeze({
  CLAIMED: 'claimed',
  ACCEPTED: 'accepted',
  SETTLED: 'settled',
  INTERRUPTED: 'interrupted',
  RECOVERY_REQUIRED: 'recovery_required',
});

function iso(value = Date.now()) { return new Date(value).toISOString(); }

export function sameEndpointSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function readBoundedRequestBody(request, { maxBytes = DEFAULT_TYPED_WORKER_MAX_BODY_BYTES } = {}) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`payload too large (max ${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendEndpointJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function legacyLifecycleState(delivery) {
  switch (delivery?.state) {
    case 'claimed': return TypedDeliveryLifecycleState.CLAIMED;
    case 'accepted':
    case 'started': return TypedDeliveryLifecycleState.ACCEPTED;
    case 'completed': return TypedDeliveryLifecycleState.SETTLED;
    case 'failed': return TypedDeliveryLifecycleState.INTERRUPTED;
    case 'recovery_pending': return TypedDeliveryLifecycleState.RECOVERY_REQUIRED;
    default: return null;
  }
}

// `state` is retained as the Codex-supervisor compatibility projection. New
// adapters consume `lifecycle_state`, which names the cross-harness contract.
export function normalizeTypedWorkerInbox(inbox = {}, { historyLimit = DEFAULT_TYPED_DELIVERY_HISTORY_LIMIT } = {}) {
  const deliveries = Array.isArray(inbox.deliveries)
    ? inbox.deliveries.slice(-historyLimit).map((delivery) => ({
      ...delivery,
      lifecycle_state: delivery?.lifecycle_state || legacyLifecycleState(delivery),
    }))
    : [];
  return {
    schema: Math.max(3, Number(inbox.schema) || 0),
    delivery_cursor: Number(inbox.delivery_cursor) || 0,
    in_flight_envelope_id: typeof inbox.in_flight_envelope_id === 'string' ? inbox.in_flight_envelope_id : null,
    last_accepted_envelope_id: typeof inbox.last_accepted_envelope_id === 'string' ? inbox.last_accepted_envelope_id : null,
    last_completed_envelope_id: typeof inbox.last_completed_envelope_id === 'string' ? inbox.last_completed_envelope_id : null,
    deliveries,
  };
}

export function typedDeliveryDigest(content, senderSessionId, targetSessionId) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([content, senderSessionId ?? null, targetSessionId]))
    .digest('hex');
}

function deliveryIndex(inbox, envelopeId) {
  return inbox.deliveries.findIndex((delivery) => delivery.envelope_id === envelopeId);
}

function replaceDelivery(inbox, index, patch) {
  const next = { ...inbox.deliveries[index], ...patch };
  inbox.deliveries[index] = next;
  return next;
}

export function claimTypedDelivery(inbox, envelope, { at = Date.now(), historyLimit = DEFAULT_TYPED_DELIVERY_HISTORY_LIMIT } = {}) {
  const existingIndex = deliveryIndex(inbox, envelope.envelope_id);
  if (existingIndex >= 0) return { inbox, delivery: inbox.deliveries[existingIndex], duplicate: true };
  if (inbox.in_flight_envelope_id) return { inbox, delivery: null, busy: true, duplicate: false };
  const claimedAt = iso(at);
  const delivery = {
    envelope_id: envelope.envelope_id,
    target_session_id: envelope.target_session_id,
    sender_session_id: envelope.sender_session_id ?? null,
    digest: typedDeliveryDigest(envelope.content, envelope.sender_session_id, envelope.target_session_id),
    // `claimed` has no former Codex meaning, but records the synchronous slot
    // reservation required before an adapter invokes its native primitive.
    state: 'claimed',
    lifecycle_state: TypedDeliveryLifecycleState.CLAIMED,
    claimed_at: claimedAt,
    turn_id: null,
  };
  inbox.deliveries.push(delivery);
  inbox.deliveries = inbox.deliveries.slice(-historyLimit);
  inbox.delivery_cursor += 1;
  inbox.in_flight_envelope_id = delivery.envelope_id;
  return { inbox, delivery, duplicate: false, busy: false };
}

export function acceptTypedDelivery(inbox, envelopeId, { turnId = null, at = Date.now() } = {}) {
  const index = deliveryIndex(inbox, envelopeId);
  if (index < 0) throw new Error(`typed delivery ${envelopeId} is not claimed`);
  const delivery = inbox.deliveries[index];
  if ([
    TypedDeliveryLifecycleState.SETTLED,
    TypedDeliveryLifecycleState.INTERRUPTED,
    TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
  ].includes(delivery.lifecycle_state)) return { inbox, delivery };
  const acceptedAt = delivery.accepted_at || iso(at);
  const next = replaceDelivery(inbox, index, {
    // Existing Codex tests and on-disk recovery records use `started` here.
    state: delivery.state === 'completed' ? 'completed' : 'started',
    lifecycle_state: TypedDeliveryLifecycleState.ACCEPTED,
    accepted_at: acceptedAt,
    turn_id: turnId ?? delivery.turn_id ?? null,
    started_at: delivery.started_at || acceptedAt,
  });
  inbox.last_accepted_envelope_id = envelopeId;
  return { inbox, delivery: next };
}

export function settleTypedDelivery(inbox, envelopeId, { turnId = null, completionStatus = null, at = Date.now() } = {}) {
  const index = deliveryIndex(inbox, envelopeId);
  if (index < 0) return { inbox, delivery: null };
  const completedAt = iso(at);
  const next = replaceDelivery(inbox, index, {
    state: 'completed',
    lifecycle_state: TypedDeliveryLifecycleState.SETTLED,
    turn_id: turnId ?? inbox.deliveries[index].turn_id ?? null,
    settled_at: completedAt,
    completed_at: completedAt,
    completion_status: completionStatus,
  });
  if (inbox.in_flight_envelope_id === envelopeId) inbox.in_flight_envelope_id = null;
  inbox.last_completed_envelope_id = envelopeId;
  return { inbox, delivery: next };
}

export function interruptTypedDelivery(inbox, envelopeId, { turnId = null, completionStatus = null, at = Date.now() } = {}) {
  const index = deliveryIndex(inbox, envelopeId);
  if (index < 0) return { inbox, delivery: null };
  const interruptedAt = iso(at);
  const next = replaceDelivery(inbox, index, {
    state: 'failed',
    lifecycle_state: TypedDeliveryLifecycleState.INTERRUPTED,
    turn_id: turnId ?? inbox.deliveries[index].turn_id ?? null,
    interrupted_at: interruptedAt,
    completed_at: interruptedAt,
    completion_status: completionStatus,
  });
  if (inbox.in_flight_envelope_id === envelopeId) inbox.in_flight_envelope_id = null;
  return { inbox, delivery: next };
}

export function requireTypedDeliveryRecovery(inbox, envelopeId, { at = Date.now(), error = null } = {}) {
  const index = deliveryIndex(inbox, envelopeId);
  if (index < 0) throw new Error(`typed delivery ${envelopeId} is not claimed`);
  const recoveryAt = iso(at);
  const next = replaceDelivery(inbox, index, {
    state: 'recovery_pending',
    lifecycle_state: TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
    recovery_required_at: recoveryAt,
    last_error: error ?? inbox.deliveries[index].last_error ?? null,
  });
  return { inbox, delivery: next };
}

export function typedDeliveryResult(delivery, { duplicate = false, httpStatus = 200 } = {}) {
  return {
    ok: true,
    accepted: [
      TypedDeliveryLifecycleState.ACCEPTED,
      TypedDeliveryLifecycleState.SETTLED,
      TypedDeliveryLifecycleState.INTERRUPTED,
      TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
    ].includes(delivery.lifecycle_state),
    duplicate,
    http_status: httpStatus,
    envelope_id: delivery.envelope_id,
    turn_id: delivery.turn_id ?? null,
    // Canonical state for new adapters; the legacy state remains visible for
    // existing Codex registry readers during the migration.
    delivery_state: delivery.lifecycle_state,
    legacy_delivery_state: delivery.state,
    claimed_at: delivery.claimed_at ?? null,
    accepted_at: delivery.accepted_at ?? null,
  };
}

export function parseTypedDeliveryResponse(result) {
  if (!result?.typed_worker || typeof result.body !== 'string') return null;
  try {
    const body = JSON.parse(result.body);
    if (!body || typeof body !== 'object'
      || typeof body.envelope_id !== 'string'
      || typeof body.accepted !== 'boolean'
      || !Object.values(TypedDeliveryLifecycleState).includes(body.delivery_state)) return null;
    return body;
  } catch {
    return null;
  }
}

function validateTypedEnvelope(body, canonicalId) {
  if (!body || typeof body !== 'object'
    || body.protocol_version !== TYPED_WORKER_PROTOCOL_VERSION
    || typeof body.envelope_id !== 'string' || !body.envelope_id
    || typeof body.content !== 'string' || !body.content
    || (body.target_session_id != null && body.target_session_id !== canonicalId)) {
    return null;
  }
  return {
    protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
    envelope_id: body.envelope_id,
    content: body.content,
    sender_session_id: typeof body.sender_session_id === 'string' ? body.sender_session_id : null,
    target_session_id: canonicalId,
  };
}

// Start a loopback-only authenticated endpoint. `onRequest` is intentionally a
// small escape hatch for adapter-owned operator routes (for example Codex
// approvals); it runs after health but before the durable delivery route.
export async function startTypedWorkerEndpoint({
  canonicalId,
  ownerToken,
  deliveryReady,
  acceptDelivery,
  onRequest = null,
  host = '127.0.0.1',
  maxBodyBytes = DEFAULT_TYPED_WORKER_MAX_BODY_BYTES,
  kind = 'typed-worker',
} = {}) {
  if (!canonicalId || !ownerToken || typeof deliveryReady !== 'function' || typeof acceptDelivery !== 'function') {
    throw new Error('canonicalId, ownerToken, deliveryReady, and acceptDelivery are required');
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', `http://${host}`);
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const expected = url.searchParams.get('session_id') === canonicalId
          && sameEndpointSecret(url.searchParams.get('owner_token'), ownerToken);
        if (!expected) return sendEndpointJson(response, 404, { error: 'not found' });
        return sendEndpointJson(response, 200, {
          protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
          kind,
          canonical_id: canonicalId,
          owner_token: ownerToken,
          delivery_ready: await deliveryReady(),
        });
      }
      if (onRequest && await onRequest({
        request, response, url, canonicalId, ownerToken,
        readBody: () => readBoundedRequestBody(request, { maxBytes: maxBodyBytes }),
        sendJson: (status, body) => sendEndpointJson(response, status, body),
        sameSecret: sameEndpointSecret,
      })) return;
      if (url.pathname !== '/brief' || request.method !== 'POST') return sendEndpointJson(response, 404, { error: 'not found' });
      const target = String(request.headers['x-golem-target-session'] || '');
      const owner = String(request.headers['x-golem-endpoint-owner'] || '');
      if (request.headers['x-sender'] !== 'dashboard'
        || target !== canonicalId
        || !sameEndpointSecret(owner, ownerToken)) {
        return sendEndpointJson(response, 403, { ok: false, error: 'typed delivery authentication failed' });
      }
      let body;
      try { body = JSON.parse(await readBoundedRequestBody(request, { maxBytes: maxBodyBytes })); } catch (error) {
        return sendEndpointJson(response, 400, { ok: false, error: error.message || 'invalid JSON delivery envelope' });
      }
      const envelope = validateTypedEnvelope(body, canonicalId);
      if (!envelope) {
        return sendEndpointJson(response, 400, { ok: false, error: `typed delivery requires protocol version ${TYPED_WORKER_PROTOCOL_VERSION}, envelope_id, non-empty content, and the canonical target` });
      }
      const result = await acceptDelivery(envelope);
      return sendEndpointJson(response, result.http_status ?? 200, result);
    })().catch((error) => sendEndpointJson(response, 500, { ok: false, error: error.message || String(error) }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('typed worker endpoint did not bind a loopback port');
  }
  return { server, host, port: address.port, kind };
}

export async function closeTypedWorkerEndpoint(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}
