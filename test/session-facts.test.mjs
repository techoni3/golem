#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.GOLEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-session-facts-'));
const {
  readEndpointLeases, readSessionFacts, releaseEndpointLeases,
  renewEndpointLease, upsertSessionFact,
} = await import('../lib/session-facts.js');

const first = upsertSessionFact({ canonical_id: 'canonical-1', harness: 'claudecode', locator: { raw_session_id: 'run-1' }, continuation_key: 'resume-1', name: 'Original', status: 'idle', revision: 1 }, { now: 1000 });
assert.equal(first.name, 'Original');
const stale = upsertSessionFact({ canonical_id: 'canonical-1', harness: 'claudecode', locator: { raw_session_id: 'wrong-old-run' }, name: 'Stale rename', status: 'busy', revision: 0, observed_at: new Date(500).toISOString() });
assert.equal(stale.name, 'Original', 'older mutable observation cannot overwrite the fact');
const renamed = upsertSessionFact({ canonical_id: 'canonical-1', harness: 'claudecode', locator: { raw_session_id: 'run-2' }, continuation_key: 'invented-change', name: 'Renamed', status: 'busy', revision: 2 }, { now: 2000 });
assert.equal(renamed.canonical_id, 'canonical-1');
assert.equal(renamed.continuation_key, 'resume-1', 'continuation ownership is immutable');
assert.equal(renamed.locator.raw_session_id, 'run-2', 'resumed raw id is only a locator');
assert.equal(readSessionFacts().length, 1);

renewEndpointLease({ canonical_id: 'canonical-1', owner_token: 'owner-1', host: '127.0.0.1', port: 1234 }, { now: 1000, ttlMs: 100 });
assert.equal(readEndpointLeases({ now: 1050 }).length, 1);
assert.equal(readEndpointLeases({ now: 1101 }).length, 0, 'expired lease is not live');
renewEndpointLease({ canonical_id: 'canonical-1', owner_token: 'owner-1', host: '127.0.0.1', port: 1234 }, { now: 2000, ttlMs: 100 });
releaseEndpointLeases('owner-1');
assert.equal(readEndpointLeases({ now: 2001 }).length, 0);

for (const file of ['session-facts.json', 'endpoint-leases.json']) {
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, file), 'utf8')), `${file} remains atomic JSON`);
}
console.log('canonical session facts + endpoint leases journey passed (12 assertions)');
