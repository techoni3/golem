// Shared durable-envelope publication. A typed endpoint can accept a native
// turn and lose the HTTP response afterwards, so every non-ticket caller must
// retain and retry its *original* envelope rather than minting a lookalike.
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
  publish,
} = {}) {
  if (!tracker || !envelope?.id || !sessionId || typeof publish !== 'function') {
    throw new Error('publishDurableEnvelope requires tracker, envelope, sessionId, and publish');
  }
  const metadata = typedTarget ? typedEnvelopeMetadata(envelope) : null;
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
  // replayed. The retry table is harness-neutral tracker state, not a Pi inbox.
  const retry = typedTarget && !delivered
    ? tracker.enqueueEnvelopeRetry(envelope.id, {
      session_id: sessionId,
      content,
      legacy,
      settlement,
      require_typed: true,
    })
    : null;
  return { envelope, delivery, typedOutcome, delivered, retry_queued: !!retry?.queued, retry };
}
