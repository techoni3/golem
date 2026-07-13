import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openTrackerDb } from '../dashboard/server/tracker-db.js';
import { enqueuePiBrief } from '../lib/pi-inbox.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-db-')); const dbPath = path.join(temp, 'tracker.db');
const facts = path.join(temp, 'session-facts.json'); fs.writeFileSync(facts, JSON.stringify({ version: 1, facts: [{ canonical_id: 'pi-real', harness: 'pi' }] }));
const a = openTrackerDb(dbPath); const b = openTrackerDb(dbPath);
try {
  assert.equal(typeof a.claimQueuePublishing, 'function');
  const ticket = a.createTicket({ project_id: 'test-000000', title: 'Pi CAS', created_by: 'test' });
  const row = a.queueDispatch(ticket.id, { session_id: 'pi-real' });
  assert.equal(a.claimQueuePublishing(row.id, { ownerToken: 'owner-a', nowMs: 1000, leaseMs: 100 }), true);
  assert.equal(b.claimQueuePublishing(row.id, { ownerToken: 'owner-b', nowMs: 1050, leaseMs: 100 }), false, 'second drainer cannot overlap live owner');
  assert.equal(b.claimQueuePublishing(row.id, { ownerToken: 'owner-b', nowMs: 1200, leaseMs: 100 }), true, 'stale owner is recoverable');
  a.markQueueNextTurn(row.id, { ownerToken: 'owner-a' }); assert.equal(a.listPendingDispatches()[0].status, 'publishing', 'non-owner cannot settle');
  b.markQueueNextTurn(row.id, { ownerToken: 'owner-b' }); assert.equal(a.listPendingDispatches().length, 0);

  const first = enqueuePiBrief('pi-real', 'one', { queue_id: row.id }, { home: temp, file: facts, messageId: row.id });
  const pending = path.join(temp, 'pi-inbox', 'pi-real', 'pending', `${row.id}.json`); const processing = path.join(temp, 'pi-inbox', 'pi-real', 'processing', `${row.id}.json`); fs.mkdirSync(path.dirname(processing)); fs.renameSync(pending, processing);
  const replay = enqueuePiBrief('pi-real', 'different', { queue_id: row.id }, { home: temp, file: facts, messageId: row.id });
  assert.equal(replay.replay, true); assert.equal(fs.existsSync(pending), false, 'consumer move cannot permit recreation'); assert.equal(first.message_id, replay.message_id);
  console.log('Pi TrackerDB owner lease + no-replace publication integration passed');
} finally { a.close(); b.close(); fs.rmSync(temp, { recursive: true, force: true }); }
