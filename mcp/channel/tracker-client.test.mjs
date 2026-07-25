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
import { projectIdFor } from '../../lib/project-id.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_SERVER = path.resolve(__dirname, '../../dashboard/server/index.js');
const CHANNEL_DIR = process.env.GOLEM_CHANNEL_SOURCE ? path.resolve(process.env.GOLEM_CHANNEL_SOURCE) : __dirname;
const CHANNEL_SERVER = path.join(CHANNEL_DIR, 'index.js');
const CHANNEL_ROOT = path.resolve(CHANNEL_DIR, '../..');

const HOST = '127.0.0.1';
const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const PROJECT_ID = 'testproj-abc123'; // synthetic contract id; we pass it explicitly
const SECOND_PROJECT_ID = 'otherproj-def456';
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
const projectsRoot = path.join(tmpRoot, 'projects');
const ideasRoot = path.join(tmpRoot, 'ideas');
const uniqueProjectRoot = path.join(tmpRoot, 'trialroomai');
const duplicateProjectRootA = path.join(tmpRoot, 'duplicate-a');
const duplicateProjectRootB = path.join(tmpRoot, 'duplicate-b');
const claudeSessionsDir = path.join(tmpRoot, '.claude', 'sessions');
const uniqueProjectId = projectIdFor(uniqueProjectRoot);
fs.mkdirSync(tmpGolemHome, { recursive: true });
for (const directory of [projectsRoot, ideasRoot, uniqueProjectRoot, duplicateProjectRootA, duplicateProjectRootB, claudeSessionsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(tmpGolemHome, 'projects.json'), JSON.stringify({
  version: 1,
  projects: [
    { id: 'registry-trialroomai', name: 'trialroomai', path: uniqueProjectRoot, kind: 'external' },
    { id: 'registry-duplicate-a', name: 'duplicate-human-name', path: duplicateProjectRootA, kind: 'external' },
    { id: 'registry-duplicate-b', name: 'duplicate-human-name', path: duplicateProjectRootB, kind: 'external' },
  ],
}));
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

function writeClaudeSession({ sessionId, pid, cwd = uniqueProjectRoot, name, status = 'idle' }) {
  fs.writeFileSync(path.join(claudeSessionsDir, `${pid}.json`), JSON.stringify({
    sessionId,
    pid,
    cwd,
    name: name || null,
    status,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }));
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
let unsupportedCcMcpClient;
let unsupportedCcMcpTransport;
let uninitializedCcChild;
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
      GOLEM_PROJECTS_ROOT: projectsRoot,
      GOLEM_IDEAS_ROOT: ideasRoot,
      HOME: tmpRoot,
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

  const foreignSpec = await client.createTicket({
    project_id: SECOND_PROJECT_ID,
    title: 'Foreign project spec',
    body: 'Must never appear in the explicitly scoped project result.',
    kind: 'spec',
    created_by: SESSION_ID,
  });
  check('createTicket preserves a second explicit project scope',
    foreignSpec.project_id === SECOND_PROJECT_ID,
    JSON.stringify(foreignSpec));

  const fetched = await client.getTicket(created.id);
  check('getTicket returns the same title', fetched?.title === 'Test ticket from client', fetched?.title);
  check('getTicket includes comments array', Array.isArray(fetched?.comments), typeof fetched?.comments);

  // 4) listTickets — project filter, then assignee (mine) filter.
  const byProject = await client.listTickets({ project: PROJECT_ID });
  check('listTickets(project) finds the ticket', byProject.some((t) => t.id === created.id), `n=${byProject.length}`);
  check('listTickets(project) excludes another project',
    !byProject.some((t) => t.id === foreignSpec.id),
    JSON.stringify(byProject));

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

  let missingProject = null;
  try {
    await client.createTicket({ title: 'must fail before HTTP' });
  } catch (e) {
    missingProject = e;
  }
  check('createTicket without project scope fails at the transport boundary',
    missingProject && /project_id is required at the MCP-to-REST boundary/.test(missingProject.message),
    missingProject?.message);

  let badCreate = null;
  try {
    await client.createTicket({ project_id: PROJECT_ID }); // missing title → 400
  } catch (e) {
    badCreate = e;
  }
  check('createTicket(no title) throws 400 with server error', badCreate && /400/.test(badCreate.message), badCreate?.message);

  // 10) A Claude channel HTTP child is not dispatchable until the host sends
  // the MCP `initialized` notification. This raw stdio child deliberately
  // starts its listener but never initializes the MCP connection.
  const uninitializedCcId = 'cc-not-initialized';
  uninitializedCcChild = spawn(process.execPath, [CHANNEL_SERVER], {
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: uninitializedCcId,
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  uninitializedCcChild.stderr?.on('data', (d) => process.stderr.write(`[uninitialized-cc:err] ${d}`));
  const uninitializedChannel = await waitForChannelEntry(
    uninitializedCcId,
    15_000,
    (channel) => channel.consumer_reason === 'mcp_not_initialized',
  );
  check('CC registry row is explicitly not ready before MCP initialization',
    uninitializedChannel.consumer_ready === false && uninitializedChannel.delivery_ready === false,
    JSON.stringify(uninitializedChannel));
  const uninitializedConsult = await fetch(`http://${uninitializedChannel.host}:${uninitializedChannel.port}/consult`, {
    method: 'POST',
    headers: { 'X-Sender': 'consult', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consult_id: 'cns-preinit', question: 'must not be accepted' }),
  });
  check('pre-initialization CC endpoint refuses channel delivery', uninitializedConsult.status === 503, await uninitializedConsult.text());
  writeClaudeSession({ sessionId: uninitializedCcId, pid: uninitializedCcChild.pid, name: 'preinit-cc' });
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [{
    session_id: uninitializedCcId,
    project_id: uniqueProjectId,
    project_path: uniqueProjectRoot,
    hook_ppid: uninitializedCcChild.pid,
    harness: 'claudecode',
    name: 'preinit-cc',
    status: 'idle',
    last_seen_at: new Date().toISOString(),
  }] }));
  await sleep(3_500);
  const beforeInitDispatchable = await client.listDispatchable('trialroomai');
  check('unique project name resolves while pre-initialization CC stays non-dispatchable',
    Array.isArray(beforeInitDispatchable) && !beforeInitDispatchable.some((row) => row.session_id === uninitializedCcId),
    JSON.stringify(beforeInitDispatchable));
  const ambiguousProject = await fetch(`${doc.url}/api/sessions/dispatchable?project=${encodeURIComponent('duplicate-human-name')}`);
  const ambiguousProjectText = await ambiguousProject.text();
  check('duplicate human project names return an explicit ambiguity error',
    ambiguousProject.status === 400 && /ambiguous.*pass an exact project_id/i.test(ambiguousProjectText),
    `${ambiguousProject.status} ${ambiguousProjectText}`);
  uninitializedCcChild.stdin.end();
  await Promise.race([new Promise((resolve) => uninitializedCcChild.once('exit', resolve)), sleep(1_000)]);
  if (uninitializedCcChild.exitCode === null) uninitializedCcChild.kill('SIGTERM');
  uninitializedCcChild = null;

  // 11) Drive the real channel MCP handler over stdio.
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
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', (d) => process.stderr.write(`[mcp:err] ${d}`));
  const channelEvents = [];
  mcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => channelEvents.push(notification));
  await mcpClient.connect(mcpTransport);

  const channelUrl = await waitForChannel();
  const leases = JSON.parse(fs.readFileSync(path.join(tmpGolemHome, 'endpoint-leases.json'), 'utf8')).leases;
  const lease = leases.find((row) => row.canonical_id === SESSION_ID);
  const validHealth = await fetch(`${channelUrl}/healthz?${new URLSearchParams({ session_id: SESSION_ID, owner_token: lease.owner_token })}`);
  check('identity-bound lease health succeeds', validHealth.status === 200, await validHealth.text());
  const wrongSessionHealth = await fetch(`${channelUrl}/healthz?${new URLSearchParams({ session_id: 'wrong-session', owner_token: lease.owner_token })}`);
  check('lease health rejects wrong canonical session', wrongSessionHealth.status === 403, await wrongSessionHealth.text());
  const wrongOwnerHealth = await fetch(`${channelUrl}/healthz?${new URLSearchParams({ session_id: SESSION_ID, owner_token: 'wrong-owner' })}`);
  check('lease health rejects wrong owner token', wrongOwnerHealth.status === 403, await wrongOwnerHealth.text());
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
  const channelsModule = await import(url.pathToFileURL(path.resolve(__dirname, '../../dashboard/server/channels.js')).href + `?t=${Date.now()}`);
  const verifiedSiblingChannels = await channelsModule.readChannels();
  const readySiblingChannels = verifiedSiblingChannels.filter((channel) => channel.session_id === siblingA || channel.session_id === siblingB);
  check('OpenCode bridge readiness is preserved independently of Claude Channels',
    readySiblingChannels.length === 2 && readySiblingChannels.every((channel) => channelsModule.isChannelDeliveryReady(channel)),
    JSON.stringify(verifiedSiblingChannels));
  const nativeSiblings = await nativeModule.readNativeSessions(() => true, verifiedSiblingChannels);
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
  const ccFallbackNotifications = [];
  ccFallbackMcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => ccFallbackNotifications.push(notification));
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
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  await ccFallbackMcpClient.connect(ccFallbackMcpTransport);
  const ccFallbackChannel = await waitForChannelEntry(ccFallbackId, 15_000, (channel) => channel.consumer_ready === true);
  const ccFallbackChannels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels;
  check('initialized Anthropic-configured CC registers an eligible channel',
    ccFallbackChannel.harness === 'claudecode' && ccFallbackChannel.delivery_ready === true,
    JSON.stringify(ccFallbackChannel));

  writeClaudeSession({ sessionId: ccFallbackId, pid: ccFallbackChannel.pid, name: 'supported-cc' });
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [{
    session_id: ccFallbackId,
    project_id: uniqueProjectId,
    project_path: uniqueProjectRoot,
    hook_ppid: ccFallbackChannel.pid,
    harness: 'claudecode',
    name: 'supported-cc',
    status: 'idle',
    last_seen_at: new Date().toISOString(),
  }] }));
  await sleep(3_500);
  const supportedByHumanProjectName = await client.listDispatchable('trialroomai');
  check('unique human project name resolves to its canonical project dispatchables',
    supportedByHumanProjectName.some((row) => row.session_id === ccFallbackId && row.project_id === uniqueProjectId && row.reachable === true),
    JSON.stringify(supportedByHumanProjectName));

  const supportedConsult = await callTool('consult_request', {
    to: ccFallbackId,
    question: 'Does the supported Claude channel receive this consult?',
    context: 'GOL-483 positive channel-eligibility journey.',
  });
  await sleep(50);
  const supportedConsultNotification = ccFallbackNotifications.find((notification) => (
    notification.params?.meta?.kind === 'consult'
      && notification.params?.meta?.consult_id === supportedConsult.json?.consult_id
  ));
  check('supported CC consult is accepted and emits concrete channel bytes',
    !supportedConsult.result.isError && !!supportedConsultNotification,
    `${supportedConsult.text} notifications=${JSON.stringify(ccFallbackNotifications)}`);

  const unsupportedCcId = 'cc-custom-provider';
  const unsupportedCcNotifications = [];
  unsupportedCcMcpClient = new Client({ name: 'golem-unsupported-cc-journey', version: '1.0.0' });
  unsupportedCcMcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => unsupportedCcNotifications.push(notification));
  unsupportedCcMcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: unsupportedCcId,
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  unsupportedCcMcpTransport.stderr?.on('data', (d) => process.stderr.write(`[unsupported-cc:err] ${d}`));
  await unsupportedCcMcpClient.connect(unsupportedCcMcpTransport);
  const unsupportedChannel = await waitForChannelEntry(
    unsupportedCcId,
    15_000,
    (channel) => channel.consumer_reason === 'unsupported_custom_base_url',
  );
  check('custom-provider CC stays explicitly ineligible after MCP initialization',
    unsupportedChannel.consumer_ready === false && unsupportedChannel.delivery_ready === false,
    JSON.stringify(unsupportedChannel));
  check('channel metadata persists no provider URL or auth secret',
    !/11434|ANTHROPIC_(?:BASE_URL|API_KEY|AUTH_TOKEN)/.test(JSON.stringify(unsupportedChannel)),
    JSON.stringify(unsupportedChannel));
  writeClaudeSession({ sessionId: unsupportedCcId, pid: unsupportedChannel.pid, name: 'unsupported-cc' });
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [
    {
      session_id: ccFallbackId,
      project_id: uniqueProjectId,
      project_path: uniqueProjectRoot,
      hook_ppid: ccFallbackChannel.pid,
      harness: 'claudecode',
      name: 'supported-cc',
      status: 'idle',
      last_seen_at: new Date().toISOString(),
    },
    {
      session_id: unsupportedCcId,
      project_id: uniqueProjectId,
      project_path: uniqueProjectRoot,
      hook_ppid: unsupportedChannel.pid,
      harness: 'claudecode',
      name: 'unsupported-cc',
      status: 'idle',
      last_seen_at: new Date().toISOString(),
    },
  ] }));
  await sleep(3_500);
  const readinessFilteredDispatchables = await client.listDispatchable('trialroomai');
  check('dashboard dispatchability keeps supported CC and excludes unsupported-provider CC',
    readinessFilteredDispatchables.some((row) => row.session_id === ccFallbackId)
      && !readinessFilteredDispatchables.some((row) => row.session_id === unsupportedCcId),
    JSON.stringify(readinessFilteredDispatchables));

  const unsupportedConsult = await callTool('consult_request', {
    to: unsupportedCcId,
    question: 'This must fail before HTTP acceptance.',
  });
  check('consult_request rejects unsupported CC with actionable Anthropic-auth guidance',
    unsupportedConsult.result.isError === true
      && /Anthropic authentication.*claude\.ai.*Console API key/i.test(unsupportedConsult.text)
      && /ANTHROPIC_BASE_URL/.test(unsupportedConsult.text),
    unsupportedConsult.text);
  check('unsupported consult emits no channel notification', unsupportedCcNotifications.length === 0, JSON.stringify(unsupportedCcNotifications));

  const unsupportedDirect = await fetch(`http://${unsupportedChannel.host}:${unsupportedChannel.port}/consult`, {
    method: 'POST',
    headers: { 'X-Sender': 'consult', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consult_id: 'cns-unsupported', question: 'must not be accepted' }),
  });
  const unsupportedDirectText = await unsupportedDirect.text();
  check('unsupported CC endpoint refuses direct legacy delivery before 202',
    unsupportedDirect.status === 503 && /Anthropic authentication/i.test(unsupportedDirectText),
    `${unsupportedDirect.status} ${unsupportedDirectText}`);


  const tools = await mcpClient.listTools();
  const transitionTool = tools.tools.find((tool) => tool.name === 'ticket_transition');
  check('MCP lists ticket_transition', !!transitionTool, tools.tools.map((tool) => tool.name).join(', '));
  check('ticket_transition description teaches the phase ladder', /queued.*building.*built.*verifying.*verified.*done/s.test(transitionTool?.description || ''), transitionTool?.description);

  const createViaMcp = async (title) => {
    const out = await callTool('ticket_create', { project: PROJECT_ID, title, kind: 'work-item', assignee: SESSION_ID });
    check(`ticket_create succeeds: ${title}`, !out.result.isError && !!out.json?.id, out.text);
    return out.json;
  };

  const specBody = [
    '# Context',
    'This spec proves explicit project scope survives MCP, HTTP, and SQLite persistence.',
    '',
    '## Acceptance criteria',
    '- The ticket remains a spec.',
    '- The requested project remains authoritative routing scope.',
  ].join('\n');
  const specCreated = await callTool('ticket_create', {
    project: PROJECT_ID,
    title: 'MCP explicit-project spec creation',
    body: specBody,
    kind: 'spec',
    assignee: SESSION_ID,
  });
  check('MCP creates a spec with explicit project scope',
    !specCreated.result.isError
      && specCreated.json?.kind === 'spec'
      && specCreated.json?.project_id === PROJECT_ID,
    specCreated.text);
  const persistedSpec = await callTool('ticket_get', { id: specCreated.json?.id });
  check('MCP spec round-trips through REST and SQLite',
    !persistedSpec.result.isError
      && persistedSpec.json?.body === specBody
      && persistedSpec.json?.project_id === PROJECT_ID,
    persistedSpec.text);
  const scopedSpecs = await callTool('ticket_list', { project: PROJECT_ID, kind: 'spec' });
  check('MCP project-scoped spec list does not widen across projects',
    !scopedSpecs.result.isError
      && Array.isArray(scopedSpecs.json)
      && scopedSpecs.json.some((ticket) => ticket.id === specCreated.json?.id)
      && !scopedSpecs.json.some((ticket) => ticket.id === foreignSpec.id),
    scopedSpecs.text);

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
    try { await unsupportedCcMcpClient?.close(); } catch { /* ignore */ }
    try { await unsupportedCcMcpTransport?.close(); } catch { /* ignore */ }
    try { uninitializedCcChild?.kill('SIGKILL'); } catch { /* ignore */ }
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
