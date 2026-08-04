import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  acceptTypedDelivery,
  claimTypedDelivery,
  closeTypedWorkerEndpoint,
  normalizeTypedWorkerInbox,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  TYPED_WORKER_PROTOCOL_VERSION,
  typedDeliveryResult,
} from '../lib/typed-worker-endpoint.js';
import { readTypedDeliveryTombstone, upsertTypedDeliveryTombstone } from '../lib/typed-delivery-tombstones.js';
import { renewEndpointLease, upsertSessionFact } from '../lib/session-facts.js';

// GOL-124 round-four production journey: a real dashboard's immediate route
// loses the first typed response after native acceptance. It must queue the
// original durable envelope, then the normal drainer may retry that same id
// without creating a second native turn.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-immediate-'));
const state = path.join(temp, 'state');
const dashboardDb = path.join(temp, 'tracker.db');
const previous = {
  GOLEM_HOME: process.env.GOLEM_HOME,
  GOLEM_TRACKER_DB: process.env.GOLEM_TRACKER_DB,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.GOLEM_HOME = state;
process.env.GOLEM_TRACKER_DB = dashboardDb;
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ events: { subscriptionDigestEnabled: true } }));

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function unusedPort() {
  const { createServer } = await import('node:http');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
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

async function postJson(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* assertion below prints text */ }
  return { response, json, text };
}

async function waitForRetry(envelopeId, label) {
  return waitFor(() => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      const row = db.prepare('SELECT * FROM envelope_delivery_retries WHERE envelope_id = ?').get(envelopeId);
      return row?.status === 'delivered' ? row : null;
    } finally {
      db.close();
    }
  }, label, 20_000);
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
      GOLEM_TRACKER_DB: dashboardDb,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
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

const canonicalId = 'typed-immediate-lost-response';
const ownerToken = 'typed-immediate-owner-token';
let inbox = normalizeTypedWorkerInbox();
let nativeStarts = 0;
let endpointRequests = 0;
let dropFirstResponse = true;
let dropNextResponse = false;
let nextResponseStatus = 202;
let endpoint;
let dashboard;

async function acceptNative(envelope) {
  const claim = claimTypedDelivery(inbox, envelope, {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId),
  });
  if (claim.duplicate) return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
  assert.equal(claim.busy, false, 'the controlled native worker is idle for its initial acceptance');
  nativeStarts += 1;
  const accepted = acceptTypedDelivery(inbox, envelope.envelope_id, { turnId: `native-${nativeStarts}` });
  upsertTypedDeliveryTombstone(canonicalId, accepted.delivery);
  const settled = settleTypedDelivery(inbox, envelope.envelope_id, { turnId: accepted.delivery.turn_id });
  upsertTypedDeliveryTombstone(canonicalId, settled.delivery);
  return typedDeliveryResult(settled.delivery, { httpStatus: 202, attemptId: envelope.attempt_id });
}

try {
  endpoint = await startTypedWorkerEndpoint({
    canonicalId,
    ownerToken,
    kind: 'typed-worker',
    deliveryReady: () => !inbox.in_flight_envelope_id,
    acceptDelivery: acceptNative,
    // The production endpoint owns authentication and schema validation. This
    // test-only response-loss seam runs after the authenticated health path so
    // the dashboard sees a real typed lease, while simulating bytes lost after
    // the native adapter accepted the first request.
    onRequest: async ({ request, response, url, readBody, sendJson, sameSecret }) => {
      if (url.pathname !== '/brief' || request.method !== 'POST') return false;
      assert.equal(request.headers['x-sender'], 'dashboard');
      assert.equal(request.headers['x-golem-target-session'], canonicalId);
      assert.equal(sameSecret(String(request.headers['x-golem-endpoint-owner'] || ''), ownerToken), true);
      const envelope = JSON.parse(await readBody());
      assert.equal(envelope.protocol_version, TYPED_WORKER_PROTOCOL_VERSION, 'dashboard emits the shared protocol version on every attempt');
      endpointRequests += 1;
      const result = await acceptNative(envelope);
      if (dropFirstResponse || dropNextResponse) {
        dropFirstResponse = false;
        dropNextResponse = false;
        response.destroy();
      } else {
        sendJson(nextResponseStatus, result);
        nextResponseStatus = 202;
      }
      return true;
    },
  });
  renewEndpointLease({
    canonical_id: canonicalId,
    owner_token: ownerToken,
    host: endpoint.host,
    port: endpoint.port,
    kind: 'typed-worker',
    harness: 'codex',
  });
  upsertSessionFact({
    canonical_id: canonicalId,
    continuation_key: `typed-immediate:${canonicalId}`,
    harness: 'codex',
    locator: { raw_session_id: canonicalId },
    project_path: repo,
    status: 'idle',
    capabilities: { typed_worker: true, typed_worker_protocol: TYPED_WORKER_PROTOCOL_VERSION },
    delivery: { mode: 'typed-worker', push: true },
  });

  dashboard = await startDashboard(await unusedPort());
  await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/native-sessions`);
    const sessions = response.ok ? await response.json() : [];
    return sessions.find((session) => session.session_id === canonicalId && session.alive) || null;
  }, `typed target discovery (${dashboard.stderr()})`);

  const created = await fetch(`${dashboard.baseUrl}/api/tickets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: 'typed-immediate-000000', kind: 'work-item',
      title: 'typed immediate lost response', body: 'controlled production journey', created_by: 'human',
    }),
  });
  assert.equal(created.status, 201);
  const ticket = await created.json();
  const dispatched = await fetch(`${dashboard.baseUrl}/api/tickets/${encodeURIComponent(ticket.id)}/dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: canonicalId, note: 'controlled native delivery; do not perform work' }),
  });
  assert.equal(dispatched.status, 200);
  const first = await dispatched.json();
  assert.equal(first.delivered, false, JSON.stringify(first));
  assert.equal(first.queued, true, 'ambiguous immediate typed delivery retains work in the shared queue');
  assert.equal(first.delivery.mode, 'shared_queue');
  assert.equal(nativeStarts, 1, 'the lost response happened after exactly one native start');
  assert.equal(endpointRequests, 1);

  const immediateQueue = new Database(dashboardDb, { readonly: true });
  try {
    const row = immediateQueue.prepare('SELECT envelope_id, status FROM dispatch_queue WHERE ticket_id = ?').get(ticket.id);
    assert.equal(row?.envelope_id, first.envelope_id, 'the retry queue retains the original immutable envelope id');
    assert.equal(row?.status, 'pending');
    assert.equal(immediateQueue.prepare('SELECT COUNT(*) AS n FROM message_envelopes WHERE ticket_id = ?').get(ticket.id).n, 1, 'the failure does not mint a second envelope lineage');
  } finally {
    immediateQueue.close();
  }

  await waitFor(() => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      const row = db.prepare('SELECT envelope_id, status FROM dispatch_queue WHERE ticket_id = ?').get(ticket.id);
      return row?.status === 'delivered' ? row : null;
    } finally {
      db.close();
    }
  }, `shared retry of original envelope (${dashboard.stderr()})`, 15_000);
  assert.equal(endpointRequests, 2, 'the generic drainer retried the retained envelope once');
  assert.equal(nativeStarts, 1, 'the duplicate-safe retry did not start a second native turn');
  assert.equal(inbox.deliveries.filter((delivery) => delivery.envelope_id === first.envelope_id).length, 1, 'one native delivery mapping survives the lost response and retry');

  // The same original-envelope path serves every non-ticket producer. These
  // are real dashboard requests; the endpoint drops each first response only
  // after accepting and settling the native turn.
  async function assertOriginalRetry(label, send, envelopeIdFor) {
    const startsBefore = nativeStarts;
    const requestsBefore = endpointRequests;
    dropNextResponse = true;
    const result = await send();
    const envelopeId = envelopeIdFor(result);
    assert.ok(envelopeId, `${label} returns/creates a durable envelope id`);
    assert.equal(nativeStarts, startsBefore + 1, `${label} first request starts one native turn before its response is lost`);
    const beforeRetry = new Database(dashboardDb, { readonly: true });
    try {
      const row = beforeRetry.prepare('SELECT status FROM envelope_delivery_retries WHERE envelope_id = ?').get(envelopeId);
      assert.equal(row?.status, 'pending', `${label} retains the original envelope in the shared retry queue`);
    } finally { beforeRetry.close(); }
    await waitForRetry(envelopeId, `${label} original-envelope retry (${dashboard.stderr()})`);
    assert.equal(endpointRequests, requestsBefore + 2, `${label} retries the original envelope once`);
    assert.equal(nativeStarts, startsBefore + 1, `${label} duplicate retry does not create a second native turn`);
    assert.equal(inbox.deliveries.filter((delivery) => delivery.envelope_id === envelopeId).length, 1, `${label} has one native envelope mapping`);
    return { result, envelopeId };
  }

  const notification = await assertOriginalRetry('notification', () => postJson(dashboard.baseUrl, '/api/messages/notify', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-notify-source', session_id: canonicalId, text: 'lost response notification',
  }), ({ json }) => json?.envelope_id);
  assert.equal(notification.result.response.status, 200, notification.result.text);
  assert.equal(notification.result.json?.queued, true, notification.result.text);

  const control = await assertOriginalRetry('control', () => postJson(dashboard.baseUrl, '/api/messages/control', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-control-source', session_id: canonicalId,
    kind: 'consult_request', content: 'lost response control', metadata: { consult_id: 'lost-control' },
    legacy: { path: '/consult', body: { consult_id: 'lost-control', question: 'controlled' } },
  }), ({ json }) => json?.envelope_id);
  assert.equal(control.result.response.status, 200, control.result.text);
  assert.equal(control.result.json?.queued, true, control.result.text);

  const commentTicket = await postJson(dashboard.baseUrl, '/api/tickets', {
    project_id: 'typed-immediate-000000', kind: 'work-item', title: 'typed comment retry', body: 'controlled', created_by: 'human',
  });
  assert.equal(commentTicket.response.status, 201, commentTicket.text);
  const createdComment = await postJson(dashboard.baseUrl, `/api/tickets/${encodeURIComponent(commentTicket.json.id)}/comments`, {
    author: 'human', body: 'lost response comment', tag: 'note', status: 'open',
  });
  assert.equal(createdComment.response.status, 201, createdComment.text);
  const comment = await assertOriginalRetry('comment dispatch', () => postJson(
    dashboard.baseUrl,
    `/api/comments/${encodeURIComponent(createdComment.json.id)}/dispatch`,
    { session_id: canonicalId },
  ), () => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      return db.prepare(`SELECT envelope_id FROM envelope_delivery_retries
        WHERE content LIKE ? ORDER BY rowid DESC LIMIT 1`).get('%lost response comment%')?.envelope_id ?? null;
    } finally { db.close(); }
  });
  assert.equal(comment.result.response.status, 502, comment.result.text);
  assert.equal(comment.result.json?.rolled_back, 0, comment.result.text);
  const commentAfterRetry = await (await fetch(`${dashboard.baseUrl}/api/tickets/${encodeURIComponent(commentTicket.json.id)}`)).json();
  const commentRetryDb = new Database(dashboardDb, { readonly: true });
  const commentDispatchDebug = commentRetryDb.prepare('SELECT status FROM comment_dispatches WHERE comment_id = ?').all(createdComment.json.id);
  commentRetryDb.close();
  assert.equal(commentAfterRetry.comments.find((entry) => entry.id === createdComment.json.id)?.dispatch_state, 'dispatched', 'comment stays visibly dispatched until the worker addresses it');
  assert.deepEqual(commentDispatchDebug.map((row) => row.status), ['delivered'], 'comment retry settles its original dispatch after correlated acceptance');

  // Seed a durable reply route, then drop the reply's typed response. It must
  // retry the child reply envelope, not create another reply lineage.
  const replySource = await postJson(dashboard.baseUrl, '/api/messages/control', {
    project_id: 'typed-immediate-000000', sender_id: canonicalId, session_id: canonicalId,
    kind: 'consult_request', content: 'reply source', metadata: { consult_id: 'reply-source' },
    legacy: { path: '/consult', body: { consult_id: 'reply-source', question: 'controlled' } },
  });
  assert.equal(replySource.response.status, 200, replySource.text);
  const reply = await assertOriginalRetry('reply', () => postJson(
    dashboard.baseUrl,
    `/api/message-envelopes/${encodeURIComponent(replySource.json.envelope_id)}/reply`,
    { kind: 'brief', text: 'lost response reply' },
    { 'x-golem-caller-session': canonicalId },
  ), ({ json }) => json?.reply?.id);
  assert.equal(reply.result.response.status, 200, reply.result.text);

  // An accepted 503 is a completed typed opportunity, not a failed HTTP
  // notification: it reports success and settles passive context through the
  // same accepted-delivery predicate.
  nextResponseStatus = 503;
  const accepted503 = await postJson(dashboard.baseUrl, '/api/messages/notify', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-notify-503', session_id: canonicalId, text: 'accepted 503 notification',
  });
  assert.equal(accepted503.response.status, 200, accepted503.text);
  assert.equal(accepted503.json?.ok, true, accepted503.text);
  assert.equal(accepted503.json?.queued, false, accepted503.text);
  nextResponseStatus = 503;
  const accepted503Control = await postJson(dashboard.baseUrl, '/api/messages/control', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-control-503', session_id: canonicalId,
    kind: 'consult_request', content: 'accepted 503 control', metadata: { consult_id: 'accepted-503-control' },
    legacy: { path: '/consult', body: { consult_id: 'accepted-503-control', question: 'controlled' } },
  });
  assert.equal(accepted503Control.response.status, 200, accepted503Control.text);
  assert.equal(accepted503Control.json?.ok, true, accepted503Control.text);
  assert.equal(accepted503Control.json?.queued, false, accepted503Control.text);

  console.log('typed immediate retry production journey passed: ticket/notification/control/comment/reply lost response -> original shared envelope retry -> one native start; accepted-503 notify/control settle');
} finally {
  await stopProcess(dashboard?.child);
  await closeTypedWorkerEndpoint(endpoint?.server);
  if (previous.GOLEM_HOME == null) delete process.env.GOLEM_HOME; else process.env.GOLEM_HOME = previous.GOLEM_HOME;
  if (previous.GOLEM_TRACKER_DB == null) delete process.env.GOLEM_TRACKER_DB; else process.env.GOLEM_TRACKER_DB = previous.GOLEM_TRACKER_DB;
  if (previous.XDG_CONFIG_HOME == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
  fs.rmSync(temp, { recursive: true, force: true });
}
