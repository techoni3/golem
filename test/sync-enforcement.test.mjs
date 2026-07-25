#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// Every role registered in lib/session-role.js needs a card AND a row in the instructions
// Roles table — that table is the single source of role ownership.
const FIXTURE_ROLES = ['manager', 'planner', 'builder', 'explorer', 'reviewer', 'standalone'];

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
  // Cards carry identity + a skill pointer only; ownership lives in instructions/AGENTS.md
  // § Roles, so no role needs card-specific content here.
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

function assertTrackerContextFiltersStaleRoster() {
  const fixture = path.join(tmp, 'tracker-context-roster');
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  fs.mkdirSync(project, { recursive: true });
  write(path.join(project, 'CLAUDE.md'), '# tracker context fixture\n');
  const liveProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(liveProcess.pid, 'live channel fixture process spawned');
  try {
    write(path.join(home, 'projects.json'), JSON.stringify({ projects: [{ id: 'fixture-project', path: project }] }));
    write(path.join(home, 'sessions.json'), JSON.stringify({
      sessions: [
        { session_id: 'stale-session', project_id: 'fixture-project', project_path: project, hook_ppid: 2147483647, status: 'idle', name: 'stale-peer' },
        { session_id: 'live-session', project_id: 'fixture-project', project_path: project, hook_ppid: 2147483647, status: 'idle', name: 'live-peer' },
      ],
    }));
    write(path.join(home, 'channels.json'), JSON.stringify({
      channels: [{ session_id: 'live-session', pid: liveProcess.pid }],
    }));
    const hook = spawnSync('bash', [path.join(repo, 'substrate', 'hooks', 'tracker-context.sh')], {
      cwd: project,
      env: { ...process.env, GOLEM_HOME: home, HOME: home },
      input: JSON.stringify({ cwd: project }),
      encoding: 'utf8',
    });
    assert.equal(hook.status, 0, `tracker context hook should be fail-open: ${hook.stderr}`);
    assert.match(hook.stdout, /live-peer/, 'live channel appears in Team roster');
    assert.doesNotMatch(hook.stdout, /stale-peer/, 'dead registry row is excluded from Team roster');
    console.log('tracker context roster filters stale sessions');
  } finally {
    liveProcess.kill();
  }
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
  // AGENTS.md, and regexes in the linter — four copies that drifted. Cards now carry
  // Mission + Load only, so a card in the legacy Leads-with/Boundaries/Hand-offs shape must
  // fail rather than be silently accepted.
  const oldCardsRoot = seedFixture('legacy-card-format');
  const oldCardsHome = path.join(tmp, 'legacy-card-format', 'home');
  write(path.join(oldCardsRoot, 'roles', 'planner.md'), '# Role: planner\nMission: Turn ideas into executable work.\nLeads with: golem:tracker\nBoundaries: never dispatch build tickets.\nHand-offs: hand off clearly.\n');
  const oldCards = lintSubstrate({ substrateRoot: oldCardsRoot, home: oldCardsHome });
  assert.equal(oldCards.ok, false, 'legacy card format should fail');
  const oldMessages = oldCards.issues.map((i) => `${i.file}:${i.line} ${i.message}`).join('\n');
  assert.match(oldMessages, /roles\/planner\.md:1 role card missing required field Load/);
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

  assertTrackerContextFiltersStaleRoster();
  assertNativeSessionDeduplication();
  await assertNativeSessionDiscovery();
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* detached repair may still be closing files */ }
}

console.log('sync enforcement journey passed');
