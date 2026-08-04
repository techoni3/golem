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
      if (dropFirstResponse) {
        dropFirstResponse = false;
        response.destroy();
      } else {
        sendJson(result.http_status ?? 200, result);
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

  console.log('typed immediate retry production journey passed: dashboard mode:now lost response -> original shared queue envelope -> one native start');
} finally {
  await stopProcess(dashboard?.child);
  await closeTypedWorkerEndpoint(endpoint?.server);
  if (previous.GOLEM_HOME == null) delete process.env.GOLEM_HOME; else process.env.GOLEM_HOME = previous.GOLEM_HOME;
  if (previous.GOLEM_TRACKER_DB == null) delete process.env.GOLEM_TRACKER_DB; else process.env.GOLEM_TRACKER_DB = previous.GOLEM_TRACKER_DB;
  if (previous.XDG_CONFIG_HOME == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
  fs.rmSync(temp, { recursive: true, force: true });
}
