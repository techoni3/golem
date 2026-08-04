import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { TYPED_WORKER_PROTOCOL_VERSION } from '../lib/typed-worker-endpoint.js';

// GOL-474 is intentionally one real journey: a dashboard creates and dispatches
// a ticket, the authenticated supervisor adapter maps its durable envelope to
// one actual App Server turn, and duplicate/restarted delivery never starts a
// second turn. The direct MCP call below uses the same bound process contract
// as the App Server's required MCP child to prove actor spoofing is rejected.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-delivery-'));
const state = path.join(temp, 'state');
const dashboardDb = path.join(temp, 'tracker.db');
process.env.GOLEM_HOME = state;
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');
process.env.GOLEM_TRACKER_DB = dashboardDb;

const { CodexSupervisor, readCodexSupervisor } = await import('../lib/codex-supervisor.js');
const { readChannels } = await import('../dashboard/server/channels.js');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function unusedPort() {
  const { createServer } = await import('node:http');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

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

async function startDashboard(port) {
  let stderr = '';
  const child = spawn(process.execPath, ['dashboard/server/index.js'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GOLEM_HOME: state,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GOLEM_TRACKER_DB: dashboardDb,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, `dashboard health (${stderr})`, 15_000);
  return { child, baseUrl, stderr: () => stderr };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function dispatchBrief(ticket, note, envelopeId) {
  return `You've been assigned tracker ticket ${ticket.display_id || ticket.id}: "${ticket.title}" (project ${ticket.project_id}, kind ${ticket.kind}).\n\n`
    + `${note ? `${note}\n\n` : ''}`
    + `Load it with the golem tracker tools (ticket_get ${ticket.display_id || ticket.id}) to read the full body, acceptance criteria, and comment thread, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete. `
    + `If you have blocking questions, create a question-kind ticket in this project assigned to 'human'.\n\n`
    + `Dispatch message_id: ${envelopeId}\nAcknowledge this dispatch first with ack({ kind: 'brief', summary: '<one sentence>', envelope_id: '${envelopeId}' }).`;
}

async function typedRetry(record, payload) {
  const response = await fetch(`http://${record.health.host}:${record.health.port}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': 'dashboard',
      'x-golem-target-session': record.canonical_id,
      'x-golem-endpoint-owner': record.health.owner_token,
    },
    body: JSON.stringify({ ...payload, protocol_version: TYPED_WORKER_PROTOCOL_VERSION }),
  });
  return { response, body: await response.json() };
}

function toolText(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}

let supervisor;
let resumed;
let dashboard;
let mcpClient;
try {
  const canonicalId = 'codex-delivery-journey';
  supervisor = new CodexSupervisor({ canonicalId, cwd: repo });
  const first = await supervisor.start();
  assert.equal(first.health.delivery_ready, true, 'MCP-bound idle supervisor is delivery-ready');
  assert.equal(first.mcp?.state, 'active');
  assert.equal(first.mcp?.binding, canonicalId);

  // The App Server's MCP child must not register the generic CC/OC HTTP route.
  const channelsBeforeDashboard = await readChannels();
  assert.equal(channelsBeforeDashboard.filter((channel) => channel.session_id === canonicalId).length, 1);
  assert.equal(fs.existsSync(path.join(state, 'channels.json')), false, 'managed MCP child does not create a generic channels.json entry');

  dashboard = await startDashboard(await unusedPort());
  const dispatchable = await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/sessions/dispatchable?project=${encodeURIComponent(first.project_id)}`);
    const rows = response.ok ? await response.json() : [];
    return rows.find((row) => row.session_id === canonicalId) || null;
  }, 'managed Codex dispatchable target');
  assert.equal(dispatchable.reachable, true);

  const createdResponse = await fetch(`${dashboard.baseUrl}/api/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: first.project_id,
      kind: 'work-item',
      title: 'GOL-474 real App Server delivery journey',
      body: 'The managed Codex supervisor must receive this through a durable tracker envelope.',
      created_by: 'human',
    }),
  });
  assert.equal(createdResponse.status, 201);
  const ticket = await createdResponse.json();
  const note = 'CONTROLLED DELIVERY JOURNEY: do not edit files or call tools other than the required ack. After acknowledging, reply exactly DELIVERY_JOURNEY_DONE and stop.';
  const request = supervisor.rpc.request.bind(supervisor.rpc);
  let headlessDispatchTurnStart = null;
  supervisor.rpc.request = async (method, params, ...rest) => {
    if (method === 'turn/start' && params.clientUserMessageId) headlessDispatchTurnStart = params;
    return request(method, params, ...rest);
  };
  const dispatchedResponse = await fetch(`${dashboard.baseUrl}/api/tickets/${encodeURIComponent(ticket.id)}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: canonicalId, note, sender_id: 'human' }),
  });
  assert.equal(dispatchedResponse.status, 200);
  const dispatched = await dispatchedResponse.json();
  assert.equal(dispatched.delivered, true, JSON.stringify(dispatched));
  assert.equal(dispatched.channel?.ok, true, JSON.stringify(dispatched.channel));
  assert.ok(dispatched.envelope_id, 'dashboard response carries the durable envelope id');
  supervisor.rpc.request = request;
  assert.deepEqual(headlessDispatchTurnStart?.sandboxPolicy, { type: 'readOnly', networkAccess: false }, 'headless dispatch retains the read-only network-disabled sandbox');
  assert.equal(headlessDispatchTurnStart?.approvalPolicy, 'untrusted', 'headless dispatch retains its conservative approval policy');
  assert.equal(headlessDispatchTurnStart?.approvalsReviewer, 'user', 'headless dispatch retains the explicit user reviewer');

  const startedTurn = await waitFor(() => {
    const record = readCodexSupervisor(canonicalId);
    const delivery = record?.inbox?.deliveries?.find((row) => row.envelope_id === dispatched.envelope_id);
    return delivery?.state === 'started' && delivery.turn_id ? { record, delivery } : null;
  }, 'dashboard envelope to real App Server turn/start', 15_000);
  assert.ok(startedTurn.delivery.turn_id, 'accepted delivery is mapped to the real App Server turn id');
  // `turn/start` responds before the turn is actually in flight. Wait for the
  // documented `turn/started` event for this exact thread/turn before asking
  // App Server to interrupt it; otherwise an early interrupt can race startup
  // and leave the controlled turn running past the terminal-record timeout.
  let turnStarted;
  try {
    turnStarted = await supervisor.rpc.waitForNotification((message) => (
      message.method === 'turn/started'
      && message.params?.threadId === first.thread_id
      && message.params?.turn?.id === startedTurn.delivery.turn_id
    ), 15_000);
  } catch (error) {
    const observed = supervisor.rpc.notifications.slice(-20).map((message) => ({
      method: message.method ?? null,
      thread_id: message.params?.threadId ?? null,
      turn_id: message.params?.turn?.id ?? null,
    }));
    throw new Error(
      `timed out waiting for turn/started (thread=${first.thread_id}, turn=${startedTurn.delivery.turn_id}); observed=${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
  assert.equal(turnStarted.params?.turn?.id, startedTurn.delivery.turn_id);
  // The integration test owns the temporary App Server and interrupts after
  // the durable mapping is known to be in flight. This proves the actual
  // protocol without allowing a model to perform ticket work in the checkout.
  let interruptWasNeeded = true;
  try {
    await supervisor.rpc.request('turn/interrupt', {
      threadId: first.thread_id,
      turnId: startedTurn.delivery.turn_id,
    });
  } catch (error) {
    // The controlled prompt can legitimately finish between persisted start and
    // the interrupt request. That is still one real, side-effect-free turn.
    if (!/no active turn to interrupt/i.test(error.message)) throw error;
    interruptWasNeeded = false;
  }
  const afterTurn = await waitFor(() => {
    const record = readCodexSupervisor(canonicalId);
    const delivery = record?.inbox?.deliveries?.find((row) => row.envelope_id === dispatched.envelope_id);
    return ['completed', 'failed'].includes(delivery?.state) ? { record, delivery } : null;
  }, 'controlled App Server turn terminal record', 30_000);
  assert.equal(afterTurn.record.health.delivery_ready, afterTurn.delivery.state === 'completed');
  assert.equal(interruptWasNeeded || afterTurn.delivery.state === 'completed', true, 'turn is either safely interrupted or completes the side-effect-free prompt');

  const payload = {
    envelope_id: dispatched.envelope_id,
    content: dispatchBrief(ticket, note, dispatched.envelope_id),
    sender_session_id: 'human',
    target_session_id: canonicalId,
  };
  const completedBeforeRetry = supervisor.rpc.notifications.filter((message) => (
    message.method === 'turn/completed' && message.params?.turn?.id === afterTurn.delivery.turn_id
  )).length;
  const duplicate = await typedRetry(afterTurn.record, payload);
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.accepted, true);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.turn_id, afterTurn.delivery.turn_id, 'retry returns the original accepted turn mapping');
  await sleep(250);
  assert.equal(
    supervisor.rpc.notifications.filter((message) => message.method === 'turn/completed' && message.params?.turn?.id === afterTurn.delivery.turn_id).length,
    completedBeforeRetry,
    'duplicate envelope never starts another App Server turn',
  );

  // A completed mapping survives a process restart and remains idempotent.
  await supervisor.stop();
  supervisor = null;
  resumed = new CodexSupervisor({ canonicalId, cwd: repo });
  const resumedRecord = await resumed.start();
  assert.equal(resumedRecord.thread_id, first.thread_id, 'restart resumes the original Codex thread');
  assert.equal(resumedRecord.health.delivery_ready, true);
  const restartedDuplicate = await typedRetry(resumedRecord, payload);
  assert.equal(restartedDuplicate.response.status, 200, JSON.stringify(restartedDuplicate.body));
  assert.equal(restartedDuplicate.body.duplicate, true);
  assert.equal(restartedDuplicate.body.turn_id, afterTurn.delivery.turn_id);
  await sleep(250);
  assert.equal(
    resumed.rpc.notifications.filter((message) => message.method === 'turn/completed').length,
    0,
    'restart retry does not create a replacement turn',
  );

  // This is the same process-level binding supplied to the real App Server MCP
  // child. A raw model argument cannot impersonate another session, while the
  // supervisor-owned identity remains the creator for a valid direct call.
  mcpClient = new Client({ name: 'golem-managed-codex-identity-journey', version: '1.0.0' });
  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'mcp/channel/index.js')],
    cwd: repo,
    env: {
      ...process.env,
      GOLEM_HOME: state,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GOLEM_CEO_SESSION_ID: canonicalId,
      GOLEM_MANAGED_CODEX_BOUND: '1',
      GOLEM_MANAGED_CODEX_BOUND_SESSION_ID: canonicalId,
      GOLEM_MANAGED_CODEX_MCP_ONLY: '1',
    },
    stderr: 'pipe',
  });
  await mcpClient.connect(mcpTransport);
  const spoof = await mcpClient.callTool({ name: 'ticket_create', arguments: {
    project: first.project_id,
    title: 'spoof must fail',
    body: 'must not persist',
    __golem_session_id: 'another-live-session',
  } });
  assert.equal(spoof.isError, true, toolText(spoof));
  assert.match(toolText(spoof), /conflicts with the supervisor binding/i);
  const bound = await mcpClient.callTool({ name: 'ticket_create', arguments: {
    project: first.project_id,
    title: 'bound actor proof',
    body: 'must use the supervisor canonical actor',
  } });
  assert.notEqual(bound.isError, true, toolText(bound));
  assert.equal(JSON.parse(toolText(bound)).created_by, canonicalId, 'bound MCP attributes writes to the supervisor-owned actor');

  console.log('GOL-474 Codex delivery journey passed: dashboard envelope -> actual App Server turn/start, typed duplicate/restart idempotency, and bound actor spoof rejection');
} finally {
  await mcpClient?.close().catch(() => {});
  await resumed?.stop({ deleteThread: true }).catch(() => {});
  await supervisor?.stop({ deleteThread: true }).catch(() => {});
  await stopProcess(dashboard?.child);
  fs.rmSync(temp, { recursive: true, force: true });
}
