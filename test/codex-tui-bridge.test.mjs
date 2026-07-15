import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// GOL-477 is one behavior-level journey through the real pinned App Server.
// This test uses the same Unix-WebSocket JSON-RPC transport as `codex --remote`
// so it can prove bridge behavior without putting an interactive terminal in CI.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-tui-bridge-'));
const state = path.join(temp, 'state');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
process.env.GOLEM_HOME = state;
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');

const { CodexSupervisor, readCodexSupervisor } = await import('../lib/codex-supervisor.js');
const { readSessionFacts, upsertSessionFact } = await import('../lib/session-facts.js');
const { readChannels } = await import('../dashboard/server/channels.js');
const { readNativeSessions } = await import('../dashboard/server/native-sessions.js');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function waitForTuiThreadGate(supervisor, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      supervisor.off('tui-thread-transition', onTransition);
      reject(new Error('TUI lifecycle gate was not closed before bridge forwarding'));
    }, timeoutMs);
    const onTransition = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
    supervisor.once('tui-thread-transition', onTransition);
  });
}

class RemoteTuiClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.serverRequests = [];
    this.notifications = [];
  }

  async connect() {
    // ws uses `ws+unix:///socket:/path` for the same HTTP Upgrade handshake
    // that Codex CLI performs for `--remote unix:///socket`.
    this.ws = new WebSocket(`ws+unix://${this.socketPath}:/`);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (frame) => this.receive(frame.toString('utf8')));
    this.ws.on('error', () => {});
  }

  receive(frame) {
    const message = JSON.parse(frame);
    this.messages.push(message);
    if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = this.pending.get(`${typeof message.id}:${String(message.id)}`);
      if (pending) {
        this.pending.delete(`${typeof message.id}:${String(message.id)}`);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) this.serverRequests.push(message);
    else if (message.method) this.notifications.push(message);
  }

  send(message) {
    assert.equal(this.ws.readyState, WebSocket.OPEN, 'TUI WebSocket is open');
    this.ws.send(JSON.stringify(message));
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(`number:${id}`);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(`number:${id}`, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }

  async waitForMessage(messages, predicate, label, timeoutMs = 90_000) {
    return waitFor(() => messages.find(predicate) || null, label, timeoutMs);
  }

  async close() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await Promise.race([new Promise((resolve) => this.ws.once('close', resolve)), sleep(2_000)]);
  }
}

async function assertSecondTuiRejected(socketPath) {
  const other = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise((resolve, reject) => {
    other.once('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 409);
      resolve();
    });
    other.once('error', (error) => {
      if (/Unexpected server response: 409/.test(error.message)) resolve();
      else reject(error);
    });
    other.once('open', () => reject(new Error('second TUI connected to a single-client bridge')));
  });
  other.terminate();
}

let supervisor;
let tui;
let originalThreadId = null;
let threadsDeleted = false;
try {
  supervisor = new CodexSupervisor({ canonicalId: 'codex-tui-bridge', cwd: workspace, mode: 'tui' });
  const booted = await supervisor.start();
  assert.equal(booted.mode, 'tui');
  assert.equal(booted.health.delivery_ready, false, 'no tracker delivery before the TUI binds an initialized thread');
  assert.ok(supervisor.tuiBridge.socketPath.startsWith(path.join(os.tmpdir(), 'golem-codex-tui-')));
  assert.equal(fs.statSync(path.dirname(supervisor.tuiBridge.socketPath)).mode & 0o077, 0, 'bridge directory is private to this user');

  tui = new RemoteTuiClient(supervisor.tuiBridge.socketPath);
  await tui.connect();
  await assertSecondTuiRejected(supervisor.tuiBridge.socketPath);
  assert.equal(supervisor.deliveryReady(), false, 'a connected but uninitialized TUI cannot receive tracker work');

  const initialize = await tui.request('initialize', {
    clientInfo: { name: 'golem_tui_bridge_journey', title: 'Golem TUI bridge journey', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  assert.ok(initialize.result?.userAgent, JSON.stringify(initialize));
  let releaseMcpActivation;
  const mcpActivationHeld = new Promise((resolve) => { releaseMcpActivation = resolve; });
  const activateManagedMcp = supervisor.activateManagedMcp.bind(supervisor);
  supervisor.activateManagedMcp = async (status) => {
    await mcpActivationHeld;
    return activateManagedMcp(status);
  };
  tui.notify('initialized');
  assert.equal(supervisor.deliveryReady(), false, 'MCP activation alone cannot bind a TUI thread for delivery');
  assert.equal(
    tui.messages.some((message) => typeof message.id === 'string' && message.id.startsWith('golem-bridge-')),
    false,
    'bridge-only mcpServerStatus/list responses never leak to the TUI',
  );

  const initialThreadGate = waitForTuiThreadGate(supervisor);
  const startThread = tui.request('thread/start', {
    cwd: workspace,
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
  });
  await initialThreadGate;
  assert.equal(supervisor.deliveryReady(), false, 'initial TUI thread/start synchronously closes the dispatch gate');
  assert.equal(supervisor.tuiConnection.lifecycle, 'pending');
  const started = await startThread;
  originalThreadId = started.result?.thread?.id;
  assert.ok(originalThreadId, JSON.stringify(started));
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.thread_id === originalThreadId, 'TUI thread/start canonical binding');
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.health?.delivery_ready, false, 'an idle thread remains unavailable until the delayed MCP binding completes');
  assert.equal(readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.status, 'idle', 'an idle thread is not misreported as working while MCP readiness catches up');
  releaseMcpActivation();
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.mcp?.state === 'active', 'reserved MCP status check after TUI initialized');
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.health?.delivery_ready, true, 'only an initialized TUI MCP plus an idle thread becomes dispatchable');
  await waitFor(() => readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.status === 'idle', 'MCP activation republishes the already-bound idle thread');

  const threadName = `golem:codex-tui-${Date.now()}`;
  const setName = await tui.request('thread/name/set', { threadId: originalThreadId, name: threadName });
  assert.equal(setName.error, undefined, JSON.stringify(setName));
  await tui.waitForMessage(tui.notifications, (message) => (
    message.method === 'thread/name/updated'
    && message.params?.threadId === originalThreadId
    && message.params?.threadName === threadName
  ), 'thread name update forwarded to the native TUI');
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.thread_name === threadName, 'canonical supervisor stores the native TUI thread name');
  assert.equal(readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.name, threadName, 'session fact publishes the real Codex thread name');

  // The native Codex hook observes the raw thread id in the same managed TUI.
  // The dashboard must collapse that pull-only observation behind the healthy
  // canonical supervisor instead of rendering a second phantom agent card.
  upsertSessionFact({
    canonical_id: originalThreadId,
    continuation_key: originalThreadId,
    harness: 'codex',
    locator: { raw_session_id: originalThreadId },
    project_path: workspace,
    status: 'active',
    delivery: { mode: 'pull', push: false },
  });
  const projected = await readNativeSessions(() => true, await readChannels());
  const sameActorRows = projected.filter((row) => [supervisor.canonicalId, originalThreadId].includes(row.session_id));
  assert.deepEqual(sameActorRows.map((row) => row.session_id), [supervisor.canonicalId], 'managed and raw Codex facts collapse to one canonical dashboard card');
  assert.equal(sameActorRows[0]?.name, threadName, 'canonical dashboard card uses the native Codex thread name');
  assert.equal(sameActorRows[0]?.status, 'idle', 'strict ready lease overrides a stale busy hook fact');

  supervisor.tuiBridge.receiveAppServerLine(JSON.stringify({
    method: 'thread/status/changed',
    params: { threadId: originalThreadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
  }));
  assert.equal(readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.status, 'waiting', 'App Server waiting state is projected without guessing from hook timing');
  assert.equal(readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.waiting_for, 'approval');
  supervisor.tuiBridge.receiveAppServerLine(JSON.stringify({
    method: 'thread/status/changed',
    params: { threadId: originalThreadId, status: { type: 'idle' } },
  }));
  assert.equal(readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.status, 'idle');

  // A response that arrives after the bridge timed out remains private even
  // after its pending entry has been removed. No reserved id can be a TUI id.
  const lateReservedId = `${supervisor.tuiBridge.reservedPrefix}:late-response`;
  supervisor.tuiBridge.receiveAppServerLine(JSON.stringify({ id: lateReservedId, result: { data: [] } }));
  await sleep(20);
  assert.equal(tui.messages.some((message) => message.id === lateReservedId), false, 'late reserved bridge response is consumed, never forwarded to TUI');

  // App Server server requests are passed to the TUI unchanged. This synthetic
  // frame exercises the transport boundary without asking a model to run a
  // command in the test workspace; real App Server approval routing was also
  // established by the pinned GOL-472 protocol journey.
  supervisor.tuiBridge.receiveAppServerLine(JSON.stringify({
    id: 'g477-forwarded-server-request', method: 'item/commandExecution/requestApproval',
    params: { threadId: originalThreadId, turnId: 'turn-forwarded', itemId: 'item-forwarded', command: 'touch must-not-run' },
  }));
  const forwardedRequest = await tui.waitForMessage(tui.serverRequests, (message) => message.id === 'g477-forwarded-server-request', 'server request forwarded unchanged to TUI');
  assert.equal(forwardedRequest.method, 'item/commandExecution/requestApproval');

  // Start a normal human turn, then steer it immediately. The bridge marks
  // both requests busy before forwarding, so tracker dispatch cannot enter
  // the same App Server client while Codex is processing either request.
  const humanStart = await tui.request('turn/start', {
    threadId: originalThreadId,
    cwd: workspace,
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    input: [{ type: 'text', text: 'Bridge journey: reply exactly GOL477_HUMAN_TURN. Do not call tools or edit files.' }],
  });
  const humanTurnId = humanStart.result?.turn?.id;
  assert.ok(humanTurnId, JSON.stringify(humanStart));
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.turn?.state, 'busy', 'TUI turn/start synchronously closes the tracker dispatch gate');
  await waitFor(() => readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.status === 'busy', 'App Server active turn projects working state');

  // A rejected steer must retain the previously active human turn. Exercise
  // the bridge response path with an App Server error rather than allowing a
  // late/error response to reopen tracker delivery.
  const rejectedSteerId = 477001;
  const rejectedSteerTracking = supervisor.noteTuiTurnStarted({
    requestId: `number:${rejectedSteerId}`,
    method: 'turn/steer',
    params: { threadId: originalThreadId, expectedTurnId: humanTurnId },
  });
  supervisor.tuiBridge.tuiRequests.set(`number:${rejectedSteerId}`, {
    method: 'turn/steer', params: { threadId: originalThreadId }, turn: rejectedSteerTracking,
  });
  supervisor.tuiBridge.receiveAppServerLine(JSON.stringify({
    id: rejectedSteerId, error: { code: -32000, message: 'synthetic rejected steer' },
  }));
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.turn?.state, 'busy', 'failed steer retains busy state for the prior turn');
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.turn?.turn_id, humanTurnId, 'failed steer retains the prior active turn id');

  // Parent recon established that an active turn/start can look like a new turn
  // in the response. The bridge must keep the original active id while a steer
  // is in flight and never inject tracker work into that human turn.
  const steer = tui.request('turn/steer', {
    threadId: originalThreadId,
    expectedTurnId: humanTurnId,
    input: [{ type: 'text', text: 'Keep waiting for the approval result.' }],
  }).catch(() => null);
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.turn?.tui_method === 'turn/steer', 'synchronous TUI steer busy marker');
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.turn?.turn_id, humanTurnId, 'steer cannot replace the active human turn id');
  const held = await supervisor.acceptDelivery({
    envelope_id: 'g477-held-human-turn', content: 'This must queue until the human turn is idle.', sender_session_id: 'human', target_session_id: supervisor.canonicalId,
  });
  assert.equal(held.http_status, 409, 'the supervisor never injects a dispatch while a TUI turn is active');

  const interrupted = await tui.request('turn/interrupt', { threadId: originalThreadId, turnId: humanTurnId });
  assert.equal(interrupted.error, undefined, JSON.stringify(interrupted));
  await steer;
  await tui.waitForMessage(tui.notifications, (message) => (
    message.method === 'turn/completed'
    && message.params?.threadId === originalThreadId
    && message.params?.turn?.id === humanTurnId
  ), 'interrupted human turn forwarded to TUI');
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.health?.delivery_ready === true, 'idle tracker delivery gate after human turn');
  await waitFor(() => readSessionFacts().find((row) => row.canonical_id === supervisor.canonicalId)?.status === 'idle', 'terminal turn returns the dashboard session to idle');

  const forkGate = waitForTuiThreadGate(supervisor);
  const forkRequest = tui.request('thread/fork', { threadId: originalThreadId, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
  await forkGate;
  assert.equal(supervisor.deliveryReady(), false, 'TUI fork synchronously closes the delivery gate before its response');
  assert.equal(supervisor.tuiConnection.lifecycle, 'pending');
  const forked = await forkRequest;
  const forkedThreadId = forked.result?.thread?.id;
  assert.ok(forkedThreadId, JSON.stringify(forked));
  assert.notEqual(forkedThreadId, originalThreadId, 'TUI fork produces a distinct canonical tracker thread');
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.thread_id === forkedThreadId, 'TUI thread/fork canonical binding');
  assert.equal(supervisor.deliveryReady(), true, 'successful fork restores a bound, dispatchable TUI thread');

  const failedResumeGate = waitForTuiThreadGate(supervisor);
  const failedResume = tui.request('thread/resume', { threadId: 'thread-does-not-exist', cwd: workspace, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
  await failedResumeGate;
  assert.equal(supervisor.deliveryReady(), false, 'TUI resume synchronously closes the gate while its result is unknown');
  const failedResumeResponse = await failedResume;
  assert.ok(failedResumeResponse.error, JSON.stringify(failedResumeResponse));
  assert.equal(supervisor.threadId, forkedThreadId, 'a failed lifecycle request restores the prior canonical mapping');
  await waitFor(() => supervisor.deliveryReady(), 'failed lifecycle restoration of delivery gate');

  const resumeGate = waitForTuiThreadGate(supervisor);
  const resumeRequest = tui.request('thread/resume', { threadId: forkedThreadId, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
  await resumeGate;
  assert.equal(supervisor.deliveryReady(), false, 'TUI resume keeps the old mapping non-dispatchable until the response');
  const resumed = await resumeRequest;
  assert.equal(resumed.result?.thread?.id, forkedThreadId, JSON.stringify(resumed));
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.thread_id, forkedThreadId, 'TUI thread/resume preserves canonical thread identity');

  // The tracked canonical thread is the exact one that receives a durable
  // tracker envelope. Its lifecycle notifications remain visible to the TUI.
  const request = supervisor.rpc.request.bind(supervisor.rpc);
  let dispatchedTurnStart = null;
  supervisor.rpc.request = async (method, params, ...rest) => {
    if (method === 'turn/start' && params.clientUserMessageId === 'g477-native-dispatch') dispatchedTurnStart = params;
    return request(method, params, ...rest);
  };
  const delivered = await supervisor.acceptDelivery({
    envelope_id: 'g477-native-dispatch',
    content: 'GOL-477 controlled dispatch. Reply exactly GOL477_TUI_BRIDGE_DONE. Do not call tools or edit files.',
    sender_session_id: 'human',
    target_session_id: supervisor.canonicalId,
  });
  supervisor.rpc.request = request;
  assert.equal(delivered.http_status, 202, JSON.stringify(delivered));
  assert.ok(delivered.turn_id);
  assert.equal(dispatchedTurnStart?.sandboxPolicy, undefined, 'interactive tracker dispatch inherits the TUI sandbox');
  assert.equal(dispatchedTurnStart?.approvalPolicy, undefined, 'interactive tracker dispatch inherits the TUI approval policy');
  assert.equal(dispatchedTurnStart?.approvalsReviewer, undefined, 'interactive tracker dispatch leaves approval review with the TUI');
  await tui.waitForMessage(tui.notifications, (message) => (
    message.method === 'turn/completed' && message.params?.turn?.id === delivered.turn_id
  ), 'injected tracker turn completion forwarded natively to the TUI');
  await waitFor(() => readCodexSupervisor(supervisor.canonicalId)?.inbox?.deliveries?.find((row) => row.envelope_id === delivered.envelope_id)?.state === 'completed', 'durable injected delivery completion');

  // Server-created thread broadcasts are informational (for example, a
  // subagent) and must not retarget the tracked TUI thread.
  supervisor.tuiBridge.receiveAppServerLine(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'subagent-thread-must-not-bind' } } }));
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.thread_id, forkedThreadId, 'subagent ThreadStarted cannot replace the canonical TUI thread');

  // Delete controlled test threads while the bridge is still usable, then
  // prove a real WebSocket close synchronously makes the lease non-ready
  // before asynchronous App Server/supervisor teardown completes.
  await supervisor.rpc.request('thread/delete', { threadId: originalThreadId }, 5_000).catch(() => {});
  await supervisor.rpc.request('thread/delete', { threadId: forkedThreadId }, 5_000).catch(() => {});
  threadsDeleted = true;
  await tui.close();
  await waitFor(() => !supervisor.tuiConnection.connected && !supervisor.deliveryReady(), 'TUI disconnect closes delivery gate', 5_000);
  assert.equal(readCodexSupervisor(supervisor.canonicalId)?.health?.delivery_ready, false, 'TUI disconnect synchronously updates the public lease gate');

  console.log('GOL-477 Codex TUI bridge journey passed: one private Unix TUI, TUI-owned initialize/approvals, lifecycle/disconnect gates, busy steering hold, canonical start/fork/resume, and native tracker turn forwarding.');
} finally {
  if (!threadsDeleted && supervisor?.rpc && originalThreadId && supervisor.rpc.child?.exitCode === null && supervisor.threadId !== originalThreadId) {
    await supervisor.rpc.request('thread/delete', { threadId: originalThreadId }, 5_000).catch(() => {});
  }
  if (!threadsDeleted && supervisor?.rpc && supervisor.threadId && supervisor.rpc.child?.exitCode === null) {
    await supervisor.rpc.request('thread/delete', { threadId: supervisor.threadId }, 5_000).catch(() => {});
    supervisor.threadId = null;
    supervisor.updateRecord({ thread_id: null });
  }
  await tui?.close().catch(() => {});
  await supervisor?.stop({ deleteThread: true }).catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
