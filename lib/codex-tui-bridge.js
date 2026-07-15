// GOL-477: one private Unix-WebSocket endpoint sits between the interactive
// Codex TUI and the pinned App Server's stdio JSONL transport. The TUI remains
// the sole logical App Server client: its frames are forwarded unchanged, while
// Golem uses cryptographically unguessable string ids for the few injected
// lifecycle/dispatch requests that it must consume itself.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import WebSocket, { WebSocketServer } from 'ws';

const RPC_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 1024 * 1024;

function idKey(id) { return `${typeof id}:${String(id)}`; }

function isRequest(message) {
  return message && typeof message === 'object'
    && Object.hasOwn(message, 'id') && typeof message.method === 'string';
}

function isResponse(message) {
  return message && typeof message === 'object'
    && Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method');
}

function isNotification(message) {
  return message && typeof message === 'object'
    && !Object.hasOwn(message, 'id') && typeof message.method === 'string';
}

function closeHttpServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function bridgeError(id, message) {
  return { id, error: { code: -32001, message } };
}

/**
 * Multiplex one real App Server stdio stream to exactly one local TUI socket.
 * It intentionally does not call initialize: only the TUI establishes the
 * App Server client session, selects sandbox/model/approval settings, and
 * answers server-originated approval requests.
 */
export class CodexTuiBridge extends EventEmitter {
  constructor({ supervisor, command = 'codex', cwd, env = process.env, configOverrides = [], onAppServerExit = null, onTuiExit = null } = {}) {
    super();
    if (!supervisor) throw new Error('CodexTuiBridge requires its owning supervisor');
    this.supervisor = supervisor;
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.configOverrides = configOverrides;
    this.onAppServerExit = onAppServerExit;
    this.onTuiExit = onTuiExit;
    this.child = null;
    this.httpServer = null;
    this.wss = null;
    this.tui = null;
    this.socketDir = null;
    this.socketPath = null;
    this.remoteUrl = null;
    this.closed = false;
    this.tuiInitialized = false;
    this.mcpVerificationStarted = false;
    this.reservedPrefix = `golem-bridge-${crypto.randomBytes(24).toString('base64url')}`;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.tuiRequests = new Map();
  }

  async start() {
    if (this.child) throw new Error('Codex TUI bridge is already started');
    this.socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-tui-'));
    fs.chmodSync(this.socketDir, 0o700);
    this.socketPath = path.join(this.socketDir, 'app-server.sock');
    this.remoteUrl = `unix://${this.socketPath}`;

    this.httpServer = http.createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Codex TUI bridge accepts WebSocket upgrades only.');
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    this.httpServer.on('upgrade', (request, socket, head) => {
      if (this.tui && this.tui.readyState === WebSocket.OPEN) {
        socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (client) => this.acceptTui(client));
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.socketPath, resolve);
    });

    const args = ['app-server'];
    for (const override of this.configOverrides) args.push('--config', override);
    args.push('--listen', 'stdio://');
    this.child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      const error = new Error(`Codex App Server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}): ${this.stderr.trim()}`);
      this.fail(error);
      if (!this.closed) this.onAppServerExit?.({ code, signal, error });
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receiveAppServerLine(line));
    return this.remoteUrl;
  }

  acceptTui(socket) {
    if (this.tui && this.tui.readyState === WebSocket.OPEN) {
      socket.close(1013, 'one Codex TUI is already attached');
      return;
    }
    this.tui = socket;
    this.supervisor.noteTuiConnected();
    socket.on('message', (frame, binary) => {
      if (binary) return socket.close(1003, 'JSON-RPC text frames are required');
      this.receiveTuiFrame(frame.toString('utf8'));
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      if (this.tui !== socket) return;
      this.tui = null;
      if (this.closed) return;
      // Close the delivery gate before triggering asynchronous supervisor
      // teardown. A queued dashboard drain must never slip into a disconnected
      // remote TUI during that small window.
      this.supervisor.noteTuiDisconnected();
      this.emit('tui-exit');
      this.onTuiExit?.();
    });
    this.emit('tui-connected', { remote_url: this.remoteUrl });
  }

  send(message) {
    if (this.closed || !this.child || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw new Error(`cannot send after Codex App Server closed: ${this.stderr || ''}`);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('Codex TUI bridge is closed'));
    const id = `${this.reservedPrefix}:${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms: ${this.stderr || ''}`));
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

  receiveTuiFrame(frame) {
    let message;
    try { message = JSON.parse(frame); } catch {
      this.sendTui({ error: { code: -32700, message: 'invalid JSON-RPC frame' } });
      return;
    }
    if (!message || typeof message !== 'object') {
      this.sendTui({ error: { code: -32600, message: 'invalid JSON-RPC message' } });
      return;
    }
    if (isRequest(message)) {
      if (typeof message.id === 'string' && message.id.startsWith(`${this.reservedPrefix}:`)) {
        this.sendTui(bridgeError(message.id, 'request id is reserved by the local Golem bridge'));
        return;
      }
      const entry = { method: message.method, params: message.params, turn: null, thread: null };
      if (message.method === 'thread/start' || message.method === 'thread/resume' || message.method === 'thread/fork') {
        entry.thread = this.supervisor.noteTuiThreadRequested({
          requestId: idKey(message.id), method: message.method,
        });
      }
      if (message.method === 'turn/start' || message.method === 'turn/steer') {
        entry.turn = this.supervisor.noteTuiTurnStarted({
          requestId: idKey(message.id), method: message.method, params: message.params ?? {},
        });
      }
      this.tuiRequests.set(idKey(message.id), entry);
      try {
        this.send(message);
      } catch (error) {
        this.tuiRequests.delete(idKey(message.id));
        if (entry.thread?.tracked) {
          this.supervisor.noteTuiThread(entry.method, { error: { code: -32001, message: error.message } }, entry.thread);
        }
        if (entry.turn?.tracked) {
          this.supervisor.noteTuiTurnResponse({ requestId: idKey(message.id), response: { error: { code: -32001, message: error.message } }, tracking: entry.turn });
        }
        this.sendTui(bridgeError(message.id, `unable to forward request to Codex App Server: ${error.message}`));
      }
      return;
    }
    if (isNotification(message) && message.method === 'initialized') {
      this.tuiInitialized = true;
      this.supervisor.noteTuiInitialized();
      this.send(message);
      this.verifyMcpAfterTuiInitialization();
      return;
    }
    // Server-request responses and every other TUI notification are forwarded
    // byte-for-byte at the JSON value level. The bridge never owns approvals.
    this.send(message);
  }

  receiveAppServerLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.fail(new Error(`Codex App Server emitted non-JSON stdout: ${line}`));
      return;
    }
    if (isResponse(message)) {
      const reservedId = typeof message.id === 'string' && message.id.startsWith(`${this.reservedPrefix}:`);
      const reserved = reservedId ? this.pending.get(message.id) : null;
      if (reservedId) {
        // Timed-out bridge calls can receive a late response. The namespace is
        // private and never valid for a TUI request, so consume every such
        // response rather than leaking a stale internal reply to the TUI.
        if (reserved) {
          this.pending.delete(message.id);
          clearTimeout(reserved.timer);
          if (message.error) reserved.reject(new Error(`${reserved.method} failed: ${JSON.stringify(message.error)}`));
          else reserved.resolve(message.result);
        }
        return;
      }
      const entry = this.tuiRequests.get(idKey(message.id));
      if (entry) {
        this.tuiRequests.delete(idKey(message.id));
        if (entry.method === 'thread/start' || entry.method === 'thread/resume' || entry.method === 'thread/fork') {
          this.supervisor.noteTuiThread(entry.method, message, entry.thread);
        } else if (entry.method === 'turn/start' || entry.method === 'turn/steer') {
          this.supervisor.noteTuiTurnResponse({ requestId: idKey(message.id), response: message, tracking: entry.turn });
        }
      }
      this.sendTui(message);
      return;
    }
    if (isRequest(message)) {
      // This includes all approval/current-time/tool-input requests. The TUI
      // receives the original id and method and answers directly to App Server.
      if (!this.tui || this.tui.readyState !== WebSocket.OPEN) {
        try { this.send(bridgeError(message.id, 'Codex TUI is unavailable to answer this App Server request')); } catch { /* App Server already failed */ }
        return;
      }
      this.sendTui(message);
      return;
    }
    if (isNotification(message)) {
      // Notifications are broadcast to the real TUI. Only the canonical
      // thread's turn completion mutates tracker state; ThreadStarted can be
      // a server-created subagent and is deliberately ignored for identity.
      this.supervisor.handleNotification(message);
      this.sendTui(message);
      return;
    }
    this.fail(new Error(`Codex App Server emitted invalid JSON-RPC message: ${line}`));
  }

  verifyMcpAfterTuiInitialization() {
    if (!this.tuiInitialized || this.mcpVerificationStarted) return;
    this.mcpVerificationStarted = true;
    void this.request('mcpServerStatus/list', {})
      .then((status) => this.supervisor.activateManagedMcp(status))
      .catch((error) => this.supervisor.markTuiMcpFailure(error));
  }

  sendTui(message) {
    if (!this.tui || this.tui.readyState !== WebSocket.OPEN) return false;
    this.tui.send(JSON.stringify(message));
    return true;
  }

  fail(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Codex TUI bridge closed'));
    if (this.tui && this.tui.readyState === WebSocket.OPEN) this.tui.close(1001, 'Golem Codex bridge stopping');
    this.tui = null;
    this.wss?.close();
    await closeHttpServer(this.httpServer).catch(() => {});
    this.httpServer = null;
    if (this.child?.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([
        new Promise((resolve) => this.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (this.child.exitCode === null) this.child.kill('SIGTERM');
    }
    if (this.socketDir) fs.rmSync(this.socketDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    this.socketDir = null;
    this.socketPath = null;
  }
}
