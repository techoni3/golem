#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertNormalizationContract,
  compareParityProjection,
  stableProjectionJson,
} from './normalization.mjs';
import { assertCredentialFreeChildEnv, isolatedChildEnv } from './isolated-env.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = path.join(repo, 'test', 'fixtures', 'parity', 'v6', 'legacy-projections.json');
const manifestPath = path.join(repo, 'docs', 'architecture', 'parity-manifest.json');

const scenarios = [
  {
    id: 'J1-render-and-discovery',
    journey: 'J1',
    regression: 'generated render or temporary-home discovery regresses',
    command: ['test/sync-enforcement.test.mjs'],
  },
  {
    id: 'J2-session-facts',
    journey: 'J2',
    regression: 'resumed identity, lease expiry, or malformed-registry safety regresses',
    command: ['test/session-facts.test.mjs'],
  },
  {
    id: 'J4-local-control-boundary',
    journey: 'J4',
    regression: 'credential-free local dashboard/SQLite/REST/WebSocket/MCP dispatch crosses an ownership seam',
    command: ['test/parity/local-control-boundary.mjs'],
  },
];

const expectedCapabilityIds = [
  'dashboard-lifecycle',
  'managed-codex',
  'ordinary-codex',
  'claude-plugin-render',
  'claude-channel',
  'opencode-bridge',
  'pi-next-turn',
  'project-discovery',
  'session-facts',
  'journal-and-spool',
  'tracker',
  'dispatch-and-envelopes',
  'bus-and-passive-deltas',
  'roles-gates-ideas-diagnostics',
  'launcher-and-compatibility-aliases',
];

function usage() {
  console.log('Usage: npm run test:legacy-baseline [-- --list]');
}

function verifyArtifacts() {
  const fixtureBytes = fs.readFileSync(fixturePath);
  const fixture = JSON.parse(fixtureBytes);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schema_version, 'golem-legacy-parity/v6');
  assert.deepEqual(manifest.capabilities.map((row) => row.id), expectedCapabilityIds,
    'the corrected GOL-13 inventory has one ordered row per confirmed capability');
  for (const capability of manifest.capabilities) {
    for (const field of ['current_owner', 'target_owner', 'user_outcome', 'evidence_journey', 'regression', 'status', 'cutover_gate']) {
      assert.ok(capability[field], `${capability.id} names ${field}`);
    }
  }
  assert.equal(manifest.capabilities.find((row) => row.id === 'managed-codex')?.current_owner,
    'lib/codex-supervisor.js + lib/codex-tui-bridge.js + lib/codex-app-server-contract.js',
    'the managed Codex row names its installed-contract owner');
  assert.equal(fixture.schema_version, 'golem-parity-fixture/v6');
  assert.equal(stableProjectionJson(fixture.projections), stableProjectionJson(fixture.projections), 'sanitized fixture is deterministic');
  assert.equal(fs.readFileSync(fixturePath).compare(fixtureBytes), 0, 'fixture validation never rewrites a golden');
  assertNormalizationContract();
  const parity = compareParityProjection(
    { readiness: 'pull_only', queue: ['first', 'second'] },
    { readiness: 'pull_only', queue: ['first', 'second'] },
  );
  assert.equal(parity.equal, true, 'future comparator accepts equivalent projections');
  assert.equal(compareParityProjection({ readiness: 'pull_only' }, { readiness: 'ready' }).equal, false,
    'future comparator keeps readiness distinctions meaningful');
  const contracts = manifest.corrected_parity_contracts;
  assert.deepEqual(contracts.ui_post_routes.comment_dispatch, {
    route: 'POST /api/comments/:cid/dispatch',
    callers: ['dashboard/web/src/api.js:244', 'dashboard/web/src/components/ticket-drawer.jsx:479'],
    preserve: ['comment-and-parent-ticket resolution', 'spec-only guard', 'assigned-or-fallback target resolution', 'enqueue before delivery', 'subscription-covered or direct delivery/error result', 'duplicate/idempotency cutover coverage'],
  });
  assert.deepEqual(contracts.ui_post_routes.unacked_dismissal, {
    route: 'POST /api/tickets/:id/unacked/:deliveryEventId/dismiss',
    callers: ['dashboard/web/src/api.js:254-255', 'dashboard/web/src/components/communication-drawer.jsx:113'],
    preserve: ['human dashboard actor default', 'dismissUnackedDispatchWarning settlement', 'ticket-updated invalidation', 'native-sessions-update invalidation', 'communication-health-updated invalidation', 'REST/WebSocket/health requery'],
  });
  assert.equal(contracts.managed_codex.current_owner, 'lib/codex-supervisor.js + lib/codex-tui-bridge.js + lib/codex-app-server-contract.js');
  assert.deepEqual(contracts.managed_codex.installed_contract, {
    package: 'codex-cli',
    version: '0.144.5',
    schema_leaf_count: 30,
    schema_fingerprint: '8fea722bf38d19e54265e4650f36e9329bac40d334c1c287d12bb6d21c8eac71',
    verification: 'verifyCodexAppServerContract before supervisor spawn',
  });
  assert.deepEqual(contracts.opencode_outside_checkout, {
    command: 'mcp/channel/index.js resolved from the installed/rendered checkout',
    node_path: '<checkout>/mcp/channel/node_modules',
    plugin: 'file://<checkout>/shims/opencode/index.js',
    lifecycle: ['install outside checkout', 'update replaces prior managed entry', 'uninstall removes managed entry', 'no stale source path', 'no duplicate plugin entry'],
  });
  assert.deepEqual(contracts.launcher_compatibility, {
    help_aliases: ['golem -h', 'golem --help', 'golem codex-supervisor -h', 'golem codex -h', 'golem sessions -h', 'golem sessions dedup -h', 'golem role -h'],
    golemx: 'compatibility path remains truthful; unsupported_custom_base_url is ineligible and never claims readiness',
  });
  const localJourneySource = fs.readFileSync(path.join(repo, 'test', 'parity', 'local-control-boundary.mjs'), 'utf8');
  for (const required of ['dashboardServer', 'channelServer', 'StdioClientTransport', 'WebSocket', 'ticket_dispatch', 'assertCredentialFreeChildEnv']) {
    assert.ok(localJourneySource.includes(required), `J4 local source contains ${required}`);
  }
  for (const forbidden of ['CodexSupervisor', 'turn/start', 'api.openai.com', 'api.anthropic.com', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'cross-harness-matrix.test.mjs']) {
    assert.equal(localJourneySource.includes(forbidden), false, `J4 local source excludes ${forbidden}`);
  }
  const isolatedEnvSource = fs.readFileSync(path.join(repo, 'test', 'parity', 'isolated-env.mjs'), 'utf8');
  assert.equal(isolatedEnvSource.includes('...process.env'), false, 'credential-free child env never copies the ambient environment');
  return fixtureBytes;
}

function appendBounded(current, chunk, limit = 12_000) {
  const next = current + String(chunk);
  return next.length <= limit ? next : `…[truncated]\n${next.slice(-limit)}`;
}

let activeChild = null;

function runScenario(scenario, temporaryHome) {
  return new Promise((resolve) => {
    const env = isolatedChildEnv({
      home: temporaryHome,
      golemHome: temporaryHome,
      xdgConfigHome: path.join(temporaryHome, '.config'),
      extra: { GOLEM_LEGACY_BASELINE: '1' },
    });
    assertCredentialFreeChildEnv(env);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      resolve({ scenario, stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawn(process.execPath, scenario.command, {
        cwd: repo,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeChild = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
      child.once('error', (error) => settle({ code: 1, error }));
      child.once('close', (code, signal) => settle({ code: code ?? 1, signal }));
    } catch (error) {
      settle({ code: 1, error });
    }
  });
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

if (process.argv.includes('--list')) {
  for (const scenario of scenarios) {
    console.log(`${scenario.id} (${scenario.journey}): node ${scenario.command.join(' ')} — ${scenario.regression}`);
  }
  process.exit(0);
}

let temporaryHome = null;
function cleanup() {
  try { activeChild?.kill('SIGTERM'); } catch { /* cleanup only */ }
  if (temporaryHome) fs.rmSync(temporaryHome, { recursive: true, force: true });
}
const onSignal = () => {
  cleanup();
  process.exit(128);
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-legacy-baseline-'));
try {
  const fixtureBytes = verifyArtifacts();
  console.log('legacy parity baseline: using isolated temporary GOLEM_HOME');
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, temporaryHome));
  assert.equal(fs.readFileSync(fixturePath).compare(fixtureBytes), 0, 'baseline run leaves fixtures unchanged');

  const failures = results.filter(({ code }) => code !== 0);
  for (const result of results) {
    const outcome = result.code === 0 ? 'PASS' : 'FAIL';
    console.log(`${outcome} ${result.scenario.id} exit=${result.code}${result.signal ? ` signal=${result.signal}` : ''}`);
    if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    if (result.code !== 0) {
      const detail = result.error?.message || result.stderr || '(no child stderr)';
      console.error(`${result.scenario.id} current failure evidence:\n${detail}`);
    }
  }
  if (failures.length) {
    console.error(`legacy parity baseline failed: ${failures.map(({ scenario }) => scenario.id).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`legacy parity baseline passed (${results.length} real-boundary scenarios)`);
  }
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  cleanup();
}
