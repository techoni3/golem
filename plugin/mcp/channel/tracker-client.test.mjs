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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_SERVER = path.resolve(__dirname, '../../../dashboard/server/index.js');

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

async function waitForChannel(timeoutMs = 15000) {
  const channelsFile = path.join(tmpGolemHome, 'channels.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels || [];
      const channel = channels.find((entry) => entry.session_id === SESSION_ID);
      if (channel?.host && channel?.port) return `http://${channel.host}:${channel.port}`;
    } catch {
      /* channel has not registered yet */
    }
    await sleep(50);
  }
  throw new Error('channel did not register within timeout');
}

let child;
let mcpClient;
let mcpTransport;
let port;

function toolText(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}

async function callTool(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = toolText(result);
  let json = null;
  if (!result.isError && text) {
    try { json = JSON.parse(text); } catch { /* non-JSON success */ }
  }
  return { result, text, json };
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

  const client = await import('./tracker-client.js');

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
    args: [path.join(__dirname, 'index.js')],
    cwd: path.resolve(__dirname, '../..'),
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
