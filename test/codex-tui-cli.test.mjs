import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GOL-477 CLI contract: the interactive bridge has a no-flag entry point,
// exposes only its two wrapper options, and cannot be bypassed with a caller
// supplied remote endpoint.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');

function run(args, env = process.env) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', env });
}

const help = run(['codex', '--help']);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage: golem codex \[--session <canonical-id>\] \[--cwd <dir>\]/);
assert.match(help.stdout, /With no flags it uses the current directory/i);
assert.match(help.stdout, /All other Codex arguments are passed through/i);

const globalHelp = run(['help']);
assert.equal(globalHelp.status, 0, globalHelp.stderr);
assert.match(globalHelp.stdout, /codex \[--session <canonical-id>\] \[--cwd <dir>\]/);

for (const args of [
  ['codex', '--remote', 'unix:///tmp/not-golem.sock'],
  ['codex', '--remote=unix:///tmp/not-golem.sock'],
  ['codex', '--remote-auth-token-env', 'TOKEN'],
  ['codex', '--', '--remote', 'unix:///tmp/not-golem.sock'],
  ['codex', '-C', '/tmp/not-golem-cwd'],
  ['codex', '--cd=/tmp/not-golem-cwd'],
  ['codex', '--', '-C/tmp/not-golem-cwd'],
]) {
  const rejected = run(args);
  assert.equal(rejected.status, 2, `${args.join(' ')}: ${rejected.stderr}`);
  assert.match(rejected.stderr, /private Unix socket|owns --remote|does not accept remote authentication|owns the working directory/i);
}

// The real CLI invocation is covered without opening a terminal: the wrapper
// forwards contract/schema/App Server calls to the pinned binary, then records
// only the final TUI launch argv and exits. This proves an explicit canonical
// id with a persisted thread launches native remote `codex resume <thread>`
// rather than quietly replacing the tracker mapping with a new thread.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-tui-cli-'));
try {
  const bin = path.join(temp, 'bin');
  const state = path.join(temp, 'state');
  const capture = path.join(temp, 'tui-argv.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const realCodex = spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realCodex, 'installed Codex binary is required for the managed-TUI CLI journey');
  const wrapper = path.join(bin, 'codex');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "app-server" ] || [ "$1" = "--version" ]; then
  exec "$GOLEM_REAL_CODEX" "$@"
fi
printf '%s\\n' "$@" > "$GOLEM_CAPTURE"
`, { mode: 0o700 });
  fs.writeFileSync(path.join(state, 'codex-supervisors.json'), JSON.stringify({
    version: 1,
    supervisors: [{
      schema: 1,
      canonical_id: 'resume-canonical',
      thread_id: 'thread-persisted-by-earlier-tui',
      health: { state: 'stopped', delivery_ready: false },
      turn: { state: 'idle', turn_id: null },
      inbox: { schema: 2, delivery_cursor: 0, in_flight_envelope_id: null, last_accepted_envelope_id: null, last_completed_envelope_id: null, deliveries: [] },
    }],
  }, null, 2));
  const resumed = run(['codex', '--session', 'resume-canonical', '--', '--model', 'test-model'], {
    ...process.env,
    GOLEM_HOME: state,
    XDG_CONFIG_HOME: path.join(temp, 'xdg'),
    GOLEM_CAPTURE: capture,
    GOLEM_REAL_CODEX: realCodex,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  const argv = fs.readFileSync(capture, 'utf8').trim().split('\n');
  assert.match(argv[1], /^unix:\/\//, `expected a private Unix remote, got ${JSON.stringify(argv)}`);
  assert.deepEqual(argv.slice(2), ['resume', 'thread-persisted-by-earlier-tui', '--model', 'test-model']);
  const stored = JSON.parse(fs.readFileSync(path.join(state, 'codex-supervisors.json'), 'utf8'));
  assert.equal(stored.supervisors[0].thread_id, 'thread-persisted-by-earlier-tui', 'CLI cleanup preserves the stored mapping until native TUI resume binds it');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

console.log('GOL-477 Codex TUI CLI contract passed: native stored-thread resume, no-flag entry point, and reserved transport/cwd ownership.');
