import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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
  assert.equal(execFileSync('pi', ['--version'], { env, encoding: 'utf8' }).trim(), '0.80.10', 'native proof is pinned to the surveyed Pi version');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines.node, '>=22.19', 'root runtime supports stable node:sqlite');
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

  // Any native input reserves the pre-agent gap before Pi reports itself busy.
  await harness.emit('input', { source: 'interactive', text: 'local turn' });
  const localBusy = await postLease(lease, typedEnvelope(sessionId, 'local-race', 'must not overtake local input'));
  assert.equal(localBusy.status, 409);
  harness.setIdle(false);
  await harness.emit('agent_start', {});
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
  const interruptPromise = postLease(lease, typedEnvelope(sessionId, 'interrupt-control', 'stop', 'interrupt'));
  await waitFor(() => harness.aborted, 'Pi abort was not requested');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', sessionId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'second').lifecycle_state, 'accepted', 'control does not report terminal before Pi settles');
  harness.setIdle(true);
  await harness.emit('agent_settled', {});
  const interrupt = await interruptPromise;
  assert.equal((await interrupt.json()).accepted, true);
  assert.equal(harness.aborted, true);
  const delivery = readJson(path.join(env.GOLEM_HOME, 'pi-workers', sessionId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'second');
  assert.equal(delivery.lifecycle_state, 'interrupted');

  const halt = await postLease(lease, typedEnvelope(sessionId, 'halt-control', 'halt', 'halt'));
  assert.equal((await halt.json()).accepted, true);
  await waitFor(() => harness.shutdown, 'halt did not shut down after its response boundary');
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
  await preCrashRestart.emit('input', { source: 'extension', text: 'retry after preaccept crash' });
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
  await postCrash.emit('input', { source: 'extension', text: 'must not replay after acceptance' });
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

  // Pi's generic agent_start is not evidence for a typed turn unless the
  // exact extension input was observed first. An unrelated RPC turn releases
  // the claim so the dashboard can safely retry it.
  const displacedId = 'pi-displaced-typed-input';
  const displaced = createHarness(extension, displacedId);
  await displaced.start();
  const displacedLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === displacedId);
  const displacedStart = postLease(displacedLease, typedEnvelope(displacedId, 'displaced', 'typed input awaiting correlation'));
  await waitFor(() => displaced.sent.length === 1, 'displaced typed input was not injected');
  await displaced.emit('input', { source: 'rpc', text: 'unrelated native turn' });
  displaced.setIdle(false);
  await displaced.emit('agent_start', {});
  const displacedResponse = await displacedStart;
  const displacedBody = await displacedResponse.json();
  assert.equal(displacedBody.delivery_state, 'recovery_required');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', displacedId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'displaced').lifecycle_state, 'recovery_required');
  displaced.setIdle(true);
  await displaced.emit('agent_settled', {});
  await displaced.emit('session_shutdown', { reason: 'quit' });

  // An earlier async Pi input extension can delay Golem's own input observer
  // after fire-and-forget sendUserMessage. Control in that window must retain
  // the claim until the native start/settlement boundary, never permit replay.
  const preInputId = 'pi-post-send-pre-input-control';
  const preInput = createHarness(extension, preInputId);
  await preInput.start();
  const preInputLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preInputId);
  const preInputStart = postLease(preInputLease, typedEnvelope(preInputId, 'pre-input', 'delayed by earlier input extension'));
  await waitFor(() => preInput.sent.length === 1, 'pre-input typed injection did not begin');
  let preInputControlDone = false;
  const preInputInterrupt = postLease(preInputLease, typedEnvelope(preInputId, 'pre-input-interrupt', 'stop delayed preflight', 'interrupt'))
    .then((response) => { preInputControlDone = true; return response; });
  await waitFor(() => preInput.aborted, 'pre-input control did not request abort');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', preInputId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'pre-input').lifecycle_state, 'claimed');

  // An unrelated input may win the first agent_start. Its settlement must not
  // falsely complete the control while the original typed preflight remains.
  await preInput.emit('input', { source: 'rpc', text: 'unrelated turn wins first start' });
  preInput.setIdle(false);
  await preInput.emit('agent_start', {});
  const preInputStartBody = await (await preInputStart).json();
  assert.equal(preInputStartBody.delivery_state, 'recovery_required');
  // The exact typed input can emerge while the unrelated turn is still
  // active, then pause before its own agent_start. Unrelated settlement still
  // must not consume the typed control waiter.
  await preInput.emit('input', { source: 'extension', text: 'delayed by earlier input extension' });
  preInput.setIdle(true);
  await preInput.emit('agent_settled', {});
  await sleep(25);
  assert.equal(preInputControlDone, false, 'unrelated settlement cannot complete typed control');

  preInput.setIdle(false);
  await preInput.emit('agent_start', {});
  preInput.setIdle(true);
  await preInput.emit('agent_settled', {});
  assert.equal((await (await preInputInterrupt).json()).accepted, true);
  const preInputRetry = await postLease(preInputLease, typedEnvelope(preInputId, 'pre-input', 'delayed by earlier input extension', 'brief', 'pre-input-retry'));
  assert.equal((await preInputRetry.json()).duplicate, true);
  assert.equal(preInput.sent.length, 1, 'post-send/pre-input control never permits a second native injection');
  await preInput.emit('session_shutdown', { reason: 'quit' });

  // Once Pi has emitted the exact extension input, interrupt cannot release
  // the claim: Pi 0.80.10 may still continue its idle auth/compaction preflight.
  // Hold the claim, re-abort at agent_start, and make retries duplicates.
  const preflightId = 'pi-correlated-preflight-control';
  const preflight = createHarness(extension, preflightId);
  await preflight.start();
  const preflightLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preflightId);
  const preflightStart = postLease(preflightLease, typedEnvelope(preflightId, 'preflight', 'correlated preflight turn'));
  await waitFor(() => preflight.sent.length === 1, 'preflight typed input was not injected');
  await preflight.emit('input', { source: 'extension', text: 'correlated preflight turn' });
  const preflightInterrupt = postLease(preflightLease, typedEnvelope(preflightId, 'preflight-interrupt', 'stop preflight', 'interrupt'));
  await waitFor(() => preflight.aborted, 'preflight control did not request abort');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', preflightId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'preflight').lifecycle_state, 'claimed');
  preflight.setIdle(false);
  await preflight.emit('agent_start', {});
  assert.equal((await (await preflightStart).json()).accepted, true);
  preflight.setIdle(true);
  await preflight.emit('agent_settled', {});
  assert.equal((await (await preflightInterrupt).json()).accepted, true);
  const preflightRetry = await postLease(preflightLease, typedEnvelope(preflightId, 'preflight', 'correlated preflight turn', 'brief', 'preflight-retry'));
  assert.equal((await preflightRetry.json()).duplicate, true);
  assert.equal(preflight.sent.length, 1, 'preflight retry never injects a second Pi prompt');
  await preflight.emit('session_shutdown', { reason: 'quit' });

  const journal = fs.readFileSync(path.join(env.GOLEM_HOME, 'journals', projectIdFor(repo), 'hook.jsonl'), 'utf8');
  assert.match(journal, /"event":"agent_start"/);
  assert.doesNotMatch(journal, /owner_token|api.key|authorization/i, 'journal contains no endpoint/auth secrets');

  // Native Pi binary proof: a local OpenAI-compatible provider holds the real
  // Pi turn open while typed delivery proves correlated acceptance, FIFO, and
  // abort settlement through Pi's actual extension events.
  let providerRequests = 0;
  const providerServer = http.createServer((request, response) => {
    providerRequests += 1;
    request.resume();
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      id: 'pi-native-proof', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`);
    const timer = setTimeout(() => {
      response.write(`data: ${JSON.stringify({
        id: 'pi-native-proof', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model',
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    }, 30_000);
    timer.unref?.();
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress !== 'string');
  const providerExtension = path.join(temp, 'pi-test-provider.ts');
  fs.writeFileSync(providerExtension, `export default function (pi) {
  pi.registerProvider('golem-test', {
    baseUrl: 'http://127.0.0.1:${providerAddress.port}/v1',
    apiKey: 'test-key',
    api: 'openai-completions',
    models: [{
      id: 'test-model', name: 'Golem native proof', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000, maxTokens: 256
    }]
  });
}\n`);
  const nativeId = crypto.randomUUID();
  const nativeEnv = { ...env };
  delete nativeEnv.PI_OFFLINE;
  const native = spawn('pi', [
    '--mode', 'rpc', '--no-approve', '--session-id', nativeId,
    '--session-dir', env.PI_CODING_AGENT_SESSION_DIR,
    '--provider', 'golem-test', '--model', 'test-model',
    '-e', providerExtension, '-e', path.join(render, 'golem.ts'),
  ], { cwd: repo, env: nativeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let nativeErr = '';
  let nativeOut = '';
  native.stderr.on('data', (chunk) => { nativeErr += chunk; });
  native.stdout.on('data', (chunk) => { nativeOut += chunk; });
  try {
    const nativeLease = await waitFor(() => readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json'))?.leases?.find((row) => row.canonical_id === nativeId), `native Pi did not register typed lease: ${nativeErr}`, 20_000);
    const nativeStart = await postLease(nativeLease, typedEnvelope(nativeId, 'native-first', 'hold this real Pi turn open', 'brief', 'native-attempt-a'));
    const nativeStartBody = await nativeStart.json();
    assert.equal(nativeStartBody.accepted, true, `native Pi rejected typed delivery: ${JSON.stringify(nativeStartBody)} ${nativeErr}`);
    assert.equal(nativeStartBody.delivery_state, 'accepted');
    await waitFor(() => providerRequests === 1, `native Pi did not call the isolated provider: ${nativeErr}`);

    const nativeBusy = await postLease(nativeLease, typedEnvelope(nativeId, 'native-second', 'must remain FIFO'));
    assert.equal(nativeBusy.status, 409, 'real Pi process rejects a second turn while native work is active');
    const nativeInterrupt = await postLease(nativeLease, typedEnvelope(nativeId, 'native-interrupt', 'abort real Pi', 'interrupt'));
    assert.equal((await nativeInterrupt.json()).accepted, true, `native interrupt did not observe settlement: ${nativeErr}`);
    const nativeRecord = readJson(path.join(env.GOLEM_HOME, 'pi-workers', nativeId, 'delivery.json'));
    assert.equal(nativeRecord.inbox.deliveries.find((row) => row.envelope_id === 'native-first').lifecycle_state, 'interrupted');
    const nativeJournal = fs.readFileSync(path.join(env.GOLEM_HOME, 'journals', projectIdFor(repo), 'hook.jsonl'), 'utf8');
    assert.match(nativeJournal, new RegExp(`"event":"agent_start","session_id":"${nativeId}"`));
    assert.match(nativeJournal, new RegExp(`"event":"agent_settled","session_id":"${nativeId}"`));
  } finally {
    native.kill('SIGTERM');
    await new Promise((resolve) => {
      if (native.exitCode !== null) return resolve();
      const timeout = setTimeout(() => { native.kill('SIGKILL'); resolve(); }, 10_000);
      native.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    providerServer.closeAllConnections?.();
    await new Promise((resolve) => providerServer.close(resolve));
  }
  assert.doesNotMatch(nativeOut, /"success":false/, `native Pi RPC reported failure: ${nativeOut}`);
  await waitFor(() => !readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json'))?.leases?.some((row) => row.canonical_id === nativeId), 'native Pi did not release endpoint lease');
  assert.equal(fs.existsSync(path.join(env.HOME, '.pi')), false, 'native isolated Pi did not write the normal profile');

  console.log('Pi native typed-worker journey passed: FIFO reservation, correlated acceptance, settlement, controls, pre/post-acceptance crash recovery, reload/fork identity, facts/journal, and real Pi typed delivery');
}

try {
  await main();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
