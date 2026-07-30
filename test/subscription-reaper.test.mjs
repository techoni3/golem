// GOL-101 — subscription reaper: the time- and roster-dependent branches that a
// live smoke cannot produce (an empty roster, a session absent for less than the
// grace window). Delivery and the end-to-end reap are covered by
// dashboard/scripts/smoke-gol-101.mjs.
import { strict as assert } from 'node:assert';
import { createSubscriptionReaper } from '../dashboard/server/subscription-reaper.js';

function harness({ subscriptions, sessions, graceMs = 60 * 60 * 1000 }) {
  const suspended = [];
  let clock = 0;
  const reaper = createSubscriptionReaper({
    tracker: {
      listSubscriptions: () => subscriptions,
      suspendSubscriptionsForSession: (session_id, reason) => {
        const hit = subscriptions.filter((s) => s.session_id === session_id && s.status === 'active');
        for (const row of hit) row.status = 'suspended';
        suspended.push({ session_id, reason, count: hit.length });
        return { ok: true, suspended: hit.length, session_id };
      },
    },
    state: { nativeSessions: () => sessions },
    graceMs,
    now: () => clock,
  });
  return { reaper, suspended, advance: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; } };
}

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push(`ok — ${name}`);
  } catch (err) {
    results.push(`FAIL — ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

// An unreadable roster must never be read as "every session died".
test('an empty roster is a no-op, not a mass reap', () => {
  const { reaper, suspended } = harness({
    subscriptions: [{ session_id: 'gone', topic: 'ticket/A-1', status: 'active' }],
    sessions: [],
  });
  const out = reaper.sweep();
  assert.equal(out.skipped, 'empty-roster');
  assert.equal(out.suspended, 0);
  assert.equal(suspended.length, 0);
});

test('a session absent for less than the grace window is left alone', () => {
  const { reaper, advance, suspended } = harness({
    subscriptions: [
      { session_id: 'gone', topic: 'ticket/A-1', status: 'active' },
      { session_id: 'live', topic: 'ticket/A-2', status: 'active' },
    ],
    sessions: [{ session_id: 'live', alive: true }],
    graceMs: 60_000,
  });
  assert.equal(reaper.sweep().suspended, 0, 'first sight only records the absence');
  advance(59_000);
  assert.equal(reaper.sweep().suspended, 0, 'still inside the grace window');
  assert.equal(suspended.length, 0);
  advance(2_000);
  const out = reaper.sweep();
  assert.equal(out.suspended, 1, 'reaped once the window elapsed');
  assert.deepEqual(suspended, [{ session_id: 'gone', reason: 'session_gone', count: 1 }]);
});

test('a session that reappears has its absence forgotten', () => {
  const sessions = [{ session_id: 'live', alive: true }];
  const { reaper, advance, suspended } = harness({
    subscriptions: [{ session_id: 'flaky', topic: 'ticket/A-1', status: 'active' }],
    sessions,
    graceMs: 60_000,
  });
  reaper.sweep(); // absent — start the clock
  advance(59_000);
  sessions.push({ session_id: 'flaky', alive: true }); // back before the window closed
  reaper.sweep();
  sessions.pop(); // gone again
  advance(30_000);
  assert.equal(reaper.sweep().suspended, 0, 'the grace window restarted on reappearance');
  assert.equal(suspended.length, 0);
});

test('a session in the roster but not alive is treated as gone', () => {
  const { reaper } = harness({
    subscriptions: [{ session_id: 'dead', topic: 'ticket/A-1', status: 'active' }],
    sessions: [{ session_id: 'dead', alive: false }, { session_id: 'live', alive: true }],
  });
  assert.equal(reaper.sweep({ force: true }).suspended, 1);
});

// A forced sweep is a blunt instrument; scoping keeps a smoke or an admin poke
// from suspending every absent owner in every project.
test('a scoped sweep touches only the named session', () => {
  const { reaper, suspended } = harness({
    subscriptions: [
      { session_id: 'goneA', topic: 'ticket/A-1', status: 'active' },
      { session_id: 'goneB', topic: 'ticket/A-2', status: 'active' },
    ],
    sessions: [{ session_id: 'live', alive: true }],
  });
  const out = reaper.sweep({ force: true, sessionId: 'goneA' });
  assert.equal(out.suspended, 1);
  assert.deepEqual(suspended.map((s) => s.session_id), ['goneA']);
});

test('force skips the grace window', () => {
  const { reaper, suspended } = harness({
    subscriptions: [{ session_id: 'gone', topic: 'ticket/A-1', status: 'active' }],
    sessions: [{ session_id: 'live', alive: true }],
  });
  const out = reaper.sweep({ force: true });
  assert.equal(out.suspended, 1);
  assert.equal(out.forced, true);
  assert.equal(suspended[0].reason, 'session_gone');
});

for (const line of results) console.log(line);
if (process.exitCode) {
  console.error('\nsubscription-reaper: FAILED');
} else {
  console.log(`\nsubscription-reaper: ${results.length} checks passed`);
}
