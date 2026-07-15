import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GOL-473: a real lifecycle journey. It starts a local stdio-only App Server,
// proves the health-only endpoint is visible to session discovery but excluded
// from tracker dispatch, then restarts onto the same persisted Codex thread.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-supervisor-'));
const state = path.join(temp, 'state');
process.env.GOLEM_HOME = state;
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');

const {
  CODEX_APP_SERVER_CONTRACT,
  verifyCodexAppServerContract,
} = await import('../lib/codex-app-server-contract.js');
const {
  CodexSupervisor,
  readCodexSupervisor,
} = await import('../lib/codex-supervisor.js');
const { readSessionFacts, readEndpointLeases } = await import('../lib/session-facts.js');
const { readChannels } = await import('../dashboard/server/channels.js');
const { readNativeSessions } = await import('../dashboard/server/native-sessions.js');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok;
  }, `dashboard health (${stderr})`);
  return { child, baseUrl, stderr: () => stderr };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let supervisor;
let resumed;
let dashboard;
try {
  const canonicalId = 'codex-supervisor-journey';
  supervisor = new CodexSupervisor({ canonicalId, cwd: repo });
  const first = await supervisor.start();
  assert.equal(first.canonical_id, canonicalId);
  assert.equal(first.health.state, 'healthy');
  assert.equal(first.health.delivery_ready, true);
  assert.equal(first.process.transport, 'stdio');
  assert.ok(first.process.pid > 0, 'managed process pid is persisted');
  assert.ok(first.thread_id, 'managed Codex thread id is persisted');
  assert.equal(first.cwd, repo);
  assert.ok(first.project_id, 'derived project id is persisted');
  assert.equal(first.version.cli_version, CODEX_APP_SERVER_CONTRACT.cliVersion);
  assert.equal(first.version.schema_fingerprint, CODEX_APP_SERVER_CONTRACT.schemaFingerprint);
  assert.equal(first.turn.state, 'idle', 'readiness turn has completed before health is exposed');
  assert.equal(first.inbox.in_flight_envelope_id, null, 'future durable inbox starts without an in-flight envelope');

  const facts = readSessionFacts();
  const fact = facts.find((row) => row.canonical_id === canonicalId);
  assert.equal(fact?.harness, 'codex');
  assert.equal(fact?.status, 'idle');
  assert.deepEqual(fact?.delivery, { mode: 'supervisor-turn', push: true });

  const leases = readEndpointLeases();
  const lease = leases.find((row) => row.canonical_id === canonicalId);
  assert.equal(lease?.delivery_ready, true, 'active bound MCP plus idle supervisor exposes a typed delivery lease');
  const channels = await readChannels();
  const channel = channels.find((row) => row.session_id === canonicalId);
  assert.equal(channel?.endpoint_health, 'healthy');
  assert.equal(channel?.delivery_ready, true);
  const native = (await readNativeSessions(() => true, channels)).find((row) => row.session_id === canonicalId);
  assert.equal(native?.alive, true, 'healthy supervisor materializes a truthful live session fact');
  assert.equal(native?.endpoint_health, 'healthy');

  const port = await unusedPort();
  dashboard = await startDashboard(port);
  const dispatchable = await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/sessions/dispatchable`);
    if (!response.ok) return null;
    return response.json();
  }, 'dispatchable session query');
  assert.equal(dispatchable.some((row) => row.session_id === canonicalId), true, 'idle managed Codex supervisor is a tracker dispatch target after GOL-474');
  const dashboardNative = await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/native-sessions`);
    if (!response.ok) return null;
    return (await response.json()).find((row) => row.session_id === canonicalId);
  }, 'native session projection');
  assert.equal(dashboardNative.alive, true);
  assert.equal(dashboardNative.reachable, true, 'typed supervisor delivery is visible as reachable only after activation');

  await assert.rejects(
    new CodexSupervisor({ canonicalId, cwd: repo }).start(),
    /already healthy.*refusing to create a duplicate App Server/i,
    'a second owner must not create a duplicate live App Server for one canonical session',
  );

  const originalThread = first.thread_id;
  // Exercise an ungraceful App Server loss rather than only the orderly stop
  // path. The exit handler must release its lease before roster recency could
  // make the old canonical session look targetable.
  supervisor.rpc.child.kill('SIGTERM');
  await waitFor(() => {
    const record = readCodexSupervisor(canonicalId);
    return record?.health?.state === 'dead'
      && !readEndpointLeases().some((row) => row.canonical_id === canonicalId);
  }, 'unexpected App Server exit cleanup');
  supervisor = null;
  assert.equal(readEndpointLeases().some((row) => row.canonical_id === canonicalId), false, 'process loss releases the health lease synchronously');
  const stopped = readCodexSupervisor(canonicalId);
  assert.equal(stopped?.health?.state, 'dead');
  const deadNative = (await readNativeSessions(() => true, [])).find((row) => row.session_id === canonicalId);
  assert.equal(deadNative?.alive, false, 'a fresh terminal fact cannot remain dispatchable by recency');

  resumed = new CodexSupervisor({ canonicalId, cwd: repo });
  const second = await resumed.start();
  assert.equal(second.thread_id, originalThread, 'restart resumes the same persisted Codex thread');
  assert.equal(second.lifecycle.resumed, true);
  assert.equal(second.health.state, 'healthy');
  await resumed.stop({ deleteThread: true });
  resumed = null;
  const deleted = readCodexSupervisor(canonicalId);
  assert.equal(deleted?.thread_id, null, 'explicit cleanup never leaves a stale resumable thread mapping');
  assert.equal(readEndpointLeases().some((row) => row.canonical_id === canonicalId), false);

  assert.throws(
    () => verifyCodexAppServerContract({ contract: { ...CODEX_APP_SERVER_CONTRACT, cliVersion: '0.0.0' } }),
    /expected codex-cli 0\.0\.0/i,
    'a CLI version mismatch fails before a managed App Server can spawn',
  );
  const help = spawnSync(process.execPath, ['cli/golem.js', 'codex-supervisor', '--help'], { cwd: repo, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /typed tracker delivery when its bound\s+MCP is active and the thread is idle/i);

  console.log('GOL-474 managed Codex supervisor lifecycle passed: version gate, bound MCP, typed delivery lease, no duplicate target, and thread resume');
} finally {
  await resumed?.stop({ deleteThread: true }).catch(() => {});
  await supervisor?.stop({ deleteThread: true }).catch(() => {});
  await stopProcess(dashboard?.child);
  fs.rmSync(temp, { recursive: true, force: true });
}
