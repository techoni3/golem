// Integration test for tracker-client.js — exercises the FULL HTTP client
// against a real dashboard server, on a throwaway port + temp config + temp DB.
//
// It NEVER touches the live :7420 dashboard or the real ~/.config/golem state:
//   - the dashboard child runs on PORT=7616 (HOST=127.0.0.1),
//   - GOLEM_TRACKER_DB points at a temp file,
//   - XDG_CONFIG_HOME points at a temp dir, so the dashboard self-registers
//     dashboard.json INTO that temp dir, and the client reads it from there.
//
// Exit 0 on full success; exit 1 on any failed assertion or round-trip.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_SERVER = path.resolve(__dirname, '../../dashboard/server/index.js');
const CHANNEL_DIR = process.env.GOLEM_CHANNEL_SOURCE ? path.resolve(process.env.GOLEM_CHANNEL_SOURCE) : __dirname;
const CHANNEL_SERVER = path.join(CHANNEL_DIR, 'index.js');
const CHANNEL_ROOT = path.resolve(CHANNEL_DIR, '../..');

const HOST = '127.0.0.1';
const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const PROJECT_ID = 'testproj-abc123'; // synthetic contract id; we pass it explicitly
const ChannelNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    content: z.string(),
    meta: z.object({ kind: z.string() }).passthrough(),
  }).passthrough(),
});

// --- temp sandbox ----------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-tracker-test-'));
const tmpConfigHome = path.join(tmpRoot, 'config'); // XDG_CONFIG_HOME
const tmpGolemHome = path.join(tmpConfigHome, 'golem');
const tmpDb = path.join(tmpRoot, 'tracker.db');
fs.mkdirSync(tmpConfigHome, { recursive: true });
process.env.GOLEM_HOME = tmpGolemHome;

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

// Wait until the dashboard self-registers dashboard.json and the API routes are
// ready (we poll /api/tickets, which 200s once routes are up).
async function waitForDashboard(timeoutMs = 15000) {
  const dashJson = path.join(tmpConfigHome, 'golem', 'dashboard.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dashJson)) {
      try {
        const doc = JSON.parse(fs.readFileSync(dashJson, 'utf8'));
        if (doc.url) {
          const res = await fetch(`${doc.url}/api/tickets`).catch(() => null);
          if (res && res.ok) return doc;
        }
      } catch {
        /* not ready yet */
      }
    }
    await sleep(200);
  }
  throw new Error('dashboard did not become ready within timeout');
}

async function waitForChannelEntry(sessionId, timeoutMs = 15000, predicate = () => true) {
  const channelsFile = path.join(tmpGolemHome, 'channels.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels || [];
      const channel = channels.find((entry) => entry.session_id === sessionId);
      if (channel?.host && channel?.port && predicate(channel)) return channel;
    } catch {
      /* channel has not registered yet */
    }
    await sleep(50);
  }
  throw new Error('channel did not register within timeout');
}

async function waitForChannel(timeoutMs = 15000) {
  const channel = await waitForChannelEntry(SESSION_ID, timeoutMs);
  return `http://${channel.host}:${channel.port}`;
}

let child;
let mcpClient;
let mcpTransport;
let identityMcpClient;
let identityMcpTransport;
let noIdentityMcpClient;
let noIdentityMcpTransport;
let ccFallbackMcpClient;
let ccFallbackMcpTransport;
let bridgeCaptureServer;
let port;

function toolText(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}

async function callToolFrom(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = toolText(result);
  let json = null;
  if (!result.isError && text) {
    try { json = JSON.parse(text); } catch { /* non-JSON success */ }
  }
  return { result, text, json };
}

async function callTool(name, args) {
  return callToolFrom(mcpClient, name, args);
}

async function main() {
  // 1) Spawn the dashboard server in the sandbox.
  port = await availablePort();
  child = spawn('node', [DASHBOARD_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST,
      GOLEM_TRACKER_DB: tmpDb,
      GOLEM_HOME: tmpGolemHome,
      XDG_CONFIG_HOME: tmpConfigHome,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stderr.write(`[dash] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[dash:err] ${d}`));

  const doc = await waitForDashboard();
  check('dashboard self-registered dashboard.json', !!doc.url, JSON.stringify(doc));
  check('dashboard.json url points at our test port', String(doc.url).includes(`:${port}`), doc.url);

  // 2) Configure env so the client resolves THIS dashboard + identity, then
  //    import the client (its helpers read env/fs lazily at call time).
  process.env.XDG_CONFIG_HOME = tmpConfigHome;
  process.env.GOLEM_HOME = tmpGolemHome;
  process.env.GOLEM_CEO_SESSION_ID = SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  const client = await import(url.pathToFileURL(path.join(CHANNEL_DIR, 'tracker-client.js')).href + `?t=${Date.now()}`);

  check('dashboardBaseUrl() reads temp dashboard.json', client.dashboardBaseUrl() === doc.url,
    `got ${client.dashboardBaseUrl()} want ${doc.url}`);
  check('currentSessionId() reflects GOLEM_CEO_SESSION_ID', client.currentSessionId() === SESSION_ID,
    client.currentSessionId());

  // 3) createTicket → getTicket round-trip.
  const created = await client.createTicket({
    project_id: PROJECT_ID,
    title: 'Test ticket from client',
    body: 'acceptance: round-trips',
    kind: 'work-item',
    assignee: SESSION_ID,
    created_by: SESSION_ID,
  });
  check('createTicket returns an id', !!created?.id, JSON.stringify(created));
  check('createTicket persisted project_id', created.project_id === PROJECT_ID, created.project_id);
  check('createTicket default state todo', created.state === 'todo', created.state);

  const fetched = await client.getTicket(created.id);
  check('getTicket returns the same title', fetched?.title === 'Test ticket from client', fetched?.title);
  check('getTicket includes comments array', Array.isArray(fetched?.comments), typeof fetched?.comments);

  // 4) listTickets — project filter, then assignee (mine) filter.
  const byProject = await client.listTickets({ project: PROJECT_ID });
  check('listTickets(project) finds the ticket', byProject.some((t) => t.id === created.id), `n=${byProject.length}`);

  const mine = await client.listTickets({ project: PROJECT_ID, assignee: SESSION_ID });
  check('listTickets(assignee=mine) finds the ticket', mine.some((t) => t.id === created.id), `n=${mine.length}`);

  const notMine = await client.listTickets({ project: PROJECT_ID, assignee: 'human' });
  check('listTickets(assignee=human) excludes it', !notMine.some((t) => t.id === created.id), `n=${notMine.length}`);

  // 5) updateTicket(state) → in_progress.
  const updated = await client.updateTicket(created.id, { state: 'in_progress', actor: SESSION_ID });
  check('updateTicket flips state to in_progress', updated.state === 'in_progress', updated.state);
  const reFetched = await client.getTicket(created.id);
  check('getTicket sees the persisted state', reFetched.state === 'in_progress', reFetched.state);

  // 6) addComment.
  const comment = await client.addComment(created.id, { author: SESSION_ID, body: 'progress: did the thing' });
  check('addComment returns a comment', !!comment?.id || !!comment?.body, JSON.stringify(comment));
  const withComment = await client.getTicket(created.id);
  check('getTicket now has the comment', withComment.comments.some((c) => /did the thing/.test(c.body)),
    `n=${withComment.comments.length}`);

  // 7) createStream → listStreams.
  const stream = await client.createStream({ project_id: PROJECT_ID, name: 'Test stream', mode: 'sequential' });
  check('createStream returns an id', !!stream?.id, JSON.stringify(stream));
  const streams = await client.listStreams(PROJECT_ID);
  check('listStreams finds the stream', streams.some((s) => s.id === stream.id), `n=${streams.length}`);

  // 8) listDispatchable (no live native sessions in the sandbox → empty array, but must 200).
  const dispatchable = await client.listDispatchable(PROJECT_ID);
  check('listDispatchable returns an array', Array.isArray(dispatchable), typeof dispatchable);

  // 9) Error path — non-2xx surfaces the server error + status.
  let threw = null;
  try {
    await client.getTicket('does-not-exist-id');
  } catch (e) {
    threw = e;
  }
  check('getTicket(unknown) throws with status', threw && /404/.test(threw.message), threw?.message);

  let badCreate = null;
  try {
    await client.createTicket({ project_id: PROJECT_ID }); // missing title → 400
  } catch (e) {
    badCreate = e;
  }
  check('createTicket(no title) throws 400 with server error', badCreate && /400/.test(badCreate.message), badCreate?.message);

  // 10) Drive the real channel MCP handler over stdio.
  mcpClient = new Client({ name: 'golem-ticket-transition-journey', version: '1.0.0' });
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: SESSION_ID,
      GOLEM_CHANNEL_PORT: '0',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', (d) => process.stderr.write(`[mcp:err] ${d}`));
  const channelEvents = [];
  mcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => channelEvents.push(notification));
  await mcpClient.connect(mcpTransport);

  const channelUrl = await waitForChannel();
  const roleResponse = await fetch(`${channelUrl}/role`, {
    method: 'POST',
    headers: { 'X-Sender': 'dashboard', 'Content-Type': 'text/plain' },
    body: 'Role assignment test',
  });
  const rolePayload = await roleResponse.json();
  check('POST /role returns role_assign', roleResponse.status === 202 && rolePayload.kind === 'role_assign', JSON.stringify(rolePayload));
  await sleep(50);
  const roleEvent = channelEvents.find((event) => event.params?.meta?.kind === 'role_assign');
  check('POST /role emits role_assign channel event', roleEvent?.params?.content === 'Role assignment test', JSON.stringify(channelEvents));
  check('POST /role never emits a brief event', !channelEvents.some((event) => event.params?.meta?.kind === 'brief'), JSON.stringify(channelEvents));

  const correlatedBrief = await fetch(`${channelUrl}/brief`, {
    method: 'POST',
    headers: { 'X-Sender': 'dashboard', 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Correlated dispatch', envelope_id: 'env-channel-metadata', target_session_id: SESSION_ID }),
  });
  check('POST /brief accepts envelope metadata', correlatedBrief.status === 202, `status ${correlatedBrief.status}`);
  await sleep(50);
  const briefEvent = channelEvents.find((event) => event.params?.content === 'Correlated dispatch');
  check('POST /brief carries envelope metadata to channel event', briefEvent?.params?.meta?.envelope_id === 'env-channel-metadata' && briefEvent?.params?.meta?.target_session_id === SESSION_ID, JSON.stringify(briefEvent));

  // One opencode MCP serves sibling sessions. Per-call shim identity must win
  // over bridge order, and missing identity must refuse writes rather than
  // attribute them to whichever sibling heartbeat was newest.
  const siblingA = 'ses_identity_sibling_a';
  const siblingB = 'ses_identity_sibling_b';
  check('injected identity overrides ambient caller id', client.currentSessionId(siblingB) === siblingB, client.currentSessionId(siblingB));
  const bridgePayloads = [];
  bridgeCaptureServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bridgePayloads.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    res.writeHead(202).end('{}');
  });
  await new Promise((resolve, reject) => {
    bridgeCaptureServer.once('error', reject);
    bridgeCaptureServer.listen(0, HOST, resolve);
  });
  const bridgeAddress = bridgeCaptureServer.address();
  const bridgePort = typeof bridgeAddress === 'object' && bridgeAddress ? bridgeAddress.port : null;
  const bridgesFile = path.join(tmpGolemHome, 'opencode-bridges.json');
  const now = new Date().toISOString();
  fs.writeFileSync(bridgesFile, JSON.stringify({
    bridges: [
      { session_id: siblingA, opencode_pid: process.pid, pid: process.pid, host: HOST, port: bridgePort, updated_at: now },
      { session_id: siblingB, opencode_pid: process.pid, pid: process.pid, host: HOST, port: bridgePort, updated_at: new Date(Date.now() + 1000).toISOString() },
    ],
  }));
  identityMcpClient = new Client({ name: 'golem-identity-journey', version: '1.0.0' });
  identityMcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      GOLEM_CHANNEL_HEARTBEAT_MS: '25',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  identityMcpTransport.stderr?.on('data', (d) => process.stderr.write(`[identity-mcp:err] ${d}`));
  await identityMcpClient.connect(identityMcpTransport);
  await sleep(50);
  const siblingChannels = JSON.parse(fs.readFileSync(path.join(tmpGolemHome, 'channels.json'), 'utf8')).channels;
  const siblingRows = siblingChannels.filter((channel) => channel.session_id === siblingA || channel.session_id === siblingB);
  check('shared opencode MCP registers both sibling channel rows', siblingRows.length === 2 && siblingRows[0].port === siblingRows[1].port, JSON.stringify(siblingRows));
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [
    { session_id: siblingA, project_id: PROJECT_ID, harness: 'opencode', status: 'idle', updated_at: now },
    { session_id: siblingB, project_id: PROJECT_ID, harness: 'opencode', status: 'idle', updated_at: now },
  ] }));
  const nativeModule = await import(url.pathToFileURL(path.resolve(__dirname, '../../dashboard/server/native-sessions.js')).href + `?t=${Date.now()}`);
  const nativeSiblings = await nativeModule.readNativeSessions(() => true);
  const nativeSiblingRows = nativeSiblings.filter((session) => session.session_id === siblingA || session.session_id === siblingB);
  check('native sessions reports both sibling rows alive', nativeSiblingRows.length === 2 && nativeSiblingRows.every((session) => session.alive === true), JSON.stringify(nativeSiblings));
  const siblingChannel = siblingRows.find((channel) => channel.session_id === siblingB);
  const addressedBrief = await fetch(`http://${siblingChannel.host}:${siblingChannel.port}/brief`, {
    method: 'POST',
    headers: { 'X-Sender': 'dashboard', 'X-Golem-Target-Session': siblingB, 'Content-Type': 'text/plain' },
    body: 'Target sibling B',
  });
  check('addressed sibling brief reaches bridge', addressedBrief.status === 202 && bridgePayloads.at(-1)?.body?.session_id === siblingB, JSON.stringify(bridgePayloads));

  const identityTicket = await callToolFrom(identityMcpClient, 'ticket_create', {
    project: PROJECT_ID,
    title: 'Per-call identity journey',
    body: 'Injected metadata must not enter this ticket.',
    __golem_session_id: siblingB,
    __golem_call_id: 'call-shim-b',
    __golem_probe: 'must-be-stripped',
  });
  check('injected sibling creates with its own author', !identityTicket.result.isError && identityTicket.json?.created_by === siblingB, identityTicket.text);
  const siblingCommentA = await callToolFrom(identityMcpClient, 'ticket_comment', {
    id: identityTicket.json?.id,
    body: 'Sibling A write',
    __golem_session_id: siblingA,
    __golem_call_id: 'call-shim-a',
  });
  const siblingCommentB = await callToolFrom(identityMcpClient, 'ticket_comment', {
    id: identityTicket.json?.id,
    body: 'Sibling B write',
    __golem_session_id: siblingB,
    __golem_call_id: 'call-shim-b',
  });
  check('sibling A write succeeds', !siblingCommentA.result.isError, siblingCommentA.text);
  check('sibling B write succeeds despite newer bridge order', !siblingCommentB.result.isError, siblingCommentB.text);
  const siblingTicket = await callToolFrom(identityMcpClient, 'ticket_get', { id: identityTicket.json?.id });
  const siblingAuthors = siblingTicket.json?.comments?.map((comment) => comment.author) || [];
  check('sibling writes retain their individual authors', siblingAuthors.includes(siblingA) && siblingAuthors.includes(siblingB), JSON.stringify(siblingTicket.json?.comments));
  check('injected metadata is stripped before ticket handlers', !JSON.stringify(siblingTicket.json).includes('__golem_'), siblingTicket.text);

  const siblingSubA = await callToolFrom(identityMcpClient, 'subscribe', {
    topic: 'ticket/SIBLING-A', __golem_session_id: siblingA, __golem_call_id: 'sub-a', __golem_probe: 'must-be-stripped',
  });
  const siblingSubB = await callToolFrom(identityMcpClient, 'subscribe', {
    topic: 'ticket/SIBLING-B', __golem_session_id: siblingB, __golem_call_id: 'sub-b', __golem_probe: 'must-be-stripped',
  });
  check('sibling A subscription uses its injected caller identity', !siblingSubA.result.isError && siblingSubA.json?.session_id === siblingA, siblingSubA.text);
  check('sibling B subscription uses its injected caller identity', !siblingSubB.result.isError && siblingSubB.json?.session_id === siblingB, siblingSubB.text);
  const siblingSubsA = await callToolFrom(identityMcpClient, 'subscriptions_list', { __golem_session_id: siblingA, __golem_call_id: 'list-a' });
  const siblingSubsB = await callToolFrom(identityMcpClient, 'subscriptions_list', { __golem_session_id: siblingB, __golem_call_id: 'list-b' });
  check('sibling subscription lists stay isolated', Array.isArray(siblingSubsA.json) && Array.isArray(siblingSubsB.json) && siblingSubsA.json.some((sub) => sub.topic === 'ticket/SIBLING-A') && !siblingSubsA.json.some((sub) => sub.topic === 'ticket/SIBLING-B') && siblingSubsB.json.some((sub) => sub.topic === 'ticket/SIBLING-B') && !siblingSubsB.json.some((sub) => sub.topic === 'ticket/SIBLING-A'), `${siblingSubsA.text}\n${siblingSubsB.text}`);
  check('subscription injected metadata is stripped before tracker handlers', !JSON.stringify([siblingSubA.json, siblingSubB.json, siblingSubsA.json, siblingSubsB.json]).includes('__golem_'), `${siblingSubA.text}\n${siblingSubB.text}`);
  const siblingUnsubA = await callToolFrom(identityMcpClient, 'unsubscribe', { topic: 'ticket/SIBLING-A', __golem_session_id: siblingA, __golem_call_id: 'unsub-a' });
  const afterUnsubB = await callToolFrom(identityMcpClient, 'subscriptions_list', { __golem_session_id: siblingB, __golem_call_id: 'list-b-after' });
  check('sibling unsubscribe affects only its injected caller subscription', !siblingUnsubA.result.isError && afterUnsubB.json?.some((sub) => sub.topic === 'ticket/SIBLING-B'), `${siblingUnsubA.text}\n${afterUnsubB.text}`);
  const ambiguousSub = await callToolFrom(identityMcpClient, 'subscribe', { topic: 'ticket/AMBIGUOUS' });
  check('ambiguous sibling subscription fails closed', ambiguousSub.result.isError && /no trusted caller session id/.test(ambiguousSub.text), ambiguousSub.text);

  const ambiguousWrite = await callToolFrom(identityMcpClient, 'ticket_comment', { id: identityTicket.json?.id, body: 'must not write' });
  check('ambiguous sibling write is refused', ambiguousWrite.result.isError && /2 sibling sessions.*refusing to write/.test(ambiguousWrite.text), ambiguousWrite.text);
  const afterAmbiguous = await callToolFrom(identityMcpClient, 'ticket_get', { id: identityTicket.json?.id });
  check('ambiguous sibling refusal writes no comment', afterAmbiguous.json?.comments?.length === 2, JSON.stringify(afterAmbiguous.json?.comments));

  fs.writeFileSync(bridgesFile, JSON.stringify({ bridges: [{ session_id: siblingA, opencode_pid: process.pid, pid: process.pid, host: HOST, port: bridgePort, updated_at: now }] }));
  await sleep(100);
  const reapedSiblingRows = JSON.parse(fs.readFileSync(path.join(tmpGolemHome, 'channels.json'), 'utf8')).channels
    .filter((channel) => channel.session_id === siblingA || channel.session_id === siblingB);
  check('removed sibling channel row is reaped', reapedSiblingRows.length === 1 && reapedSiblingRows[0].session_id === siblingA, JSON.stringify(reapedSiblingRows));
  const singleBridgeWrite = await callToolFrom(identityMcpClient, 'ticket_comment', { id: identityTicket.json?.id, body: 'Single bridge back-compat' });
  check('single bridge resolves without injection', !singleBridgeWrite.result.isError, singleBridgeWrite.text);

  await identityMcpClient.close();
  identityMcpClient = null;
  identityMcpTransport = null;
  fs.writeFileSync(bridgesFile, JSON.stringify({ bridges: [] }));
  await sleep(100);
  const channelsFile = path.join(tmpGolemHome, 'channels.json');
  const channelCountBeforeNoIdentity = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels.length;
  noIdentityMcpClient = new Client({ name: 'golem-no-identity-journey', version: '1.0.0' });
  noIdentityMcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      GOLEM_CHANNEL_HEARTBEAT_MS: '60000',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  await noIdentityMcpClient.connect(noIdentityMcpTransport);
  await sleep(50);
  const channelCountAfterNoIdentity = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels.length;
  check('missing bridge channel does not register', channelCountAfterNoIdentity === channelCountBeforeNoIdentity, `${channelCountBeforeNoIdentity} -> ${channelCountAfterNoIdentity}`);
  const noBridgeWrite = await callToolFrom(noIdentityMcpClient, 'ticket_comment', { id: identityTicket.json?.id, body: 'must not write without bridge' });
  check('missing bridge write is refused', noBridgeWrite.result.isError && /no live opencode bridge row.*refusing to write/.test(noBridgeWrite.text), noBridgeWrite.text);

  const lateBridgeId = 'ses_late_opencode_bridge';
  const lateBridgeStarted = Date.now();
  fs.writeFileSync(bridgesFile, JSON.stringify({ bridges: [{
    session_id: lateBridgeId,
    opencode_pid: process.pid,
    pid: process.pid,
    host: HOST,
    port: bridgePort,
    name: 'late-bridge',
    updated_at: new Date().toISOString(),
  }] }));
  let lateBridgeChannel = null;
  try { lateBridgeChannel = await waitForChannelEntry(lateBridgeId, 1000); } catch { /* asserted below */ }
  const lateBridgeElapsed = Date.now() - lateBridgeStarted;
  check('late opencode bridge registers before the 60s heartbeat', !!lateBridgeChannel && lateBridgeElapsed < 1000, `${lateBridgeElapsed}ms ${JSON.stringify(lateBridgeChannel)}`);

  const lateSiblingBridgeId = 'ses_late_opencode_sibling';
  const lateSiblingStarted = Date.now();
  fs.writeFileSync(bridgesFile, JSON.stringify({ bridges: [{
    session_id: lateBridgeId,
    opencode_pid: process.pid,
    pid: process.pid,
    host: HOST,
    port: bridgePort,
    name: 'late-bridge',
    updated_at: new Date().toISOString(),
  }, {
    session_id: lateSiblingBridgeId,
    opencode_pid: process.pid,
    pid: process.pid,
    host: HOST,
    port: bridgePort,
    name: 'late-sibling',
    updated_at: new Date().toISOString(),
  }] }));
  let lateSiblingChannel = null;
  try { lateSiblingChannel = await waitForChannelEntry(lateSiblingBridgeId, 1000); } catch { /* asserted below */ }
  const lateSiblingElapsed = Date.now() - lateSiblingStarted;
  check('late opencode sibling registers before the heartbeat', !!lateSiblingChannel && lateSiblingElapsed < 1000, `${lateSiblingElapsed}ms ${JSON.stringify(lateSiblingChannel)}`);

  fs.writeFileSync(bridgesFile, JSON.stringify({ bridges: [{
    session_id: lateBridgeId,
    opencode_pid: process.pid,
    pid: process.pid,
    host: HOST,
    port: bridgePort,
    name: 'late-bridge-renamed',
    updated_at: new Date().toISOString(),
  }, {
    session_id: lateSiblingBridgeId,
    opencode_pid: process.pid,
    pid: process.pid,
    host: HOST,
    port: bridgePort,
    name: 'late-sibling',
    updated_at: new Date().toISOString(),
  }] }));
  let renamedLateBridge = null;
  try {
    renamedLateBridge = await waitForChannelEntry(lateBridgeId, 1000, (channel) => channel.name === 'late-bridge-renamed');
  } catch { /* asserted below */ }
  check('late opencode bridge name refreshes before the heartbeat', renamedLateBridge?.name === 'late-bridge-renamed', JSON.stringify(renamedLateBridge));

  fs.writeFileSync(bridgesFile, JSON.stringify({ bridges: [] }));
  const removalDeadline = Date.now() + 1000;
  let lateBridgeRemoved = false;
  while (Date.now() < removalDeadline) {
    const channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels || [];
    if (!channels.some((channel) => channel.session_id === lateBridgeId)) {
      lateBridgeRemoved = true;
      break;
    }
    await sleep(25);
  }
  check('removed late opencode bridge promptly reaps its channel', lateBridgeRemoved, JSON.stringify(JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels));

  const ccFallbackId = 'ses_claude_env_fallback';
  ccFallbackMcpClient = new Client({ name: 'golem-cc-env-fallback-journey', version: '1.0.0' });
  ccFallbackMcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: ccFallbackId,
      GOLEM_CHANNEL_PORT: '0',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  await ccFallbackMcpClient.connect(ccFallbackMcpTransport);
  await sleep(50);
  const ccFallbackChannels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels;
  check('CLAUDE_CODE_SESSION_ID fallback still registers a channel', ccFallbackChannels.some((channel) => channel.session_id === ccFallbackId), JSON.stringify(ccFallbackChannels));

  const tools = await mcpClient.listTools();
  const transitionTool = tools.tools.find((tool) => tool.name === 'ticket_transition');
  check('MCP lists ticket_transition', !!transitionTool, tools.tools.map((tool) => tool.name).join(', '));
  check('ticket_transition description teaches the phase ladder', /queued.*building.*built.*verifying.*verified.*done/s.test(transitionTool?.description || ''), transitionTool?.description);

  const createViaMcp = async (title) => {
    const out = await callTool('ticket_create', { project: PROJECT_ID, title, kind: 'work-item', assignee: SESSION_ID });
    check(`ticket_create succeeds: ${title}`, !out.result.isError && !!out.json?.id, out.text);
    return out.json;
  };

  const simple = await createViaMcp('MCP transition success');
  const simpleBuilding = await callTool('ticket_transition', { id: simple.id, phase: 'building' });
  check('ticket_transition queued -> building succeeds', !simpleBuilding.result.isError && simpleBuilding.json?.phase === 'building', simpleBuilding.text);
  check('building derives legacy state in_progress', simpleBuilding.json?.state === 'in_progress', simpleBuilding.text);

  const illegal = await createViaMcp('MCP transition illegal');
  const illegalDone = await callTool('ticket_transition', { id: illegal.id, phase: 'done' });
  check('illegal transition returns MCP error', illegalDone.result.isError === true, illegalDone.text);
  check('illegal transition preserves server error verbatim', illegalDone.text === 'transitionTicket: illegal transition queued -> done', illegalDone.text);
  const illegalAfter = await callTool('ticket_get', { id: illegal.id });
  check('illegal transition leaves ticket unchanged', illegalAfter.json?.phase === 'queued', illegalAfter.text);

  const missing = await createViaMcp('MCP transition missing artifact');
  await callTool('ticket_transition', { id: missing.id, phase: 'building' });
  const missingBuilt = await callTool('ticket_transition', { id: missing.id, phase: 'built' });
  check('missing artifact returns MCP error', missingBuilt.result.isError === true, missingBuilt.text);
  check('missing artifact preserves server error verbatim', missingBuilt.text === 'transitionTicket: missing required artifact(s): closingBrief', missingBuilt.text);
  const missingAfter = await callTool('ticket_get', { id: missing.id });
  check('missing artifact leaves ticket in building', missingAfter.json?.phase === 'building', missingAfter.text);

  const walk = await createViaMcp('MCP full legal phase walk');
  await callTool('ticket_transition', { id: walk.id, phase: 'building' });
  await callTool('ticket_comment', { id: walk.id, body: 'Closing brief: implementation complete with mechanical evidence.' });
  const walkedBuilt = await callTool('ticket_transition', { id: walk.id, phase: 'built' });
  check('full walk reaches built', !walkedBuilt.result.isError && walkedBuilt.json?.phase === 'built', walkedBuilt.text);
  const dispatched = await callTool('ticket_dispatch', { id: walk.id, session_id: SESSION_ID, note: 'verification routing' });
  check('full walk records manager dispatch artifact', !dispatched.result.isError, dispatched.text);
  const walkedVerifying = await callTool('ticket_transition', { id: walk.id, phase: 'verifying' });
  check('full walk reaches verifying', !walkedVerifying.result.isError && walkedVerifying.json?.phase === 'verifying', walkedVerifying.text);
  await callTool('ticket_comment', { id: walk.id, body: 'Verification PASS: journey test completed.' });
  const walkedVerified = await callTool('ticket_transition', { id: walk.id, phase: 'verified' });
  check('full walk reaches verified', !walkedVerified.result.isError && walkedVerified.json?.phase === 'verified', walkedVerified.text);
  const walkedDone = await callTool('ticket_transition', { id: walk.id, phase: 'done' });
  check('full walk reaches done through MCP alone', !walkedDone.result.isError && walkedDone.json?.phase === 'done', walkedDone.text);

  const blocked = await createViaMcp('MCP transition reason forwarding');
  const blockedOut = await callTool('ticket_transition', { id: blocked.id, phase: 'blocked', reason: 'waiting for credentials' });
  check('ticket_transition forwards reason', !blockedOut.result.isError && blockedOut.json?.phase === 'blocked', blockedOut.text);

  const skipped = await createViaMcp('MCP transition skip reason forwarding');
  await callTool('ticket_transition', { id: skipped.id, phase: 'building' });
  await callTool('ticket_comment', { id: skipped.id, body: 'Closing brief: ready for exceptional closure.' });
  await callTool('ticket_transition', { id: skipped.id, phase: 'built' });
  const skippedDone = await callTool('ticket_transition', { id: skipped.id, phase: 'done', skip_reason: 'manager-approved test skip' });
  check('ticket_transition forwards skip_reason', !skippedDone.result.isError && skippedDone.json?.phase === 'done', skippedDone.text);

  const legacy = await createViaMcp('MCP legacy update compatibility');
  const legacyUpdated = await callTool('ticket_update', { id: legacy.id, state: 'in_progress' });
  check('ticket_update legacy state remains compatible', !legacyUpdated.result.isError && legacyUpdated.json?.state === 'in_progress', legacyUpdated.text);
}

main()
  .catch((err) => {
    failures++;
    console.error('UNHANDLED:', err?.stack || err);
  })
  .finally(async () => {
    // Kill child, clean temp.
    try { await mcpClient?.close(); } catch { /* ignore */ }
    try { await mcpTransport?.close(); } catch { /* ignore */ }
    try { await identityMcpClient?.close(); } catch { /* ignore */ }
    try { await identityMcpTransport?.close(); } catch { /* ignore */ }
    try { await noIdentityMcpClient?.close(); } catch { /* ignore */ }
    try { await noIdentityMcpTransport?.close(); } catch { /* ignore */ }
    try { await ccFallbackMcpClient?.close(); } catch { /* ignore */ }
    try { await ccFallbackMcpTransport?.close(); } catch { /* ignore */ }
    try { await new Promise((resolve) => bridgeCaptureServer?.close(resolve) ?? resolve()); } catch { /* ignore */ }
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    if (failures === 0) {
      console.log('\nALL PASS (exit 0)');
      process.exit(0);
    } else {
      console.log(`\n${failures} FAILURE(S) (exit 1)`);
      process.exit(1);
    }
  });
