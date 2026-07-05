#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const home = mkdtempSync(path.join(tmpdir(), 'golem-gol-312-'));
process.env.GOLEM_HOME = home;

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, GOLEM_HOME: home },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const sessionsPath = path.join(home, 'sessions.json');
writeFileSync(sessionsPath, JSON.stringify({
  version: 1,
  sessions: [
    { session_id: 's-manager', name: 'old-general', role: 'general', project_path: repoRoot },
    { session_id: 's-explorer-1', name: 'old-researcher', role: 'researcher', project_path: repoRoot },
    { session_id: 's-explorer-2', name: 'old-ui', role: 'ui-tester', project_path: repoRoot },
    { session_id: 's-planner', name: 'planner', role: 'planner', project_path: repoRoot },
  ],
}, null, 2));

const roles = await import('../../lib/session-role.js');
const seeded = roles.readRoleRegistry();
assert.deepEqual(seeded.map((r) => r.name).sort(), ['builder', 'explorer', 'manager', 'planner']);
assert.deepEqual(json(path.join(home, 'roles', 'index.json')).roles.map((r) => r.name).sort(), ['builder', 'explorer', 'manager', 'planner']);

const migrated = json(sessionsPath).sessions;
assert.equal(migrated.find((s) => s.session_id === 's-manager').role, 'manager');
assert.equal(migrated.find((s) => s.session_id === 's-manager').role_updated_by, 'system:role-migration');
assert.equal(migrated.find((s) => s.session_id === 's-explorer-1').role, 'explorer');
assert.equal(migrated.find((s) => s.session_id === 's-explorer-2').role, 'explorer');
assert.equal(migrated.find((s) => s.session_id === 's-planner').role, 'planner');

assert.throws(() => roles.validateSessionRole('general'), /invalid session role/);
assert.equal(roles.validateSessionRole('manager'), 'manager');

const critic = roles.createRole({ name: 'critic', color: '#ff00aa', glyph: 'CR', body: '# Role: critic\nReview plans and surface risks.' });
assert.equal(critic.name, 'critic');
assert.equal(roles.getRole('critic').glyph, 'CR');
roles.updateRoleMeta('critic', { glyph: 'RV' });
assert.equal(roles.getRole('critic').glyph, 'RV');
assert.match(roles.readRoleCard('critic'), /Review plans/);

roles.setSessionRole('s-planner', 'critic', { by: 'human:cli' });
assert.throws(() => roles.deleteRole('critic'), /assigned to 1 session/);
assert.deepEqual(roles.deleteRole('critic', { force: true }), { ok: true, role: 'critic', cleared_sessions: 1 });
assert.equal(json(sessionsPath).sessions.find((s) => s.session_id === 's-planner').role, null);

roles.createRole({ name: 'critic', color: '#ff00aa', glyph: 'CR', body: '# Role: critic\nReview plans and surface risks.' });
const cliOut = run(['cli/golem.js', 'role', 'critic', '--session', 's-manager']);
assert.equal(JSON.parse(cliOut).role, 'critic');
const cliSessions = json(sessionsPath).sessions;
assert.equal(cliSessions.find((s) => s.session_id === 's-manager').role, 'critic');
assert.equal(cliSessions.find((s) => s.session_id === 's-manager').role_updated_by, 'human:cli');

console.log(JSON.stringify({
  ok: true,
  golem_home: home,
  seeded_roles: seeded.map((r) => r.name).sort(),
  migrated_roles: migrated.map((s) => ({ id: s.session_id, role: s.role, by: s.role_updated_by })),
  assertions: [
    'temp GOLEM_HOME seeded only manager/planner/builder/explorer',
    'general/researcher/ui-tester migrated with system:role-migration provenance',
    'custom role CRUD persisted card + metadata',
    'delete refused assigned role unless force cleared sessions',
    'CLI accepted dynamic custom role from registry',
  ],
}, null, 2));
