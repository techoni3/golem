import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

function fakeNpm(version) {
  const root = mkdtempSync(join(tmpdir(), 'golem-stack-certification-test-'));
  const file = join(root, 'npm');
  const childPidFile = join(root, 'install-child.pid');
  writeFileSync(file, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nconst { writeFileSync } = require('node:fs');\nif (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(version)} + '\\n'); else { const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)']); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid)); setInterval(() => {}, 1000); }\n`);
  chmodSync(file, 0o755);
  return { root, file, childPidFile };
}

test('the stack certification refuses to certify an ineligible Node/npm pair', () => {
  const fake = fakeNpm('0.0.0');
  try {
    const result = spawnSync(process.execPath, [runner, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, STACK_CERTIFICATION_NPM_COMMAND: fake.file },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema_version, 1);
    assert.equal(report.overall, 'FAIL');
    assert.equal(result.status, 1);
    assert.equal(report.rows.length, 9);
    for (const row of report.rows) {
      assert.equal(row.status, 'FAIL');
      assert.match(row.evidence, /requires Node >=24\.18\.0 <25 and npm 11\.16\.0/);
    }
    assert.deepEqual(report.platform_matrix.map((row) => row.arch), ['arm64', 'x64']);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('the install timeout emits structured failure rows and terminates its process group', async () => {
  const fake = fakeNpm('11.16.0');
  try {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [runner, '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STACK_CERTIFICATION_NPM_COMMAND: fake.file,
        STACK_CERTIFICATION_TEST_INSTALL_TIMEOUT_MS: '50',
        STACK_CERTIFICATION_TEST_KILL_GRACE_MS: '25',
      },
    });
    const elapsedMs = Date.now() - startedAt;
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.ok(elapsedMs < 2_000, `timeout guard took ${elapsedMs}ms`);
    assert.equal(report.rows.length, 9);
    for (const row of report.rows) {
      assert.equal(row.status, 'FAIL');
      assert.equal(row.details?.timed_out, true);
      assert.equal(row.details?.timeout_ms, 50);
      assert.equal(row.details?.kill_grace_ms, 25);
    }
    const childPid = Number(readFileSync(fake.childPidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});
