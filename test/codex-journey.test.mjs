import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-'));
const home = path.join(temp, 'home');
const state = path.join(temp, 'state');
const env = { ...process.env, HOME: home, GOLEM_HOME: state, XDG_CONFIG_HOME: path.join(temp, 'xdg') };
try {
  execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'sync', '--target', 'codex'], { cwd: repo, env });
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'render must not mutate user Codex state');
  const root = path.join(state, 'renders', 'codex');
  const plugin = path.join(root, 'plugins', 'golem');
  const caps = JSON.parse(fs.readFileSync(path.join(plugin, 'capabilities.json')));
  assert.deepEqual(caps.delivery, ['pull', 'next_turn']);
  assert.equal(caps.push_delivery, false);
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json'))).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStop', 'Stop']);
  const payload = { session_id: 'codex-test', cwd: repo, hook_event_name: 'SessionStart', source: 'resume', model: 'test' };
  execFileSync(process.execPath, [path.join(plugin, 'hooks/hook.mjs'), 'session-start'], { env, input: JSON.stringify(payload) });
  const fact = JSON.parse(fs.readFileSync(path.join(state, 'session-facts.json'))).facts[0];
  assert.equal(fact.canonical_id, 'codex-test');
  assert.deepEqual(fact.delivery, { mode: 'next_turn', push: false });
  const native = spawnSync('codex', ['--version'], { env, encoding: 'utf8' });
  if (native.status === 0) {
    const added = spawnSync('codex', ['plugin', 'marketplace', 'add', root], { env, encoding: 'utf8' });
    assert.equal(added.status, 0, `native marketplace validation failed: ${added.stderr || added.stdout}`);
    const listed = spawnSync('codex', ['plugin', 'marketplace', 'list'], { env, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /golem-workspace|golem-codex-/);
    console.log(`codex native present: ${native.stdout.trim()}; marketplace accepted`);
  } else console.log('codex native absent: structural journey only');
  console.log('codex temp-home journey passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
