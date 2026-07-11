import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTrackerDb } from '../server/tracker-db.js';
import { initDispatchDrainer } from '../server/dispatch-queue.js';

const PROJECT = 'golem-1eba80';
const SESSION = 'smoke-gol-311-session';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-311-home-'));
process.env.GOLEM_HOME = home;

const tracker = openTrackerDb(':memory:');
const pushed = [];
const chat = { record() {} };
const drainer = initDispatchDrainer({
  tracker,
  state: { nativeSessions: () => [{ session_id: SESSION, alive: true, status: 'idle' }] },
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
  assert.equal(schema, '15', 'schema v15 is active');

  const spec = tracker.createTicket({ project_id: PROJECT, kind: 'spec', title: 'SMOKE GOL-311 spec', created_by: SESSION });
  const child = tracker.createTicket({ project_id: PROJECT, kind: 'work-item', title: 'SMOKE GOL-311 child', parent_id: spec.id, created_by: SESSION, assignee: SESSION });
  assert.equal(tracker.raw().prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 0, 'creator and assignee do not create automatic subscriptions');

  const sub = tracker.subscribe({ session_id: SESSION, topic: `ticket/${child.display_id}` });
  tracker.updateTicket(child.id, { phase: 'building', actor: 'writer-session' });
  tracker.recordEvent({ ticket_id: child.id, project_id: PROJECT, topic: `ticket/${child.display_id}`, class: 'activity', type: 'raw_activity', actor: 'writer-session' });
  tracker.updateTicket(child.id, { assignee: 'other-session', actor: 'writer-session' });
  tracker.ingestBusEvents({ class: 'lifecycle', hook_event: 'session-start', session_id: SESSION, project_id: PROJECT, cwd: '/tmp' });
  assert.equal(tracker.raw().prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 1, 'assignment and lifecycle keep subscriptions manual-only');

  const passive = tracker.claimPassiveDelta(SESSION);
  assert.match(passive.batch?.body || '', /phase: queued → building/, 'manual exact topic receives phase delta');
  assert.match(passive.batch?.body || '', /assignment:/, 'manual exact topic receives assignment delta');
  assert.doesNotMatch(passive.batch?.body || '', /raw_activity|lifecycle/, 'activity and lifecycle history never enter passive context');
  tracker.releasePassiveDelta(SESSION, passive.lease_id);
  tracker.setDispatched(child.id, { session_id: SESSION, actor: 'dispatcher-session' });
  tracker.setDispatched(spec.id, { session_id: 'spec-target-session', actor: 'dispatcher-session' });
  assert.equal(tracker.raw().prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 1, 'dispatch and spec target keep subscriptions manual-only');

  tracker.recordEvent({ ticket_id: child.id, project_id: PROJECT, topic: `ticket/${child.display_id}`, class: 'tracker', type: 'cutover_hidden', actor: 'writer-session' });
  await drainer.tick();
  assert.equal(pushed.length, 0, 'disabled subscription digests make zero textual pushBrief calls');
  const shadowed = tracker.raw().prepare('SELECT cursor_seq FROM subscriptions WHERE id = ?').get(sub.id).cursor_seq;
  assert.ok(shadowed > sub.cursor_seq, 'disabled path shadow-advances the durable cursor');

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ events: { subscriptionDigestEnabled: true } }));
  tracker.recordEvent({ ticket_id: child.id, project_id: PROJECT, topic: `ticket/${child.display_id}`, class: 'tracker', type: 'enabled_after_cutover', actor: 'writer-session' });
  await drainer.tick();
  assert.equal(pushed.length, 1, 'explicit config override re-enables legacy digest delivery');
  assert.match(pushed[0].body, /enabled_after_cutover/, 're-enabled digest carries new history');
  assert.doesNotMatch(pushed[0].body, /cutover_hidden/, 're-enabled digest cannot replay shadow-advanced cutover history');

  const event = tracker.raw().prepare("SELECT * FROM events WHERE ticket_id = ? AND type = 'state_change' AND topic = ?").get(child.id, `ticket/${child.display_id}`);
  assert.ok(event, 'ticket mutation emits event on ticket/<display_id>');
  const mirror = tracker.raw().prepare("SELECT * FROM events WHERE ticket_id = ? AND type = 'state_change' AND topic = ?").get(child.id, `spec/${spec.display_id}/tree`);
  assert.ok(mirror, 'child mutation mirrors onto spec tree topic');

  const overflowTopic = 'ticket/SMOKE-OVERFLOW';
  const overflow = tracker.subscribe({ session_id: SESSION, topic: overflowTopic, cursor_seq: 0 });
  for (let i = 0; i < 505; i++) tracker.recordEvent({ topic: overflowTopic, class: 'tracker', type: 'overflow_test', actor: SESSION, data: { i } });
  const pending = tracker.pendingEventsForSubscription(overflow);
  assert.equal(pending.truncated, true, 'backlog overflow truncates');
  assert.equal(pending.events.length, 500, 'history truncation remains capped at 500');

  tracker.recordEvent({ project_id: PROJECT, topic: 'activity/smoke', class: 'activity', type: 'old_activity', actor: SESSION });
  tracker.raw().prepare("UPDATE events SET created_at = '2000-01-01T00:00:00.000Z' WHERE class = 'activity'").run();
  const pruned = tracker.pruneBus({ nowTs: '2000-01-10T00:00:00.000Z', activityDays: 7 });
  assert.ok(pruned.deleted > 0, 'prune removes old activity');
  assert.ok(tracker.raw().prepare("SELECT * FROM events WHERE type = 'bus_pruned'").get(), 'prune emits bus_pruned');

  console.log(JSON.stringify({
    ok: true,
    schema,
    quiet_pushes: 0,
    shadow_cursor: shadowed,
    enabled_pushes: pushed.length,
    overflow: { count: pending.count, emitted: pending.events.length, omitted: pending.omitted },
    pruned,
  }, null, 2));
} finally {
  drainer.close();
  tracker.close();
  fs.rmSync(home, { recursive: true, force: true });
}
