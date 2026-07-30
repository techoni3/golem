import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTrackerDb, defaultDbPath } from '../server/tracker-db.js';
import { teamAssists } from '../server/team-assist.js';

const PROJECT = 'golem-1eba80';
const MANAGER = 'smoke-gol-315-manager';
const BUILDER = 'smoke-gol-315-builder';
const EXPLORER = 'smoke-gol-315-explorer';

function schemaVersion(tracker) {
  return tracker.raw().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
}

function assertSchemaAtLeast11(tracker, label) {
  const schema = Number(schemaVersion(tracker));
  assert.ok(schema >= 11, `${label} schema is at least v11`);
  return String(schema);
}

function eventOf(tracker, ticketId, type, topic) {
  return tracker.raw().prepare('SELECT * FROM events WHERE ticket_id = ? AND type = ? AND topic = ? ORDER BY id DESC').get(ticketId, type, topic);
}

async function proveRealDbMigration() {
  const source = defaultDbPath();
  assert.ok(fs.existsSync(source), `real tracker db exists at ${source}`);
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'golem-gol-315-'));
  const copy = path.join(dir, 'tracker-copy.db');
  await fsPromises.copyFile(source, copy);
  const migrated = openTrackerDb(copy);
  try {
    assertSchemaAtLeast11(migrated, 'copied real tracker DB');
    const cols = migrated.raw().prepare("PRAGMA table_info(tickets)").all().map((row) => row.name);
    assert.ok(cols.includes('phase'), 'copied DB has phase column after openTrackerDb migration');
  } finally {
    migrated.close();
  }
  return copy;
}

const tracker = openTrackerDb(':memory:');

try {
  assertSchemaAtLeast11(tracker, 'memory tracker DB');

  const assists = teamAssists([
    { session_id: 'mgr-busy', label: 'busy lead', role: 'lead', alive: true, pending_count: 2, in_progress_tickets: [{ id: 'x' }] },
    { session_id: MANAGER, label: 'free lead', role: 'lead', alive: true, pending_count: 0, in_progress_tickets: [] },
    { session_id: EXPLORER, label: 'free explorer', role: 'explorer', alive: true, pending_count: 0, in_progress_tickets: [] },
    { session_id: 'explorer-busy', label: 'busy explorer', role: 'explorer', alive: true, pending_count: 1, in_progress_tickets: [{ id: 'y' }] },
  ]);
  assert.equal(assists.suggested_manager.session_id, MANAGER, 'least-loaded lead is suggested');
  assert.equal(assists.suggested_explorer.session_id, EXPLORER, 'least-loaded explorer is suggested');

  const spec = tracker.createTicket({ project_id: PROJECT, kind: 'spec', title: 'SMOKE GOL-315 spec', created_by: MANAGER, assignee: MANAGER });
  assert.equal(spec.phase, 'drafting', 'new specs default to drafting');
  assert.equal(spec.state, 'todo', 'drafting maps to todo');

  const sub = tracker.subscribe({ session_id: MANAGER, topic: `spec/${spec.display_id}/tree`, cursor_seq: 0, reason: 'smoke-manager-tree' });

  tracker.transitionTicket(spec.id, { phase: 'grounding', actor: MANAGER });
  tracker.addComment(spec.id, { author: MANAGER, body: 'grounding-summary: scope and open questions resolved.' });
  tracker.transitionTicket(spec.id, { phase: 'grounded', actor: MANAGER });
  tracker.addComment(spec.id, { author: MANAGER, body: 'design: one child work item exercises via-manager verification.' });
  tracker.transitionTicket(spec.id, { phase: 'designing', actor: MANAGER });
  tracker.transitionTicket(spec.id, { phase: 'designed', actor: MANAGER });
  tracker.transitionTicket(spec.id, { phase: 'planning', actor: MANAGER });

  const child = tracker.createTicket({
    project_id: PROJECT,
    kind: 'work-item',
    title: 'SMOKE GOL-315 child',
    body: '- [ ] child acceptance',
    parent_id: spec.id,
    wave: 1,
    created_by: MANAGER,
    assignee: BUILDER,
  });
  assert.equal(child.phase, 'queued', 'new work item defaults to queued');
  tracker.transitionTicket(spec.id, { phase: 'planned', actor: MANAGER });

  tracker.transitionTicket(child.id, { phase: 'building', actor: BUILDER });
  tracker.transitionTicket(spec.id, { phase: 'building', actor: MANAGER });
  const mirror = eventOf(tracker, child.id, 'state_change', `spec/${spec.display_id}/tree`)
    || eventOf(tracker, child.id, 'phase_change', `spec/${spec.display_id}/tree`);
  assert.ok(mirror, 'child event mirrors to spec tree topic');

  tracker.addComment(child.id, {
    author: BUILDER,
    body: 'Closing brief\n\nWhat was done: smoke child implemented.\n\nAcceptance checklist: child acceptance verified by smoke.\n\nTesting instructions: run node dashboard/scripts/smoke-gol-315.mjs.\n\nNot-done/deferred: nothing.',
  });
  tracker.transitionTicket(child.id, { phase: 'built', actor: BUILDER });
  tracker.setDispatched(child.id, { session_id: EXPLORER, actor: MANAGER });
  tracker.transitionTicket(child.id, { phase: 'verifying', actor: MANAGER, managerDispatch: true });
  tracker.addComment(child.id, { author: EXPLORER, body: 'verification report: PASS. smoke observed expected phase and subscription events.' });
  tracker.transitionTicket(child.id, { phase: 'verified', actor: EXPLORER, verificationReport: true });
  tracker.transitionTicket(child.id, { phase: 'done', actor: MANAGER });

  tracker.addComment(spec.id, { author: MANAGER, body: 'spec close retrospective: shipped child smoke; deferred nothing.' });
  tracker.transitionTicket(spec.id, { phase: 'done', actor: MANAGER });

  const pending = tracker.pendingEventsForSubscription(sub);
  assert.ok(pending.events.some((event) => event.topic === `spec/${spec.display_id}/tree`), 'manager subscription sees spec tree events');

  const copiedDb = await proveRealDbMigration();

  console.log(JSON.stringify({
    ok: true,
    schema: schemaVersion(tracker),
    assists,
    spec: { id: spec.display_id, phase: tracker.getTicket(spec.id).phase, state: tracker.getTicket(spec.id).state },
    child: { id: child.display_id, phase: tracker.getTicket(child.id).phase, state: tracker.getTicket(child.id).state },
    subscription_events: pending.events.length,
    copied_real_db: copiedDb,
  }, null, 2));
} finally {
  tracker.close();
}
