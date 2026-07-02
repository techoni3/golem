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
//
// This module does NOT add another session poll. It reads state.nativeSessions()
// (already refreshed every 3s by state.js) on its own 5s tick.

const TICK_MS = 5_000;
const COOLDOWN_MS = 60_000;
const OFFLINE_EXPIRY_MS = 60 * 60_000; // 60 min

export function initDispatchDrainer({
  tracker,
  state,
  chat,
  pushBrief,
  buildDispatchBrief,
  broadcastWS,
}) {
  // session_id → ts(ms) of the most recent successful delivery. Used by the
  // cooldown check so we never deliver twice to a session within 60s.
  const lastDeliveredAt = new Map();
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    let pending;
    try {
      pending = tracker.listPendingDispatches();
    } catch (err) {
      console.error('[dispatch-drainer] listPendingDispatches failed:', err);
      return;
    }
    if (!pending || pending.length === 0) return;

    const sessions = state.nativeSessions();
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
    for (const [sessionId, rows] of bySession) {
      const s = byId.get(sessionId);

      // Session unknown or dead.
      if (!s || !s.alive) {
        const oldest = rows[0]; // FIFO: rows[0] is the oldest by created_at
        const createdMs = Date.parse(oldest.created_at);
        if (Number.isFinite(createdMs) && now - createdMs > OFFLINE_EXPIRY_MS) {
          try {
            tracker.expireQueuedDispatch(oldest.id, 'session offline > 60m');
            chat.record(
              'system',
              'error',
              `queued dispatch ${oldest.id.slice(0, 8)} for ${sessionId} expired — session offline > 60m`,
            );
            const ticket = tracker.getTicket(oldest.ticket_id);
            if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
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

      // Deliver FIRST pending row only (one per session per tick).
      const row = rows[0];
      try {
        const ticket = tracker.getTicket(row.ticket_id);
        if (!ticket) {
          // Ticket vanished (deleted). Cancel the orphaned queue row.
          tracker.cancelQueuedDispatch(row.id, { actor: 'golem-drainer' });
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
            const refreshed = tracker.getTicket(row.ticket_id);
            if (refreshed) broadcastWS({ type: 'ticket-updated', ticket: refreshed });
            continue;
          }
        }

        // Durable-first: setDispatched BEFORE pushBrief (crash between →
        // ticket assigned, not lost).
        tracker.setDispatched(ticket.id, { session_id: sessionId, actor: 'golem-drainer' });
        const briefString = buildDispatchBrief(ticket, row.note);

        let pushResult;
        try {
          pushResult = await pushBrief(briefString, sessionId);
        } catch (err) {
          pushResult = { ok: false, error: String(err?.message ?? err) };
        }

        tracker.markQueueDelivered(row.id, {
          error: pushResult.ok ? null : pushResult.error || `status ${pushResult.status}`,
        });

        if (pushResult && pushResult.ok) {
          chat.record('user', 'brief', briefString, { session_id: sessionId });
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
        lastDeliveredAt.set(sessionId, Date.now());
      } catch (err) {
        console.error(`[dispatch-drainer] delivery for ${row.id} failed:`, err);
      }
    }
  }

  timer = setInterval(() => {
    tick().catch((err) => console.error('[dispatch-drainer] tick threw:', err));
  }, TICK_MS);
  timer.unref();

  return {
    close() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}