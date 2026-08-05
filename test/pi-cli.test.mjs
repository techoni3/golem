#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-cli-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const normalProfile = path.join(temp, 'home', '.pi');
const capture = path.join(temp, 'pi-launch.json');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(normalProfile, { recursive: true });
fs.writeFileSync(path.join(normalProfile, 'sentinel'), 'human profile\n');

const fakePi = path.join(bin, 'pi');
fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write((process.env.GOLEM_FAKE_PI_VERSION || '0.80.10') + '\\n');
  process.exit(0);
}
fs.writeFileSync(process.env.GOLEM_PI_CAPTURE, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2),
  profile: process.env.PI_CODING_AGENT_DIR,
  sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
  requested_provider: process.env.GOLEM_PI_REQUESTED_PROVIDER,
  requested_model: process.env.GOLEM_PI_REQUESTED_MODEL,
  launch_nonce: process.env.GOLEM_PI_LAUNCH_NONCE,
  pi_version: process.env.GOLEM_PI_VERSION,
  extension_version: process.env.GOLEM_PI_EXTENSION_VERSION,
}, null, 2));
if (process.env.GOLEM_FAKE_PI_TERM === '1') process.kill(process.pid, 'SIGTERM');
process.exit(Number(process.env.GOLEM_FAKE_PI_EXIT || 0));
`, { mode: 0o700 });

const baseEnv = {
  ...process.env,
  HOME: path.join(temp, 'home'),
  GOLEM_HOME: state,
  XDG_CONFIG_HOME: path.join(temp, 'xdg'),
  PATH: bin,
  GOLEM_PI_CAPTURE: capture,
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
};
function run(args, env = baseEnv) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8' });
}

try {
  const help = run(['pi', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /golem pi \[--provider <id> --model <id>\]/);
  assert.match(help.stdout, /Pi 0\.80\.10/);

  const launched = run([
    'pi', '--provider', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud',
    '--resume', 'native-session-id', '--', '--thinking', 'high', 'prompt with spaces',
  ]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stderr, /dashboard unavailable.*degraded mode/);
  const record = JSON.parse(fs.readFileSync(capture, 'utf8'));
  const extension = path.join(state, 'renders', 'pi', 'golem.ts');
  assert.deepEqual(record.args, [
    '--no-extensions', '--extension', extension,
    '--provider', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud',
    '--session', 'native-session-id', '--thinking', 'high', 'prompt with spaces',
  ]);
  assert.equal(record.cwd, fs.realpathSync(project));
  assert.equal(record.profile, path.join(state, 'pi-agent'));
  assert.equal(record.sessions, path.join(state, 'pi-sessions'));
  assert.equal(record.requested_provider, 'ollama');
  assert.equal(record.requested_model, 'deepseek-v4-flash:0731-cloud');
  assert.equal(record.pi_version, '0.80.10');
  assert.match(record.extension_version, /^5\./);
  assert.match(record.launch_nonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readdirSync(normalProfile), ['sentinel'], 'managed launch never mutates the normal Pi profile');

  for (const args of [
    ['pi', '--provider', 'ollama'],
    ['pi', '--model', 'deepseek-v4-flash:0731-cloud'],
    ['pi', '--provider'],
    ['pi', '--resume'],
    ['pi', '--', '--session-id', 'spoofed'],
    ['pi', '--', '--session-dir', '/tmp/spoofed'],
  ]) {
    const rejected = run(args);
    assert.equal(rejected.status, 2, `${args.join(' ')}\n${rejected.stderr}`);
  }

  const unsupported = run(['pi'], { ...baseEnv, GOLEM_FAKE_PI_VERSION: '0.80.9' });
  assert.equal(unsupported.status, 1, unsupported.stderr);
  assert.match(unsupported.stderr, /supports Pi 0\.80\.10; found 0\.80\.9/);

  const missing = run(['pi'], { ...baseEnv, PATH: path.join(temp, 'missing-bin') });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /could not find the 'pi' executable/);

  const failed = run(['pi'], { ...baseEnv, GOLEM_FAKE_PI_EXIT: '17' });
  assert.equal(failed.status, 17, failed.stderr);
  const signaled = run(['pi'], { ...baseEnv, GOLEM_FAKE_PI_TERM: '1' });
  assert.equal(signaled.status, null, signaled.stderr);
  assert.equal(signaled.signal, 'SIGTERM');

  fs.writeFileSync(path.join(state, 'renders', 'pi', 'golem.ts'), '// user tamper\n');
  fs.rmSync(capture);
  const drift = run(['pi']);
  assert.equal(drift.status, 1, drift.stderr);
  assert.match(`${drift.stdout}\n${drift.stderr}`, /TAMPER.*refused to overwrite/s);
  assert.equal(fs.existsSync(capture), false, 'tampered render fails before Pi launch');

  console.log('Pi CLI journey passed: pinned compatibility, exact provider/model/resume/passthrough, isolated profile, render guard, diagnostics, and exit/signal propagation');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
