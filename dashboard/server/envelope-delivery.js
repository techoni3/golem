// Shared durable-envelope publication. A typed endpoint can accept a native
// turn and lose the HTTP response afterwards, so every non-ticket caller must
// retain and retry its *original* envelope rather than minting a lookalike.
import crypto from 'node:crypto';
import { typedEnvelopeMetadata } from '../../lib/typed-worker-endpoint.js';
import { recordTypedEnvelopeOutcome } from './typed-delivery.js';

// A typed 2xx is not itself proof of acceptance: only the correlated endpoint
// result is. Legacy channel routes retain their established HTTP success rule.
export function acceptedDelivery(delivery) {
  if (delivery?.accepted === true) return true;
  return delivery?.typed_worker === true ? false : delivery?.ok === true;
}

// `publish` receives canonical metadata for a typed target and is deliberately
// injected by the caller. This keeps the durable lifecycle independent of the
// HTTP/Unix channel transport while giving every producer the same retry rule.
export async function publishDurableEnvelope({
  tracker,
  envelope,
  sessionId,
  content,
  legacy = null,
  typedTarget = false,
  settlement = null,
  retryOwnerToken = crypto.randomUUID(),
  retryAlreadyOwned = false,
  deferRetrySettlement = false,
  publish,
} = {}) {
  if (!tracker || !envelope?.id || !sessionId || typeof publish !== 'function') {
    throw new Error('publishDurableEnvelope requires tracker, envelope, sessionId, and publish');
  }
  const metadata = typedTarget ? typedEnvelopeMetadata(envelope) : null;
  // Reserve the immutable envelope before transport. If the dashboard dies
  // after native acceptance but before it observes the HTTP response, this
  // owned lease is the durable handoff to a later drainer.
  let retry = null;
  let retryOwned = false;
  if (typedTarget) {
    retry = tracker.enqueueEnvelopeRetry(envelope.id, {
      session_id: sessionId,
      content,
      legacy,
      settlement,
      require_typed: true,
    });
    retryOwned = retryAlreadyOwned || tracker.claimEnvelopeRetry(envelope.id, { ownerToken: retryOwnerToken });
    if (!retryOwned) {
      return {
        envelope,
        delivery: { ok: false, status: 409, typed_worker: true, error: 'original typed envelope is already publishing' },
        typedOutcome: null,
        delivered: false,
        retry_queued: !!retry?.queued,
        retry,
      };
    }
  }
  let delivery;
  try {
    delivery = await publish({ envelope, sessionId, content, legacy, metadata });
  } catch (error) {
    delivery = { ok: false, status: 0, error: String(error?.message ?? error) };
  }
  if (typedTarget && delivery?.typed_attempt_id == null && metadata?.attempt_id) {
    delivery = { ...delivery, typed_attempt_id: metadata.attempt_id, typed_worker: delivery?.typed_worker ?? true };
  }
  const typedOutcome = typedTarget
    ? recordTypedEnvelopeOutcome(tracker, envelope.id, metadata?.attempt_id, delivery)
    : null;
  if (typedOutcome?.accepted && !delivery?.accepted) delivery = { ...delivery, accepted: true };
  const delivered = acceptedDelivery(delivery);
  if (!typedOutcome) {
    tracker.markEnvelopeDelivery(envelope.id, {
      error: delivered ? null : (delivery?.error || `status ${delivery?.status ?? '?'}`),
    });
  }

  // A typed non-acceptance is ambiguous until the same immutable envelope is
  // replayed. Release the pre-transport reservation for reclaim; the drainer
  // defers marking delivery until its associated settlement is durable.
  if (typedTarget && retryOwned) {
    if (delivered && !deferRetrySettlement) {
      tracker.markEnvelopeRetryDelivered(envelope.id, { ownerToken: retryOwnerToken });
    } else if (!delivered) {
      tracker.releaseEnvelopeRetry(envelope.id, {
        ownerToken: retryOwnerToken,
        error: delivery?.error || `status ${delivery?.status ?? '?'}`,
      });
    }
  }
  return { envelope, delivery, typedOutcome, delivered, retry_queued: !!retry?.queued && !delivered, retry };
}
