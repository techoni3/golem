// GOL-101: subscription reaper — suspends bus subscriptions whose owning
// session is gone.
//
// Why this exists. `applySubscriptionLifecycle` in tracker-db.js suspends a
// session's subscriptions on a `session_end` lifecycle event, and that event
// has exactly one producer: the Claude Code `SessionEnd` hook forwarding to
// POST /api/bus/ingest. Everything else leaks:
//
//   - the Codex adapter renders no SessionEnd hook at all
//     (lib/compiler/adapters/codex.js), so a Codex session can never suspend;
//   - a killed / crashed session, a closed terminal, or a machine restart runs
//     no hook in any harness;
//   - `expires_at` is written by the subscribe route but no query enforces it.
//
// The result was 36 permanently-active subscriptions in the live DB, 26 of them
// owned by one Codex session dead for over a week. Stale subscriptions are not
// inert: the dispatch drainer walks them every 5s, and they used to suppress
// comment dispatch delivery entirely.
//
// So rather than chase per-harness lifecycle events, reconcile against the one
// authority on liveness the dashboard already maintains — the native-session
// roster (`state.nativeSessions()`, refreshed every 3s, `alive` computed
// per-harness in native-sessions.js).
//
// Two safety rules, both deliberate:
//
//   1. A session must be *continuously* absent from the roster for GRACE_MS
//      before its subscriptions are suspended. A live Codex session whose
//      supervisor lease blips would otherwise lose its subscriptions with no
//      way back — only Claude Code re-activates on `hook_session_start`.
//   2. An empty roster means "we cannot see anything", not "everything died".
//      The sweep no-ops rather than reaping the world.
//
// Suspension is reversible: a genuine re-subscribe flips the row back to
// active, and `hook_session_start` reactivates a Claude Code session's rows.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 60 minutes, matching the drainer's offline expiry

export function createSubscriptionReaper({
  tracker,
  state,
  log = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  graceMs = DEFAULT_GRACE_MS,
  now = () => Date.now(),
} = {}) {
  if (!tracker) throw new Error('createSubscriptionReaper: tracker is required');
  if (!state) throw new Error('createSubscriptionReaper: state is required');

  /** @type {Map<string, number>} session_id → first tick it was seen missing */
  const missingSince = new Map();
  let timer = null;

  function liveSessionIds() {
    const rows = state.nativeSessions() ?? [];
    return new Set(rows.filter((s) => s?.session_id && s.alive !== false).map((s) => s.session_id));
  }

  // `force` skips the grace window — used by the admin endpoint to clear
  // already-stale rows without waiting an hour for the first sweep to age out.
  // `sessionId` narrows the sweep to one owner, so a forced reap does not have
  // to be a fleet-wide action.
  function sweep({ force = false, sessionId = null } = {}) {
    const live = liveSessionIds();
    if (live.size === 0) {
      return { skipped: 'empty-roster', suspended: 0, sessions: [], pending: missingSince.size };
    }
    const ts = now();
    const active = tracker.listSubscriptions().filter((sub) => sub.status === 'active');
    const scoped = sessionId ? active.filter((sub) => sub.session_id === sessionId) : active;
    const owners = [...new Set(scoped.map((sub) => sub.session_id).filter(Boolean))];

    for (const owner of owners) {
      if (live.has(owner)) missingSince.delete(owner);
      else if (!missingSince.has(owner)) missingSince.set(owner, ts);
    }
    // Drop bookkeeping for owners that no longer hold any active subscription.
    // A scoped sweep saw only one owner, so it must not evict anyone else.
    if (!sessionId) {
      const allOwners = new Set(active.map((sub) => sub.session_id).filter(Boolean));
      for (const owner of [...missingSince.keys()]) {
        if (!allOwners.has(owner)) missingSince.delete(owner);
      }
    }

    const reaped = [];
    let suspended = 0;
    for (const owner of owners) {
      if (live.has(owner)) continue;
      const since = missingSince.get(owner) ?? ts;
      if (!force && ts - since < graceMs) continue;
      const result = tracker.suspendSubscriptionsForSession(owner, 'session_gone');
      if (result.suspended > 0) {
        suspended += result.suspended;
        reaped.push({ session_id: owner, suspended: result.suspended });
      }
      missingSince.delete(owner);
    }

    if (suspended > 0) {
      log?.info?.({ suspended, sessions: reaped.map((r) => r.session_id) }, 'suspended subscriptions of gone sessions');
    }
    return { suspended, sessions: reaped, pending: missingSince.size, forced: force };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        sweep();
      } catch (err) {
        log?.warn?.({ err }, 'subscription reap sweep failed');
      }
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { sweep, start, stop };
}
