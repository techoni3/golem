import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireChrome } from './_chrome.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-129-pi-browser-'));
const home = path.join(temp, 'state');
const project = path.join(temp, 'project');
const db = path.join(temp, 'tracker.db');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# GOL-129 isolated Pi browser fixture\n');
process.env.GOLEM_HOME = home;
process.env.GOLEM_TRACKER_DB = db;

const [{ projectIdFor }, facts, typed] = await Promise.all([
  import('../server/project-id.js'),
  import('../../lib/session-facts.js'),
  import('../../lib/typed-worker-endpoint.js'),
]);
const projectId = projectIdFor(project);
const canonicalId = 'pi-gol-129-browser';
const ownerToken = 'pi-gol-129-browser-owner';
const observedAt = new Date(Date.now() - 30 * 60_000).toISOString();
const received = [];

fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: projectId, name: 'GOL-129 Pi fixture', path: project, kind: 'auto' },
] }));
fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [{
  session_id: canonicalId, harness: 'pi', project_path: project, name: 'Pi first-class worker',
  status: 'idle', role: 'builder', boot_time: observedAt, last_seen_at: observedAt,
}] }));
facts.upsertSessionFact({
  canonical_id: canonicalId, continuation_key: 'pi-continuation-gol-129', harness: 'pi',
  locator: { raw_session_id: canonicalId, session_file: path.join(home, 'pi-sessions', 'fixture.jsonl') },
  project_path: project, name: 'Pi first-class worker', status: 'idle',
  provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud',
  delivery: { mode: 'typed-worker', push: true, ready: true },
  capabilities: { typed_worker: true, typed_worker_protocol: typed.TYPED_WORKER_PROTOCOL_VERSION },
  trust: 'host-full-trust', lifecycle_event: 'agent_settled',
  observations: {
    adapter_state: 'idle', delivery_state: 'settled', pi_version: '0.80.10', extension_version: '5.6.14',
  },
  observed_at: observedAt,
});

const endpoint = await typed.startTypedWorkerEndpoint({
  canonicalId, ownerToken, kind: 'typed-worker', deliveryReady: () => true,
  acceptDelivery: async (envelope) => {
    received.push(envelope);
    return {
      ok: true, accepted: true, http_status: 200,
      envelope_id: envelope.envelope_id, attempt_id: envelope.attempt_id,
      accepted_attempt_id: envelope.attempt_id, delivery_state: 'settled', turn_id: `turn-${received.length}`,
    };
  },
});
facts.renewEndpointLease({
  canonical_id: canonicalId, owner_token: ownerToken, host: endpoint.host, port: endpoint.port,
  kind: 'typed-worker', harness: 'pi', delivery_ready: true,
});

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`${label} timed out`);
}
async function stop(child) {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit').catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, pause(2_000)]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

const port = await unusedPort();
let stderr = '';
const dashboard = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repo,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GOLEM_HOME: home, GOLEM_TRACKER_DB: db },
  stdio: ['ignore', 'ignore', 'pipe'],
});
dashboard.stderr.setEncoding('utf8');
dashboard.stderr.on('data', (chunk) => { stderr += chunk; });
let chrome;
try {
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, `dashboard health: ${stderr}`);
  const projected = await waitFor(async () => {
    const rows = await (await fetch(`${base}/api/native-sessions`)).json();
    return rows.find((row) => row.session_id === canonicalId && row.alive && row.delivery_ready) || null;
  }, `live Pi projection: ${stderr}`);
  assert.equal(Date.parse(projected.fact_observed_at), Date.parse(observedAt));
  assert.equal(projected.provider, 'ollama');
  assert.equal(projected.trust, 'host-full-trust');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  const card = page.locator('.agent-card.native-session-card').filter({ hasText: 'Pi first-class worker' }).first();
  await card.waitFor();
  assert.equal(await card.locator('.agent-harness-icon').getAttribute('aria-label'), 'Harness: Pi');
  assert.equal(await card.locator('.agent-model-pill').getAttribute('title'), 'DeepSeek: deepseek-v4-flash:0731-cloud');
  // GOL-274: operational Pi truth belongs in the drawer, not the compact card.
  assert.equal(await card.locator('.agent-card-pi-truth').count(), 0);
  const cardText = await card.innerText();
  for (const hidden of ['continuation', 'supported · Pi', 'host-full-trust', 'turn settled']) {
    assert.equal(cardText.includes(hidden), false, `compact Pi card still exposes ${hidden}`);
  }

  const role = card.locator('select');
  await role.selectOption('reviewer');
  await waitFor(() => received.some((item) => item.kind === 'role_assign'), 'role_assign disposition');

  const input = card.locator('.cc-composer-input');
  await input.fill('browser Pi brief');
  const [briefResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/brief') && response.request().method() === 'POST'),
    card.getByRole('button', { name: 'Send' }).click(),
  ]);
  assert.equal(briefResponse.status(), 200, await briefResponse.text());
  await waitFor(() => received.some((item) => item.kind === 'brief' && item.content.includes('browser Pi brief')), 'brief disposition');
  await card.getByRole('button', { name: 'Interrupt' }).click();
  await waitFor(() => received.some((item) => item.kind === 'interrupt'), 'interrupt disposition');
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: 'Halt' }).click();
  await waitFor(() => received.some((item) => item.kind === 'halt'), 'halt disposition');

  const postControl = async (kind, legacy) => {
    const response = await fetch(`${base}/api/messages/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender_id: 'browser-fixture', session_id: canonicalId, kind, content: `${kind} fixture`, legacy }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await postControl('consult', { path: '/brief', body: 'consult fixture' });
  await postControl('gate_resolution', { path: '/gates/gol-129/approve', body: 'approved' });
  await waitFor(() => received.some((item) => item.kind === 'consult') && received.some((item) => item.kind === 'gate_resolution'), 'consult and gate dispositions');

  await card.locator('.agent-card-surface').click();
  const drawer = page.locator('[role="dialog"][aria-label^="Agent details"]:visible');
  await drawer.waitFor();
  const metadata = await drawer.locator('.nsd-meta-grid').innerText();
  for (const expected of ['continuation', 'pi-continuation-gol-129', 'provider', 'ollama', 'delivery mode', 'typed-worker', 'compatibility', 'supported · Pi 0.80.10 · Node >=22.19', 'trust', 'host-full-trust']) {
    assert.ok(metadata.toLowerCase().includes(expected.toLowerCase()), `drawer is missing ${expected}: ${metadata}`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`GOL-129 Pi dashboard browser journey passed: truthful card/drawer, stale-fact live lease, and canonical role/brief/consult/interrupt/halt/gate controls; port=${port}`);
} finally {
  if (chrome) await chrome.cleanup();
  await stop(dashboard);
  await typed.closeTypedWorkerEndpoint(endpoint.server);
  fs.rmSync(temp, { recursive: true, force: true });
}
