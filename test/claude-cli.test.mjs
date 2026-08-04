import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Native CLI journey for the thin Claude Code launcher. A fake executable
// proves the public wrapper contract at the process boundary without opening an
// authenticated session or mocking the wrapper's implementation.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const channelFlag = '--dangerously-load-development-channels';
const channel = 'plugin:golem@golem-workspace';

function run(args, { cwd = repo, env = process.env } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-claude-cli-'));
try {
  const baseEnv = {
    ...process.env,
    GOLEM_HOME: path.join(temp, 'state'),
  };
  const globalHelp = run(['help'], { env: baseEnv });
  assert.equal(globalHelp.status, 0, globalHelp.stderr);
  assert.match(globalHelp.stdout, /claude\|cc \[--backend native\|ollama\] \[--model <id>\]/);

  const wrapperHelp = run(['claude', '--help'], { env: baseEnv });
  assert.equal(wrapperHelp.status, 0, wrapperHelp.stderr);
  assert.match(wrapperHelp.stdout, /Usage: golem claude \[--backend native\|ollama\] \[--model <id>\]/);
  assert.match(wrapperHelp.stdout, new RegExp(`${channelFlag} ${channel}`));
  assert.match(wrapperHelp.stdout, /golem claude -- --help/);

  const bin = path.join(temp, 'bin');
  const project = path.join(temp, 'project');
  const capture = path.join(temp, 'claude-argv.txt');
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf '%s\\n' "$PWD" > "$GOLEM_CLAUDE_CAPTURE"
printf '%s\\n' "$@" >> "$GOLEM_CLAUDE_CAPTURE"
if [ "\${GOLEM_FAKE_CLAUDE_TERM:-0}" = "1" ]; then
  kill -TERM "$$"
fi
exit "\${GOLEM_FAKE_CLAUDE_EXIT:-0}"
`, { mode: 0o700 });

  const env = {
    ...baseEnv,
    GOLEM_CLAUDE_CAPTURE: capture,
    PATH: bin,
  };

  const launched = run([
    'claude',
    '--',
    '--model',
    'claude-sonnet',
    'prompt with spaces',
  ], { cwd: project, env });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), [
    fs.realpathSync(project),
    channelFlag,
    channel,
    '--model',
    'claude-sonnet',
    'prompt with spaces',
  ]);

  fs.rmSync(capture);
  const nativeModel = run(['cc', '--model', 'claude-opus', '--', '--verbose'], { cwd: project, env });
  assert.equal(nativeModel.status, 0, nativeModel.stderr);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), [
    fs.realpathSync(project),
    channelFlag,
    channel,
    '--model',
    'claude-opus',
    '--verbose',
  ]);

  const ollamaCapture = path.join(temp, 'ollama-argv.txt');
  fs.writeFileSync(path.join(bin, 'ollama'), `#!/bin/sh
printf '%s\\n' "$PWD" > "$GOLEM_OLLAMA_CAPTURE"
printf '%s\\n' "$@" >> "$GOLEM_OLLAMA_CAPTURE"
exit "\${GOLEM_FAKE_OLLAMA_EXIT:-0}"
`, { mode: 0o700 });
  const ollamaEnv = { ...env, GOLEM_OLLAMA_CAPTURE: ollamaCapture };
  const ollamaLaunch = run([
    'claude', '--backend', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud', '--', '--verbose',
  ], { cwd: project, env: ollamaEnv });
  assert.equal(ollamaLaunch.status, 0, ollamaLaunch.stderr);
  assert.deepEqual(fs.readFileSync(ollamaCapture, 'utf8').trim().split('\n'), [
    fs.realpathSync(project),
    'launch',
    'claude',
    '--model',
    'deepseek-v4-flash:0731-cloud',
    '--',
    channelFlag,
    channel,
    '--verbose',
  ]);

  const invalidBackend = run(['claude', '--backend', 'not-real'], { cwd: project, env });
  assert.equal(invalidBackend.status, 2, invalidBackend.stderr);
  assert.match(invalidBackend.stderr, /unknown backend 'not-real'/);

  for (const missingValue of [
    ['--backend'],
    ['--backend', '--model', 'deepseek-v4-flash:0731-cloud'],
    ['--model'],
    ['--model', '--verbose'],
    ['--model', '-h'],
  ]) {
    const rejectedValue = run(['claude', ...missingValue], { cwd: project, env });
    assert.equal(rejectedValue.status, 2, rejectedValue.stderr);
    assert.match(rejectedValue.stderr, /requires a value for --(?:backend|model)/);
  }

  fs.rmSync(capture);
  const rejected = run([
    'claude',
    `${channelFlag}=plugin:other@example`,
  ], { cwd: project, env });
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.match(rejected.stderr, /golem claude owns --dangerously-load-development-channels/);
  assert.equal(fs.existsSync(capture), false, 'reserved channel override must fail before spawn');

  const nativeFailure = run(['claude', '--verbose'], {
    cwd: project,
    env: { ...env, GOLEM_FAKE_CLAUDE_EXIT: '7' },
  });
  assert.equal(nativeFailure.status, 7, nativeFailure.stderr);

  const nativeSignal = run(['claude'], {
    cwd: project,
    env: { ...env, GOLEM_FAKE_CLAUDE_TERM: '1' },
  });
  assert.equal(nativeSignal.status, null, nativeSignal.stderr);
  assert.equal(nativeSignal.signal, 'SIGTERM', nativeSignal.stderr);

  const missing = run(['claude'], {
    cwd: project,
    env: { ...baseEnv, PATH: path.join(temp, 'empty-bin') },
  });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /'claude' executable was not found on PATH/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Claude CLI journey passed: native/Ollama backend selection, model forwarding, cc alias, push channel injection, exact passthrough, reserved ownership, exit propagation, and diagnostics.');
