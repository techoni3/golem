import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CODEX_APP_SERVER_CONTRACT, fingerprintCodexAppServerSchema } from '../lib/codex-app-server-contract.js';

// GOL-472: this is intentionally one end-to-end protocol journey, not a
// replacement supervisor. It proves exactly the installed App Server contract
// that GOL-473 may depend on, and fails closed on a CLI/schema upgrade.
const CONTRACT = CODEX_APP_SERVER_CONTRACT;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generated = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-app-server-'));
const deniedPath = path.join(generated, 'approval-must-not-create-this-file');

function version() {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `codex --version failed: ${result.stderr || result.stdout}`);
  const match = `${result.stdout}${result.stderr}`.match(/codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  assert.ok(match, `could not parse codex version: ${result.stdout || result.stderr}`);
  return match[1];
}

function methodNames(schema) {
  const names = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value?.properties?.method?.enum)) value.properties.method.enum.forEach((name) => names.add(name));
    Object.values(value).forEach(walk);
  };
  walk(schema);
  return names;
}

class AppServerRpc {
  constructor() {
    this.child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.notificationWaiters = [];
    this.requestWaiters = [];
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`app-server exited before close (code=${code}, signal=${signal}): ${this.stderr}`)));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
  }

  send(message) {
    assert.equal(this.child.exitCode, null, `cannot send after app-server exit: ${this.stderr}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error(`app-server emitted non-JSON stdout: ${line}`));
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.serverRequests.push(message);
      // The spike never permits an App Server-initiated action. It proves that
      // callbacks are observable and replyable while ensuring the requested
      // filesystem mutation remains denied.
      if (message.method === 'item/commandExecution/requestApproval') this.send({ id: message.id, result: { decision: 'decline' } });
      else if (message.method === 'execCommandApproval') this.send({ id: message.id, result: { decision: 'denied' } });
      else this.send({ id: message.id, error: { code: -32601, message: 'GOL-472 spike denies unsolicited server request' } });
      this.resolveWaiter(this.requestWaiters, message);
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
    this.resolveWaiter(this.notificationWaiters, message);
  }

  resolveWaiter(waiters, message) {
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) return;
    const [{ resolve, timer }] = waiters.splice(index, 1);
    clearTimeout(timer);
    resolve(message);
  }

  fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    for (const { reject, timer } of [...this.notificationWaiters, ...this.requestWaiters]) {
      clearTimeout(timer);
      reject(error);
    }
    this.notificationWaiters = [];
    this.requestWaiters = [];
  }

  request(method, params, timeoutMs = 15_000) {
    const id = this.pending.size + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms; stderr=${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  waitFor(kind, predicate, timeoutMs = 90_000) {
    const seen = kind === 'notification' ? this.notifications : this.serverRequests;
    const existing = seen.find(predicate);
    if (existing) return Promise.resolve(existing);
    const waiters = kind === 'notification' ? this.notificationWaiters : this.requestWaiters;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for App Server ${kind}; stderr=${this.stderr}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const deadline = Date.now() + 2_000;
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this.child.exitCode !== null || Date.now() >= deadline) {
          clearInterval(interval);
          if (this.child.exitCode === null) this.child.kill('SIGTERM');
          resolve();
        }
      }, 25);
    });
  }
}

let rpc;
let threadId;
try {
  // The CLI version is recorded, not gated — the schema fingerprint below is
  // the real contract, and a CLI upgrade that leaves the protocol untouched
  // must not fail. Assert only that a version is readable.
  assert.match(version(), /^[0-9]+\.[0-9]+\.[0-9]+$/, 'codex-cli version is readable');
  const generatedSchema = spawnSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', generated], { encoding: 'utf8' });
  assert.equal(generatedSchema.status, 0, `schema generation failed: ${generatedSchema.stderr || generatedSchema.stdout}`);
  const schemaFingerprint = fingerprintCodexAppServerSchema(generated, CONTRACT);
  assert.equal(schemaFingerprint, CONTRACT.schemaFingerprint, 'App Server contract fingerprint changed; do not run a managed supervisor until its protocol contract is reviewed');
  const clientMethods = methodNames(JSON.parse(fs.readFileSync(path.join(generated, 'ClientRequest.json'))));
  const serverMethods = methodNames(JSON.parse(fs.readFileSync(path.join(generated, 'ServerRequest.json'))));
  const notificationMethods = methodNames(JSON.parse(fs.readFileSync(path.join(generated, 'ServerNotification.json'))));
  for (const method of ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'mcpServerStatus/list']) {
    assert.ok(clientMethods.has(method), `generated client schema must expose ${method}`);
  }
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]) {
    assert.ok(serverMethods.has(method), `generated server schema must expose ${method}`);
  }
  for (const method of ['thread/name/updated', 'thread/status/changed', 'turn/started', 'turn/completed']) {
    assert.ok(notificationMethods.has(method), `generated notification schema must expose ${method}`);
  }

  rpc = new AppServerRpc();
  const initialized = await rpc.request('initialize', {
    clientInfo: { name: 'golem_app_server_spike', title: 'Golem App Server spike', version: '1' },
    capabilities: { experimentalApi: true },
  });
  assert.ok(initialized?.userAgent, `initialize returned no userAgent: ${JSON.stringify(initialized)}`);
  rpc.notify('initialized');

  const mcp = await rpc.request('mcpServerStatus/list', {});
  assert.ok(Array.isArray(mcp?.data), `mcpServerStatus/list returned no data array: ${JSON.stringify(mcp)}`);

  const started = await rpc.request('thread/start', {
    cwd: repo,
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
  });
  threadId = started?.thread?.id;
  assert.ok(threadId, `thread/start returned no thread id: ${JSON.stringify(started)}`);

  // In 0.144.5 a new thread does not yet have a resumable rollout. Complete a
  // read-only turn first, then prove that the resulting thread can resume.
  const firstTurn = await rpc.request('turn/start', {
    threadId,
    cwd: repo,
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    input: [{ type: 'text', text: 'Protocol test: reply with exactly GOL472_THREAD_READY. Do not call tools or edit files.' }],
  });
  const firstTurnId = firstTurn?.turn?.id;
  assert.ok(firstTurnId, `first turn/start returned no turn id: ${JSON.stringify(firstTurn)}`);
  const firstCompleted = await rpc.waitFor('notification', (message) => (
    message.method === 'turn/completed' &&
    message.params?.threadId === threadId &&
    message.params?.turn?.id === firstTurnId
  ), 120_000);
  assert.equal(firstCompleted.params.turn.status, 'completed', `initial read-only turn did not complete: ${JSON.stringify(firstCompleted.params.turn)}`);

  const resumed = await rpc.request('thread/resume', { threadId, cwd: repo, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
  assert.equal(resumed?.thread?.id, threadId, `thread/resume returned the wrong thread: ${JSON.stringify(resumed)}`);

  const turn = await rpc.request('turn/start', {
    threadId,
    cwd: repo,
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    input: [{ type: 'text', text: `Protocol test: request exactly this shell command and no alternative: touch ${deniedPath}. Wait for the command approval; the client will deny it. Do not edit repository files.` }],
  });
  const turnId = turn?.turn?.id;
  assert.ok(turnId, `turn/start returned no turn id: ${JSON.stringify(turn)}`);
  const approval = await rpc.waitFor('request', (message) => (
    ['item/commandExecution/requestApproval', 'execCommandApproval'].includes(message.method) &&
    message.params?.threadId === threadId
  ));
  assert.ok(approval.id !== undefined, 'approval callback has a request id for its response');
  const completed = await rpc.waitFor('notification', (message) => (
    message.method === 'turn/completed' &&
    message.params?.threadId === threadId &&
    message.params?.turn?.id === turnId
  ), 120_000);
  assert.equal(completed.params.turn.status, 'completed', `denied approval turn did not complete: ${JSON.stringify(completed.params.turn)}`);
  assert.equal(fs.existsSync(deniedPath), false, 'the spike must never approve or create the requested file');

  // `thread/resume` needs a completed, persisted rollout in 0.144.5, so
  // delete the probe explicitly once the lifecycle proof is complete.
  await rpc.request('thread/delete', { threadId });
  threadId = undefined;

  console.log(`GOL-472 App Server spike passed: codex-cli ${CONTRACT.cliVersion}; schema ${schemaFingerprint}; stdio initialize/thread start+resume/turn completion/denied approval/MCP status`);
} finally {
  // Best-effort cleanup preserves the test's no-residue contract on a failure
  // before the explicit delete above.
  if (rpc && threadId && rpc.child.exitCode === null) {
    try { await rpc.request('thread/delete', { threadId }, 5_000); } catch { /* best-effort cleanup only */ }
  }
  await rpc?.close();
  fs.rmSync(generated, { recursive: true, force: true });
}
