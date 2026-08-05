import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// GOL-476 is one control-plane journey: real dashboard + SQLite and a real
// managed App Server supervisor deliver every supported non-ticket control as
// a durable typed envelope. It also exercises the owner-authenticated, manual
// approval bridge without asking a real model to perform a side effect.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-control-plane-'));
const home = path.join(temp, 'home');
const xdg = path.join(temp, 'xdg');
const dbPath = path.join(temp, 'tracker.db');
process.env.GOLEM_HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.GOLEM_TRACKER_DB = dbPath;
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({}));

const { CodexSupervisor, readCodexSupervisor } = await import('../lib/codex-supervisor.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(check, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function startDashboard() {
  const port = await unusedPort();
  let stderr = '';
  const child = spawn(process.execPath, ['dashboard/server/index.js'], {
    cwd: repo,
    env: { ...process.env, GOLEM_HOME: home, GOLEM_TRACKER_DB: dbPath, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, `dashboard health (${stderr})`, 15_000);
  return { child, base, stderr: () => stderr };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startLegacyRoleChannel() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port, requests };
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* asserted by caller */ }
  return { response, json, text };
}

async function awaitControl(supervisor, envelopeId, label) {
  const started = await waitFor(() => {
    const delivery = readCodexSupervisor(supervisor.canonicalId)?.inbox?.deliveries?.find((row) => row.envelope_id === envelopeId);
    return delivery?.turn_id ? delivery : null;
  }, `${label} typed envelope -> App Server turn`);
  // The prompts are deliberately read-only and short. Prefer completion so
  // the next control proves the same supervisor remains delivery-ready.
  const completed = await waitFor(() => {
    const record = readCodexSupervisor(supervisor.canonicalId);
    const delivery = record?.inbox?.deliveries?.find((row) => row.envelope_id === envelopeId);
    return delivery?.state === 'completed' && record.health?.delivery_ready ? delivery : null;
  }, `${label} controlled turn completion`, 75_000);
  assert.equal(completed.turn_id, started.turn_id);
}

async function waitForNativeSessionWs(base, sessionId, predicate, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`${label} timed out`));
    }, 15_000);
    const finish = (result, error = null) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (error) reject(error); else resolve(result);
    };
    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const rows = message.type === 'snapshot'
        ? message.payload?.native_sessions
        : message.type === 'native-sessions-update'
          ? message.native_sessions
          : null;
      const row = Array.isArray(rows) ? rows.find((candidate) => candidate.session_id === sessionId) : null;
      if (row && predicate(row)) finish(row);
    });
    ws.on('error', (error) => finish(null, error));
  });
}

function approvalHeaders(record) {
  return {
    'content-type': 'application/json',
    'x-golem-target-session': record.canonical_id,
    'x-golem-endpoint-owner': record.health.owner_token,
  };
}

let supervisor;
let dashboard;
let legacyRoleChannel;
try {
  const sessionId = 'codex-control-plane';
  supervisor = new CodexSupervisor({ canonicalId: sessionId, cwd: repo });
  const first = await supervisor.start();
  dashboard = await startDashboard();
  await waitFor(async () => {
    const rows = await (await fetch(`${dashboard.base}/api/sessions/dispatchable?project=${encodeURIComponent(first.project_id)}`)).json();
    return rows.some((row) => row.session_id === sessionId && row.reachable === true);
  }, 'managed Codex dispatchable control target');

  const notify = await post(dashboard.base, '/api/messages/notify', {
    project_id: first.project_id,
    sender_id: 'cc-control-source',
    session_id: sessionId,
    text: 'CONTROL NOTIFY: Reply exactly CONTROL_NOTIFY_OK. Do not call tools or access files.',
  });
  assert.equal(notify.response.status, 200, notify.text);
  assert.equal(notify.json.ok, true, notify.text);
  await awaitControl(supervisor, notify.json.envelope_id, 'session notification');
  assert.equal(readCodexSupervisor(sessionId).inbox.deliveries.find((row) => row.envelope_id === notify.json.envelope_id)?.sender_session_id, 'cc-control-source');

  const ticketCreate = await post(dashboard.base, '/api/tickets', {
    project_id: first.project_id, kind: 'work-item', title: 'GOL-476 gate control journey', body: 'controlled', created_by: 'human',
  });
  assert.equal(ticketCreate.response.status, 201, ticketCreate.text);
  const gateComment = await post(dashboard.base, `/api/tickets/${encodeURIComponent(ticketCreate.json.id)}/comments`, {
    author: sessionId, tag: 'question', status: 'open', block_id: 'gate:control-gate', body: 'Requested by: codex-control-plane',
  });
  assert.equal(gateComment.response.status, 201, gateComment.text);
  const gateResolve = await fetch(`${dashboard.base}/api/tickets/${encodeURIComponent(ticketCreate.json.id)}/comments/${encodeURIComponent(gateComment.json.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved', body: 'approved for controlled journey' }),
  });
  assert.equal(gateResolve.status, 200, await gateResolve.text());
  const gateEnvelope = await waitFor(() => {
    const record = readCodexSupervisor(sessionId);
    return record?.inbox?.deliveries?.find((row) => row.sender_session_id === 'human:dashboard' && row.target_session_id === sessionId && row.state !== 'completed')
      || record?.inbox?.deliveries?.find((row) => row.sender_session_id === 'human:dashboard' && row.target_session_id === sessionId);
  }, 'gate resolution envelope');
  await awaitControl(supervisor, gateEnvelope.envelope_id, 'gate resolution');

  const threadName = 'sol:codex-control-plane';
  await supervisor.rpc.request('thread/name/set', { threadId: first.thread_id, name: threadName });
  await waitFor(() => readCodexSupervisor(sessionId)?.thread_name === threadName, 'managed Codex native thread name');
  const beforeRoleDeliveries = readCodexSupervisor(sessionId).inbox.deliveries.length;
  const roleTurns = [];
  const request = supervisor.rpc.request.bind(supervisor.rpc);
  supervisor.rpc.request = async (method, params, ...rest) => {
    if (method === 'turn/start' && params.clientUserMessageId) roleTurns.push(params);
    return request(method, params, ...rest);
  };
  const role = await post(dashboard.base, `/api/sessions/${encodeURIComponent(sessionId)}/role`, { role: 'manager' });
  supervisor.rpc.request = request;
  assert.equal(role.response.status, 200, role.text);
  assert.equal(role.json.saved, true);
  assert.equal(role.json.session.role, 'manager');
  assert.equal(role.json.session.harness, 'codex', 'managed role persistence is enriched from canonical facts');
  assert.equal(role.json.session.name, threadName);
  assert.equal(role.json.session.project_path, repo);
  assert.equal(role.json.activation.ok, true, role.text);
  assert.ok(role.json.activation.envelope_id, 'role activation is allocated as a durable control envelope');
  assert.equal(roleTurns.length, 1, 'idle role assignment starts exactly one typed App Server turn');
  assert.equal(roleTurns[0].clientUserMessageId, role.json.activation.envelope_id);
  assert.match(roleTurns[0].input?.[0]?.text || '', /ROLE ASSIGNMENT ONLY/);
  assert.match(roleTurns[0].input?.[0]?.text || '', /Your session role is now: manager/);
  assert.match(roleTurns[0].input?.[0]?.text || '', /Role card \(identity context for later/);
  await awaitControl(supervisor, role.json.activation.envelope_id, 'role assignment');
  assert.equal(readCodexSupervisor(sessionId).inbox.deliveries.length, beforeRoleDeliveries + 1, 'one durable envelope maps to one role turn');
  const renderedRole = await waitFor(async () => {
    const snapshot = await (await fetch(`${dashboard.base}/api/snapshot`)).json();
    return snapshot.native_sessions?.find((row) => row.session_id === sessionId && row.role === 'manager') || null;
  }, 'managed Codex rendered role after dashboard reconciliation');
  assert.equal(renderedRole.harness, 'codex');
  assert.equal(renderedRole.name, threadName);
  assert.ok(renderedRole.model, 'role-enriched managed card retains its App Server model');

  // Persist first, then report partial success when the canonical thread is
  // not delivery-ready. The failed durable envelope is never injected later.
  supervisor.noteThreadStatus({ threadId: first.thread_id, status: { type: 'active', activeFlags: [] } });
  await waitFor(() => readCodexSupervisor(sessionId)?.health?.delivery_ready === false, 'busy managed Codex delivery gate');
  const assertBusyDeliveryFacts = (row, surface) => {
    assert.equal(row.status, 'busy', `${surface} retains the active session status`);
    assert.equal(row.channel_present, true, `${surface} distinguishes a present channel`);
    assert.equal(row.endpoint_health, 'healthy', `${surface} retains authenticated endpoint health`);
    assert.equal(row.delivery_ready, false, `${surface} reports immediate delivery as unavailable`);
    assert.equal(row.delivery_reason, 'busy', `${surface} reports active delivery as busy rather than channel loss`);
    assert.equal(row.reachable, false, `${surface} keeps reachable as the immediate-delivery compatibility alias`);
  };
  const busyNative = await waitFor(async () => {
    const rows = await (await fetch(`${dashboard.base}/api/native-sessions`)).json();
    const row = rows.find((candidate) => candidate.session_id === sessionId);
    return row?.status === 'busy' && row.delivery_ready === false ? row : null;
  }, 'managed Codex busy native-session facts');
  assertBusyDeliveryFacts(busyNative, 'native REST');
  const busySnapshot = await waitFor(async () => {
    const snapshot = await (await fetch(`${dashboard.base}/api/snapshot`)).json();
    const row = snapshot.native_sessions?.find((candidate) => candidate.session_id === sessionId);
    return row?.status === 'busy' && row.delivery_ready === false ? row : null;
  }, 'managed Codex busy snapshot facts');
  assertBusyDeliveryFacts(busySnapshot, 'snapshot');
  const busyWs = await waitForNativeSessionWs(
    dashboard.base,
    sessionId,
    (row) => row.status === 'busy' && row.delivery_ready === false,
    'managed Codex busy WebSocket facts',
  );
  assertBusyDeliveryFacts(busyWs, 'WebSocket');
  const busyDispatchable = await waitFor(async () => {
    const rows = await (await fetch(`${dashboard.base}/api/sessions/dispatchable?project=${encodeURIComponent(first.project_id)}`)).json();
    const row = rows.find((candidate) => candidate.session_id === sessionId);
    return row?.delivery_ready === false ? row : null;
  }, 'managed Codex busy dispatchable target');
  assertBusyDeliveryFacts(busyDispatchable, 'dispatchable REST');
  const beforeBusyRoleDeliveries = readCodexSupervisor(sessionId).inbox.deliveries.length;
  const busyRole = await post(dashboard.base, `/api/sessions/${encodeURIComponent(sessionId)}/role`, { role: 'builder' });
  assert.equal(busyRole.response.status, 200, busyRole.text);
  assert.equal(busyRole.json.saved, true);
  assert.equal(busyRole.json.session.role, 'builder');
  assert.equal(busyRole.json.activation.ok, false);
  assert.ok(busyRole.json.activation.envelope_id, 'undelivered activation remains a durable failed envelope');
  assert.match(busyRole.json.activation.error, /not delivery-ready/i);
  assert.equal(readCodexSupervisor(sessionId).inbox.deliveries.length, beforeBusyRoleDeliveries, 'busy role activation is never injected mid-turn');
  supervisor.noteThreadStatus({ threadId: first.thread_id, status: { type: 'idle' } });
  await waitFor(() => readCodexSupervisor(sessionId)?.health?.delivery_ready === true, 'managed Codex gate restored after synthetic busy boundary');
  const idleNative = await waitFor(async () => {
    const rows = await (await fetch(`${dashboard.base}/api/native-sessions`)).json();
    const row = rows.find((candidate) => candidate.session_id === sessionId);
    return row?.delivery_ready === true ? row : null;
  }, 'managed Codex native-session delivery restored');
  assert.equal(idleNative.delivery_reason, 'ready');
  assert.equal(idleNative.reachable, true);

  // A live OpenCode channel retains the legacy /role transport even though
  // the dashboard now allocates the same durable role_assign envelope first.
  legacyRoleChannel = await startLegacyRoleChannel();
  fs.writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ version: 1, channels: [{
    session_id: 'opencode-role-legacy', pid: process.pid, host: '127.0.0.1', port: legacyRoleChannel.port,
    harness: 'opencode', project_id: first.project_id, project_path: repo, cwd: repo, name: 'oc:role-legacy',
  }] }));
  const legacyRole = await post(dashboard.base, '/api/sessions/opencode-role-legacy/role', { role: 'manager' });
  assert.equal(legacyRole.response.status, 200, legacyRole.text);
  assert.equal(legacyRole.json.activation.ok, true, legacyRole.text);
  assert.equal(legacyRoleChannel.requests.length, 1);
  assert.equal(legacyRoleChannel.requests[0].path, '/role');
  assert.match(legacyRoleChannel.requests[0].body, /Your session role is now: manager/);
  const liveRolePush = await post(dashboard.base, '/api/roles/manager/push', {});
  assert.equal(liveRolePush.response.status, 200, liveRolePush.text);
  assert.ok(liveRolePush.json.results.some((row) => row.session_id === 'opencode-role-legacy' && row.ok), liveRolePush.text);
  assert.equal(legacyRoleChannel.requests.at(-1).path, '/role', 'role push-to-live preserves the OpenCode legacy route');
  for (const [path, body, label] of [
    ['/api/interrupt', { session_id: sessionId, text: 'controlled interrupt' }, 'interrupt'],
    ['/api/halt', { session_id: sessionId, text: 'controlled halt' }, 'halt'],
  ]) {
    const gated = await post(dashboard.base, path, body);
    assert.equal(gated.response.status, 409, gated.text);
    assert.match(gated.json.error, new RegExp(`managed Codex ${label} is gated`, 'i'));
    assert.match(gated.json.error, /supervisor|dispatch/i);
  }

  // The request is injected into the real supervisor transport to exercise
  // owner authentication and response mapping without issuing an unsafe shell
  // command to the test checkout.
  const sent = [];
  const originalSend = supervisor.rpc.send.bind(supervisor.rpc);
  supervisor.rpc.send = (message) => { sent.push(message); };
  supervisor.rpc.receive(JSON.stringify({
    id: 'command-approval', method: 'item/commandExecution/requestApproval',
    params: { threadId: first.thread_id, turnId: 'turn-control', itemId: 'item-control', startedAtMs: Date.now(), command: 'touch SHOULD_NOT_RUN', reason: 'controlled approval request' },
  }));
  const commandPending = readCodexSupervisor(sessionId).approvals.pending[0];
  assert.equal(commandPending.method, 'item/commandExecution/requestApproval');
  assert.equal(Object.hasOwn(commandPending, 'command'), false, 'durable approval state is redacted');
  const record = readCodexSupervisor(sessionId);
  const base = `http://${record.health.host}:${record.health.port}`;
  const forbidden = await fetch(`${base}/approvals`);
  assert.equal(forbidden.status, 403, 'approval state is not exposed without owner authentication');
  const listed = await fetch(`${base}/approvals`, { headers: approvalHeaders(record) });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).pending[0].id, commandPending.id);
  const detail = await fetch(`${base}/approvals/${encodeURIComponent(commandPending.id)}`, { headers: approvalHeaders(record) });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).approval.request.params.command, 'touch SHOULD_NOT_RUN', 'full request is available only on the protected live endpoint');
  const denied = await fetch(`${base}/approvals/${encodeURIComponent(commandPending.id)}/decision`, {
    method: 'POST', headers: approvalHeaders(record), body: JSON.stringify({ decision: 'cancel' }),
  });
  assert.equal(denied.status, 200);
  assert.deepEqual(sent.pop(), { id: 'command-approval', result: { decision: 'cancel' } });

  supervisor.rpc.receive(JSON.stringify({
    id: 'permissions-approval', method: 'item/permissions/requestApproval',
    params: { threadId: first.thread_id, turnId: 'turn-control', itemId: 'permissions-control', startedAtMs: Date.now(), cwd: repo, permissions: { network: { enabled: true } } },
  }));
  const permissionPending = readCodexSupervisor(sessionId).approvals.pending.find((row) => row.method === 'item/permissions/requestApproval');
  assert.ok(permissionPending);
  const permissionDecision = await fetch(`${base}/approvals/${encodeURIComponent(permissionPending.id)}/decision`, {
    method: 'POST', headers: approvalHeaders(readCodexSupervisor(sessionId)), body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(permissionDecision.status, 200);
  assert.deepEqual(sent.pop(), { id: 'permissions-approval', result: { permissions: { network: { enabled: true } }, scope: 'turn' } }, 'permission approval grants exactly the requested profile for one turn');
  supervisor.rpc.receive(JSON.stringify({
    id: 'permissions-decline', method: 'item/permissions/requestApproval',
    params: { threadId: first.thread_id, turnId: 'turn-control', itemId: 'permissions-decline', startedAtMs: Date.now(), cwd: repo, permissions: { network: { enabled: true } } },
  }));
  const declinePending = readCodexSupervisor(sessionId).approvals.pending.find((row) => row.item_id === 'permissions-decline');
  const declineDecision = await fetch(`${base}/approvals/${encodeURIComponent(declinePending.id)}/decision`, {
    method: 'POST', headers: approvalHeaders(readCodexSupervisor(sessionId)), body: JSON.stringify({ decision: 'decline' }),
  });
  assert.equal(declineDecision.status, 200);
  assert.deepEqual(sent.pop(), {
    id: 'permissions-decline',
    error: { code: -32001, message: 'Golem operator declined permission-profile approval' },
  }, 'permission decline stays fail-closed because the App Server schema has no deny result');
  supervisor.rpc.send = originalSend;

  console.log('GOL-482/GOL-498 Codex control-plane journey passed: typed controls, busy channel-presence/delivery facts across REST/snapshot/WebSocket/dispatchable rows, saved busy-role warning, legacy OpenCode /role, gated interrupt/halt, and owner-mediated approvals.');
} finally {
  await new Promise((resolve) => legacyRoleChannel?.server.close(resolve) ?? resolve());
  await supervisor?.stop({ deleteThread: true }).catch(() => {});
  await stop(dashboard?.child);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
