#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintSubstrate } from '../lib/substrate-lint.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli', 'golem.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-sync-enforce-'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
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
  write(path.join(root, 'roles', 'manager.md'), '# Role: manager\nMission: Own intake, routing, and closure across active work in the tracker.\nLeads with: golem:tracker\nBoundaries: never author or decompose specs; stay scoped.\nHand-offs: hand off clearly.\n');
  write(path.join(root, 'roles', 'planner.md'), '# Role: planner\nMission: Turn ambiguity into executable tracker work and hand the readiness gate to the manager.\nLeads with: golem:tracker\nBoundaries: never dispatch build tickets; stay scoped.\nHand-offs: hand off clearly.\n');
  for (const role of ['builder', 'explorer']) {
    write(path.join(root, 'roles', `${role}.md`), `# Role: ${role}\nMission: ${role} mission.\nLeads with: golem:tracker\nBoundaries: stay scoped.\nHand-offs: hand off clearly.\n`);
  }
  write(path.join(root, 'skills', 'tracker', 'SKILL.md'), '---\nname: tracker\ndescription: Track assigned work through the golem tracker.\n---\n# tracker\n');
  write(path.join(root, 'skills', 'extra', 'SKILL.md'), '---\nname: extra\ndescription: Extra fixture skill used to verify orphan warnings.\n---\n# extra\n');
  write(path.join(root, 'agents', 'worker.md'), '---\nname: worker\ndescription: worker\n---\nUse golem:tracker.\n');
  write(path.join(root, 'instructions', 'AGENTS.md'), 'Use golem:tracker.\n');
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
    fs.writeFileSync(agentsFile, JSON.stringify([
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
    const sessions = await readNativeSessions(() => true);

    const crossProject = sessions.filter((row) => row.name === 'cross-project');
    assert.equal(crossProject.length, 2, 'same-named live sessions in different projects both surface');
    assert.equal(new Set(crossProject.map((row) => row.project_id)).size, 2, 'cross-project rows retain distinct project ids');
    assert.equal(sessions.filter((row) => row.name === 'dead-live').length, 1, 'dead same-project name collision collapses to live row');
    assert.equal(sessions.filter((row) => row.name === 'same-project-live').length, 2, 'same-project live name collisions both surface');
    assert.equal(sessions.filter((row) => row.name === 'resume-rekey').length, 1, 'same-pid Claude resume rows collapse');
    assert.equal(sessions.find((row) => row.session_id === 'oc_fallback')?.alive, true, 'live channel and fresh registry survive a missing bridge');
    assert.equal(sessions.some((row) => row.session_id === 'oc_no_channel'), false, 'missing bridge and channel do not resurrect a session');
    console.log('native session discovery journey passed');
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
    write(path.join(root, 'roles', 'builder.md'), '# Role: builder\nMission: Build.\nLeads with: \nBoundaries: scoped.\n');
  }, /missing required field Hand-offs|Leads with field is empty/);

  assertFails('bad-description', (root) => {
    write(path.join(root, 'skills', 'tracker', 'SKILL.md'), `---\nname: tracker\ndescription: ${Array.from({ length: 46 }, (_, i) => `word${i}`).join(' ')}\n---\n# tracker\n`);
  }, /description is 46 words/);

  const oldCardsRoot = seedFixture('old-card-protocol');
  const oldCardsHome = path.join(tmp, 'old-card-protocol', 'home');
  write(path.join(oldCardsRoot, 'roles', 'planner.md'), '# Role: planner\nMission: Turn ideas into executable work and hand off to builders.\nLeads with: golem:tracker\nBoundaries: never own repo writes when a builder is available.\nHand-offs: hand off clearly.\n');
  write(path.join(oldCardsRoot, 'roles', 'manager.md'), '# Role: manager\nMission: Own intake, routing, and closure across active work in the tracker.\nLeads with: golem:tracker\nBoundaries: never take a builder implementation lane; stay scoped.\nHand-offs: hand off clearly.\n');
  const oldCards = lintSubstrate({ substrateRoot: oldCardsRoot, home: oldCardsHome });
  assert.equal(oldCards.ok, false, 'old card protocol fixture should fail');
  const oldMessages = oldCards.issues.map((i) => `${i.file}:${i.line} ${i.message}`).join('\n');
  assert.match(oldMessages, /roles\/planner\.md:2 planner Mission must contain "readiness gate"/);
  assert.match(oldMessages, /roles\/planner\.md:2 planner Mission must NOT contain "hand off to builders"/);
  assert.match(oldMessages, /roles\/planner\.md:4 planner Boundaries must contain "never dispatch"/);
  assert.match(oldMessages, /roles\/manager\.md:4 manager Boundaries must contain "never author or decompose specs"/);
  console.log('old card protocol: failed as expected');

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

  await assertNativeSessionDiscovery();
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* detached repair may still be closing files */ }
}

console.log('sync enforcement journey passed');
