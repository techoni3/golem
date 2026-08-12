#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintSubstrate } from '../lib/substrate-lint.js';
import { dedupeNativeSessions } from '../dashboard/server/native-sessions.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli', 'golem.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-sync-enforce-'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Every role registered in lib/session-role.js needs a card AND a row in the compact
// instructions Roles table.
// Must track BUILTIN_ROLES in lib/session-role.js — the lint checks registered
// roles against the fixture's cards and AGENTS.md table, so a stale list here
// fails as a missing card rather than as a real defect.
const FIXTURE_ROLES = ['lead', 'builder', 'explorer', 'reviewer', 'standalone'];

function rolesTable(roles) {
  return [
    '## Roles',
    '',
    '| Role | Owns | Never | Load |',
    '|---|---|---|---|',
    ...roles.map((r) => `| **${r}** | fixture owns | fixture never | \`golem:tracker\` |`),
  ].join('\n');
}

function seedFixture(name) {
  const root = path.join(tmp, name, 'substrate');
  write(path.join(root, 'README.md'), '# fixture\n');
  write(path.join(root, 'mcp.json'), '{"mcpServers":{}}\n');
  write(path.join(root, 'plugin-meta.json'), JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-plugin.json',
    name: 'golem', displayName: 'golem', description: 'fixture', author: 'test', license: 'MIT', keywords: ['golem'],
  }, null, 2) + '\n');
  write(path.join(root, 'hooks', 'hooks.json'), '{}\n');
  write(path.join(root, 'hooks', 'session-register.sh'), '#!/usr/bin/env bash\nexit 0\n');
  // Cards carry identity + a skill pointer. The shared routing table is in
  // instructions/AGENTS.md § Roles, so no role needs fixture-specific content here.
  for (const role of FIXTURE_ROLES) {
    write(path.join(root, 'roles', `${role}.md`), `# Role: ${role}\nMission: ${role} mission.\nLoad: golem:tracker\n`);
  }
  write(path.join(root, 'skills', 'tracker', 'SKILL.md'), '---\nname: tracker\ndescription: Track assigned work through the golem tracker.\n---\n# tracker\n');
  write(path.join(root, 'skills', 'extra', 'SKILL.md'), '---\nname: extra\ndescription: Extra fixture skill used to verify orphan warnings.\n---\n# extra\n');
  write(path.join(root, 'agents', 'worker.md'), '---\nname: worker\ndescription: worker\n---\nUse golem:tracker.\n');
  write(path.join(root, 'instructions', 'AGENTS.md'), `Use golem:tracker.\n\n${rolesTable(FIXTURE_ROLES)}\n`);
  return root;
}

function runSync(substrateRoot, home) {
  return spawnSync(process.execPath, [cli, 'sync', '--check', '--target', 'cc'], {
    cwd: repo,
    env: { ...process.env, GOLEM_SUBSTRATE_ROOT: substrateRoot, GOLEM_HOME: home, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    encoding: 'utf8',
  });
}

function renderSync(substrateRoot, home) {
  return spawnSync(process.execPath, [cli, 'sync', '--target', 'cc', '--force'], {
    cwd: repo,
    env: { ...process.env, GOLEM_SUBSTRATE_ROOT: substrateRoot, GOLEM_HOME: home, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    encoding: 'utf8',
  });
}

function assertFails(label, mutate, pattern) {
  const root = seedFixture(label);
  const home = path.join(tmp, label, 'home');
  mutate(root, home);
  const res = runSync(root, home);
  assert.notEqual(res.status, 0, `${label} should fail`);
  assert.match(`${res.stdout}\n${res.stderr}`, pattern, label);
  console.log(`${label}: failed as expected`);
}

async function assertShippedHookBundlesAreRunnable() {
  // Rendering a script without the sibling it sources ships a bundle that dies
  // on line 1. Checking that the file resolves is not the same as running it —
  // the codex bundle shipped tracker-context.sh without _golem-home.sh and
  // every project_context call on Codex returned isError, while sync --check
  // stayed green because the adapter never declared the missing file.
  const codex = await import('../lib/compiler/adapters/codex.js');
  const plan = codex.buildPlan({ substrateRoot: path.join(repo, 'substrate'), repoRoot: repo, packageVersion: '0.0.0' });
  const shipped = new Set(plan.map((i) => path.basename(i.outputRelPath)));
  // Assert both unconditionally. Guarding this on `if (shipped.has(...))` made it
  // vacuous: dropping BOTH entries from the adapter passed, because the check
  // simply skipped.
  assert.ok(shipped.has('tracker-context.sh'), 'codex bundle must ship tracker-context.sh');
  assert.ok(shipped.has('_golem-home.sh'), 'codex bundle ships tracker-context.sh without the _golem-home.sh it sources');

  // Then actually execute what was rendered, not an equivalent copy elsewhere.
  const out = path.join(tmp, 'codex-bundle');
  for (const it of plan.filter((i) => i.outputRelPath.includes('/hooks/'))) {
    const dest = path.join(out, it.outputRelPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, it.build());
  }
  const script = path.join(out, 'plugins', 'golem', 'hooks', 'tracker-context.sh');
  assert.ok(fs.existsSync(script), 'rendered codex bundle must contain tracker-context.sh');
  const res = spawnSync('bash', [script], { input: '{}', encoding: 'utf8', cwd: repo });
  assert.equal(res.status, 0, `rendered codex tracker-context.sh must run: ${res.stderr}`);
  assert.doesNotMatch(res.stderr || '', /No such file or directory/, 'rendered script must not be missing a sourced sibling');
  JSON.parse(res.stdout); // must emit valid JSON, not a truncated payload

  // Codex must actually INJECT that payload, not merely ship the script. The
  // original gap was exactly this shape: the bundle carried tracker-context.sh,
  // the hook registered the session and returned silently, and every check
  // passed because nothing asserted on stdout. Render the whole bundle (lib/ and
  // hooks/) because hook.mjs imports `../lib/*.js` and cannot run from the repo.
  const full = path.join(tmp, 'codex-full');
  for (const it of plan) {
    const dest = path.join(full, it.outputRelPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, it.build());
  }
  const hook = path.join(full, 'plugins', 'golem', 'hooks', 'hook.mjs');
  const start = spawnSync('node', [hook, 'session-start'], {
    input: JSON.stringify({ session_id: 'test-codex-l4', cwd: repo }), encoding: 'utf8', cwd: repo,
  });
  assert.equal(start.status, 0, `codex session-start hook must exit 0: ${start.stderr}`);
  const emitted = JSON.parse(start.stdout || '{}');
  const hso = emitted.hookSpecificOutput;
  assert.ok(hso?.additionalContext, 'codex session-start must inject L4 additionalContext');
  assert.equal(hso.hookEventName, 'SessionStart');
  // SessionStartHookSpecificOutputWire declares additionalProperties:false, so an
  // extra key silently invalidates the whole payload rather than being ignored.
  assert.deepEqual(Object.keys(hso).sort(), ['additionalContext', 'hookEventName']);

  // Fail open: a missing script must cost context, never the session. And no
  // other lifecycle event may write to stdout — Codex parses it as hook output.
  fs.rmSync(path.join(full, 'plugins', 'golem', 'hooks', 'tracker-context.sh'));
  const degraded = spawnSync('node', [hook, 'session-start'], {
    input: JSON.stringify({ session_id: 'test-codex-l4', cwd: repo }), encoding: 'utf8', cwd: repo,
  });
  assert.equal(degraded.status, 0, 'codex hook must fail open when the context script is absent');
  assert.equal(degraded.stdout.trim(), '', 'fail-open must emit nothing rather than a partial payload');
  for (const ev of ['stop', 'tool-pre', 'pre-compact']) {
    const other = spawnSync('node', [hook, ev], {
      input: JSON.stringify({ session_id: 'test-codex-l4', cwd: repo }), encoding: 'utf8', cwd: repo,
    });
    assert.equal(other.stdout.trim(), '', `${ev} must not write hook output`);
  }
  console.log('shipped hook bundles run standalone; codex injects L4 and fails open');
}

async function assertPiWorkerSurfacesAreExplicit() {
  const pi = await import('../lib/compiler/adapters/pi.js');
  const plan = pi.buildPlan({ substrateRoot: path.join(repo, 'substrate'), repoRoot: repo, packageVersion: '0.0.0' });
  const keys = new Set(plan.map((entry) => entry.key));
  for (const required of [
    'runtime:golem-client.js', 'runtime:golem-tool-contracts.js', 'runtime:golem-tool-runtime.js',
    'instructions:AGENTS.md', 'role:builder', 'role:explorer', 'role:reviewer',
    'skill:tracker/SKILL.md', 'skill:building/SKILL.md', 'skill:reviewing/SKILL.md',
    'hook:tracker-context.sh', 'hook:_golem-home.sh',
  ]) assert.ok(keys.has(required), `Pi render must explicitly declare ${required}`);
  assert.equal(keys.has('role:lead'), false, 'Pi worker render must not silently enable lead scope');
  assert.equal(keys.has('role:standalone'), false, 'Pi worker render must not silently enable standalone scope');

  const broken = path.join(tmp, 'pi-missing-surface');
  fs.cpSync(path.join(repo, 'substrate'), broken, { recursive: true });
  fs.rmSync(path.join(broken, 'roles', 'reviewer.md'));
  assert.throws(
    () => pi.buildPlan({ substrateRoot: broken, repoRoot: repo, packageVersion: '0.0.0' }),
    /reviewer\.md/,
    'missing required Pi role surface must fail plan construction rather than disappear',
  );
  console.log('Pi worker surfaces are explicit and missing required resources fail loudly');
}

async function assertPiRolePersistenceBoundary() {
  const { setSessionRole } = await import('../lib/session-role.js');
  const priorHome = process.env.GOLEM_HOME;
  const home = path.join(tmp, 'pi-role-boundary');
  process.env.GOLEM_HOME = home;
  try {
    fs.mkdirSync(home, { recursive: true });
    write(path.join(home, 'session-facts.json'), JSON.stringify({ version: 1, facts: [{
      canonical_id: 'pi-role-test', harness: 'pi', project_path: repo, observed_at: new Date().toISOString(),
    }] }));
    assert.throws(() => setSessionRole('pi-role-test', 'lead', { by: 'human:dashboard' }), /Pi first-class worker role/);
    assert.throws(() => setSessionRole('pi-role-test', 'standalone', { by: 'human:cli' }), /Pi first-class worker role/);
    assert.equal(setSessionRole('pi-role-test', 'builder', { by: 'human:dashboard' }).role, 'builder');
  } finally {
    if (priorHome == null) delete process.env.GOLEM_HOME;
    else process.env.GOLEM_HOME = priorHome;
  }
  console.log('Pi role persistence rejects lead/standalone before canonical truth changes');
}

async function assertProjectCwdResolution() {
  // The three cases below were all reachable without a live server and all
  // shipped unguarded: removing the $HOME stop, re-adding AGENTS.md to the
  // predicate, and removing the refusal itself each left the suite green.
  const { resolveProjectCwd } = await import('../mcp/channel/identity.js');
  const base = path.join(tmp, 'cwdres');
  const home = path.join(base, 'home');
  const repoDir = path.join(base, 'proj');
  const nested = path.join(repoDir, 'a', 'b');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  write(path.join(home, 'sessions.json'), JSON.stringify({
    sessions: [{ session_id: 'known', project_path: repoDir }],
  }));

  assert.equal(resolveProjectCwd({ sessionId: 'known', home, cwd: '/tmp', homeDir: base }), repoDir,
    'registry row wins over cwd');
  assert.equal(resolveProjectCwd({ sessionId: '', home, cwd: nested, homeDir: base }), repoDir,
    'no row: walks up from cwd to the repo root');

  // A dotfiles repo at HOME is very common. Walking into it renders that repo's
  // commits as the project's — confidently, and in the voice of derived state.
  const fakeHome = path.join(base, 'fakehome');
  fs.mkdirSync(path.join(fakeHome, '.git'), { recursive: true });
  const underHome = path.join(fakeHome, 'scratch');
  fs.mkdirSync(underHome, { recursive: true });
  assert.equal(resolveProjectCwd({ sessionId: '', home, cwd: underHome, homeDir: fakeHome }), null,
    'must not climb into a dotfiles repo at HOME');

  // AGENTS.md is deliberately NOT a project marker here: rootFrom() in
  // tracker-context.sh matches only .git/CLAUDE.md, and these two must agree.
  const agentsOnly = path.join(base, 'agents-only');
  fs.mkdirSync(agentsOnly, { recursive: true });
  write(path.join(agentsOnly, 'AGENTS.md'), '# not a project root\n');
  assert.equal(resolveProjectCwd({ sessionId: '', home, cwd: agentsOnly, homeDir: base }), null,
    'AGENTS.md alone must not mark a project root');

  // null is the contract the refusal depends on.
  assert.equal(resolveProjectCwd({ sessionId: 'unknown', home, cwd: path.join(base, 'nowhere'), homeDir: base }), null,
    'unknown session outside any project resolves to null, which the caller must treat as isError');
  console.log('project cwd resolution refuses rather than guessing');
}

async function assertPayloadBudgetAndRefusal() {
  // The aggregate budget and the project_context refusal both shipped unguarded.
  // The refusal is the one that got silently reverted and passed every gate.
  const hook = path.join(repo, 'substrate', 'hooks', 'tracker-context.sh');
  const home = path.join(tmp, 'budget', 'home');
  const project = path.join(tmp, 'budget', 'project');
  fs.mkdirSync(path.join(home, 'roles'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  write(path.join(project, 'CLAUDE.md'), '# budget fixture\n');
  spawnSync('git', ['init', '-q'], { cwd: project, encoding: 'utf8' });
  // Enough commits that the section reaches its own 2,600-char cap; together with
  // the oversized card that is comfortably past the aggregate ceiling, so the drop
  // actually fires. One commit left the payload under budget and the assertion
  // passed without exercising anything.
  for (let i = 0; i < 30; i += 1) {
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', `feat(scope-${i}): ${'x'.repeat(150)}`], { cwd: project, encoding: 'utf8' });
  }
  write(path.join(home, 'sessions.json'), JSON.stringify({
    sessions: [{ session_id: 'b', project_id: 'budget-fixture', project_path: project, role: 'lead', status: 'idle', name: 'b' }],
  }));
  // A large overlay card is the documented precedence-1 override, and it used to
  // land outside the budget entirely because bash appended it after assembly.
  // Sized to actually force a drop. A 2KB card left the payload under budget and
  // the "omission is stated" assertion passed vacuously.
  write(path.join(home, 'roles', 'lead.md'), `# Role: lead\n${'x'.repeat(2048)}\n`);
  const res = spawnSync('bash', [hook], {
    cwd: project, encoding: 'utf8', input: JSON.stringify({ session_id: 'b', cwd: project }),
    env: { ...process.env, GOLEM_HOME: home, HOME: home, CLAUDE_CODE_SESSION_ID: 'b' },
  });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  const shown = (s) => (s.match(/^ {2}[0-9a-f]{7} /gm) || []).length;

  assert.match(ctx, /Role: lead/, 'the role card is part of the payload');
  assert.ok(ctx.length <= 3600, `a large role card must not blow the budget, got ${ctx.length} chars`);

  // Commits RESIZE under pressure; they do not vanish. Whole-section dropping as
  // the only lever put a cliff on the ordinary path — every packaged role card is
  // 241-298 bytes, so 33 bytes over budget cost all 2,600 chars of commits.
  assert.ok(shown(ctx) > 0, 'commits shrink to fit rather than dropping wholesale');
  assert.doesNotMatch(ctx, /commits omitted/, 'a section that was merely trimmed must not be reported as omitted');
  const header = ctx.match(/Recent commits \((\d+) of \d+\)/);
  assert.ok(header, 'a trimmed commits section states how many of how many');
  assert.equal(Number(header[1]), shown(ctx), 'the (N of M) header must match the lines present');

  // A pathological card is truncated rather than dropped, and — because it is
  // capped — it can never starve the sections behind it. That is the property
  // worth pinning: no single field can crowd out the rest.
  write(path.join(home, 'roles', 'lead.md'), `# Role: lead\n${'x'.repeat(6000)}\n`);
  const huge = spawnSync('bash', [hook], {
    cwd: project, encoding: 'utf8', input: JSON.stringify({ session_id: 'b', cwd: project }),
    env: { ...process.env, GOLEM_HOME: home, HOME: home, CLAUDE_CODE_SESSION_ID: 'b' },
  });
  const hugeCtx = JSON.parse(huge.stdout).hookSpecificOutput.additionalContext;
  assert.match(hugeCtx, /Role: lead/, 'the card is never dropped — a session must know what it is');
  assert.match(hugeCtx, /role card truncated/, 'an undroppable card must still be truncatable');
  assert.ok(hugeCtx.length <= 3600, `a 6KB card must still fit the budget, got ${hugeCtx.length}`);
  assert.ok(shown(hugeCtx) > 0, 'a capped card cannot starve the commits behind it');
  // Shed ORDER, across the whole card-size range. Commits are the cheapest field
  // to re-fetch (one command) and recently-closed the dearest (node:sqlite plus
  // the tracker schema), so recently-closed must never be dropped while commits
  // survive. It used to be, for a 30-char overshoot: commitsWithin fitted the
  // entries but returned the header too, so the assembled payload was over by the
  // header's length and the next branch paid for that with a ~700-char section.
  // The hook resolves registryId from projects.json (by id or by path), so
  // without this mapping the ticket rows never match and the section is simply
  // absent — which would make the shed-order assertion below pass on nothing.
  write(path.join(home, 'projects.json'), JSON.stringify({ projects: [{ id: 'budget-fixture', path: project }] }));
  const db = new DatabaseSync(path.join(home, 'tracker.db'));
  db.exec('CREATE TABLE tickets (display_id TEXT, kind TEXT, title TEXT, project_id TEXT, state TEXT, done_at TEXT)');
  const ins = db.prepare('INSERT INTO tickets VALUES (?,?,?,?,?,?)');
  // 'spec', not 'task': recent-closes lists spec closes only. A task
  // fixture renders an empty section and the shed-order assertion below would
  // then be checking that nothing got dropped from nothing.
  for (let i = 0; i < 8; i += 1) ins.run(`GOL-${i}`, 'spec', `closed item ${i} ${'y'.repeat(60)}`, 'budget-fixture', 'done', '2026-07-30');
  db.close();
  for (const size of [0, 100, 300, 500, 1000, 2000]) {
    write(path.join(home, 'roles', 'lead.md'), `# Role: lead\n${'x'.repeat(size)}\n`);
    const out = spawnSync('bash', [hook], {
      cwd: project, encoding: 'utf8', input: JSON.stringify({ session_id: 'b', cwd: project }),
      env: { ...process.env, GOLEM_HOME: home, HOME: home, CLAUDE_CODE_SESSION_ID: 'b' },
    });
    const c = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    assert.ok(c.length <= 3600, `card ${size}b must stay in budget, got ${c.length}`);
    if (shown(c) > 0) {
      assert.match(c, /Recently closed:/, `card ${size}b dropped recently-closed while keeping commits — shed order inverted`);
    }
    const h = c.match(/Recent commits \((\d+) of \d+\)/);
    if (h) assert.equal(Number(h[1]), shown(c), `card ${size}b header disagrees with the lines present`);
  }
  // The card must survive node failing, not just node being absent. Moving the
  // card into the node block had quietly made it the one field that did not
  // degrade independently, and the first fix gated on `command -v node` — which
  // covers a missing binary but not one that runs and produces nothing.
  const nodeShim = path.join(tmp, 'budget', 'nonode');
  fs.mkdirSync(nodeShim, { recursive: true });
  write(path.join(nodeShim, 'node'), '#!/usr/bin/env bash\nexit 1\n');
  fs.chmodSync(path.join(nodeShim, 'node'), 0o755);
  write(path.join(home, 'roles', 'lead.md'), '# Role: lead\nMission: fixture.\n');
  const broken = spawnSync('bash', [hook], {
    cwd: project, encoding: 'utf8', input: JSON.stringify({ session_id: 'b', cwd: project }),
    env: { ...process.env, PATH: `${nodeShim}:${process.env.PATH}`, GOLEM_HOME: home, HOME: home, CLAUDE_CODE_SESSION_ID: 'b' },
  });
  assert.equal(broken.status, 0, 'a failing node must not break session start');
  const brokenCtx = JSON.parse(broken.stdout).hookSpecificOutput.additionalContext;
  assert.match(brokenCtx, /Role: lead/, 'the role card survives node exiting non-zero');
  assert.equal((brokenCtx.match(/Role: lead/g) || []).length, 1, 'and is not emitted twice when node succeeds');
  console.log('payload budget resizes commits, truncates the card, and sheds in order');
}

async function assertOrphanDirectoryPruning() {
  const compiler = await import('../lib/compiler/engine.js');
  const base = path.join(tmp, 'prune');
  const outDir = path.join(base, 'out');
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const item = (rel, body) => ({ key: rel, outputRelPath: rel, sourceSha256: crypto.createHash('sha256').update(body).digest('hex'), build: () => body });
  const render = (items) => {
    const prev = process.env.GOLEM_HOME;
    process.env.GOLEM_HOME = home;
    try { return compiler.render({ target: 'cc', outDir, items, packageVersion: '0.0.0', force: true }); }
    finally { if (prev === undefined) delete process.env.GOLEM_HOME; else process.env.GOLEM_HOME = prev; }
  };

  render([item('skills/keep/SKILL.md', 'keep\n'), item('skills/drop/SKILL.md', 'drop\n'), item('top.md', 'top\n')]);
  assert.ok(fs.existsSync(path.join(outDir, 'skills', 'drop', 'SKILL.md')), 'seeded');

  // A sibling directory whose name is a prefix of another must not be swept.
  fs.mkdirSync(path.join(outDir, 'skills', 'dropX'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'skills', 'dropX', 'held.txt'), 'x');

  const res = render([item('skills/keep/SKILL.md', 'keep\n'), item('top.md', 'top\n')]);
  assert.equal(res.pruned.length, 1, 'the removed source was pruned');
  assert.ok(!fs.existsSync(path.join(outDir, 'skills', 'drop')), 'emptied directory is removed, not just its file');
  assert.ok(fs.existsSync(path.join(outDir, 'skills', 'keep', 'SKILL.md')), 'sibling with content survives');
  assert.ok(fs.existsSync(path.join(outDir, 'skills', 'dropX', 'held.txt')), 'prefix-named sibling survives');
  assert.ok(fs.existsSync(path.join(outDir, 'skills')), 'a parent that still has children survives');
  assert.ok(fs.existsSync(outDir), 'outDir itself is never removed');

  // Emptying the last child must not climb out of outDir.
  const res2 = render([item('top.md', 'top\n')]);
  assert.ok(res2.pruned.length >= 1, 'last skill pruned');
  fs.rmSync(path.join(outDir, 'skills', 'dropX'), { recursive: true, force: true });
  assert.ok(fs.existsSync(outDir), 'outDir survives after its last nested child is gone');
  assert.ok(fs.existsSync(base), 'pruning never climbs above outDir');
  console.log('orphan directory pruning is bounded to outDir');
}

function assertNativeSessionDeduplication() {
  const row = (session_id, { alive, pid = 42, project_id = 'project-a', name = 'resume-rekey' } = {}) => ({
    session_id,
    alive,
    pid,
    project_id,
    name,
    harness: 'claudecode',
  });

  // readNativeSessions sorts alive rows first, making a dead winner unreachable
  // end-to-end; assert the filter itself to pin that invariant under both orders.
  assert.deepEqual(
    dedupeNativeSessions([row('dead', { alive: false }), row('live', { alive: true })]).map((entry) => entry.session_id),
    ['dead', 'live'],
    'a live same-pid row survives a dead winner',
  );
  assert.deepEqual(
    dedupeNativeSessions([row('live', { alive: true }), row('dead', { alive: false })]).map((entry) => entry.session_id),
    ['live'],
    'a live same-pid winner collapses its dead resume-rekey row',
  );
  assert.deepEqual(
    dedupeNativeSessions([row('newer', { alive: true }), row('older', { alive: true })]).map((entry) => entry.session_id),
    ['newer'],
    'two live same-pid rows preserve the caller-selected first row',
  );
  assert.deepEqual(
    dedupeNativeSessions([row('newer', { alive: false }), row('older', { alive: false })]).map((entry) => entry.session_id),
    ['newer'],
    'two dead same-pid rows collapse to the first row',
  );
  assert.deepEqual(
    dedupeNativeSessions([
      row('project-a', { alive: true, project_id: 'project-a', name: 'shared-name' }),
      row('project-b', { alive: true, project_id: 'project-b', name: 'shared-name' }),
    ]).map((entry) => entry.session_id),
    ['project-a', 'project-b'],
    'same-named rows from different projects remain visible',
  );
  console.log('native session deduplication invariant passed');
}

async function assertNativeSessionDiscovery() {
  const fixture = path.join(tmp, 'native-sessions');
  const home = path.join(fixture, 'home');
  const golemHome = path.join(fixture, 'golem-home');
  const bin = path.join(fixture, 'bin');
  const projectA = path.join(fixture, 'project-a');
  const projectB = path.join(fixture, 'project-b');
  const agentsFile = path.join(fixture, 'agents.json');
  for (const dir of [home, golemHome, bin, projectA, projectB, path.join(home, '.claude', 'sessions')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  write(path.join(projectA, 'AGENTS.md'), '# project a\n');
  write(path.join(projectB, 'AGENTS.md'), '# project b\n');
  const fakeClaude = path.join(bin, 'claude');
  write(fakeClaude, `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.env.FAKE_CLAUDE_AGENTS));\n`);
  fs.chmodSync(fakeClaude, 0o755);

  const liveProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(liveProcess.pid, 'live fixture process spawned');
  try {
    const now = Date.now();
    const orderIndependentPid = 2_147_483_646;
    fs.writeFileSync(agentsFile, JSON.stringify([
      { sessionId: 'cc_order_dead', pid: orderIndependentPid, cwd: projectB, name: 'order-independent-rekey', status: 'idle', startedAt: now + 1000 },
      { sessionId: 'cc_order_live', pid: orderIndependentPid, cwd: projectB, name: 'order-independent-rekey', status: 'idle', startedAt: now - 1000 },
      { sessionId: 'cc_live', pid: liveProcess.pid, cwd: projectA, name: 'dead-live', status: 'idle', startedAt: now },
      { sessionId: 'cc_dead', pid: 2147483647, cwd: projectA, name: 'dead-live', status: 'idle', startedAt: now - 1000 },
      { sessionId: 'cc_resume_new', pid: liveProcess.pid, cwd: projectA, name: 'resume-rekey', status: 'idle', startedAt: now },
    ]));
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${liveProcess.pid}.json`), JSON.stringify({
      sessionId: 'cc_resume_old', pid: liveProcess.pid, cwd: projectA, name: 'resume-rekey',
      status: 'idle', startedAt: now - 1000, updatedAt: now - 1000,
    }));

    const fresh = new Date(now).toISOString();
    const opencodeRows = [
      ['oc_cross_a', projectA, 'cross-project'],
      ['oc_cross_b', projectB, 'cross-project'],
      ['oc_same_a', projectA, 'same-project-live'],
      ['oc_same_b', projectA, 'same-project-live'],
      ['oc_fallback', projectA, 'bridge-less'],
      ['oc_no_channel', projectA, 'no-channel'],
    ];
    fs.writeFileSync(path.join(golemHome, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: opencodeRows.map(([session_id, project_path, name]) => ({
        session_id, project_path, name, harness: 'opencode', status: 'idle',
        boot_time: fresh, last_seen_at: fresh,
      })),
    }));
    fs.writeFileSync(path.join(golemHome, 'channels.json'), JSON.stringify({
      version: 1,
      channels: opencodeRows
        .filter(([sessionId]) => sessionId !== 'oc_no_channel')
        .map(([session_id]) => ({ session_id, pid: liveProcess.pid, harness: 'opencode' })),
    }));

    process.env.HOME = home;
    process.env.GOLEM_HOME = golemHome;
    process.env.FAKE_CLAUDE_AGENTS = agentsFile;
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    const { readNativeSessions } = await import(`../dashboard/server/native-sessions.js?t=${Date.now()}`);
    const originalKill = process.kill;
    let orderIndependentChecks = 0;
    process.kill = (pid, signal) => {
      if (Number(pid) === orderIndependentPid) {
        orderIndependentChecks += 1;
        if (orderIndependentChecks === 1) {
          const error = new Error('synthetic dead pid');
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }
      return originalKill.call(process, pid, signal);
    };
    let sessions;
    try {
      sessions = await readNativeSessions(() => true);
    } finally {
      process.kill = originalKill;
    }

    const crossProject = sessions.filter((row) => row.name === 'cross-project');
    assert.equal(crossProject.length, 2, 'same-named live sessions in different projects both surface');
    assert.equal(new Set(crossProject.map((row) => row.project_id)).size, 2, 'cross-project rows retain distinct project ids');
    assert.equal(sessions.filter((row) => row.name === 'dead-live').length, 1, 'dead same-project name collision collapses to live row');
    assert.equal(sessions.filter((row) => row.name === 'same-project-live').length, 2, 'same-project live name collisions both surface');
    assert.equal(sessions.filter((row) => row.name === 'resume-rekey').length, 1, 'same-pid Claude resume rows collapse');
    // This live row must survive even with native-sessions.js's out.sort call
    // deleted: its dead same-pid twin is deliberately first in source order.
    assert.equal(sessions.find((row) => row.session_id === 'cc_order_live')?.alive, true, 'dead-first same-pid collapse never hides the live row');
    assert.equal(sessions.find((row) => row.session_id === 'oc_fallback')?.alive, true, 'live channel and fresh registry survive a missing bridge');
    assert.equal(sessions.some((row) => row.session_id === 'oc_no_channel'), false, 'missing bridge and channel do not resurrect a session');
    console.log('native session discovery journey passed');
  } finally {
    liveProcess.kill();
  }
}

async function assertTrackerContextOmitsBootRoster() {
  const fixture = path.join(tmp, 'tracker-context-no-roster');
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  fs.mkdirSync(project, { recursive: true });
  write(path.join(project, 'CLAUDE.md'), '# tracker context fixture\\n');
  write(path.join(home, 'projects.json'), JSON.stringify({ projects: [{ id: 'fixture-project', path: project }] }));
  write(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [
    { session_id: 'late-peer', project_id: 'fixture-project', project_path: project, status: 'idle', name: 'late-peer' },
  ] }));
  write(path.join(home, 'channels.json'), JSON.stringify({ channels: [{ session_id: 'late-peer', pid: process.pid }] }));
  const runHook = (extraEnv = {}) => spawnSync('bash', [path.join(repo, 'substrate', 'hooks', 'tracker-context.sh')], {
    cwd: project, env: { ...process.env, GOLEM_HOME: home, HOME: home, ...extraEnv },
    input: JSON.stringify({ cwd: project }), encoding: 'utf8',
  });
  const first = runHook();
  assert.equal(first.status, 0, 'tracker context hook should be fail-open: ' + first.stderr);
  const context = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(context, /Team on |Roster is informational|late-peer/, 'boot context must not carry a live session pool');
  assert.equal(typeof context, 'string', 'stable context remains a string even when optional sources are absent');

  fs.writeFileSync(path.join(home, 'tracker.db'), crypto.randomBytes(4096));
  const corrupt = runHook();
  assert.equal(corrupt.status, 0, 'corrupt tracker.db must not break session start');
  assert.doesNotMatch(JSON.parse(corrupt.stdout).hookSpecificOutput.additionalContext, /Team on |late-peer/, 'corrupt db does not reintroduce roster');
  console.log('tracker context omits the boot roster');
}

try {
  assertFails('role-parity', (root, home) => {
    write(path.join(home, 'roles', 'index.json'), JSON.stringify({ version: 1, roles: [{ name: 'manager' }, { name: 'planner' }, { name: 'builder' }, { name: 'explorer' }, { name: 'ghost' }] }));
  }, /registered role ghost has no substrate role card/);

  assertFails('bad-reference', (root) => {
    write(path.join(root, 'instructions', 'AGENTS.md'), 'Use golem:not-a-skill.\n');
  }, /golem:not-a-skill does not resolve/);

  assertFails('bad-card', (root) => {
    write(path.join(root, 'roles', 'builder.md'), '# Role: builder\nMission: Build.\nLoad: \n');
  }, /missing required field Load|Load field is empty/);

  // The Roles table is the single source of role ownership; losing it, or losing a row, must fail
  // rather than silently orphan every card and role skill that points at it.
  assertFails('missing-roles-section', (root) => {
    write(path.join(root, 'instructions', 'AGENTS.md'), 'Use golem:tracker.\n');
  }, /has no "## Roles" section/);

  assertFails('role-missing-table-row', (root) => {
    const partial = FIXTURE_ROLES.filter((r) => r !== 'explorer');
    write(path.join(root, 'instructions', 'AGENTS.md'), `Use golem:tracker.\n\n${rolesTable(partial)}\n`);
  }, /registered role explorer has no row in the Roles table/);

  // Routing now lives largely in skill-to-skill pointers, so a dangling ref inside a skill must
  // fail, not merely warn.
  assertFails('bad-skill-reference', (root) => {
    write(path.join(root, 'skills', 'extra', 'SKILL.md'), '---\nname: extra\ndescription: Extra fixture skill used to verify orphan warnings.\n---\n# extra\nSee golem:not-a-skill.\n');
  }, /golem:not-a-skill does not resolve/);

  assertFails('bad-description', (root) => {
    write(path.join(root, 'skills', 'tracker', 'SKILL.md'), `---\nname: tracker\ndescription: ${Array.from({ length: 46 }, (_, i) => `word${i}`).join(' ')}\n---\n# tracker\n`);
  }, /description is 46 words/);

  // Migration guard. Ownership used to be duplicated across the role card, the role skill,
  // AGENTS.md, and regexes in the linter — four copies that drifted. Cards now carry the
  // Load pointer only (missions live in AGENTS.md § Roles), so a card in the legacy
  // Leads-with/Boundaries/Hand-offs shape must fail rather than be silently accepted.
  const oldCardsRoot = seedFixture('legacy-card-format');
  const oldCardsHome = path.join(tmp, 'legacy-card-format', 'home');
  write(path.join(oldCardsRoot, 'roles', 'lead.md'), '# Role: lead\nMission: Turn ideas into executable work.\nLeads with: golem:tracker\nBoundaries: never dispatch build tickets.\nHand-offs: hand off clearly.\n');
  const oldCards = lintSubstrate({ substrateRoot: oldCardsRoot, home: oldCardsHome });
  assert.equal(oldCards.ok, false, 'legacy card format should fail');
  const oldMessages = oldCards.issues.map((i) => `${i.file}:${i.line} ${i.message}`).join('\n');
  assert.match(oldMessages, /roles\/lead\.md:1 role card missing required field Load/);
  console.log('legacy card format: failed as expected');

  const cleanRoot = seedFixture('clean-warn');
  const cleanHome = path.join(tmp, 'clean-warn', 'home');
  const clean = lintSubstrate({ substrateRoot: cleanRoot, home: cleanHome });
  assert.equal(clean.ok, true);
  assert.ok(clean.warnings.some((w) => /skill extra is not referenced/.test(w.message)), 'orphan skill warns');
  const cleanRender = renderSync(cleanRoot, cleanHome);
  assert.equal(cleanRender.status, 0, `clean fixture render should pass: ${cleanRender.stderr || cleanRender.stdout}`);
  const cleanSync = runSync(cleanRoot, cleanHome);
  assert.equal(cleanSync.status, 0, `clean fixture check should pass: ${cleanSync.stderr || cleanSync.stdout}`);
  assert.match(`${cleanSync.stdout}\n${cleanSync.stderr}`, /WARN skills\/extra\/SKILL.md/);
  assert.doesNotMatch(`${cleanSync.stdout}\n${cleanSync.stderr}`, /substrate lint failed/);
  console.log('clean fixture: sync passed; orphan skill warned without failing');

  const repairHome = path.join(tmp, 'repair-home');
  const repairRoot = path.join(tmp, 'repair-project');
  fs.mkdirSync(repairRoot, { recursive: true });
  write(path.join(repairRoot, 'CLAUDE.md'), '# repair project\n');
  const env = { ...process.env, GOLEM_HOME: repairHome, HOME: repairHome, GOLEM_CLI: cli };
  spawnSync(process.execPath, [cli, 'sync', '--target', 'cc'], { cwd: repo, env, encoding: 'utf8' });
  const rendered = path.join(repairHome, '.claude', 'CLAUDE.md');
  assert.ok(fs.existsSync(rendered), 'global render exists before stale test');
  fs.writeFileSync(rendered, 'stale\n');
  const hook = spawnSync('bash', [path.join(repo, 'substrate', 'hooks', 'session-register.sh')], {
    cwd: repairRoot,
    env,
    input: JSON.stringify({ session_id: 'repair-test', cwd: repairRoot, harness: 'claudecode' }),
    encoding: 'utf8',
  });
  assert.equal(hook.status, 0, 'SessionStart hook is fail-open');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && fs.readFileSync(rendered, 'utf8') === 'stale\n') {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.notEqual(fs.readFileSync(rendered, 'utf8'), 'stale\n', 'detached global repair restored stale render');
  console.log('global freshness repair: restored stale render');

  await assertTrackerContextOmitsBootRoster();
  await assertOrphanDirectoryPruning();
  await assertShippedHookBundlesAreRunnable();
  await assertPiWorkerSurfacesAreExplicit();
  await assertPiRolePersistenceBoundary();
  await assertProjectCwdResolution();
  await assertPayloadBudgetAndRefusal();
  assertNativeSessionDeduplication();
  await assertNativeSessionDiscovery();
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* detached repair may still be closing files */ }
}

console.log('sync enforcement journey passed');
