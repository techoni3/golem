import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

function fakeNpm(version, { hangInstall = false, hangTypeScript = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'golem-stack-certification-test-'));
  const file = join(root, 'npm');
  const childPidFile = join(root, 'install-child.pid');
  const rowChildPidFile = join(root, 'row-child.pid');
  const hangingCompiler = `const { spawn } = require('node:child_process');\nconst { writeFileSync } = require('node:fs');\nif (process.argv.includes('--version')) { process.stdout.write('Version 7.0.2\\n'); process.exit(0); }\nconst child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)']);\nwriteFileSync(process.env.STACK_CERTIFICATION_TEST_ROW_CHILD_PID_FILE, String(child.pid));\nsetInterval(() => {}, 1000);\n`;
  const versionCompiler = (value) => `if (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(value)} + '\\n');`;
  writeFileSync(file, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nconst { mkdirSync, writeFileSync } = require('node:fs');\nconst { dirname, join } = require('node:path');\nconst write = (file, contents) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents); };\nif (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(0); }\nif (process.argv.includes('install')) {\n  if (${JSON.stringify(hangInstall)}) { const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)']); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid)); setInterval(() => {}, 1000); }\n  else {\n    if (${JSON.stringify(hangTypeScript)}) {\n      const root = process.cwd();\n      write(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ${JSON.stringify(hangingCompiler)});\n      write(join(root, 'tools', 'openapi-codegen', 'node_modules', 'typescript', 'bin', 'tsc'), ${JSON.stringify(versionCompiler('Version 5.9.3'))});\n      write(join(root, 'tools', 'openapi-codegen', 'node_modules', 'openapi-typescript', 'bin', 'cli.js'), ${JSON.stringify(versionCompiler('v7.13.0'))});\n    }\n    process.exit(0);\n  }\n} else if (process.argv.includes('ls')) {\n  process.stdout.write('stack certification peer tree\\n');\n  process.exit(0);\n} else {\n  process.exit(0);\n}\n`);
  chmodSync(file, 0o755);
  return { root, file, childPidFile, rowChildPidFile };
}

function runnerEnv(fake, extra = {}) {
  return {
    ...process.env,
    PATH: [fake.root, process.env.PATH].filter(Boolean).join(delimiter),
    TMPDIR: fake.root,
    STACK_CERTIFICATION_NPM_COMMAND: fake.file,
    ...extra,
  };
}

function remainingRunnerRoots(fake) {
  return readdirSync(fake.root).filter((name) => name.startsWith('golem-stack-certification-'));
}

async function waitForFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function assertProcessGone(pid) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('the stack certification refuses to certify an ineligible Node/npm pair', () => {
  const fake = fakeNpm('0.0.0');
  try {
    const result = spawnSync(process.execPath, [runner, '--json'], {
      encoding: 'utf8',
      env: runnerEnv(fake),
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

test('certification timeout and interrupt guards terminate process groups and clean temporary state', async () => {
  const install = fakeNpm('11.16.0', { hangInstall: true });
  try {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [runner, '--json'], {
      encoding: 'utf8',
      env: runnerEnv(install, {
        STACK_CERTIFICATION_TEST_INSTALL_TIMEOUT_MS: '50',
        STACK_CERTIFICATION_TEST_KILL_GRACE_MS: '25',
      }),
    });
    const elapsedMs = Date.now() - startedAt;
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.ok(elapsedMs < 2_000, `timeout guard took ${elapsedMs}ms`);
    assert.equal(report.rows.length, 9);
    for (const row of report.rows) {
      assert.equal(row.status, 'FAIL');
      assert.equal(row.details?.timed_out, true, JSON.stringify(row));
      assert.equal(row.details?.timeout_ms, 50);
      assert.equal(row.details?.kill_grace_ms, 25);
    }
    const childPid = Number(readFileSync(install.childPidFile, 'utf8'));
    await assertProcessGone(childPid);
    assert.deepEqual(remainingRunnerRoots(install), []);
  } finally {
    rmSync(install.root, { recursive: true, force: true });
  }

  const rowTimeout = fakeNpm('11.16.0', { hangTypeScript: true });
  try {
    const result = spawnSync(process.execPath, [runner, '--json'], {
      encoding: 'utf8',
      env: runnerEnv(rowTimeout, {
        STACK_CERTIFICATION_TEST_COMMAND_TIMEOUT_MS: '500',
        STACK_CERTIFICATION_TEST_KILL_GRACE_MS: '25',
        STACK_CERTIFICATION_TEST_ROW_CHILD_PID_FILE: rowTimeout.rowChildPidFile,
      }),
    });
    const report = JSON.parse(result.stdout);
    const typescript = report.rows.find((row) => row.id === 'typescript-7-reference-build');
    assert.equal(result.status, 1);
    assert.equal(typescript?.status, 'FAIL');
    assert.equal(typescript?.details?.timed_out, true, JSON.stringify(typescript));
    assert.equal(typescript?.details?.timeout_ms, 500);
    await waitForFile(rowTimeout.rowChildPidFile);
    await assertProcessGone(Number(readFileSync(rowTimeout.rowChildPidFile, 'utf8')));
    assert.deepEqual(remainingRunnerRoots(rowTimeout), []);
  } finally {
    rmSync(rowTimeout.root, { recursive: true, force: true });
  }

  const interrupted = fakeNpm('11.16.0', { hangTypeScript: true });
  try {
    const child = spawn(process.execPath, [runner, '--json'], {
      env: runnerEnv(interrupted, {
        STACK_CERTIFICATION_TEST_COMMAND_TIMEOUT_MS: '10000',
        STACK_CERTIFICATION_TEST_KILL_GRACE_MS: '25',
        STACK_CERTIFICATION_TEST_ROW_CHILD_PID_FILE: interrupted.rowChildPidFile,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForFile(interrupted.rowChildPidFile);
    child.kill('SIGINT');
    const { code, signal } = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(code, 130);
    assert.equal(signal, null);
    await assertProcessGone(Number(readFileSync(interrupted.rowChildPidFile, 'utf8')));
    assert.deepEqual(remainingRunnerRoots(interrupted), []);
  } finally {
    rmSync(interrupted.root, { recursive: true, force: true });
  }
});
