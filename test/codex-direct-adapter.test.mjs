import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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

function runHookConcurrently(plugin, env, event, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(plugin, 'hooks', 'hook.mjs'), event], {
      cwd: repositoryRoot,
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`Codex hook ${event} exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

function revisionOf(signal) {
  return Number(signal.deduplication_key.split(':')[3]);
}

test('direct Codex codec and installed hook preserve canonical lifecycle/pull truth', async () => {
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
    // A post-terminal start without a native resume declaration remains
    // terminal; only the documented SessionStart source resumes a generation.
    runHook(plugin, env, 'session-start', payload);
    runHook(plugin, env, 'session-start', { ...payload, source: 'resume' });
    await Promise.all(Array.from({ length: 10 }, (_, index) => runHookConcurrently(
      plugin,
      env,
      index % 2 === 0 ? 'user-prompt' : 'tool-pre',
      payload,
    )));

    const lifecycle = JSON.parse(fs.readFileSync(path.join(golemHome, 'codex-lifecycle.json'), 'utf8'));
    const records = Object.values(lifecycle.sessions);
    assert.equal(records.length, 1);
    const record = records[0];
    const generationOne = codexIdentity({ projectPath: project, rawSessionId: 'codex-native-thread-1' });
    const generationTwo = codexIdentity({ projectPath: project, rawSessionId: 'codex-native-thread-1', generationOrdinal: 2 });
    assert.equal(record.project_id, generationOne.projectId, 'rendered hook and typed direct adapter share the project algorithm');
    assert.equal(record.session_id, generationOne.sessionId, 'rendered hook and typed direct adapter share the session algorithm');
    assert.equal(record.generation_id, generationTwo.generationId, 'rendered hook and typed direct adapter share the generation algorithm');
    assert.equal(record.state, 'active');
    assert.equal(record.generation_ordinal, 2, 'documented native resume creates exactly one successor generation');
    assert.equal(record.revision, 15, 'all lifecycle callbacks allocate one monotonic revision under the lifecycle lock');
    assert.equal(record.resumed_from_generation_id, generationOne.generationId);
    assert.deepEqual(record.aliases, { native_conversation: 'thread-native-1' }, 'resume retains the canonical native alias');
    assert.equal(record.generations.length, 2);
    assert.deepEqual(record.generations.map((generation) => ({
      generation_id: generation.generation_id,
      ordinal: generation.ordinal,
      state: generation.state,
    })), [
      { generation_id: generationOne.generationId, ordinal: 1, state: 'ended' },
      { generation_id: generationTwo.generationId, ordinal: 2, state: 'active' },
    ]);

    const pending = fs.readdirSync(path.join(golemHome, 'inbox', 'pending')).filter((name) => name.endsWith('.json'));
    assert.equal(pending.length, 16, 'project, terminal/resume lineage, and all concurrent callbacks are durable');
    const signals = pending.map((name) => JSON.parse(fs.readFileSync(path.join(golemHome, 'inbox', 'pending', name), 'utf8')));
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.started').length, 1);
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.resumed').length, 1);
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.activity').length, 11);
    assert.equal(signals.filter((signal) => signal.event_kind === 'session.ended').length, 2, 'terminal restart is represented as terminal, never resumed');
    const resumed = signals.find((signal) => signal.event_kind === 'session.resumed');
    assert.deepEqual(resumed.payload, {
      kind: 'session.resumed',
      generation: {
        project_id: generationTwo.projectId,
        session_id: generationTwo.sessionId,
        generation_id: generationTwo.generationId,
      },
      resumed_from_generation_id: generationOne.generationId,
    });
    const sessionSignals = signals.filter((signal) => signal.payload.generation);
    assert.equal(new Set(sessionSignals.map((signal) => signal.payload.generation.generation_id)).size, 2);
    assert.equal(new Set(sessionSignals.map((signal) => signal.payload.generation.session_id)).size, 1);
    const successorRevisions = sessionSignals
      .filter((signal) => signal.payload.generation.generation_id === generationTwo.generationId)
      .map(revisionOf)
      .sort((left, right) => left - right);
    assert.deepEqual(successorRevisions, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'concurrent callbacks neither duplicate nor lose successor events');
    assert.equal(new Set(sessionSignals.map((signal) => signal.event_id)).size, sessionSignals.length, 'concurrent callbacks publish distinct canonical events');
    assert.equal(signals.some((signal) => JSON.stringify(signal).includes('ghp-abcdef123456')), false, 'prompt and token data are absent from canonical envelopes');
    assert.equal(signals.some((signal) => JSON.stringify(signal).includes('thread-native-1')), false, 'native aliases are not copied into unbounded runtime payloads');

    const facts = JSON.parse(fs.readFileSync(path.join(golemHome, 'session-facts.json'), 'utf8')).facts;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].status, 'active');
    assert.ok(facts[0].canonical_project_id?.startsWith('prj_'));
    assert.equal(facts[0].delivery.push, false);
    assert.deepEqual(facts[0].aliases, { native_conversation: 'thread-native-1' });

    const direct = codexRuntimeSignal({ identity: generationOne, event: 'user-prompt', revision: 9, model: 'gpt-direct', observedAt: '2026-07-21T00:00:00.000Z' });
    assert.equal(direct.event_kind, 'session.activity');
    assert.equal(direct.payload.kind, 'session.activity');
    const typedResume = codexRuntimeSignal({
      identity: generationOne,
      event: 'session-start',
      revision: 5,
      resumed: true,
      resumedFromGenerationId: generationOne.generationId,
      generationOrdinal: 2,
      observedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.deepEqual(typedResume.payload, resumed.payload, 'typed and rendered resume shapes share canonical generation lineage');
    assert.equal(codexDirectCapability.pushDelivery, false);
    assert.deepEqual(codexDirectCapability.delivery, ['pull']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
