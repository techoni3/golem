// GOL-473/474: one Golem-owned, headless App Server process per canonical
// Codex session. It owns lifecycle/recovery and, once its required MCP is
// active, accepts a durable tracker envelope through its typed loopback adapter.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { CODEX_APP_SERVER_CONTRACT, verifyCodexAppServerContract } from './codex-app-server-contract.js';
import { CodexTuiBridge } from './codex-tui-bridge.js';
import { codexSupervisorsJsonPath } from './golem-home.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import {
  DEFAULT_LEASE_TTL_MS,
  releaseEndpointLeases,
  renewEndpointLease,
  upsertSessionFact,
  withRegistryLock,
} from './session-facts.js';

export const CODEX_SUPERVISORS_VERSION = 1;
const HEALTH_HOST = '127.0.0.1';
const RPC_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 120_000;
const READINESS_PROMPT = 'Golem supervisor readiness check. Reply with exactly GOLEM_CODEX_SUPERVISOR_READY. Do not call tools, access the network, or edit files.';
const GOLEM_MCP_SERVER_NAME = 'golem';
const GOLEM_MCP_ENTRYPOINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'channel', 'index.js');
const DELIVERY_HISTORY_LIMIT = 256;
const APPROVAL_HISTORY_LIMIT = 128;

// Pinned 0.144.5 App Server request/response pairs. "approve" always maps to
// the schema's one-off decision, never a session/policy amendment. The
// permission profile request/grant schemas share the fileSystem/network shape;
// an explicit approval echoes exactly that requested profile with scope=turn.
const APPROVAL_DECISIONS = Object.freeze({
  'item/commandExecution/requestApproval': { approve: 'accept', decline: 'decline', cancel: 'cancel' },
  'item/fileChange/requestApproval': { approve: 'accept', decline: 'decline', cancel: 'cancel' },
  execCommandApproval: { approve: 'approved', decline: 'denied', cancel: 'abort' },
  applyPatchApproval: { approve: 'approved', decline: 'denied', cancel: 'abort' },
});
const PERMISSIONS_APPROVAL_METHOD = 'item/permissions/requestApproval';

function iso(value = Date.now()) { return new Date(value).toISOString(); }

function normalizeThreadName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name || null;
}

function normalizeModelField(value) {
  if (typeof value !== 'string') return null;
  const field = value.trim();
  return field || null;
}

function projectThreadStatus(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes('waitingOnApproval')) return { status: 'waiting', waiting_for: 'approval' };
    if (flags.includes('waitingOnUserInput')) return { status: 'waiting', waiting_for: 'user input' };
    return { status: 'busy', waiting_for: null };
  }
  if (status.type === 'idle') return { status: 'idle', waiting_for: null };
  if (status.type === 'systemError') return { status: 'error', waiting_for: null };
  if (status.type === 'notLoaded') return { status: 'offline', waiting_for: null };
  return null;
}

function tomlString(value) { return JSON.stringify(String(value)); }

export function managedCodexMcpConfig({ canonicalId, cwd }) {
  // Codex documents --config dotted TOML overrides and stdio MCP entries.
  // Keep this per App Server process: neither project nor user config is
  // modified, and only the MCP child receives the canonical actor binding.
  const env = [
    `GOLEM_CEO_SESSION_ID=${tomlString(canonicalId)}`,
    'GOLEM_MANAGED_CODEX_BOUND="1"',
    `GOLEM_MANAGED_CODEX_BOUND_SESSION_ID=${tomlString(canonicalId)}`,
    'GOLEM_MANAGED_CODEX_MCP_ONLY="1"',
  ].join(',');
  return [
    `mcp_servers.${GOLEM_MCP_SERVER_NAME}.enabled=true`,
    `mcp_servers.${GOLEM_MCP_SERVER_NAME}.required=true`,
    `mcp_servers.${GOLEM_MCP_SERVER_NAME}.command=${tomlString(process.execPath)}`,
    `mcp_servers.${GOLEM_MCP_SERVER_NAME}.args=[${tomlString(GOLEM_MCP_ENTRYPOINT)}]`,
    `mcp_servers.${GOLEM_MCP_SERVER_NAME}.cwd=${tomlString(cwd)}`,
    `mcp_servers.${GOLEM_MCP_SERVER_NAME}.env={${env}}`,
  ];
}

function normalizeInbox(inbox = {}) {
  return {
    schema: 2,
    delivery_cursor: Number(inbox.delivery_cursor) || 0,
    in_flight_envelope_id: typeof inbox.in_flight_envelope_id === 'string' ? inbox.in_flight_envelope_id : null,
    last_accepted_envelope_id: typeof inbox.last_accepted_envelope_id === 'string' ? inbox.last_accepted_envelope_id : null,
    last_completed_envelope_id: typeof inbox.last_completed_envelope_id === 'string' ? inbox.last_completed_envelope_id : null,
    deliveries: Array.isArray(inbox.deliveries) ? inbox.deliveries.slice(-DELIVERY_HISTORY_LIMIT) : [],
  };
}

function normalizeApprovals(approvals = {}) {
  return {
    schema: 1,
    pending: Array.isArray(approvals.pending) ? approvals.pending.slice(-APPROVAL_HISTORY_LIMIT) : [],
    history: Array.isArray(approvals.history) ? approvals.history.slice(-APPROVAL_HISTORY_LIMIT) : [],
  };
}

function redactApproval(message, { state = 'pending', reason = null } = {}) {
  const params = message?.params && typeof message.params === 'object' ? message.params : {};
  return {
    id: crypto.randomUUID(),
    request_id: String(message?.id ?? ''),
    method: String(message?.method ?? ''),
    state,
    created_at: iso(),
    thread_id: typeof params.threadId === 'string' ? params.threadId : null,
    turn_id: typeof params.turnId === 'string' ? params.turnId : null,
    item_id: typeof params.itemId === 'string' ? params.itemId : (typeof params.callId === 'string' ? params.callId : null),
    approval_id: typeof params.approvalId === 'string' ? params.approvalId : null,
    reason: typeof params.reason === 'string' ? params.reason.slice(0, 240) : null,
    terminal_reason: reason,
  };
}

function approvalResponse(message, action) {
  if (message?.method === PERMISSIONS_APPROVAL_METHOD) {
    if (action === 'approve') {
      return {
        id: message.id,
        result: { permissions: message.params?.permissions ?? {}, scope: 'turn' },
      };
    }
    // The schema exposes no decline/cancel result. A JSON-RPC error is the
    // only fail-closed response; it cannot be mistaken for a permission grant.
    const pastTense = action === 'cancel' ? 'cancelled' : 'declined';
    return approvalFailure(message, `Golem operator ${pastTense} permission-profile approval`);
  }
  const decisions = APPROVAL_DECISIONS[message?.method];
  const decision = decisions?.[action];
  if (!decision) return null;
  return { id: message.id, result: { decision } };
}

function approvalFailure(message, explanation) {
  return { id: message.id, error: { code: -32001, message: explanation } };
}

function digestDelivery(content, senderSessionId, targetSessionId) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([content, senderSessionId ?? null, targetSessionId]))
    .digest('hex');
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== CODEX_SUPERVISORS_VERSION || !Array.isArray(parsed.supervisors)) {
      throw new Error(`invalid supervisor registry schema at ${file}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: CODEX_SUPERVISORS_VERSION, supervisors: [] };
    throw new Error(`cannot read Codex supervisor registry at ${file}: ${error.message}`, { cause: error });
  }
}

function updateRegistry(canonicalId, mutate, { file = codexSupervisorsJsonPath() } = {}) {
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const index = registry.supervisors.findIndex((row) => row.canonical_id === canonicalId);
    const previous = index >= 0 ? registry.supervisors[index] : null;
    const next = mutate(previous);
    if (next == null) {
      if (index >= 0) registry.supervisors.splice(index, 1);
    } else if (index >= 0) {
      registry.supervisors[index] = next;
    } else {
      registry.supervisors.push(next);
    }
    atomicWrite(file, registry);
    return next;
  });
}

export function readCodexSupervisors({ file = codexSupervisorsJsonPath() } = {}) {
  return readRegistry(file).supervisors;
}

export function readCodexSupervisor(canonicalId, { file = codexSupervisorsJsonPath() } = {}) {
  return readCodexSupervisors({ file }).find((row) => row.canonical_id === canonicalId) ?? null;
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function probeHealth(record, timeoutMs = 350) {
  const health = record?.health;
  if (!health?.host || !health?.port || !health?.owner_token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ session_id: record.canonical_id, owner_token: health.owner_token });
    const response = await fetch(`http://${health.host}:${health.port}/healthz?${params}`, { signal: controller.signal });
    const body = response.ok ? await response.json() : null;
    return response.ok && body?.canonical_id === record.canonical_id && body?.owner_token === health.owner_token;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function listenForHealth(supervisor) {
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', `http://${HEALTH_HOST}`);
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const expected = url.searchParams.get('session_id') === supervisor.canonicalId
          && sameSecret(url.searchParams.get('owner_token'), supervisor.ownerToken);
        if (!expected) return sendJson(response, 404, { error: 'not found' });
        return sendJson(response, 200, {
          canonical_id: supervisor.canonicalId,
          owner_token: supervisor.ownerToken,
          delivery_ready: supervisor.deliveryReady(),
        });
      }
      const approvalDetailMatch = /^\/approvals\/([A-Za-z0-9-]+)$/.exec(url.pathname);
      const approvalDecisionMatch = /^\/approvals\/([A-Za-z0-9-]+)\/decision$/.exec(url.pathname);
      if (url.pathname === '/approvals' || approvalDetailMatch || approvalDecisionMatch) {
        const target = String(request.headers['x-golem-target-session'] || '');
        const owner = String(request.headers['x-golem-endpoint-owner'] || '');
        if (target !== supervisor.canonicalId || !sameSecret(owner, supervisor.ownerToken)) {
          return sendJson(response, 403, { ok: false, error: 'operator approval authentication failed' });
        }
        if (url.pathname === '/approvals' && request.method === 'GET') {
          return sendJson(response, 200, { canonical_id: supervisor.canonicalId, pending: supervisor.listPendingApprovals() });
        }
        if (approvalDetailMatch && request.method === 'GET') {
          const detail = supervisor.approvalDetail(approvalDetailMatch[1]);
          return detail
            ? sendJson(response, 200, { canonical_id: supervisor.canonicalId, approval: detail })
            : sendJson(response, 404, { ok: false, error: 'approval is not pending in this live supervisor' });
        }
        if (approvalDecisionMatch && request.method === 'POST') {
          let body;
          try { body = JSON.parse(await readRequestBody(request)); } catch (error) {
            return sendJson(response, 400, { ok: false, error: error.message || 'invalid JSON approval decision' });
          }
          try {
            const approval = supervisor.decideApproval(approvalDecisionMatch[1], body?.decision);
            return sendJson(response, 200, { ok: true, approval });
          } catch (error) {
            return sendJson(response, /not pending/.test(String(error?.message)) ? 404 : 400, { ok: false, error: error.message || String(error) });
          }
        }
        return sendJson(response, 405, { ok: false, error: 'unsupported operator approval operation' });
      }
      if (url.pathname !== '/brief' || request.method !== 'POST') return sendJson(response, 404, { error: 'not found' });
      const target = String(request.headers['x-golem-target-session'] || '');
      const owner = String(request.headers['x-golem-endpoint-owner'] || '');
      if (request.headers['x-sender'] !== 'dashboard'
        || target !== supervisor.canonicalId
        || !sameSecret(owner, supervisor.ownerToken)) {
        return sendJson(response, 403, { ok: false, error: 'typed delivery authentication failed' });
      }
      let body;
      try { body = JSON.parse(await readRequestBody(request)); } catch (error) {
        return sendJson(response, 400, { ok: false, error: error.message || 'invalid JSON delivery envelope' });
      }
      if (!body || typeof body !== 'object'
        || typeof body.envelope_id !== 'string' || !body.envelope_id
        || typeof body.content !== 'string' || !body.content
        || (body.target_session_id != null && body.target_session_id !== supervisor.canonicalId)) {
        return sendJson(response, 400, { ok: false, error: 'typed delivery requires envelope_id, non-empty content, and the canonical target' });
      }
      const result = await supervisor.acceptDelivery({
        envelope_id: body.envelope_id,
        content: body.content,
        sender_session_id: typeof body.sender_session_id === 'string' ? body.sender_session_id : null,
        target_session_id: supervisor.canonicalId,
      });
      return sendJson(response, result.http_status, result);
    })().catch((error) => sendJson(response, 500, { ok: false, error: error.message || String(error) }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HEALTH_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Codex supervisor health endpoint did not bind a loopback port');
  }
  return { server, host: HEALTH_HOST, port: address.port };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function mergeRecord(previous, patch) {
  return {
    ...previous,
    ...patch,
    canonical_id: previous?.canonical_id ?? patch.canonical_id,
    schema: CODEX_SUPERVISORS_VERSION,
    updated_at: iso(),
  };
}

/** Minimal JSONL transport. Unknown unsolicited server requests fail closed. */
export class CodexAppServerRpc extends EventEmitter {
  constructor({ command = 'codex', cwd, env = process.env, configOverrides = [], onExit = null, onServerRequest = null } = {}) {
    super();
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = new Set();
    this.stderr = '';
    this.nextId = 1;
    this.closed = false;
    this.onServerRequest = onServerRequest;
    const args = ['app-server'];
    for (const override of configOverrides) args.push('--config', override);
    args.push('--listen', 'stdio://');
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      const error = new Error(`Codex App Server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}): ${this.stderr.trim()}`);
      this.fail(error);
      onExit?.({ code, signal, error });
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
  }

  send(message) {
    if (this.closed || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw new Error(`cannot send after Codex App Server closed: ${this.stderr.trim()}`);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      this.off('notification', waiter.listener);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  denyServerRequest(message) {
    // Responses are taken from the pinned 0.144.5 schema. Unknown requests
    // receive a JSON-RPC error instead of a guessed approval shape.
    const method = message.method;
    if (method === 'item/commandExecution/requestApproval') return { id: message.id, result: { decision: 'decline' } };
    if (method === 'item/fileChange/requestApproval') return { id: message.id, result: { decision: 'decline' } };
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { id: message.id, result: { decision: 'denied' } };
    return { id: message.id, error: { code: -32601, message: `Golem supervisor denies unsolicited App Server request ${method}` } };
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error(`Codex App Server emitted non-JSON stdout: ${line}`));
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      try {
        const outcome = this.onServerRequest?.(message);
        if (outcome && typeof outcome === 'object') this.send(outcome);
        else if (outcome !== true) this.send(this.denyServerRequest(message));
      } catch (error) { this.fail(error); }
      this.emit('server-request', message);
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
    this.emit('notification', message);
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms: ${this.stderr.trim()}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.send({ method, id, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }

  waitForNotification(predicate, timeoutMs = TURN_TIMEOUT_MS) {
    const seen = this.notifications.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { listener: null, timer: null, reject };
      const clear = () => {
        clearTimeout(waiter.timer);
        this.off('notification', waiter.listener);
        this.notificationWaiters.delete(waiter);
      };
      const timer = setTimeout(() => {
        clear();
        reject(new Error(`timed out waiting for Codex App Server notification: ${this.stderr.trim()}`));
      }, timeoutMs);
      const listener = (message) => {
        if (!predicate(message)) return;
        clear();
        resolve(message);
      };
      waiter.timer = timer;
      waiter.listener = listener;
      this.notificationWaiters.add(waiter);
      this.on('notification', listener);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const finished = await Promise.race([
      new Promise((resolve) => this.child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
    return finished;
  }
}

export class CodexSupervisor extends EventEmitter {
  constructor({ canonicalId = `codex-${crypto.randomUUID()}`, cwd = process.cwd(), command = 'codex', env = process.env, registryFile = codexSupervisorsJsonPath(), mode = 'headless' } = {}) {
    super();
    if (!canonicalId || typeof canonicalId !== 'string') throw new Error('canonicalId is required');
    if (!['headless', 'tui'].includes(mode)) throw new Error(`unsupported Codex supervisor mode: ${mode}`);
    this.canonicalId = canonicalId;
    this.cwd = path.resolve(cwd);
    this.command = command;
    this.env = env;
    this.registryFile = registryFile;
    this.mode = mode;
    this.ownerToken = crypto.randomBytes(32).toString('base64url');
    this.rpc = null;
    this.tuiBridge = null;
    this.healthServer = null;
    this.healthAddress = null;
    this.leaseHeartbeat = null;
    this.threadId = null;
    this.threadName = null;
    this.model = null;
    this.modelProvider = null;
    this.projectRoot = null;
    this.projectId = null;
    this.contract = null;
    this.mcp = { state: 'unverified', binding: null };
    // A stored thread id is recovery metadata, not evidence that a live TUI
    // has selected it. TUI delivery is eligible only after this exact client
    // has connected, initialized, and completed its own lifecycle request.
    this.tuiConnection = { connected: false, initialized: false, thread_bound: false, lifecycle: 'unbound' };
    this.deliverySerial = Promise.resolve();
    // Full approval requests exist only in this live process. The registry
    // records a redacted correlation row so a restart cannot accidentally
    // replay an approval or expose command/file contents at rest.
    this.pendingApprovals = new Map();
    this.expectedExit = false;
    this.stopped = false;
    this.stoppingPromise = null;
  }

  readRecord() { return readCodexSupervisor(this.canonicalId, { file: this.registryFile }); }

  updateRecord(patch) {
    return updateRegistry(this.canonicalId, (previous) => mergeRecord(previous, patch), { file: this.registryFile });
  }

  activateManagedMcp(mcpStatus) {
    const golem = Array.isArray(mcpStatus?.data)
      ? mcpStatus.data.find((entry) => entry?.name === GOLEM_MCP_SERVER_NAME)
      : null;
    const tools = golem?.tools && typeof golem.tools === 'object' ? Object.keys(golem.tools) : [];
    if (!golem || golem.serverInfo?.name !== GOLEM_MCP_SERVER_NAME
      || !tools.includes('ticket_dispatch') || !tools.includes('sessions_dispatchable')) {
      throw new Error(`Codex App Server did not activate the required Golem MCP binding: ${JSON.stringify(mcpStatus)}`);
    }
    this.mcp = {
      state: 'active',
      binding: this.canonicalId,
      server_name: GOLEM_MCP_SERVER_NAME,
      tools,
      checked_at: iso(),
    };
    this.updateRecord({ mcp: this.mcp });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    if (this.threadId) this.writeRuntimeFact('supervisor-tui-mcp-active');
    return this.mcp;
  }

  markTuiMcpFailure(error) {
    this.mcp = { state: 'failed', binding: this.canonicalId, checked_at: iso() };
    this.updateRecord({ mcp: this.mcp, last_error: `TUI MCP verification failed: ${error.message}` });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    if (this.threadId) this.writeFact('error', 'supervisor-tui-mcp-failed', { error: error.message });
  }

  noteTuiConnected() {
    if (this.mode !== 'tui') return;
    this.tuiConnection = {
      ...this.tuiConnection,
      connected: true,
      initialized: false,
      // A reconnect must perform its own thread lifecycle request. A registry
      // id alone cannot prove the new TUI is actually attached to that thread.
      thread_bound: false,
      lifecycle: 'unbound',
      connected_at: iso(),
    };
    this.updateRecord({
      lifecycle: { ...(this.readRecord()?.lifecycle ?? {}), tui_connection: 'connected', tui_connected_at: iso() },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    if (this.threadId) this.writeFact('initializing', 'supervisor-tui-connected-awaiting-initialize');
  }

  noteTuiInitialized() {
    if (this.mode !== 'tui') return;
    this.tuiConnection = { ...this.tuiConnection, initialized: true, initialized_at: iso() };
    this.updateRecord({
      lifecycle: { ...(this.readRecord()?.lifecycle ?? {}), tui_initialized_at: iso() },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    if (this.threadId) this.writeFact('initializing', 'supervisor-tui-initialized-awaiting-thread');
  }

  noteTuiDisconnected() {
    if (this.mode !== 'tui') return;
    this.tuiConnection = {
      ...this.tuiConnection,
      connected: false,
      initialized: false,
      thread_bound: false,
      lifecycle: 'unbound',
      disconnected_at: iso(),
    };
    this.updateRecord({
      lifecycle: { ...(this.readRecord()?.lifecycle ?? {}), tui_connection: 'disconnected', tui_disconnected_at: iso() },
    });
    // Do this before bridge cleanup starts so a concurrent direct delivery
    // observes a closed gate rather than a stale healthy lease.
    if (this.healthAddress) this.persistLease(this.healthAddress);
    if (this.threadId) this.writeFact('offline', 'supervisor-tui-disconnected');
  }

  noteTuiThreadRequested({ requestId, method }) {
    if (this.mode !== 'tui') return { tracked: false };
    const record = this.readRecord();
    const prior = {
      threadId: this.threadId,
      connection: { ...this.tuiConnection },
      turn: record?.turn ?? { state: 'idle', turn_id: null },
    };
    // /new, resume, and fork are asynchronous changes of canonical target.
    // Keep the old mapping for recovery but make it non-dispatchable before
    // the request reaches App Server. Only a response failure restores it.
    this.tuiConnection = {
      ...this.tuiConnection,
      thread_bound: false,
      lifecycle: 'pending',
      lifecycle_request_id: requestId,
      lifecycle_method: method,
      lifecycle_started_at: iso(),
    };
    this.updateRecord({
      lifecycle: {
        ...(record?.lifecycle ?? {}),
        tui_lifecycle: 'pending', tui_lifecycle_request_id: requestId,
        tui_thread_method: method, tui_thread_started_at: iso(),
      },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    if (this.threadId) this.writeFact('initializing', 'supervisor-tui-thread-transition', { tui_thread_method: method });
    // Emitted after durable gating and before the bridge forwards the frame;
    // it is useful to observe the no-injection race boundary in journeys.
    this.emit('tui-thread-transition', { state: 'pending', request_id: requestId, method });
    return { tracked: true, requestId, prior };
  }

  noteTuiThread(method, response, tracking = null) {
    const record = this.readRecord();
    const pending = tracking?.tracked
      && this.tuiConnection.lifecycle === 'pending'
      && this.tuiConnection.lifecycle_request_id === tracking.requestId;
    if (response?.error) {
      if (!pending) return;
      this.threadId = tracking.prior.threadId;
      this.tuiConnection = { ...tracking.prior.connection, lifecycle: tracking.prior.connection.lifecycle || 'unbound' };
      this.updateRecord({
        thread_id: this.threadId,
        lifecycle: {
          ...(record?.lifecycle ?? {}),
          tui_lifecycle: this.tuiConnection.lifecycle,
          tui_thread_rejected_at: iso(), tui_thread_method: method,
        },
        turn: tracking.prior.turn,
      });
      if (this.healthAddress) this.persistLease(this.healthAddress);
      if (this.threadId) this.writeRuntimeFact('supervisor-tui-thread-transition-rejected', { tui_thread_method: method });
      return;
    }
    const threadId = response?.result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) {
      // A malformed success result is not a successful rebind. Preserve the
      // old canonical mapping instead of silently replacing it with null.
      this.noteTuiThread(method, { error: { code: -32000, message: 'thread lifecycle response omitted thread.id' } }, tracking);
      return;
    }
    if (!pending) return;
    // Only responses to the TUI's own start/resume/fork requests call this
    // method. Server-created ThreadStarted broadcasts are deliberately not a
    // canonical-session signal because they can describe a subagent thread.
    this.threadId = threadId;
    this.threadName = normalizeThreadName(response?.result?.thread?.name);
    this.model = normalizeModelField(response?.result?.model) ?? this.model;
    this.modelProvider = normalizeModelField(response?.result?.modelProvider) ?? this.modelProvider;
    this.tuiConnection = {
      ...this.tuiConnection,
      thread_bound: this.tuiConnection.connected && this.tuiConnection.initialized,
      lifecycle: 'bound',
      bound_at: iso(),
    };
    this.updateRecord({
      thread_id: threadId,
      thread_name: this.threadName,
      model: this.model,
      model_provider: this.modelProvider,
      thread_status: response?.result?.thread?.status ?? record?.thread_status ?? null,
      lifecycle: {
        ...(this.readRecord()?.lifecycle ?? {}), tui_lifecycle: 'bound',
        tui_thread_method: method, tui_thread_at: iso(),
      },
      turn: { state: 'idle', turn_id: null, kind: 'tui', thread_bound_at: iso() },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    this.writeRuntimeFact('supervisor-tui-thread-bound', { tui_thread_method: method });
  }

  noteTuiTurnStarted({ requestId, method, params }) {
    if (!this.threadId || params?.threadId !== this.threadId) return { priorTurnId: null, tracked: false };
    const record = this.readRecord();
    const current = record?.turn ?? {};
    const priorTurnId = ['busy', 'starting'].includes(current.state) ? (current.turn_id ?? null) : null;
    // Persist this before the frame reaches App Server. A human start or steer
    // can otherwise race a dashboard dispatch, and App Server may answer a
    // steer with a misleading fresh-looking turn id while the original remains
    // active. The busy marker, not that response id, is the dispatch gate.
    this.updateRecord({
      turn: {
        ...current,
        state: 'busy',
        turn_id: priorTurnId,
        kind: 'tui',
        tui_request_id: requestId,
        tui_method: method,
        started_at: iso(),
      },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    this.writeFact('busy', 'supervisor-tui-turn-started', { tui_method: method });
    return { priorTurnId, tracked: true };
  }

  noteTuiTurnResponse({ requestId, response, tracking }) {
    if (!tracking?.tracked) return;
    const record = this.readRecord();
    const current = record?.turn ?? {};
    if (current.tui_request_id !== requestId) return;
    if (response?.error) {
      // A rejected steer can arrive while the original human turn remains
      // active. Its prior id is the authoritative busy state until a terminal
      // notification for that turn is observed.
      const priorTurnId = tracking.priorTurnId;
      this.updateRecord({
        turn: priorTurnId
          ? { ...current, state: 'busy', turn_id: priorTurnId, kind: 'tui', response_rejected_at: iso(), completion_status: null }
          : { state: 'idle', turn_id: null, kind: 'tui', completed_at: iso(), completion_status: 'request_rejected' },
      });
      if (this.healthAddress) this.persistLease(this.healthAddress);
      if (priorTurnId) this.writeFact('busy', 'supervisor-tui-turn-rejected', { retained_turn_id: priorTurnId });
      else this.writeRuntimeFact('supervisor-tui-turn-rejected', { retained_turn_id: null });
      return;
    }
    // A turn/steer response is not proof that a new turn replaced an active
    // one. Keep the pre-existing id until a terminal notification says so.
    const turnId = tracking.priorTurnId ?? response?.result?.turn?.id ?? null;
    this.updateRecord({
      turn: { ...current, state: 'busy', turn_id: turnId, kind: 'tui', started_at: current.started_at || iso() },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
  }

  approvalState() { return normalizeApprovals(this.readRecord()?.approvals); }

  persistApprovalState(state) {
    return this.updateRecord({ approvals: normalizeApprovals(state) });
  }

  handleServerRequest(message) {
    if (!APPROVAL_DECISIONS[message?.method] && message?.method !== PERMISSIONS_APPROVAL_METHOD) return false;
    const state = this.approvalState();
    const approval = redactApproval(message);
    state.pending.push(approval);
    this.pendingApprovals.set(approval.id, { message, approval });
    this.persistApprovalState(state);
    this.emit('approval-pending', { ...approval });
    return true;
  }

  listPendingApprovals() {
    return this.approvalState().pending;
  }

  approvalDetail(approvalId) {
    const live = this.pendingApprovals.get(approvalId);
    if (!live) return null;
    // This is intentionally the sole surface that returns unredacted live
    // request parameters. The loopback endpoint authenticates it with the
    // private supervisor owner token before calling this method.
    return { ...live.approval, request: live.message };
  }

  decideApproval(approvalId, action) {
    if (!['approve', 'decline', 'cancel'].includes(action)) throw new Error('approval decision must be approve, decline, or cancel');
    const live = this.pendingApprovals.get(approvalId);
    if (!live) throw new Error('approval is not pending in this live supervisor');
    const response = approvalResponse(live.message, action);
    if (!response) throw new Error(`approval method ${live.message.method} has no schema-proven ${action} response`);
    this.rpc.send(response);
    this.pendingApprovals.delete(approvalId);
    const state = this.approvalState();
    state.pending = state.pending.filter((approval) => approval.id !== approvalId);
    state.history.push({ ...live.approval, state: action === 'approve' ? 'approved' : 'declined', decision: action, resolved_at: iso() });
    this.persistApprovalState(state);
    this.emit('approval-resolved', { ...live.approval, decision: action });
    return { ...live.approval, decision: action };
  }

  failPendingApprovals({ reason, respond = false } = {}) {
    const state = this.approvalState();
    const pending = [...this.pendingApprovals.values()];
    for (const live of pending) {
      if (respond) {
        try {
          const response = approvalResponse(live.message, 'decline')
            ?? approvalFailure(live.message, 'Golem supervisor closed before an operator decision');
          this.rpc?.send(response);
        } catch { /* process is already gone; durable failure below is authoritative */ }
      }
      this.pendingApprovals.delete(live.approval.id);
    }
    if (!state.pending.length) return;
    const now = iso();
    for (const approval of state.pending) {
      state.history.push({ ...approval, state: 'failed_closed', terminal_reason: reason || 'supervisor_stopped', resolved_at: now });
    }
    state.pending = [];
    this.persistApprovalState(state);
  }

  writeFact(status, lifecycleEvent, observations = {}) {
    if (!this.threadId) return null;
    return upsertSessionFact({
      canonical_id: this.canonicalId,
      continuation_key: `codex-app-server:${this.threadId}`,
      harness: 'codex',
      locator: { raw_session_id: this.threadId },
      project_path: this.cwd,
      name: this.threadName,
      model: this.model,
      model_provider: this.modelProvider,
      status,
      waiting_for: status === 'waiting' ? (observations.waiting_for ?? null) : null,
      delivery: this.deliveryReady()
        ? { mode: 'supervisor-turn', push: true }
        : { mode: 'supervisor-pending', push: false },
      lifecycle_event: lifecycleEvent,
      observations: {
        managed: true,
        mode: this.mode,
        transport: 'stdio',
        project_id: this.projectId,
        thread_id: this.threadId,
        version: this.contract?.cli_version ?? null,
        schema_fingerprint: this.contract?.schema_fingerprint ?? null,
        mcp_state: this.mcp.state,
        ...observations,
      },
    });
  }

  runtimeProjection(record = this.readRecord()) {
    const projected = projectThreadStatus(record?.thread_status);
    if (projected?.status === 'busy' || projected?.status === 'waiting'
      || projected?.status === 'error' || projected?.status === 'offline') return projected;
    const turnState = record?.turn?.state;
    if (turnState === 'busy' || turnState === 'starting') return { status: 'busy', waiting_for: null };
    // App Server's thread status is the activity truth. A failed/interrupted
    // durable delivery can keep the dispatch gate closed until recovery while
    // the interactive thread itself is already idle.
    if (projected?.status === 'idle') return { status: 'idle', waiting_for: null };
    if (turnState === 'recovery_pending' || turnState === 'failed') return { status: 'error', waiting_for: null };
    if (turnState === 'idle') return { status: 'idle', waiting_for: null };
    return { status: this.deliveryReady(record) ? 'idle' : 'initializing', waiting_for: null };
  }

  writeRuntimeFact(lifecycleEvent, observations = {}) {
    const projection = this.runtimeProjection();
    return this.writeFact(projection.status, lifecycleEvent, {
      ...observations,
      waiting_for: projection.waiting_for,
    });
  }

  noteThreadName(params = {}) {
    if (params.threadId !== this.threadId) return;
    this.threadName = normalizeThreadName(params.threadName);
    this.updateRecord({ thread_name: this.threadName });
    this.writeRuntimeFact('supervisor-thread-name-updated');
  }

  noteThreadSettings(params = {}) {
    if (params.threadId !== this.threadId || !params.threadSettings) return;
    this.model = normalizeModelField(params.threadSettings.model) ?? this.model;
    this.modelProvider = normalizeModelField(params.threadSettings.modelProvider) ?? this.modelProvider;
    this.updateRecord({ model: this.model, model_provider: this.modelProvider });
    this.writeRuntimeFact('supervisor-thread-settings-updated', { model_provider: this.modelProvider });
  }

  noteThreadStatus(params = {}) {
    if (params.threadId !== this.threadId) return;
    const projection = projectThreadStatus(params.status);
    if (!projection) return;
    const record = this.readRecord();
    const inbox = normalizeInbox(record?.inbox);
    let turn = record?.turn ?? { state: 'idle', turn_id: null };
    if (projection.status === 'busy' || projection.status === 'waiting') {
      turn = { ...turn, state: 'busy' };
    } else if (projection.status === 'idle' && !inbox.in_flight_envelope_id
      && turn.state !== 'failed' && turn.state !== 'recovery_pending') {
      turn = { ...turn, state: 'idle' };
    } else if (projection.status === 'error') {
      turn = { ...turn, state: 'failed' };
    } else if (projection.status === 'offline') {
      turn = { ...turn, state: 'unavailable' };
    }
    this.updateRecord({ thread_status: params.status, turn });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    this.writeRuntimeFact('supervisor-thread-status-changed', { waiting_for: projection.waiting_for });
  }

  noteTurnStarted(params = {}) {
    if (params.threadId !== this.threadId || !params.turn?.id) return;
    const record = this.readRecord();
    const inbox = normalizeInbox(record?.inbox);
    const inFlight = inbox.in_flight_envelope_id;
    this.updateRecord({
      thread_status: { type: 'active', activeFlags: [] },
      turn: {
        ...(record?.turn ?? {}),
        state: 'busy',
        turn_id: params.turn.id,
        kind: inFlight ? 'dispatch' : (record?.turn?.kind ?? 'tui'),
        ...(inFlight ? { envelope_id: inFlight } : {}),
        started_at: record?.turn?.started_at || iso(),
      },
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    this.writeFact('busy', 'supervisor-turn-started', { turn_id: params.turn.id });
  }

  deliveryReady(record = this.readRecord()) {
    const inbox = normalizeInbox(record?.inbox);
    const threadActivity = projectThreadStatus(record?.thread_status);
    return Boolean(
      this.healthServer
      && this.threadId
      && this.mcp.state === 'active'
      && this.mcp.binding === this.canonicalId
      && (this.mode !== 'tui' || (
        this.tuiConnection.connected
        && this.tuiConnection.initialized
        && this.tuiConnection.thread_bound
        && this.tuiConnection.lifecycle === 'bound'
      ))
      && !['busy', 'waiting', 'error', 'offline'].includes(threadActivity?.status)
      && record?.turn?.state === 'idle'
      && !inbox.in_flight_envelope_id,
    );
  }

  async markStale(existing, reason) {
    if (!existing) return;
    if (existing.health?.owner_token) {
      releaseEndpointLeases(existing.health.owner_token, { canonicalId: this.canonicalId });
    }
    updateRegistry(this.canonicalId, (previous) => mergeRecord(previous, {
      health: { ...(previous?.health ?? {}), state: 'stale', stale_at: iso(), stale_reason: reason },
      process: { ...(previous?.process ?? {}), stale_at: iso() },
    }), { file: this.registryFile });
  }

  async prepareRecovery() {
    const existing = this.readRecord();
    if (!existing) return null;
    if (existing.health?.state === 'healthy') {
      if (await probeHealth(existing)) {
        throw new Error(`Codex supervisor ${this.canonicalId} is already healthy (pid=${existing.process?.pid ?? 'unknown'}); refusing to create a duplicate App Server`);
      }
      await this.markStale(existing, pidAlive(existing.process?.pid) ? 'health_endpoint_unreachable' : 'recorded_process_dead');
    }
    return existing;
  }

  persistLease({ host, port }) {
    const deliveryReady = this.deliveryReady();
    const lease = renewEndpointLease({
      canonical_id: this.canonicalId,
      owner_token: this.ownerToken,
      host,
      port,
      pid: this.rpc?.child?.pid ?? null,
      harness: 'codex',
      transport: 'stdio',
      kind: 'codex-supervisor',
      delivery_ready: deliveryReady,
    });
    this.updateRecord({
      health: {
        state: 'healthy', host, port, owner_token: this.ownerToken,
        delivery_ready: deliveryReady, lease_expires_at: lease.expires_at, checked_at: iso(),
      },
    });
  }

  startLeaseHeartbeat(host, port) {
    const interval = Math.max(1_000, Math.floor(DEFAULT_LEASE_TTL_MS / 3));
    this.leaseHeartbeat = setInterval(() => {
      try { this.persistLease({ host, port }); } catch (error) { this.handleUnexpectedExit({ error, reason: 'lease_renewal_failed' }); }
    }, interval);
    this.leaseHeartbeat.unref?.();
  }

  async initializeRpc(existing) {
    this.rpc = new CodexAppServerRpc({
      command: this.command,
      cwd: this.cwd,
      env: this.env,
      configOverrides: managedCodexMcpConfig({ canonicalId: this.canonicalId, cwd: this.cwd }),
      onExit: ({ error }) => this.handleUnexpectedExit({ error, reason: 'app_server_exit' }),
      onServerRequest: (message) => this.handleServerRequest(message),
    });
    this.rpc.on('notification', (message) => this.handleNotification(message));
    const initialized = await this.rpc.request('initialize', {
      clientInfo: { name: 'golem_codex_supervisor', title: 'Golem Codex Supervisor', version: '1' },
      capabilities: { experimentalApi: true },
    });
    if (!initialized?.userAgent) throw new Error(`Codex App Server initialize returned no userAgent: ${JSON.stringify(initialized)}`);
    this.rpc.notify('initialized');

    const mcpStatus = await this.rpc.request('mcpServerStatus/list', {});
    this.activateManagedMcp(mcpStatus);

    if (existing?.thread_id) {
      const resumed = await this.rpc.request('thread/resume', {
        threadId: existing.thread_id,
        cwd: this.cwd,
        sandbox: 'read-only',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
      });
      if (resumed?.thread?.id !== existing.thread_id) {
        throw new Error(`Codex App Server resume returned the wrong thread: ${JSON.stringify(resumed)}`);
      }
      this.threadId = existing.thread_id;
      this.threadName = normalizeThreadName(resumed?.thread?.name) ?? this.threadName;
      this.model = normalizeModelField(resumed?.model) ?? this.model;
      this.modelProvider = normalizeModelField(resumed?.modelProvider) ?? this.modelProvider;
      this.updateRecord({
        thread_name: this.threadName,
        thread_status: resumed?.thread?.status ?? null,
        model: this.model,
        model_provider: this.modelProvider,
      });
      return { resumed: true };
    }

    const started = await this.rpc.request('thread/start', {
      cwd: this.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
    });
    this.threadId = started?.thread?.id ?? null;
    if (!this.threadId) throw new Error(`Codex App Server thread/start returned no thread id: ${JSON.stringify(started)}`);
    this.threadName = normalizeThreadName(started?.thread?.name);
    this.model = normalizeModelField(started?.model) ?? this.model;
    this.modelProvider = normalizeModelField(started?.modelProvider) ?? this.modelProvider;
    this.updateRecord({
      thread_name: this.threadName,
      thread_status: started?.thread?.status ?? null,
      model: this.model,
      model_provider: this.modelProvider,
    });
    return { resumed: false };
  }

  async initializeTuiBridge() {
    this.tuiBridge = new CodexTuiBridge({
      supervisor: this,
      command: this.command,
      cwd: this.cwd,
      env: this.env,
      configOverrides: managedCodexMcpConfig({ canonicalId: this.canonicalId, cwd: this.cwd }),
      onAppServerExit: ({ error }) => this.handleUnexpectedExit({ error, reason: 'app_server_exit' }),
      onTuiExit: () => {
        this.emit('tui-exit');
        // A remote TUI disconnect is the lifecycle boundary for this wrapper,
        // not an invitation to leave a hidden App Server/socket alive.
        void this.stop().catch(() => {});
      },
    });
    await this.tuiBridge.start();
    this.rpc = this.tuiBridge;
    return { resumed: false, tui: true };
  }

  async establishReadinessTurn() {
    const started = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      cwd: this.cwd,
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      input: [{ type: 'text', text: READINESS_PROMPT }],
    }, TURN_TIMEOUT_MS);
    const turnId = started?.turn?.id;
    if (!turnId) throw new Error(`Codex App Server readiness turn returned no turn id: ${JSON.stringify(started)}`);
    this.updateRecord({
      turn: { state: 'busy', turn_id: turnId, started_at: iso(), kind: 'readiness' },
      inbox: normalizeInbox(),
    });
    this.writeFact('busy', 'supervisor-readiness-turn-start', { turn_id: turnId });
    const completed = await this.rpc.waitForNotification((message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === this.threadId
      && message.params?.turn?.id === turnId
    ), TURN_TIMEOUT_MS);
    if (completed.params?.turn?.status !== 'completed') {
      throw new Error(`Codex App Server readiness turn did not complete: ${JSON.stringify(completed.params?.turn)}`);
    }
  }

  handleNotification(message) {
    if (message.method === 'thread/name/updated') {
      this.noteThreadName(message.params);
      return;
    }
    if (message.method === 'thread/status/changed') {
      this.noteThreadStatus(message.params);
      return;
    }
    if (message.method === 'thread/settings/updated') {
      this.noteThreadSettings(message.params);
      return;
    }
    if (message.method === 'turn/started') {
      this.noteTurnStarted(message.params);
      return;
    }
    if (message.method !== 'turn/completed' || message.params?.threadId !== this.threadId) return;
    const turn = message.params.turn ?? {};
    const completed = turn.status === 'completed';
    const record = this.readRecord();
    const inbox = normalizeInbox(record?.inbox);
    let index = inbox.deliveries.findIndex((delivery) => delivery.turn_id === turn.id);
    // A very fast App Server completion can beat persistence of the turn/start
    // response. The serialized inbox has at most one in-flight envelope, so it
    // is safe to attach that completion to its accepted mapping.
    if (index < 0 && inbox.in_flight_envelope_id) {
      index = inbox.deliveries.findIndex((delivery) => (
        delivery.envelope_id === inbox.in_flight_envelope_id && delivery.state === 'accepted'
      ));
    }
    if (index >= 0) {
      const delivery = inbox.deliveries[index];
      inbox.deliveries[index] = {
        ...delivery,
        state: completed ? 'completed' : 'failed',
        turn_id: turn.id ?? delivery.turn_id ?? null,
        completed_at: iso(),
        completion_status: turn.status ?? null,
      };
      inbox.in_flight_envelope_id = null;
      if (completed) inbox.last_completed_envelope_id = delivery.envelope_id;
    }
    // `turn/completed` is a terminal boundary for the session even when the
    // turn itself failed or was interrupted. A dispatched envelope keeps its
    // own failed result above, but that must not strand an otherwise reusable
    // TUI in a permanently working/dead state.
    const terminalState = index >= 0 && !completed ? 'failed' : 'idle';
    this.updateRecord({
      thread_status: { type: 'idle' },
      turn: {
        state: terminalState, turn_id: turn.id ?? null,
        completed_at: iso(), completion_status: turn.status ?? null,
      },
      inbox,
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    this.writeRuntimeFact('supervisor-turn-completed', {
      turn_id: turn.id ?? null, completion_status: turn.status ?? null,
    });
  }

  deliveryResult(delivery, { duplicate = false, httpStatus = 200 } = {}) {
    return {
      ok: true,
      accepted: true,
      duplicate,
      http_status: httpStatus,
      envelope_id: delivery.envelope_id,
      turn_id: delivery.turn_id ?? null,
      delivery_state: delivery.state,
      accepted_at: delivery.accepted_at,
    };
  }

  acceptDelivery(envelope) {
    const execute = async () => this.acceptDeliverySerial(envelope);
    const next = this.deliverySerial.then(execute, execute);
    this.deliverySerial = next.catch(() => {});
    return next;
  }

  async acceptDeliverySerial(envelope) {
    const record = this.readRecord();
    const inbox = normalizeInbox(record?.inbox);
    const digest = digestDelivery(envelope.content, envelope.sender_session_id, envelope.target_session_id);
    const existing = inbox.deliveries.find((delivery) => delivery.envelope_id === envelope.envelope_id);
    if (existing) {
      // The authenticated dashboard owns immutable envelope content. Once its
      // id has a persisted mapping, a replay must return that mapping and must
      // never inspect retry bytes closely enough to create a second turn.
      // This also survives a caller that lost the original rendered brief.
      return this.deliveryResult(existing, { duplicate: true });
    }
    if (!this.deliveryReady(record)) {
      return { ok: false, accepted: false, http_status: 409, error: 'managed Codex target is not idle and delivery-ready' };
    }

    // Write acceptance before the external RPC. A process loss in the narrow
    // request/record gap remains recovery_pending rather than replaying a
    // potentially-started turn; at-most-once is safer than a duplicate task.
    const accepted = {
      envelope_id: envelope.envelope_id,
      target_session_id: envelope.target_session_id,
      sender_session_id: envelope.sender_session_id,
      digest,
      state: 'accepted',
      accepted_at: iso(),
      turn_id: null,
    };
    inbox.deliveries.push(accepted);
    inbox.deliveries = inbox.deliveries.slice(-DELIVERY_HISTORY_LIMIT);
    inbox.delivery_cursor += 1;
    inbox.in_flight_envelope_id = accepted.envelope_id;
    inbox.last_accepted_envelope_id = accepted.envelope_id;
    this.updateRecord({
      turn: { state: 'starting', turn_id: null, envelope_id: accepted.envelope_id, started_at: accepted.accepted_at, kind: 'dispatch' },
      inbox,
    });
    if (this.healthAddress) this.persistLease(this.healthAddress);
    this.writeFact('busy', 'supervisor-delivery-accepted', { envelope_id: accepted.envelope_id });

    let started;
    try {
      const turnStart = {
        threadId: this.threadId,
        cwd: this.cwd,
        clientUserMessageId: accepted.envelope_id,
        input: [{ type: 'text', text: envelope.content }],
      };
      // The live interactive TUI owns its model, sandbox, and approval
      // configuration. Sending any of these optional overrides here would
      // turn a tracker dispatch into a hidden policy change. Headless mode
      // retains its deliberately conservative settings below.
      if (this.mode === 'headless') {
        turnStart.sandboxPolicy = { type: 'readOnly', networkAccess: false };
        turnStart.approvalPolicy = 'untrusted';
        turnStart.approvalsReviewer = 'user';
      }
      started = await this.rpc.request('turn/start', turnStart, TURN_TIMEOUT_MS);
    } catch (error) {
      // No retry is attempted: the external server may have accepted the turn
      // even when its response was lost. Keep the durable mapping unresolved.
      this.updateRecord({
        turn: { state: 'recovery_pending', turn_id: null, envelope_id: accepted.envelope_id, failed_at: iso(), kind: 'dispatch' },
        inbox,
        last_error: `delivery turn start outcome unknown: ${error.message}`,
      });
      if (this.healthAddress) this.persistLease(this.healthAddress);
      this.writeFact('error', 'supervisor-delivery-recovery-pending', { envelope_id: accepted.envelope_id });
      return { ok: false, accepted: true, http_status: 503, error: 'delivery outcome is recovery-pending; it will not be replayed automatically', envelope_id: accepted.envelope_id };
    }
    const turnId = started?.turn?.id;
    if (!turnId) {
      this.updateRecord({
        turn: { state: 'recovery_pending', turn_id: null, envelope_id: accepted.envelope_id, failed_at: iso(), kind: 'dispatch' },
        inbox,
        last_error: `turn/start returned no turn id: ${JSON.stringify(started)}`,
      });
      if (this.healthAddress) this.persistLease(this.healthAddress);
      return { ok: false, accepted: true, http_status: 503, error: 'delivery outcome is recovery-pending; it will not be replayed automatically', envelope_id: accepted.envelope_id };
    }
    const latest = normalizeInbox(this.readRecord()?.inbox);
    const latestIndex = latest.deliveries.findIndex((delivery) => delivery.envelope_id === accepted.envelope_id);
    // A completion may have arrived immediately after the RPC result. Preserve
    // that terminal state rather than overwriting it back to busy.
    if (latestIndex < 0) throw new Error(`accepted envelope ${accepted.envelope_id} disappeared from the durable inbox`);
    const persisted = latest.deliveries[latestIndex];
    latest.deliveries[latestIndex] = {
      ...persisted,
      state: persisted.state === 'completed' ? 'completed' : 'started',
      turn_id: turnId,
      started_at: persisted.started_at || iso(),
    };
    this.updateRecord({
      turn: persisted.state === 'completed'
        ? this.readRecord()?.turn
        : { state: 'busy', turn_id: turnId, envelope_id: accepted.envelope_id, started_at: iso(), kind: 'dispatch' },
      inbox: latest,
    });
    return this.deliveryResult(latest.deliveries[latestIndex], { httpStatus: 202 });
  }

  handleUnexpectedExit({ error, reason }) {
    if (this.expectedExit || this.stopped) return;
    this.stopped = true;
    // In TUI mode the bridge owns a private Unix listener in addition to the
    // App Server child. An App Server death must close that listener too;
    // otherwise a stale local socket could outlive the released lease.
    if (this.tuiBridge) void this.tuiBridge.close().catch(() => {});
    this.failPendingApprovals({ reason: reason || 'app_server_exit', respond: false });
    if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat);
    this.leaseHeartbeat = null;
    if (this.healthServer) this.healthServer.close();
    this.healthServer = null;
    this.healthAddress = null;
    releaseEndpointLeases(this.ownerToken, { canonicalId: this.canonicalId });
    this.updateRecord({
      process: { pid: this.rpc?.child?.pid ?? null, transport: 'stdio', exited_at: iso(), exit_reason: reason },
      health: { state: 'dead', dead_at: iso(), reason, delivery_ready: false },
      turn: { ...(this.readRecord()?.turn ?? {}), state: 'failed', failed_at: iso() },
      last_error: error?.message ?? String(error ?? reason),
    });
    this.writeFact('dead', 'supervisor-dead', { reason, error: error?.message ?? null });
    this.emit('dead', { error, reason });
  }

  async start() {
    if (this.stoppingPromise) await this.stoppingPromise;
    this.stoppingPromise = null;
    this.expectedExit = false;
    this.stopped = false;
    this.contract = verifyCodexAppServerContract({ command: this.command, contract: CODEX_APP_SERVER_CONTRACT });
    this.projectRoot = await resolveProjectRoot(this.cwd);
    this.projectId = projectIdFor(this.projectRoot);
    const existing = await this.prepareRecovery();
    // Preserve a requested TUI session's recovery mapping until the TUI itself
    // successfully resumes or replaces it. deliveryReady still remains false
    // because tuiConnection.thread_bound starts false.
    if (this.mode === 'tui') this.threadId = existing?.thread_id ?? null;
    this.threadName = normalizeThreadName(existing?.thread_name);
    this.model = normalizeModelField(existing?.model);
    this.modelProvider = normalizeModelField(existing?.model_provider);
    const recoveredInbox = normalizeInbox(existing?.inbox);
    const recoveredApprovals = normalizeApprovals(existing?.approvals);
    if (recoveredApprovals.pending.length) {
      const closedAt = iso();
      recoveredApprovals.history.push(...recoveredApprovals.pending.map((approval) => ({
        ...approval,
        state: 'failed_closed',
        terminal_reason: 'supervisor_restarted_before_operator_decision',
        resolved_at: closedAt,
      })));
      recoveredApprovals.pending = [];
    }
    this.updateRecord({
      canonical_id: this.canonicalId,
      thread_id: existing?.thread_id ?? null,
      thread_name: this.threadName,
      model: this.model,
      model_provider: this.modelProvider,
      thread_status: existing?.thread_status ?? null,
      cwd: this.cwd,
      project_root: this.projectRoot,
      project_id: this.projectId,
      mode: this.mode,
      version: this.contract,
      process: { pid: null, transport: 'stdio', starting_at: iso() },
      health: { state: 'starting', delivery_ready: false },
      turn: existing?.turn ?? { state: 'idle', turn_id: null },
      inbox: recoveredInbox,
      approvals: normalizeApprovals(recoveredApprovals),
      mcp: { state: 'starting', binding: this.canonicalId },
    });
    try {
      const lifecycle = this.mode === 'tui'
        ? await this.initializeTuiBridge()
        : await this.initializeRpc(existing);
      this.updateRecord({
        thread_id: this.threadId,
        process: { pid: this.rpc.child.pid, transport: 'stdio', started_at: iso() },
        lifecycle: { ...(this.readRecord()?.lifecycle ?? {}), resumed: lifecycle.resumed, last_started_at: iso() },
        mcp: this.mcp,
      });
      if (this.mode === 'headless' && !lifecycle.resumed) await this.establishReadinessTurn();
      const inFlight = normalizeInbox(this.readRecord()?.inbox).deliveries.find((delivery) => (
        delivery.envelope_id === normalizeInbox(this.readRecord()?.inbox).in_flight_envelope_id
        && (delivery.state === 'accepted' || delivery.state === 'started')
      ));
      if (this.mode === 'headless' && lifecycle.resumed && inFlight) {
        this.updateRecord({
          turn: {
            state: 'recovery_pending', turn_id: inFlight.turn_id ?? null,
            envelope_id: inFlight.envelope_id, recovered_at: iso(), kind: 'dispatch',
          },
        });
        this.writeFact('error', 'supervisor-delivery-recovery-pending', { envelope_id: inFlight.envelope_id, resumed: true });
      } else if (this.mode === 'headless' && lifecycle.resumed) {
        this.updateRecord({ turn: { state: 'idle', turn_id: null, resumed_at: iso() } });
        this.writeFact('idle', 'supervisor-resumed', { resumed: true });
      }

      const health = await listenForHealth(this);
      this.healthServer = health.server;
      this.healthAddress = { host: health.host, port: health.port };
      this.persistLease(health);
      this.startLeaseHeartbeat(health.host, health.port);
      this.stopped = false;
      if (this.mode === 'headless') {
        this.writeRuntimeFact(lifecycle.resumed ? 'supervisor-resumed-ready' : 'supervisor-ready', { resumed: lifecycle.resumed });
      }
      return this.readRecord();
    } catch (error) {
      this.expectedExit = true;
      this.failPendingApprovals({ reason: 'supervisor_start_failed', respond: true });
      if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat);
      this.leaseHeartbeat = null;
      releaseEndpointLeases(this.ownerToken, { canonicalId: this.canonicalId });
      await closeServer(this.healthServer).catch(() => {});
      this.healthServer = null;
      this.healthAddress = null;
      await this.rpc?.close().catch(() => {});
      this.updateRecord({
        health: { state: 'failed', failed_at: iso(), delivery_ready: false },
        turn: { ...(this.readRecord()?.turn ?? {}), state: 'failed', failed_at: iso() },
        last_error: error.message,
      });
      if (this.threadId) this.writeFact('failed', 'supervisor-start-failed', { error: error.message });
      throw error;
    }
  }

  async stop({ deleteThread = false } = {}) {
    if (this.stoppingPromise) return this.stoppingPromise;
    if (this.stopped) return this.readRecord();
    this.stoppingPromise = this.stopOnce({ deleteThread });
    return this.stoppingPromise;
  }

  async stopOnce({ deleteThread = false } = {}) {
    this.expectedExit = true;
    this.failPendingApprovals({ reason: 'supervisor_stopped', respond: true });
    if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat);
    this.leaseHeartbeat = null;
    let deletionError = null;
    try {
      if (deleteThread && this.rpc && this.threadId && this.rpc.child.exitCode === null) {
        await this.rpc.request('thread/delete', { threadId: this.threadId }, RPC_TIMEOUT_MS);
        // Record the terminal lifecycle fact before clearing the in-memory id so
        // a deleted thread cannot linger as an apparently idle native session.
        this.writeFact('dead', 'supervisor-thread-deleted');
        this.threadId = null;
      }
    } catch (error) {
      // Preserve the mapping for a later explicit recovery attempt, but never
      // let a cleanup failure keep an expired process lease dispatchable.
      deletionError = error;
    } finally {
      releaseEndpointLeases(this.ownerToken, { canonicalId: this.canonicalId });
      await closeServer(this.healthServer).catch(() => {});
      this.healthServer = null;
      this.healthAddress = null;
      await this.rpc?.close().catch(() => {});
      this.stopped = true;
      this.updateRecord({
        thread_id: this.threadId,
        process: { pid: this.rpc?.child?.pid ?? null, transport: 'stdio', stopped_at: iso() },
        health: { state: 'stopped', stopped_at: iso(), delivery_ready: false },
        turn: normalizeInbox(this.readRecord()?.inbox).in_flight_envelope_id
          ? { ...(this.readRecord()?.turn ?? {}), state: 'recovery_pending', stopped_at: iso() }
          : { state: 'idle', turn_id: null, stopped_at: iso() },
        ...(deletionError ? { last_error: deletionError.message } : {}),
      });
      if (this.threadId) this.writeFact('dead', 'supervisor-stopped');
    }
    if (deletionError) throw deletionError;
    return this.readRecord();
  }
}
