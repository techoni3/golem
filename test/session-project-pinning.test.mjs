#!/usr/bin/env node
// Regression: a session registered under a project must stay under that project
// even when its live cwd drifts to another directory (e.g. an agent cd's into
// a sibling repo mid-session). The dashboard derives project_id from the live
// cwd every tick; it must prefer the REGISTERED project (pinned at session
// start in sessions.json / the session fact) over the drifted cwd.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pinning-'));
// Point HOME at the temp dir BEFORE importing native-sessions.js so its
// hardcoded `~/.claude/sessions` and `~/.golem` reads land in the sandbox.
process.env.HOME = tmp;
process.env.GOLEM_HOME = path.join(tmp, '.golem');

// Two sibling project roots, each with a .git marker so resolveProjectRoot
// walks up to them.
const projectA = path.join(tmp, 'yitfit');
const projectB = path.join(tmp, 'trialroom_app');
for (const p of [projectA, projectB]) {
  fs.mkdirSync(path.join(p, '.git'), { recursive: true });
}

const { projectIdFor } = await import('../lib/project-id.js');
const { readNativeSessions, mergeSources } = await import('../dashboard/server/native-sessions.js');

const idA = projectIdFor(projectA);
const idB = projectIdFor(projectB);
assert.notEqual(idA, idB, 'the two projects must resolve to distinct ids');

// --- mergeSources preserves the registered project across a live-cwd overlay ---
const golemRow = {
  session_id: 'pin-me', pid: 999, cwd: projectA, name: 'pin-me', status: 'idle',
  started_at: 0, updated_at: 1000, kind: null, harness: 'claudecode', model: null,
  role: null, role_updated_at: null, role_updated_by: null, ended_at: null,
  source: 'native', _from: 'golem',
  registered_project_path: projectA, registered_project_id: idA,
};
// CLI row carries the LIVE cwd (drifted to projectB) and is higher priority.
const cliRow = {
  session_id: 'pin-me', pid: 4242, cwd: projectB, name: 'pin-me', status: 'idle',
  waiting_for: null, model: null, started_at: 0, updated_at: 2000, kind: 'interactive',
  source: 'native', _from: 'cli',
};
const merged = mergeSources([cliRow], [], [golemRow]).find((r) => r.session_id === 'pin-me');
assert.equal(merged.cwd, projectB, 'live cwd is surfaced for display');
assert.equal(merged.registered_project_path, projectA, 'registered project survives the live-cwd overlay');

// --- readNativeSessions pins the session to its registered project ---
// Write the golem registry row (registered under A) and a live ~/.claude
// session file whose cwd has drifted to B.
const golemHome = process.env.GOLEM_HOME;
fs.mkdirSync(golemHome, { recursive: true });
fs.writeFileSync(path.join(golemHome, 'sessions.json'), JSON.stringify({
  version: 1,
  sessions: [{
    session_id: 'pin-me', hook_ppid: 999, project_id: idA, project_path: projectA,
    harness: 'claudecode', name: 'pin-me', model: null, boot_time: new Date(0).toISOString(),
    last_seen_at: new Date(1000).toISOString(),
  }],
}));
const claudeSessions = path.join(tmp, '.claude', 'sessions');
fs.mkdirSync(claudeSessions, { recursive: true });
// Use a real pid so the ~/.claude registry row passes pid-liveness.
fs.writeFileSync(path.join(claudeSessions, `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId: 'pin-me', cwd: projectB, startedAt: 0, procStart: 0,
  version: '2.1.x', kind: 'interactive', name: 'pin-me', updatedAt: 2000,
}));

const rows = await readNativeSessions(() => true, []);
const row = rows.find((r) => r.session_id === 'pin-me');
assert.ok(row, 'the session is surfaced');
assert.equal(row.cwd, projectB, 'live cwd is still shown for display');
assert.equal(row.project_id, idA, 'session stays under its REGISTERED project, not the drifted cwd');
assert.equal(row.project_root, projectA, 'project root is the registered root');
assert.notEqual(row.project_id, idB, 'session must not move to the drifted project');

// A session with NO registered project still falls back to the live cwd.
fs.writeFileSync(path.join(claudeSessions, `${process.pid}-raw.json`), JSON.stringify({
  pid: process.pid, sessionId: 'raw-claude', cwd: projectB, startedAt: 0, procStart: 0,
  version: '2.1.x', kind: 'interactive', name: 'raw-claude', updatedAt: 2000,
}));
const rawRows = await readNativeSessions(() => true, []);
const raw = rawRows.find((r) => r.session_id === 'raw-claude');
assert.equal(raw.project_id, idB, 'unregistered session derives project from its live cwd');

console.log('session project pinning journey passed');
