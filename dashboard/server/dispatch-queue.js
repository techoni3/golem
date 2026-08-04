// TKT-0245: dispatch drainer — background loop that delivers queued dispatches
// when their target session goes idle.
//
// Why this exists: a brief pushed while the target is mid-turn gets buried
// under the in-flight tool stream and is effectively ignored. Delivering on
// idle (the session has finished its turn and is waiting for input) makes the
// brief the next thing the agent sees. The queue lives in SQLite
// (tracker.db dispatch_queue) so it survives dashboard restarts (routine).
//
// Semantics (preserve in comments when editing):
//   • One delivery per session per tick + a 60s per-session cooldown — never
//     stack a second brief onto a session that hasn't visibly gone busy yet.
//     Status freshness is 3s (state.js poll) and Claude's status flip lags a
//     prompt by seconds; without the cooldown we'd double-deliver.
//   • `waiting` is NOT idle — waiting = mid-task blocked on human input;
//     delivering there recreates the original bug. Both busy AND waiting hold.
//   • Durable-first: setDispatched BEFORE pushBrief (a crash between leaves
//     the ticket assigned, not lost).
//   • A session that is offline is NOT immediately expired — it may come back.
//     Only after 60m offline does the oldest pending row expire.
//   • Alive but no registered channel = unreachable (TKT-0369): treated like
//     offline — rows held pending, same 60m expiry. Never attempt a push that
//     would burn the row (setDispatched already run); the row auto-delivers
//     when the channel re-registers (e.g. after /reload-plugins).
//
// This module does NOT add another session poll. It reads state.nativeSessions()
// (already refreshed every 3s by state.js) on its own 5s tick.

import { loadConfig } from '../../lib/golem-config.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { checkpointPiPickupAck, claimPiPickupAcks, completePiPickupAck, enqueuePiBrief } from '../../lib/pi-inbox.js';
import { isChannelDeliveryReady, isTypedWorkerChannel } from './channels.js';
import { hasTypedWorkerCapability, isSessionFactTerminal, readEndpointLeases, readSessionFacts } from '../../lib/session-facts.js';
import { typedEnvelopeMetadata } from '../../lib/typed-worker-endpoint.js';
import { recordTypedEnvelopeOutcome } from './typed-delivery.js';

const TICK_MS = 5_000;
const COOLDOWN_MS = 60_000;
const OFFLINE_EXPIRY_MS = 60 * 60_000; // 60 min

export function initDispatchDrainer({
  tracker,
  state,
  chat,
  pushBrief,
  pushControlEnvelope,
  buildDispatchBrief,
  broadcastWS,
  listChannels,
  listEndpointLeases = () => readEndpointLeases({ includeExpired: true }),
  listSessionFacts = () => readSessionFacts(),
}) {
  // Older isolated drainer journeys provide only pushBrief. Production passes
  // the typed control adapter; the fallback preserves their legacy generic
  // subscription behavior without altering CC/OC delivery.
  const deliverControl = pushControlEnvelope ?? (({ content }, sessionId) => pushBrief(content, sessionId));
  // session_id → ts(ms) of the most recent successful delivery. Used by the
  // cooldown check so we never deliver twice to a session within 60s.
  const lastDeliveredAt = new Map();
  const waveHoldLogged = new Set();
  const publishing = new Set();
  const publishingOwner = crypto.randomUUID();
  const ackOwner = crypto.randomUUID();
  let timer = null;
  let stopped = false;

  function unackedWindowMinutes() {
    const n = Number(loadConfig()?.dispatch?.unackedWindowMinutes);
    return Number.isFinite(n) && n >= 0 ? n : 5;
  }

  async function checkUnackedDispatches() {
    const windowMinutes = unackedWindowMinutes();
    let changed = false;
    const deliverChild = async (claimed, purpose) => {
      const child = claimed.envelope;
      let content = '';
      try { content = JSON.parse(child.payload || '{}').content || ''; } catch { /* durable fallback below */ }
      let result;
      const metadata = typedEnvelopeMetadata(child);
      try {
        result = await pushBrief(content, child.recipient_session_id, metadata);
      } catch (err) {
        result = { ok: false, error: String(err?.message ?? err) };
      }
      const typedOutcome = recordTypedEnvelopeOutcome(tracker, child.id, metadata.attempt_id, result);
      const delivered = !!result?.ok || typedOutcome?.accepted === true;
      const error = delivered ? null : (result?.error || `status ${result?.status ?? '?'}`);
      if (!typedOutcome) tracker.markEnvelopeDelivery(child.id, { error });
      chat.record(delivered ? 'user' : 'system', delivered ? 'brief' : 'error',
        delivered ? content : `${purpose} for ${claimed.root.ticket_id} failed — ${error}`,
        { session_id: child.recipient_session_id || null, ticket_id: claimed.root.ticket_id });
      const ticket = tracker.getTicket(claimed.root.ticket_id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      changed = true;
    };
    try {
      // New durable envelopes use explicit acknowledgement facts. Escalations
      // go first, so a failed ping (which stamps escalate_after=now) waits for
      // the next five-second pass rather than escalating in its own ping pass.
      for (;;) {
        const claimed = tracker.claimDueEscalation();
        if (!claimed) break;
        if (!claimed.envelope.recipient_session_id) {
          tracker.markEnvelopeDelivery(claimed.envelope.id, { error: 'no stored reply route for escalation' });
          const ticket = tracker.getTicket(claimed.root.ticket_id);
          if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
          changed = true;
          continue;
        }
        await deliverChild(claimed, 'dispatch escalation');
      }
      for (;;) {
        const claimed = tracker.claimDueAckPing(windowMinutes);
        if (!claimed) break;
        await deliverChild(claimed, 'dispatch acknowledgement ping');
      }
    } catch (err) {
      console.error('[dispatch-drainer] unacked check failed:', err);
      return changed;
    }
    // GOL-140 legacy deliveries predate envelope facts and retain their
    // event/activity heuristic unchanged.
    let rows = [];
    try {
      rows = tracker.unackedDispatchesForWindow(windowMinutes);
    } catch (err) {
      console.error('[dispatch-drainer] legacy unacked check failed:', err);
      return changed;
    }
    for (const row of rows) {
      try {
        tracker.recordUnackedDispatchWarning(row, { windowMinutes });
        const label = row.display_id || row.ticket_id;
        chat.record(
          'system',
          'warning',
          `dispatch of ${label} to ${row.session_id} appears unacknowledged — no ticket activity from target since delivery attempt at ${row.delivered_at} (${windowMinutes}m window)`,
          { session_id: row.session_id, ticket_id: row.ticket_id },
        );
        const ticket = tracker.getTicket(row.ticket_id);
        if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
        changed = true;
      } catch (err) {
        console.error('[dispatch-drainer] unacked warning failed:', err);
      }
    }
    return changed;
  }

  function eventLine(ev) {
    const label = ev.topic || ev.ticket_id || ev.project_id || 'event';
    const actor = ev.actor_label || ev.actor || ev.actor_kind || 'unknown';
    return `- #${ev.id} ${label} ${ev.type} by ${actor} (${ev.created_at})`;
  }

  function digestBrief(sessionId, digests) {
    const fromSeq = Math.min(...digests.map((d) => d.from_seq + 1));
    const toSeq = Math.max(...digests.map((d) => d.to_seq));
    const lines = [
      `Event subscription digest (${fromSeq}-${toSeq})`,
      '',
      `Subscriber: ${sessionId}`,
      '',
    ];
    for (const d of digests) {
      lines.push(`## ${d.subscription.topic}`);
      if (d.truncated) lines.push(`Backlog truncated: ${d.omitted} event(s) elided. Re-read the ticket/spec for full state.`);
      for (const ev of d.events) lines.push(eventLine(ev));
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  async function tick() {
    if (stopped) return;
    let pending;
    for (const ack of claimPiPickupAcks({ ownerToken: ackOwner })) {
      try {
        const meta = ack.value?.metadata || {}; const settled = ack.value.settled || {};
        const step = (name, fn) => { if (!settled[name]) { fn(); settled[name] = true; ack.value.settled = settled; checkpointPiPickupAck(ack.file, ack.value); } };
        if (meta.queue_id) step('queue', () => tracker.markQueueDelivered(meta.queue_id, { envelope_id: meta.envelope_id || null }));
        if (meta.envelope_id) step('envelope', () => tracker.markEnvelopeDelivery(meta.envelope_id, { error: null }));
        if (meta.passive_lease_id) step('passive', () => tracker.commitPassiveDelta(meta.session_id, meta.passive_lease_id));
        if (meta.ticket_id) step('comments', () => tracker.markCommentDispatchesDeliveredForTicket(meta.ticket_id, meta.session_id));
        completePiPickupAck(ack);
      } catch (err) { console.error('[dispatch-drainer] Pi pickup settlement failed:', err); }
    }
    try {
      pending = tracker.listPendingDispatches();
    } catch (err) {
      console.error('[dispatch-drainer] listPendingDispatches failed:', err);
      return;
    }
    let queueChanged = await checkUnackedDispatches();
    pending = pending || [];

    const sessions = state.nativeSessions();
    // TKT-0369: sessions whose channel MCP is down are UNREACHABLE — treat
    // them like offline sessions (hold rows pending, 60m expiry), never attempt
    // a push that would burn the row with setDispatched already run. Built once
    // per tick so a transient readChannels failure makes everyone wait one tick
    // (safe), not burn.
    let channelIds = new Set();
    let channelsBySession = new Map();
    let typedCapableSessionIds = new Set();
    try {
      // A managed Codex supervisor can keep a healthy loopback lease while it
      // is busy/recovering. Treat delivery_ready:false exactly like an absent
      // channel here so a queued envelope is held, never burned on a 409.
      // Legacy CC/OC rows remain eligible by their established presence rule.
      const readyChannels = (await listChannels()).filter((channel) => isChannelDeliveryReady(channel));
      channelIds = new Set(readyChannels.map((channel) => channel.session_id));
      channelsBySession = new Map(readyChannels.map((channel) => [channel.session_id, channel]));
    } catch { /* transient → everyone waits a tick */ }
    try {
      typedCapableSessionIds = new Set((await listEndpointLeases())
        .filter(isTypedWorkerChannel)
        .map((lease) => lease.canonical_id || lease.session_id)
        .filter(Boolean));
    } catch { /* a registry read failure never falls back to the Pi spool */ }
    try {
      for (const fact of await listSessionFacts()) {
        if (fact?.canonical_id && !isSessionFactTerminal(fact) && hasTypedWorkerCapability(fact)) {
          typedCapableSessionIds.add(fact.canonical_id);
        }
      }
    } catch { /* a fact read failure never invents a legacy Pi fallback */ }
    const byId = new Map();
    for (const s of sessions) if (s.session_id) byId.set(s.session_id, s);

    // Group pending rows by session_id. listPendingDispatches returns FIFO by
    // created_at globally, so within each session the rows are also FIFO.
    const bySession = new Map();
    for (const row of pending) {
      const arr = bySession.get(row.session_id) ?? [];
      arr.push(row);
      bySession.set(row.session_id, arr);
    }

    const now = Date.now();
    // TKT-0286: broadcast dispatch-queue-updated once if any row transitioned this tick.
    for (const [sessionId, rows] of bySession) {
      const s = byId.get(sessionId);
      const isPi = s?.harness === 'pi';
      const isTypedWorker = isTypedWorkerChannel(channelsBySession.get(sessionId));
      const isTypedCapable = isTypedWorker || typedCapableSessionIds.has(sessionId);
      // Pi stays on the migration-only next-turn spool only until it has
      // registered the shared typed endpoint. A first-class Pi lease follows
      // the same generic channel path as any other typed worker.
      const usesLegacyPiSpool = isPi && !isTypedCapable;

      const waveGate = (row) => {
        try {
          return tracker.waveGateForTicket(row.ticket_id);
        } catch (err) {
          console.error('[dispatch-drainer] wave gate check failed:', err);
          return { blocked: false };
        }
      };

      const isWaveHeld = (row) => waveGate(row)?.blocked === true;

      // Session unknown, dead, OR unreachable (channel MCP down — TKT-0369):
      // hold rows pending (60m expiry), never burn one on a push that can't land.
      if (!s || !s.alive || (!usesLegacyPiSpool && !channelIds.has(sessionId))) {
        const oldest = rows.find((row) => !isWaveHeld(row));
        if (!oldest) continue; // all rows are wave-held; do not expire them as offline.
        const createdMs = Date.parse(oldest.created_at);
        if (Number.isFinite(createdMs) && now - createdMs > OFFLINE_EXPIRY_MS) {
          try {
            tracker.expireQueuedDispatch(oldest.id, 'target offline or channel unreachable > 60m');
            chat.record(
              'system',
              'error',
              `queued dispatch ${oldest.id.slice(0, 8)} for ${sessionId} expired — target offline or channel unreachable > 60m`,
            );
            const ticket = tracker.getTicket(oldest.ticket_id);
            if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
            queueChanged = true;
          } catch (err) {
            console.error('[dispatch-drainer] expire failed:', err);
          }
        }
        // else skip — the session may come back.
        continue;
      }

      // Cooldown: never stack a second brief onto a session that hasn't
      // visibly gone busy yet. Status freshness is 3s and Claude's status
      // flip lags a prompt by seconds.
      const last = lastDeliveredAt.get(sessionId);
      if (last != null && now - last < COOLDOWN_MS) continue;

      // waiting = mid-task blocked on human input — delivering there recreates
      // the original bug. Both busy AND waiting hold.
      if (s.status !== 'idle') continue;

      // Deliver FIRST wave-eligible pending row only (one per session per tick).
      // Wave-held rows remain pending and do not block unrelated non-wave rows
      // queued behind them for the same session.
      let row = null;
      for (const candidate of rows) {
        const gate = waveGate(candidate);
        if (!gate.blocked) { row = candidate; break; }
        if (!waveHoldLogged.has(candidate.id)) {
          waveHoldLogged.add(candidate.id);
          chat.record(
            'system',
            'info',
            `queued dispatch ${candidate.id.slice(0, 8)} for ${candidate.ticket_id} is wave-held (W${gate.wave}; open wave W${gate.min_open_wave})`,
            { session_id: sessionId, ticket_id: candidate.ticket_id },
          );
          queueChanged = true;
        }
      }
      if (!row) continue;
      const requiresPublishingLease = usesLegacyPiSpool || isTypedWorker;
      try {
        const ticket = tracker.getTicket(row.ticket_id);
        if (!ticket) {
          // Ticket vanished (deleted). Cancel the orphaned queue row.
          tracker.cancelQueuedDispatch(row.id, { actor: 'golem-drainer' });
          queueChanged = true;
          const refreshed = tracker.getTicket(row.ticket_id);
          if (refreshed) broadcastWS({ type: 'ticket-updated', ticket: refreshed });
          continue;
        }
        // Ticket dispatched elsewhere meanwhile (dispatched_at newer than the
        // queue row's created_at) → the queue row is stale; cancel it.
        if (ticket.dispatched_at) {
          const dispatchedMs = Date.parse(ticket.dispatched_at);
          const createdMs = Date.parse(row.created_at);
          if (
            Number.isFinite(dispatchedMs) &&
            Number.isFinite(createdMs) &&
            dispatchedMs > createdMs
          ) {
            tracker.cancelQueuedDispatch(row.id, { actor: 'golem-drainer' });
            try { await pushBrief(`Dispatch revoked for ${ticket.display_id || ticket.id}: ${ticket.title || ''}\n\nReason: superseded before queued delivery. Stand down unless you receive a new dispatch.`, row.session_id); } catch { /* best-effort */ }
            queueChanged = true;
            const refreshed = tracker.getTicket(row.ticket_id);
            if (refreshed) broadcastWS({ type: 'ticket-updated', ticket: refreshed });
            continue;
          }
        }

        if (requiresPublishingLease) {
          if (publishing.has(row.id)) continue;
          if (!tracker.claimQueuePublishing(row.id, { ownerToken: publishingOwner })) continue;
          publishing.add(row.id);
        }

        // Durable-first: setDispatched BEFORE pushBrief (crash between →
        // ticket assigned, not lost).
        let assigned = ticket;
        if (!usesLegacyPiSpool) assigned = tracker.setDispatched(ticket.id, { session_id: sessionId, actor: 'golem-drainer' });
        if (assigned.revoked_session_id) {
          try { await pushBrief(`Dispatch revoked for ${assigned.display_id || assigned.id}: ${assigned.title || ''}\n\nReason: queued dispatch delivered to another session. Stand down unless you receive a new dispatch.`, assigned.revoked_session_id); } catch { /* best-effort */ }
        }
        let envelope = row.envelope_id ? tracker.getEnvelope(row.envelope_id) : null;
        // A queued typed envelope may wait behind a busy turn or an earlier
        // wave longer than its original TTL. Extend the durable source before
        // rendering, so the endpoint receives exactly the expiry the tracker
        // now authorizes rather than a synthetic or stale timestamp.
        if (isTypedWorker && envelope) envelope = tracker.renewEnvelopeExpiry(envelope.id);
        const typedAttemptId = isTypedWorker ? crypto.randomUUID() : null;
        const deliveryMetadata = envelope
          ? typedEnvelopeMetadata(envelope, { attemptId: typedAttemptId ?? crypto.randomUUID() })
          : null;
        if (isTypedWorker && row.envelope_id) {
          tracker.recordTypedEnvelopeLifecycle(row.envelope_id, { state: 'claimed', attempt_id: typedAttemptId });
        }
        let briefString = buildDispatchBrief(ticket, row.note, row.workspace || undefined, row.envelope_id || null);
        try {
          const payload = envelope?.payload ? JSON.parse(envelope.payload) : null;
          if (typeof payload?.content === 'string') briefString = payload.content;
        } catch { /* legacy rows retain reconstructed brief behavior */ }
        let passive = null;
        if (row.envelope_id) {
          try {
            const claim = tracker.claimPassiveDelta(sessionId);
            if (claim?.lease_id && claim?.batch?.body) {
              passive = claim;
              briefString = `${briefString}\n\n${claim.batch.body}`;
            }
          } catch { /* passive delivery must not hold a queued dispatch */ }
        }

        let pushResult;
        try {
          pushResult = usesLegacyPiSpool
            ? enqueuePiBrief(sessionId, briefString, { queue_id: row.id, envelope_id: row.envelope_id || null, ticket_id: ticket.id, session_id: sessionId, passive_lease_id: passive?.lease_id || null }, { messageId: row.id })
            : await pushBrief(briefString, sessionId, deliveryMetadata);
        } catch (err) {
          pushResult = { ok: false, error: String(err?.message ?? err) };
        }
        const typedOutcome = isTypedWorker
          ? recordTypedEnvelopeOutcome(tracker, row.envelope_id, typedAttemptId, pushResult)
          : null;
        const typedAccepted = typedOutcome?.accepted === true;
        if (isTypedWorker && row.envelope_id && !typedAccepted) {
            tracker.recordTypedEnvelopeLifecycle(row.envelope_id, {
              state: 'pending',
              attempt_id: typedAttemptId,
              error: pushResult?.error || `status ${pushResult?.status ?? '?'}`,
            });
        }

        // Set the outcome from the delivery opportunity before queue/envelope
        // writes: their failure must not replay context that already landed.
        const passiveCommitted = isTypedWorker ? typedAccepted : !!pushResult?.ok;
        try {
          if (pushResult.queued) {
            assigned = tracker.setDispatched(ticket.id, { session_id: sessionId, actor: 'golem-drainer' });
            if (assigned.revoked_session_id) {
              try { await pushBrief(`Dispatch revoked for ${assigned.display_id || assigned.id}: ${assigned.title || ''}\n\nReason: queued dispatch delivered to another session. Stand down unless you receive a new dispatch.`, assigned.revoked_session_id); } catch { /* best-effort */ }
            }
            tracker.markQueueNextTurn(row.id, { ownerToken: publishingOwner });
          }
          else if (isTypedWorker && typedAccepted) {
            tracker.markQueueDelivered(row.id, { envelope_id: row.envelope_id || null, ownerToken: publishingOwner });
          }
          else if (requiresPublishingLease) tracker.releaseQueuePublishing(row.id, { ownerToken: publishingOwner });
          else {
            tracker.markQueueDelivered(row.id, { error: pushResult.ok ? null : pushResult.error || `status ${pushResult.status}`, envelope_id: row.envelope_id || null });
            if (row.envelope_id) tracker.markEnvelopeDelivery(row.envelope_id, { error: pushResult.ok ? null : pushResult.error || `status ${pushResult.status}` });
          }
        } finally {
          if (passive?.lease_id) {
            try {
              if (passiveCommitted && !pushResult.queued) tracker.commitPassiveDelta(sessionId, passive.lease_id);
              else if (pushResult.queued) { /* pickup ack settles this lease */ }
              else tracker.releasePassiveDelta(sessionId, passive.lease_id);
            } catch { /* a failed settlement leaves the batch replayable */ }
          }
        }
        if (pushResult && (pushResult.ok || typedAccepted) && !pushResult.queued) {
          tracker.markCommentDispatchesDeliveredForTicket(ticket.id, sessionId);
        }

        if (pushResult && (pushResult.ok || typedAccepted)) {
          chat.record('user', 'brief', briefString, { session_id: sessionId, delivery: pushResult.queued ? 'next_turn' : 'push' });
        } else {
          const detail = pushResult?.error || `status ${pushResult?.status ?? '?'}`;
          chat.record(
            'system',
            'error',
            `dispatch of ${ticket.id} to ${sessionId} — channel ${detail} (ticket assigned; session will pick it up on resume)`,
          );
        }

        const delivered = tracker.getTicket(ticket.id);
        if (delivered) broadcastWS({ type: 'ticket-updated', ticket: delivered });
        if (waveHoldLogged.delete(row.id)) {
          chat.record('system', 'info', `wave hold released for ${ticket.id}; dispatch delivered to ${sessionId}`, { session_id: sessionId, ticket_id: ticket.id });
        }
        queueChanged = true;
        lastDeliveredAt.set(sessionId, Date.now());
      } catch (err) {
        if (requiresPublishingLease) { try { tracker.releaseQueuePublishing(row.id, { ownerToken: publishingOwner }); } catch {} }
        console.error(`[dispatch-drainer] delivery for ${row.id} failed:`, err);
      } finally {
        if (requiresPublishingLease) publishing.delete(row.id);
      }
    }
    let digestChanged = false;
    try {
      const subsBySession = tracker.activeSubscriptionsBySession();
      const subscriptionDigestEnabled = loadConfig()?.events?.subscriptionDigestEnabled === true;
      for (const [sessionId, subs] of subsBySession) {
        if (!subscriptionDigestEnabled) {
          // GOL-424: preserve event history but quietly advance each durable
          // cursor through eligible classes. Re-enabling legacy digests later
          // therefore cannot replay the disabled-era backlog into a model turn.
          for (const sub of subs) {
            const pending = tracker.pendingEventsForSubscription(sub);
            if (pending.to_seq > pending.from_seq) {
              tracker.advanceSubscriptionCursor(sub.id, pending.from_seq, pending.to_seq);
              digestChanged = true;
            }
          }
          continue;
        }
        const s = byId.get(sessionId);
        if (!s || !s.alive || !channelIds.has(sessionId)) continue;
        const last = lastDeliveredAt.get(sessionId);
        if (last != null && now - last < COOLDOWN_MS) continue;
        if (s.status !== 'idle') continue;
        const digests = subs
          .map((sub) => tracker.pendingEventsForSubscription(sub))
          .filter((d) => d.to_seq > d.from_seq && (d.events.length > 0 || d.truncated));
        if (!digests.length) continue;
        const brief = digestBrief(sessionId, digests);
        const envelope = tracker.createControlEnvelope({
          sender_id: 'golem-drainer',
          recipient_session_id: sessionId,
          kind: 'subscription_digest',
          payload: {
            content: brief,
            topics: digests.map((digest) => digest.subscription.topic),
            from_seq: Math.min(...digests.map((digest) => digest.from_seq + 1)),
            to_seq: Math.max(...digests.map((digest) => digest.to_seq)),
          },
        });
        let pushResult;
        try {
          pushResult = await deliverControl({
            envelope,
            content: brief,
            legacy: { path: '/brief', body: brief },
          }, sessionId);
        } catch (err) {
          pushResult = { ok: false, error: String(err?.message ?? err) };
        }
        const typedOutcome = recordTypedEnvelopeOutcome(tracker, envelope.id, pushResult?.typed_attempt_id ?? null, pushResult);
        const delivered = !!pushResult?.ok || typedOutcome?.accepted === true;
        if (!typedOutcome) tracker.markEnvelopeDelivery(envelope.id, {
          error: delivered ? null : (pushResult?.error || `status ${pushResult?.status ?? '?'}`),
        });
        if (!delivered) {
          const detail = pushResult?.error || `status ${pushResult?.status ?? '?'}`;
          chat.record('system', 'error', `subscription digest to ${sessionId} failed — channel ${detail}`, { session_id: sessionId });
          continue;
        }
        chat.record('user', 'brief', brief, { session_id: sessionId });
        for (const d of digests) tracker.advanceSubscriptionCursor(d.subscription.id, d.from_seq, d.to_seq);
        lastDeliveredAt.set(sessionId, Date.now());
        digestChanged = true;
      }
    } catch (err) {
      console.error('[dispatch-drainer] subscription digest failed:', err);
    }
    // TKT-0286: one signal per tick if any queue row transitioned (deliver,
    // expire, or a drainer-internal cancel) — queue-aware surfaces refetch.
    if (queueChanged) {
      broadcastWS({ type: 'dispatch-queue-updated' });
      // Envelope delivery/ping/escalation facts changed. The Agents health
      // drawer listens for this signal and refetches once; it never polls.
      broadcastWS({ type: 'communication-health-updated' });
    }
    if (digestChanged) broadcastWS({ type: 'bus-subscriptions-updated' });
  }

  timer = setInterval(() => {
    tick().catch((err) => console.error('[dispatch-drainer] tick threw:', err));
  }, TICK_MS);
  timer.unref();

  return {
    // Exposed for deterministic journey coverage; production still runs it on
    // the interval above.
    tick,
    close() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
