// One recorder for typed-worker responses. A non-2xx transport result may
// still mean the native turn accepted work (for example recovery_required),
// but only when the response proves the exact durable envelope *and* attempt.
import { parseTypedDeliveryResponse } from '../../lib/typed-worker-endpoint.js';

export function recordTypedEnvelopeOutcome(tracker, envelopeId, attemptId, delivery) {
  if (!envelopeId || !attemptId) return null;
  const outcome = parseTypedDeliveryResponse(delivery, { envelopeId, attemptId });
  if (!outcome?.accepted) return null;
  const error = delivery?.ok ? null : (outcome.error || delivery?.error || null);
  const current = tracker.getEnvelope(envelopeId)?.delivery_state || 'pending';
  // Direct routes can receive a fast terminal answer before observing their
  // claim. Materialize the required prefix; never allow claimed -> terminal.
  if (['pending', 'published'].includes(current)) {
    tracker.recordTypedEnvelopeLifecycle(envelopeId, { state: 'claimed', attempt_id: attemptId });
  }
  if (tracker.getEnvelope(envelopeId)?.delivery_state === 'claimed'
    && ['settled', 'interrupted'].includes(outcome.delivery_state)) {
    tracker.recordTypedEnvelopeLifecycle(envelopeId, {
      state: 'accepted',
      attempt_id: attemptId,
      accepted_attempt_id: outcome.accepted_attempt_id,
    });
  }
  tracker.recordTypedEnvelopeLifecycle(envelopeId, {
    state: outcome.delivery_state,
    attempt_id: attemptId,
    accepted_attempt_id: outcome.accepted_attempt_id,
    error,
  });
  return outcome;
}

export function acceptedTypedDelivery(tracker, envelopeId, attemptId, delivery) {
  return recordTypedEnvelopeOutcome(tracker, envelopeId, attemptId, delivery)?.accepted === true;
}

// A schema-2/3 worker deliberately refuses pre-fence unknown identities. This
// is not a generic delivery failure: the tracker can atomically reissue its
// still-pending lineage with a new envelope id/created_at and retry safely.
export function isLegacyReplayFence(delivery) {
  if (delivery?.legacy_replay_fenced === true) return true;
  if (typeof delivery?.body !== 'string') return false;
  try { return JSON.parse(delivery.body)?.legacy_replay_fenced === true; } catch { return false; }
}
