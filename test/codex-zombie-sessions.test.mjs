#!/usr/bin/env node
/**
 * GOL-83 — Codex zombie session lifecycle:
 *  - SessionStart succession supersedes prior same-project ids
 *  - turn stop does NOT kill the live card
 *  - managed dual-id raw fact is shadowed without a healthy lease
 *  - role assign does not fabricate unknown ids / refresh last_seen_at
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-zombie-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# zombie fixture\n');
process.env.GOLEM_HOME = home;
process.env.HOME = home;

const {
  isSessionFactTerminal,
  markSessionFactsEnded,
  readSessionFacts,
  supersedePriorCodexFacts,
  upsertSessionFact,
} = await import('../lib/session-facts.js');
const {
  markSessionsEnded,
  supersedePriorCodexSessions,
  upsertSessionRegistration,
} = await import('../lib/session-registry.js');
const { setSessionRole } = await import('../lib/session-role.js');
const { readNativeSessions } = await import('../dashboard/server/native-sessions.js');
const { sessionsJsonPath, sessionFactsJsonPath, codexSupervisorsJsonPath } = await import('../lib/golem-home.js');

function materializeHookFixture() {
  // Codex hooks are installed as plugins/golem/hooks/hook.mjs with ../lib/*.
  // Mirror that layout so in-tree tests exercise the real import graph.
  const root = path.join(home, 'plugin');
  const hooksDir = path.join(root, 'hooks');
  const libDir = path.join(root, 'lib');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'shims/codex/hook.mjs'), path.join(hooksDir, 'hook.mjs'));
  for (const name of ['golem-home.js', 'project-id.js', 'session-facts.js', 'session-registry.js', 'session-role.js']) {
    fs.copyFileSync(path.join(repo, 'lib', name), path.join(libDir, name));
  }
  return path.join(hooksDir, 'hook.mjs');
}

const hookPath = materializeHookFixture();

function runHook(event, payload, env = {}) {
  const result = spawnSync(process.execPath, [hookPath, event], {
    cwd: project,
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `hook ${event} exit ${result.status}: ${result.stderr}`);
  return result;
}

// --- unit: terminal predicate never treats bare ended as session death ---
assert.equal(isSessionFactTerminal({ status: 'ended' }), false, 'turn-stop ended is not terminal');
assert.equal(isSessionFactTerminal({ status: 'idle' }), false);
assert.equal(isSessionFactTerminal({ status: 'superseded' }), true);
assert.equal(isSessionFactTerminal({ status: 'dead' }), true);
assert.equal(isSessionFactTerminal({ ended_at: new Date().toISOString() }), true);
assert.equal(isSessionFactTerminal({ status: 'failed' }), true);

// --- SessionStart A then B: only B alive ---
const model = 'gpt-test';
runHook('session-start', { session_id: 'raw-a', cwd: project, model });
runHook('user-prompt', { session_id: 'raw-a', cwd: project, model });
runHook('stop', { session_id: 'raw-a', cwd: project, model });

let facts = readSessionFacts();
let factA = facts.find((f) => f.canonical_id === 'raw-a');
assert.ok(factA, 'session A fact exists');
assert.equal(factA.status, 'idle', 'turn stop leaves fact idle, not session-terminal');
assert.equal(isSessionFactTerminal(factA), false);

let native = await readNativeSessions(() => true, []);
assert.equal(native.find((r) => r.session_id === 'raw-a')?.alive, true, 'post-stop multi-turn card stays alive');

runHook('session-start', { session_id: 'raw-b', cwd: project, model });
facts = readSessionFacts();
factA = facts.find((f) => f.canonical_id === 'raw-a');
const factB = facts.find((f) => f.canonical_id === 'raw-b');
assert.ok(factB, 'session B fact exists');
assert.equal(factA?.status, 'superseded', 'prior fact superseded on new SessionStart');
assert.ok(factA?.ended_at, 'prior fact has ended_at');
assert.equal(isSessionFactTerminal(factA), true);

const sessions = JSON.parse(fs.readFileSync(sessionsJsonPath(), 'utf8')).sessions;
assert.ok(sessions.find((s) => s.session_id === 'raw-a')?.ended_at, 'prior sessions.json row ended');
assert.equal(sessions.find((s) => s.session_id === 'raw-b')?.ended_at ?? null, null, 'new row is live');

native = await readNativeSessions(() => true, []);
assert.equal(native.some((r) => r.session_id === 'raw-a' && r.alive), false, 'superseded A not alive');
assert.equal(native.find((r) => r.session_id === 'raw-b')?.alive, true, 'B is alive');

// --- managed dual-id: raw twin shadowed without healthy lease ---
const canonical = 'codex-managed-1';
const thread = 'thread-raw-1';
fs.writeFileSync(codexSupervisorsJsonPath(), JSON.stringify({
  version: 1,
  supervisors: [{
    canonical_id: canonical,
    thread_id: thread,
    thread_name: 'managed-main',
    cwd: project,
    health: { state: 'dead' },
  }],
}, null, 2));
// Registry row under the RAW thread id (what ordinary hooks write) — this is
// the live dual-card failure mode; shadow must delete it from the map.
await upsertSessionRegistration({ sessionId: thread, cwd: project, harness: 'codex', model });
upsertSessionFact({
  canonical_id: canonical,
  harness: 'codex',
  locator: { raw_session_id: thread },
  project_path: project,
  name: 'managed-main',
  status: 'dead',
  ended_at: new Date().toISOString(),
  model,
});
upsertSessionFact({
  canonical_id: thread,
  harness: 'codex',
  locator: { raw_session_id: thread },
  project_path: project,
  status: 'active',
  model,
});
native = await readNativeSessions(() => true, []);
assert.equal(native.some((r) => r.session_id === thread), false, 'raw twin registry+fact shadowed without healthy lease');
assert.equal(native.some((r) => r.session_id === canonical && r.alive), false, 'dead managed canonical not alive');

// Live managed pair: only canonical card
const liveCanon = 'codex-managed-live';
const liveThread = 'thread-raw-live';
fs.writeFileSync(codexSupervisorsJsonPath(), JSON.stringify({
  version: 1,
  supervisors: [{
    canonical_id: liveCanon,
    thread_id: liveThread,
    thread_name: 'testing',
    cwd: project,
    health: { state: 'healthy' },
  }],
}, null, 2));
await upsertSessionRegistration({ sessionId: liveThread, cwd: project, harness: 'codex', model });
await upsertSessionRegistration({ sessionId: liveCanon, cwd: project, harness: 'codex', model });
upsertSessionFact({
  canonical_id: liveCanon,
  harness: 'codex',
  locator: { raw_session_id: liveThread },
  project_path: project,
  name: 'testing',
  status: 'idle',
  model,
});
upsertSessionFact({
  canonical_id: liveThread,
  harness: 'codex',
  locator: { raw_session_id: liveThread },
  project_path: project,
  status: 'idle',
  model,
});
native = await readNativeSessions(() => true, [{
  session_id: liveCanon,
  endpoint_health: 'healthy',
  kind: 'codex-supervisor',
  delivery_ready: true,
}]);
assert.equal(native.filter((r) => r.session_id === liveCanon || r.session_id === liveThread).length, 1,
  'live managed pair yields exactly one card');
assert.equal(native.find((r) => r.session_id === liveCanon)?.alive, true, 'canonical live');
assert.equal(native.some((r) => r.session_id === liveThread), false, 'raw twin absent when live');

// managed bind writes under canonical id
runHook('session-start', {
  session_id: 'thread-bound-2',
  cwd: project,
  model,
}, {
  GOLEM_MANAGED_CODEX_BOUND: '1',
  GOLEM_MANAGED_CODEX_BOUND_SESSION_ID: 'codex-bound-2',
});
facts = readSessionFacts();
const bound = facts.find((f) => f.canonical_id === 'codex-bound-2');
assert.ok(bound, 'managed bind fact uses Golem canonical id');
assert.equal(bound.locator.raw_session_id, 'thread-bound-2');
assert.equal(facts.some((f) => f.canonical_id === 'thread-bound-2' && !isSessionFactTerminal(f)), false,
  'no live raw-as-canonical fact when managed-bound');

// --- role assign hygiene ---
assert.throws(
  () => setSessionRole('totally-unknown-session', 'builder', { by: 'human:dashboard' }),
  /session not found/i,
  'unknown id does not fabricate a row',
);

const before = JSON.parse(fs.readFileSync(sessionsJsonPath(), 'utf8')).sessions
  .find((s) => s.session_id === 'raw-b');
const seenBefore = before?.last_seen_at;
const roleRow = setSessionRole('raw-b', 'builder', { by: 'human:dashboard' });
assert.equal(roleRow.role, 'builder');
assert.equal(roleRow.last_seen_at, seenBefore, 'role assign does not refresh last_seen_at');

// --- helpers: mark APIs ---
await upsertSessionRegistration({ sessionId: 'mark-me', cwd: project, harness: 'codex', model });
const marked = markSessionsEnded(['mark-me']);
assert.ok(marked.includes('mark-me'));
assert.ok(JSON.parse(fs.readFileSync(sessionsJsonPath(), 'utf8')).sessions.find((s) => s.session_id === 'mark-me')?.ended_at);
// already-terminal is a no-op
assert.deepEqual(markSessionsEnded(['mark-me']), []);

// registry supersede protects other managed ids
await upsertSessionRegistration({ sessionId: 'keep-me', cwd: project, harness: 'codex', model });
await upsertSessionRegistration({ sessionId: 'drop-me', cwd: project, harness: 'codex', model });
const superMarked = supersedePriorCodexSessions({
  projectPath: project,
  keepSessionId: 'keep-me',
  protectSessionIds: ['drop-me'],
});
assert.equal(superMarked.includes('drop-me'), false, 'protectSessionIds skips peer managed');

// facts supersede
upsertSessionFact({
  canonical_id: 'old-fact', harness: 'codex', locator: { raw_session_id: 'old-fact' },
  project_path: project, status: 'active',
});
const factMarked = supersedePriorCodexFacts({ projectPath: project, keepCanonicalIds: ['keep-me'] });
assert.ok(factMarked.includes('old-fact'));
assert.ok(isSessionFactTerminal(readSessionFacts().find((f) => f.canonical_id === 'old-fact')));

// markSessionFactsEnded is idempotent on already-terminal
assert.deepEqual(markSessionFactsEnded(['old-fact']), []);

// cleanup smoke: sessions file still valid JSON
assert.doesNotThrow(() => JSON.parse(fs.readFileSync(sessionsJsonPath(), 'utf8')));
assert.doesNotThrow(() => JSON.parse(fs.readFileSync(sessionFactsJsonPath(), 'utf8')));

console.log('GOL-83 codex zombie sessions journey passed');
