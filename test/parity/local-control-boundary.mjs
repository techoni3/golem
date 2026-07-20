#!/usr/bin/env node
// J4 certification boundary: real dashboard + SQLite + REST + WebSocket +
// stdio MCP + immediate dispatch.  It deliberately does not import a Codex
// supervisor, start a model turn, or configure a cloud provider.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
// The SDK belongs to the channel package rather than the root package. Keep
// this explicit so the certification works from an isolated worktree without
// installing or changing any toolchain dependency.
import { Client } from '../../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { z } from '../../mcp/channel/node_modules/zod/index.js';

import { projectIdFor } from '../../lib/project-id.js';
import { assertCredentialFreeChildEnv, isolatedChildEnv } from './isolated-env.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dashboardServer = path.join(repo, 'dashboard', 'server', 'index.js');
const channelServer = path.join(repo, 'mcp', 'channel', 'index.js');
const sessionId = 'parity-local-control-session';
const notificationSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.object({ kind: z.string() }).passthrough() }).passthrough(),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendBounded(current, chunk, limit = 12_000) {
  const next = current + String(chunk);
  return next.length <= limit ? next : `…[truncated]\n${next.slice(-limit)}`;
}

function errorDetail(error) {
  return [error?.code, error?.syscall, error?.address, error?.port, error?.message]
    .filter(Boolean)
    .join(' ');
}

async function unusedLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(typeof address, 'object');
  return address.port;
}

async function waitFor(check, label, { timeoutMs = 15_000, detail = () => '' } = {}) {
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
  const evidence = detail();
  throw new Error(`${label} timed out${lastError ? `: ${errorDetail(lastError)}` : ''}${evidence ? `\n${evidence}` : ''}`);
}

function textResult(result) {
  return result?.content?.find((part) => part.type === 'text')?.text || '';
}

async function toolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = textResult(result);
  assert.equal(Boolean(result.isError), false, `${name} MCP error: ${text}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} returned non-JSON MCP text: ${text}\n${errorDetail(error)}`);
  }
}

async function openWs(base, dashboardDetail) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* cleanup only */ }
      reject(new Error(`dashboard WebSocket snapshot timed out\n${dashboardDetail()}`));
    }, 12_000);
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'snapshot') {
          clearTimeout(timer);
          resolve(ws);
        }
      } catch { /* wait for the next frame */ }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`dashboard WebSocket failed: ${errorDetail(error)}\n${dashboardDetail()}`));
    });
  });
}

function nextWsEvent(ws, predicate, dashboardDetail) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, new Error(`dashboard WebSocket delta timed out\n${dashboardDetail()}`)), 12_000);
    const onMessage = (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (predicate(message)) finish(message);
      } catch { /* not a relevant frame */ }
    };
    const onError = (error) => finish(null, new Error(`dashboard WebSocket failed: ${errorDetail(error)}\n${dashboardDetail()}`));
    const finish = (value, error = null) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-local-control-boundary-'));
const home = path.join(tempRoot, 'home');
const golemHome = path.join(tempRoot, 'golem-home');
const xdgConfigHome = path.join(tempRoot, 'xdg');
const projectRoot = path.join(tempRoot, 'project');
const projectId = projectIdFor(projectRoot);
const dbPath = path.join(tempRoot, 'tracker.db');
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });

let dashboard;
let mcpClient;
let mcpTransport;
let ws;
let dashboardStderr = '';
let mcpStderr = '';
let signalCleanup = false;

function cleanup() {
  if (signalCleanup) return;
  signalCleanup = true;
  try { ws?.close(); } catch { /* cleanup only */ }
  try { mcpTransport?.close(); } catch { /* cleanup only */ }
  try { dashboard?.kill('SIGTERM'); } catch { /* cleanup only */ }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* cleanup only */ }
}

const onSignal = () => {
  cleanup();
  process.exit(128);
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  const port = await unusedLocalPort();
  const childEnv = isolatedChildEnv({
    home,
    golemHome,
    xdgConfigHome,
    extra: {
      HOST: '127.0.0.1',
      PORT: String(port),
      GOLEM_TRACKER_DB: dbPath,
      GOLEM_PROJECTS_ROOT: path.join(tempRoot, 'projects'),
      GOLEM_IDEAS_ROOT: path.join(tempRoot, 'ideas'),
      LOG_LEVEL: 'warn',
    },
  });
  assertCredentialFreeChildEnv(childEnv);
  const base = `http://127.0.0.1:${port}`;

  dashboard = spawn(process.execPath, [dashboardServer], {
    cwd: repo,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dashboard.stderr.setEncoding('utf8');
  dashboard.stderr.on('data', (chunk) => { dashboardStderr = appendBounded(dashboardStderr, chunk); });
  dashboard.stdout.setEncoding('utf8');
  dashboard.stdout.on('data', (chunk) => { dashboardStderr = appendBounded(dashboardStderr, chunk); });
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 'local dashboard health', {
    detail: () => `dashboard stderr:\n${dashboardStderr || '(no output)'}`,
  });

  mcpClient = new Client({ name: 'golem-parity-local-control-boundary', version: '1.0.0' });
  const deliveredBrief = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP dispatch notification timed out\n${mcpStderr || '(no MCP stderr)'}`)), 12_000);
    mcpClient.setNotificationHandler(notificationSchema, (notification) => {
      if (notification.params?.meta?.kind === 'brief') {
        clearTimeout(timer);
        resolve(notification);
      }
    });
  });
  const channelEnv = isolatedChildEnv({
    home,
    golemHome,
    xdgConfigHome,
    extra: {
      GOLEM_CEO_SESSION_ID: sessionId,
      GOLEM_CHANNEL_PORT: '0',
    },
  });
  assertCredentialFreeChildEnv(channelEnv);
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [channelServer],
    cwd: repo,
    env: channelEnv,
    stderr: 'pipe',
  });
  mcpTransport.stderr?.setEncoding('utf8');
  mcpTransport.stderr?.on('data', (chunk) => { mcpStderr = appendBounded(mcpStderr, chunk); });
  await mcpClient.connect(mcpTransport);

  const channel = await waitFor(() => {
    const registry = JSON.parse(fs.readFileSync(path.join(golemHome, 'channels.json'), 'utf8'));
    return registry.channels?.find((entry) => entry.session_id === sessionId && entry.consumer_ready === true && entry.delivery_ready === true);
  }, 'initialized local MCP channel registration', { detail: () => `MCP stderr:\n${mcpStderr || '(no output)'}` });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${channel.pid}.json`), JSON.stringify({
    sessionId,
    pid: channel.pid,
    cwd: projectRoot,
    name: 'parity local control',
    status: 'idle',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }));

  const target = await waitFor(async () => {
    const rows = await (await fetch(`${base}/api/sessions/dispatchable?project=${encodeURIComponent(projectId)}`)).json();
    return rows.find((row) => row.session_id === sessionId && row.reachable === true);
  }, 'credential-free local dispatchable target', { timeoutMs: 20_000, detail: () => `dashboard stderr:\n${dashboardStderr || '(no output)'}\nMCP stderr:\n${mcpStderr || '(no output)'}` });
  assert.equal(target.project_id, projectId);

  ws = await openWs(base, () => `dashboard stderr:\n${dashboardStderr || '(no output)'}`);
  const ticketCreated = nextWsEvent(ws, (message) => message.type === 'ticket-created', () => `dashboard stderr:\n${dashboardStderr || '(no output)'}`);
  const created = await toolJson(mcpClient, 'ticket_create', {
    project: projectId,
    title: 'credential-free local J4 dispatch',
    kind: 'work-item',
  });
  assert.ok(created.id, 'MCP ticket_create returned an id');
  const createdEvent = await ticketCreated;
  assert.equal(createdEvent.ticket?.display_id, created.id,
    'raw ticket-created display_id matches the MCP public ticket id');
  assert.ok(createdEvent.ticket?.id, 'raw ticket-created event retains the internal ticket id');
  const internalTicketId = createdEvent.ticket.id;

  const ticketUpdated = nextWsEvent(ws, (message) => message.type === 'ticket-updated'
    && message.ticket?.id === internalTicketId
    && message.ticket?.display_id === created.id,
    () => `dashboard stderr:\n${dashboardStderr || '(no output)'}`);
  const dispatched = await toolJson(mcpClient, 'ticket_dispatch', {
    id: created.id,
    session_id: sessionId,
    note: 'local parity certification only',
  });
  assert.equal(dispatched.delivered, true, JSON.stringify(dispatched));
  const notification = await deliveredBrief;
  assert.equal(notification.params.meta.envelope_id, dispatched.envelope_id);
  const updatedEvent = await ticketUpdated;
  assert.equal(updatedEvent.ticket?.id, internalTicketId,
    'raw ticket-updated event retains the created internal ticket id');
  assert.equal(updatedEvent.ticket?.display_id, created.id,
    'raw ticket-updated display_id remains the MCP public ticket id');

  const persisted = await (await fetch(`${base}/api/tickets/${encodeURIComponent(created.id)}`)).json();
  assert.equal(persisted.assignee, sessionId, 'SQLite-backed ticket retains dispatched assignee');
  console.log('local control boundary passed: dashboard/SQLite/REST/WebSocket/MCP/dispatch stayed credential-free and local-only');
} catch (error) {
  console.error(`local control boundary failed: ${errorDetail(error)}`);
  if (dashboardStderr) console.error(`dashboard stderr:\n${dashboardStderr}`);
  if (mcpStderr) console.error(`MCP stderr:\n${mcpStderr}`);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  try { await mcpClient?.close(); } catch { /* cleanup only */ }
  try { await mcpTransport?.close(); } catch { /* cleanup only */ }
  try { await stopChild(dashboard); } catch { /* cleanup only */ }
  cleanup();
}
