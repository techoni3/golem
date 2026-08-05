import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-native-'));
const env = {
  ...process.env,
  HOME: path.join(temp, 'home'),
  GOLEM_HOME: path.join(temp, 'state'),
  XDG_CONFIG_HOME: path.join(temp, 'xdg'),
  PI_CODING_AGENT_DIR: path.join(temp, 'pi-profile'),
  PI_CODING_AGENT_SESSION_DIR: path.join(temp, 'pi-sessions'),
  PI_OFFLINE: '1',
};
fs.mkdirSync(env.GOLEM_HOME, { recursive: true });
fs.writeFileSync(path.join(env.GOLEM_HOME, 'dashboard.json'), JSON.stringify({ url: 'http://127.0.0.1:1' }));
process.env.GOLEM_HOME = env.GOLEM_HOME;
process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(message);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function createHarness(extension, sessionId, { reason = 'startup', previousSessionFile } = {}) {
  const handlers = new Map();
  const sent = [];
  let idle = true;
  let pending = false;
  let aborted = false;
  let shutdown = false;
  let name = 'pi-native-test';
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(text) { sent.push(text); },
  };
  extension(pi);
  const ctx = {
    cwd: repo,
    mode: 'tui',
    model: { provider: 'ollama', id: 'deepseek-v4-flash:0731-cloud' },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort: () => { aborted = true; idle = true; },
    shutdown: () => { shutdown = true; },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(temp, `${sessionId}.jsonl`),
      getSessionName: () => name,
      getLeafId: () => `leaf-${sent.length}`,
    },
  };
  const emit = async (event, payload = {}) => {
    let result;
    for (const handler of handlers.get(event) || []) {
      const next = await handler(payload, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  return {
    pi, ctx, sent, emit,
    setIdle(value) { idle = value; },
    setPending(value) { pending = value; },
    setName(value) { name = value; },
    get aborted() { return aborted; },
    get shutdown() { return shutdown; },
    start: () => emit('session_start', { reason, previousSessionFile }),
  };
}

function typedEnvelope(sessionId, id, content, kind = 'brief', attempt = `attempt-${id}`) {
  const now = Date.now();
  return {
    protocol_version: 1,
    envelope_id: id,
    target_session_id: sessionId,
    sender_session_id: 'sender-test',
    kind,
    content,
    attempt_id: attempt,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
  };
}

async function postLease(lease, envelope) {
  return fetch(`http://${lease.host}:${lease.port}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': 'dashboard',
      'x-golem-target-session': lease.canonical_id,
      'x-golem-endpoint-owner': lease.owner_token,
    },
    body: JSON.stringify(envelope),
  });
}

async function main() {
  execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'sync', '--target', 'pi'], { cwd: repo, env });
  const render = path.join(env.GOLEM_HOME, 'renders', 'pi');
  const caps = readJson(path.join(render, 'capabilities.json'));
  assert.equal(caps.tier, 'B', 'delivery alone does not prematurely promote Pi');
  assert.equal(caps.push_delivery, true);
  assert.deepEqual(caps.delivery, ['typed-worker', 'next_turn_migration']);
  assert.equal(fs.existsSync(path.join(env.HOME, '.pi')), false, 'sync does not mutate Pi profile');
  for (const required of ['pi-native-adapter.js', 'typed-worker-endpoint.js', 'typed-delivery-tombstones.js', 'project-id.js']) {
    assert.ok(fs.existsSync(path.join(render, 'lib', required)), `Pi render ships ${required}`);
  }

  const executable = path.join(render, 'golem.mjs');
  fs.copyFileSync(path.join(render, 'golem.ts'), executable);
  const extension = (await import(`${pathToFileURL(executable).href}?t=${Date.now()}`)).default;
  const sessionId = 'pi-native-session';
  const harness = createHarness(extension, sessionId);
  await harness.start();
  let lease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === sessionId);
  assert.equal(lease.kind, 'typed-worker');
  assert.equal(lease.delivery_ready, true);

  const legacyRoot = path.join(env.GOLEM_HOME, 'pi-inbox', sessionId);
  fs.mkdirSync(path.join(legacyRoot, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'pending', 'legacy.json'), JSON.stringify({ text: 'legacy already-published work' }));
  const migrated = await harness.emit('input', { source: 'interactive', text: 'human turn' });
  assert.match(migrated.text, /legacy already-published work/);
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  assert.ok(fs.existsSync(path.join(legacyRoot, 'acks', 'legacy.json')), 'migration pickup acknowledges only at observable agent_start');
  harness.setIdle(true);
  await harness.emit('agent_settled', {});

  // The first publish reserves synchronously. A second pre-agent publish cannot
  // overtake it even though the mocked Pi context still reports idle.
  const firstPromise = postLease(lease, typedEnvelope(sessionId, 'first', 'first native turn'));
  await waitFor(() => harness.sent.length === 1, 'first native sendUserMessage was not invoked');
  const secondBusy = await postLease(lease, typedEnvelope(sessionId, 'second', 'must wait'));
  assert.equal(secondBusy.status, 409);
  assert.equal(harness.sent.length, 1);
  await harness.emit('input', { source: 'extension', text: 'first native turn' });
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  const firstResponse = await firstPromise;
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.accepted, true);
  assert.equal(firstBody.delivery_state, 'accepted');
  assert.equal(firstBody.accepted_attempt_id, 'attempt-first');
  const activeBusy = await postLease(lease, typedEnvelope(sessionId, 'second', 'must still wait', 'brief', 'attempt-second-a'));
  assert.equal(activeBusy.status, 409);
  harness.setIdle(true);
  await harness.emit('agent_settled', {});

  // Terminal duplicate returns the immutable first disposition and never calls
  // Pi twice. Then the queued second logical envelope can start.
  const duplicate = await postLease(lease, typedEnvelope(sessionId, 'first', 'first native turn', 'brief', 'attempt-first-retry'));
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(harness.sent.length, 1);
  const secondPromise = postLease(lease, typedEnvelope(sessionId, 'second', 'second native turn', 'brief', 'attempt-second-b'));
  await waitFor(() => harness.sent.length === 2, 'second native sendUserMessage was not invoked');
  await harness.emit('input', { source: 'extension', text: 'second native turn' });
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  assert.equal((await (await secondPromise).json()).accepted, true);

  // Busy interrupt is accepted through the control path, aborts Pi, and makes
  // the accepted work terminal rather than replaying it.
  const interrupt = await postLease(lease, typedEnvelope(sessionId, 'interrupt-control', 'stop', 'interrupt'));
  assert.equal((await interrupt.json()).accepted, true);
  assert.equal(harness.aborted, true);
  const delivery = readJson(path.join(env.GOLEM_HOME, 'pi-workers', sessionId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'second');
  assert.equal(delivery.lifecycle_state, 'interrupted');

  const halt = await postLease(lease, typedEnvelope(sessionId, 'halt-control', 'halt', 'halt'));
  assert.equal((await halt.json()).accepted, true);
  assert.equal(harness.shutdown, true);
  await harness.emit('session_shutdown', { reason: 'reload' });
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.some((row) => row.owner_token === lease.owner_token), false);

  // Reload keeps canonical identity but receives a new endpoint lease. Fork is
  // a distinct canonical worker with previous-session lineage in its fact.
  const resumed = createHarness(extension, sessionId, { reason: 'reload' });
  await resumed.start();
  lease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === sessionId);
  assert.ok(lease && lease.owner_token);
  const forked = createHarness(extension, 'pi-native-fork', { reason: 'fork', previousSessionFile: path.join(temp, `${sessionId}.jsonl`) });
  await forked.start();
  const facts = readJson(path.join(env.GOLEM_HOME, 'session-facts.json')).facts;
  assert.equal(facts.filter((fact) => fact.canonical_id === sessionId).length, 1);
  assert.equal(facts.find((fact) => fact.canonical_id === sessionId).provider, 'ollama');
  assert.equal(facts.find((fact) => fact.canonical_id === sessionId).model, 'deepseek-v4-flash:0731-cloud');
  assert.equal(facts.find((fact) => fact.canonical_id === sessionId).trust, 'host-full-trust');
  assert.equal(facts.find((fact) => fact.canonical_id === 'pi-native-fork').observations.previous_session_file, path.join(temp, `${sessionId}.jsonl`));
  await resumed.emit('session_shutdown', { reason: 'quit' });
  await forked.emit('session_shutdown', { reason: 'quit' });

  // Crash before correlated agent_start releases the exact claim for replay.
  const preCrashId = 'pi-preaccept-crash';
  const preCrash = createHarness(extension, preCrashId);
  await preCrash.start();
  let preCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preCrashId);
  const preCrashResponse = postLease(preCrashLease, typedEnvelope(preCrashId, 'precrash', 'retry after preaccept crash', 'brief', 'pre-attempt-a'));
  await waitFor(() => preCrash.sent.length === 1, 'pre-crash injection did not start');
  await preCrash.emit('session_shutdown', { reason: 'quit' });
  assert.equal((await preCrashResponse).status, 503);
  const preCrashRestart = createHarness(extension, preCrashId, { reason: 'resume' });
  await preCrashRestart.start();
  preCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preCrashId);
  const preRetry = postLease(preCrashLease, typedEnvelope(preCrashId, 'precrash', 'retry after preaccept crash', 'brief', 'pre-attempt-b'));
  await waitFor(() => preCrashRestart.sent.length === 1, 'pre-crash retry did not inject');
  preCrashRestart.setIdle(false);
  await preCrashRestart.emit('agent_start', {});
  assert.equal((await (await preRetry).json()).accepted_attempt_id, 'pre-attempt-b');
  preCrashRestart.setIdle(true);
  await preCrashRestart.emit('agent_settled', {});
  await preCrashRestart.emit('session_shutdown', { reason: 'quit' });

  // Crash after acceptance freezes the first attempt as recovery-required. A
  // retry gets that original disposition and never injects a second Pi turn.
  const postCrashId = 'pi-postaccept-crash';
  const postCrash = createHarness(extension, postCrashId);
  await postCrash.start();
  let postCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === postCrashId);
  const postStart = postLease(postCrashLease, typedEnvelope(postCrashId, 'postcrash', 'must not replay after acceptance', 'brief', 'post-attempt-a'));
  await waitFor(() => postCrash.sent.length === 1, 'post-crash injection did not start');
  postCrash.setIdle(false);
  await postCrash.emit('agent_start', {});
  assert.equal((await (await postStart).json()).accepted, true);
  await postCrash.emit('session_shutdown', { reason: 'quit' });
  const postCrashRestart = createHarness(extension, postCrashId, { reason: 'resume' });
  await postCrashRestart.start();
  postCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === postCrashId);
  assert.equal(postCrashLease.delivery_ready, false);
  const postRetry = await postLease(postCrashLease, typedEnvelope(postCrashId, 'postcrash', 'must not replay after acceptance', 'brief', 'post-attempt-b'));
  const postRetryBody = await postRetry.json();
  assert.equal(postRetryBody.delivery_state, 'recovery_required');
  assert.equal(postRetryBody.accepted_attempt_id, 'post-attempt-a');
  assert.equal(postCrashRestart.sent.length, 0);
  await postCrashRestart.emit('session_shutdown', { reason: 'quit' });

  const journal = fs.readFileSync(path.join(env.GOLEM_HOME, 'journals', projectIdFor(repo), 'hook.jsonl'), 'utf8');
  assert.match(journal, /"event":"agent_start"/);
  assert.doesNotMatch(journal, /owner_token|api.key|authorization/i, 'journal contains no endpoint/auth secrets');

  // Native Pi binary proof: load the shipped extension in isolated RPC mode,
  // observe its real session_start lease/fact, then terminate and observe lease
  // cleanup. No provider call or user profile is needed.
  const nativeId = crypto.randomUUID();
  const native = spawn('pi', [
    '--mode', 'rpc', '--offline', '--no-approve', '--session-id', nativeId,
    '--session-dir', env.PI_CODING_AGENT_SESSION_DIR, '-e', path.join(render, 'golem.ts'),
  ], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let nativeErr = '';
  native.stderr.on('data', (chunk) => { nativeErr += chunk; });
  await waitFor(() => readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json'))?.leases?.find((row) => row.canonical_id === nativeId), `native Pi did not register typed lease: ${nativeErr}`, 20_000);
  native.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`native Pi did not exit: ${nativeErr}`)), 10_000);
    native.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  await waitFor(() => !readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json'))?.leases?.some((row) => row.canonical_id === nativeId), 'native Pi did not release endpoint lease');
  assert.equal(fs.existsSync(path.join(env.HOME, '.pi')), false, 'native isolated Pi did not write the normal profile');

  console.log('Pi native typed-worker journey passed: FIFO reservation, correlated acceptance, settlement, controls, pre/post-acceptance crash recovery, reload/fork identity, facts/journal, and real Pi lease lifecycle');
}

try {
  await main();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
