import { strict as assert } from 'node:assert';
import { openTrackerDb } from '../server/tracker-db.js';
import { initDispatchDrainer } from '../server/dispatch-queue.js';

const PROJECT = 'golem-1eba80';
const SESSION = 'smoke-gol-311-session';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function state() {
  return {
    nativeSessions: () => [{ session_id: SESSION, alive: true, status: 'idle' }],
  };
}

const tracker = openTrackerDb(':memory:');
const pushed = [];
const chat = { record() {} };
const drainer = initDispatchDrainer({
  tracker,
  state: state(),
  chat,
  pushBrief: async (body, sessionId) => {
    pushed.push({ body, sessionId });
    return { ok: true, status: 202 };
  },
  buildDispatchBrief: (ticket, note) => `${ticket.display_id || ticket.id}\n${note || ''}`,
  broadcastWS() {},
  listChannels: async () => [{ session_id: SESSION }],
});

try {
  const schema = tracker.raw().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
  assert.equal(schema, '9', 'schema v9 is active');

  const spec = tracker.createTicket({ project_id: PROJECT, kind: 'spec', title: 'SMOKE GOL-311 spec', created_by: SESSION });
  const child = tracker.createTicket({ project_id: PROJECT, kind: 'work-item', title: 'SMOKE GOL-311 child', parent_id: spec.id, created_by: SESSION, assignee: SESSION });
  tracker.updateTicket(child.id, { state: 'in_progress', actor: SESSION });

  const event = tracker.raw().prepare("SELECT * FROM events WHERE ticket_id = ? AND type = 'state_change' AND topic = ?").get(child.id, `ticket/${child.display_id}`);
  assert.ok(event, 'ticket mutation emits event on ticket/<display_id>');
  assert.equal(event.class, 'tracker', 'event class is tracker');
  assert.equal(event.actor_kind, 'session', 'actor_kind is session');
  const mirror = tracker.raw().prepare("SELECT * FROM events WHERE ticket_id = ? AND type = 'state_change' AND topic = ?").get(child.id, `spec/${spec.display_id}/tree`);
  assert.ok(mirror, 'child mutation mirrors onto spec tree topic');

  const sub = tracker.subscribe({ session_id: SESSION, topic: `ticket/${child.display_id}` });
  tracker.addComment(child.id, { author: 'human', body: 'SMOKE GOL-311 digest comment' });
  await wait(5500);
  assert.ok(pushed.some((p) => p.sessionId === SESSION && p.body.includes('SMOKE GOL-311 digest comment') || p.body.includes('commented')), 'subscription digest delivered');
  const advanced = tracker.raw().prepare('SELECT cursor_seq FROM subscriptions WHERE id = ?').get(sub.id).cursor_seq;
  assert.ok(advanced > sub.cursor_seq, 'subscription cursor advanced');

  tracker.setDispatched(child.id, { session_id: 'prior-session', actor: SESSION });
  tracker.setDispatched(child.id, { session_id: SESSION, actor: SESSION });
  const revoked = tracker.raw().prepare("SELECT * FROM events WHERE ticket_id = ? AND type = 'dispatch_revoked'").get(child.id);
  assert.ok(revoked, 'redispatch emits dispatch_revoked');

  const overflowTopic = 'ticket/SMOKE-OVERFLOW';
  const overflow = tracker.subscribe({ session_id: SESSION, topic: overflowTopic, cursor_seq: 0 });
  for (let i = 0; i < 505; i++) tracker.recordEvent({ topic: overflowTopic, class: 'tracker', type: 'overflow_test', actor: SESSION, data: { i } });
  const pending = tracker.pendingEventsForSubscription(overflow);
  assert.equal(pending.truncated, true, 'backlog overflow truncates');
  assert.equal(pending.events.length, 500, 'truncation caps digest events at 500');

  tracker.recordEvent({ project_id: PROJECT, topic: 'activity/smoke', class: 'activity', type: 'old_activity', actor: SESSION });
  const old = '2000-01-01T00:00:00.000Z';
  tracker.raw().prepare("UPDATE events SET created_at = ? WHERE class = 'activity'").run(old);
  const pruned = tracker.pruneBus({ nowTs: '2000-01-10T00:00:00.000Z', activityDays: 7 });
  assert.ok(pruned.deleted > 0, 'prune removes old activity');
  const pruneEvent = tracker.raw().prepare("SELECT * FROM events WHERE type = 'bus_pruned'").get();
  assert.ok(pruneEvent, 'prune emits bus_pruned');
  const stats = tracker.busStats();
  assert.ok(Array.isArray(stats.rows_per_class), 'bus stats returns rows_per_class');
  assert.ok(Array.isArray(stats.subscriptions_by_status), 'bus stats returns subscription counts');

  console.log(JSON.stringify({
    ok: true,
    schema,
    ticket_topic: event.topic,
    mirror_topic: mirror.topic,
    digest_delivered: pushed.length,
    cursor_before: sub.cursor_seq,
    cursor_after: advanced,
    dispatch_revoked: revoked.id,
    overflow: { count: pending.count, emitted: pending.events.length, omitted: pending.omitted },
    pruned,
    stats,
  }, null, 2));
} finally {
  drainer.close();
  tracker.close();
}
