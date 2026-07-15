import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ events: { subscriptionDigestEnabled: true } }));

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

function approvalHeaders(record) {
  return {
    'content-type': 'application/json',
    'x-golem-target-session': record.canonical_id,
    'x-golem-endpoint-owner': record.health.owner_token,
  };
}

let supervisor;
let dashboard;
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

  const consult = await post(dashboard.base, '/api/messages/control', {
    project_id: first.project_id,
    sender_id: 'oc-control-source',
    session_id: sessionId,
    kind: 'consult_request',
    content: 'CONSULT REQUEST (cns-control): Reply exactly CONTROL_CONSULT_OK. Do not call tools or access files.',
    metadata: { consult_id: 'cns-control', from_session: 'oc-control-source' },
    legacy: { path: '/consult', body: { consult_id: 'cns-control', from_session: 'oc-control-source', question: 'controlled journey' } },
  });
  assert.equal(consult.response.status, 200, consult.text);
  assert.equal(consult.json.ok, true, consult.text);
  await awaitControl(supervisor, consult.json.envelope_id, 'consult request');

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

  const subscription = await post(dashboard.base, '/api/bus/subscribe', {
    session_id: sessionId, topic: `ticket/${ticketCreate.json.display_id}`,
  });
  assert.equal(subscription.response.status, 201, subscription.text);
  const comment = await post(dashboard.base, `/api/tickets/${encodeURIComponent(ticketCreate.json.id)}/comments`, {
    author: 'cc-control-source', tag: 'note', status: 'open', body: 'subscription event',
  });
  assert.equal(comment.response.status, 201, comment.text);
  const subscriptionEnvelope = await waitFor(() => {
    const record = readCodexSupervisor(sessionId);
    return record?.inbox?.deliveries?.find((row) => row.sender_session_id === 'golem-drainer' && row.target_session_id === sessionId) || null;
  }, 'subscription digest envelope', 20_000);
  await awaitControl(supervisor, subscriptionEnvelope.envelope_id, 'subscription digest');

  const role = await post(dashboard.base, `/api/sessions/${encodeURIComponent(sessionId)}/role`, { role: 'manager' });
  assert.equal(role.response.status, 200, role.text);
  assert.equal(role.json.session.role, 'manager', 'role remains durably assigned when activation is gated');
  assert.equal(role.json.activation.gated, true);
  assert.match(role.json.activation.error, /explicit ticket dispatch/i);
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

  console.log('GOL-476 Codex control-plane journey passed: typed notify/consult/gate/subscription envelopes, actionable role/interrupt/halt gates, and owner-mediated one-off approvals.');
} finally {
  await supervisor?.stop({ deleteThread: true }).catch(() => {});
  await stop(dashboard?.child);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
