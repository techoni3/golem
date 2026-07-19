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

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = path.join(repo, 'test', 'fixtures', 'parity', 'v5', 'legacy-projections.json');
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
    id: 'J4-cross-harness-delivery',
    journey: 'J4',
    regression: 'real dashboard/SQLite/MCP delivery crosses readiness or ownership seams',
    command: ['test/cross-harness-matrix.test.mjs'],
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
  assert.equal(manifest.schema_version, 'golem-legacy-parity/v5');
  assert.deepEqual(manifest.capabilities.map((row) => row.id), expectedCapabilityIds,
    'the corrected GOL-13 inventory has one ordered row per confirmed capability');
  for (const capability of manifest.capabilities) {
    for (const field of ['current_owner', 'target_owner', 'user_outcome', 'evidence_journey', 'regression', 'status', 'cutover_gate']) {
      assert.ok(capability[field], `${capability.id} names ${field}`);
    }
  }
  assert.equal(fixture.schema_version, 'golem-parity-fixture/v5');
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
  return fixtureBytes;
}

function runScenario(scenario, temporaryHome) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, scenario.command, {
      cwd: repo,
      env: {
        ...process.env,
        GOLEM_HOME: temporaryHome,
        HOME: temporaryHome,
        XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      },
      stdio: 'inherit',
    });
    child.once('error', (error) => resolve({ scenario, code: 1, error }));
    child.once('exit', (code, signal) => resolve({ scenario, code: code ?? 1, signal }));
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

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-legacy-baseline-'));
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
  }
  if (failures.length) {
    console.error(`legacy parity baseline failed: ${failures.map(({ scenario }) => scenario.id).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`legacy parity baseline passed (${results.length} real-boundary scenarios)`);
  }
} finally {
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
