import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  codexDirectCapability,
  codexIdentity,
  codexRuntimeSignal,
} from '@golem/adapter-codex';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const node = process.execPath;

function runHook(plugin, env, event, payload) {
  execFileSync(node, [path.join(plugin, 'hooks', 'hook.mjs'), event], {
    cwd: repositoryRoot,
    env,
    input: JSON.stringify(payload),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('direct Codex codec and installed hook preserve canonical lifecycle/pull truth', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-direct-'));
  const project = path.join(home, 'project');
  const nested = path.join(project, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  const golemHome = path.join(home, 'golem-home');
  const env = { ...process.env, GOLEM_HOME: golemHome, HOME: path.join(home, 'user') };
  fs.mkdirSync(env.HOME, { recursive: true });
  try {
    execFileSync(node, [path.join(repositoryRoot, 'cli', 'golem.js'), 'sync', '--target', 'codex'], { cwd: repositoryRoot, env });
    const plugin = path.join(golemHome, 'renders', 'codex', 'plugins', 'golem');
    const capabilities = JSON.parse(fs.readFileSync(path.join(plugin, 'capabilities.json'), 'utf8'));
    assert.deepEqual(capabilities.delivery, ['pull']);
    assert.equal(capabilities.push_delivery, false);
    assert.equal(capabilities.control, false);
    assert.equal(capabilities.discovery, true);
    assert.equal(capabilities.readiness, 'pull_only');
    assert.equal(capabilities.delivery_qualification, 'unproven');
    assert.match(fs.readFileSync(path.join(plugin, 'hooks', 'hook.mjs'), 'utf8'), /direct-lifecycle/);
    assert.equal(fs.existsSync(path.join(plugin, 'hooks', 'direct-lifecycle.mjs')), true);
    assert.doesNotMatch(fs.readFileSync(path.join(plugin, 'hooks', 'hook.mjs'), 'utf8'), new RegExp(repositoryRoot.replaceAll('/', '[\\\\/]')));

    const payload = {
      session_id: 'codex-native-thread-1',
      cwd: nested,
      model: 'gpt-direct',
      prompt: 'Bearer ghp-abcdef123456 must never enter the lifecycle envelope',
      tool_input: { secret: 'ghp-abcdef123456' },
      thread_id: 'thread-native-1',
    };
    runHook(plugin, env, 'session-start', payload);
    runHook(plugin, env, 'user-prompt', payload);
    runHook(plugin, env, 'stop', payload);
    runHook(plugin, env, 'session-start', payload);

    const lifecycle = JSON.parse(fs.readFileSync(path.join(golemHome, 'codex-lifecycle.json'), 'utf8'));
    const records = Object.values(lifecycle.sessions);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'ended', 'terminal state survives a later native restart');
    assert.equal(records[0].generation_ordinal, 1, 'restart does not create a duplicate generation');
    assert.equal(records[0].revision, 4);

    const pending = fs.readdirSync(path.join(golemHome, 'inbox', 'pending')).filter((name) => name.endsWith('.json'));
    assert.equal(pending.length, 5, 'project start, start, activity, and both terminal callbacks are durable');
    const signals = pending.map((name) => JSON.parse(fs.readFileSync(path.join(golemHome, 'inbox', 'pending', name), 'utf8')));
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.started').length, 1);
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.activity').length, 1);
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.ended').length, 2, 'terminal restart is represented as terminal, never resumed');
    const sessionSignals = signals.filter((signal) => signal.payload.generation);
    assert.equal(new Set(sessionSignals.map((signal) => signal.payload.generation.generation_id)).size, 1);
    assert.equal(new Set(sessionSignals.map((signal) => signal.payload.generation.session_id)).size, 1);
    assert.equal(signals.some((signal) => JSON.stringify(signal).includes('ghp-abcdef123456')), false, 'prompt and token data are absent from canonical envelopes');
    assert.equal(signals.some((signal) => JSON.stringify(signal).includes('thread-native-1')), false, 'native aliases are not copied into unbounded runtime payloads');

    const facts = JSON.parse(fs.readFileSync(path.join(golemHome, 'session-facts.json'), 'utf8')).facts;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].status, 'ended');
    assert.ok(facts[0].canonical_project_id?.startsWith('prj_'));
    assert.equal(facts[0].delivery.push, false);
    assert.deepEqual(facts[0].aliases, { native_conversation: 'thread-native-1' });

    const identity = codexIdentity({ projectPath: project, rawSessionId: 'codex-native-thread-1' });
    const direct = codexRuntimeSignal({ identity, event: 'user-prompt', revision: 9, model: 'gpt-direct', observedAt: '2026-07-21T00:00:00.000Z' });
    assert.equal(direct.event_kind, 'session.activity');
    assert.equal(direct.payload.kind, 'session.activity');
    assert.equal(codexDirectCapability.pushDelivery, false);
    assert.deepEqual(codexDirectCapability.delivery, ['pull']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
