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

const corruptFacts = path.join(process.env.GOLEM_HOME, 'corrupt-facts.json');
fs.writeFileSync(corruptFacts, '{"version":1,"facts":[');
const corruptBytes = fs.readFileSync(corruptFacts);
assert.throws(() => upsertSessionFact({ canonical_id: 'must-not-write', harness: 'opencode', locator: { raw_session_id: 'raw' } }, { file: corruptFacts }), /cannot read facts registry/);
assert.deepEqual(fs.readFileSync(corruptFacts), corruptBytes, 'malformed registry is preserved byte-for-byte');

const projected = upsertSessionFact({ canonical_id: 'unprobed', harness: 'opencode', locator: { raw_session_id: 'unprobed' }, project_path: process.cwd(), status: 'idle' });
renewEndpointLease({ canonical_id: projected.canonical_id, owner_token: 'unprobed-owner', host: '127.0.0.1', port: 9 });
const { readNativeSessions } = await import('../dashboard/server/native-sessions.js');
const unprobed = (await readNativeSessions(() => true)).find((row) => row.session_id === projected.canonical_id);
assert.equal(unprobed?.alive, false, 'valid but unprobed lease never makes projection alive');
assert.equal(unprobed?.endpoint_health, 'unverified', 'lease validity is distinct from verified endpoint health');

console.log('canonical session facts + endpoint leases journey passed (16 assertions)');
