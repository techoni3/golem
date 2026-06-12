#!/usr/bin/env node
// golem channel server — pushes briefs / interrupts / halts / gate verdicts
// into a live `golem-ceo` Claude Code session, and exposes a `GET /events`
// SSE stream so the dashboard can subscribe to CEO acks.
//
// v3 multi-CEO topology:
//   - Each CEO session spawns its own channel-server child (one MCP per CEO).
//   - GOLEM_CHANNEL_PORT=0 (the launcher's default) → bind a random free port,
//     so multiple CEOs coexist without EADDRINUSE.
//   - On listen, the channel server registers itself in
//     ~/.config/golem/channels.json keyed by CLAUDE_CODE_SESSION_ID. The
//     dashboard reads that registry and opens one SSE per session.
//   - Every broadcast payload carries `session_id` so the dashboard can route
//     the message into the right CEO's chat lane.
//
// See substrate/channels/golem/README.md for setup. Authoritative protocol
// docs: https://code.claude.com/docs/en/channels-reference.md
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { URL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.1.0';
// GOLEM_CHANNEL_PORT=0 → kernel-assigned free port (multi-CEO mode).
// Default kept at 7421 so single-CEO smoke tests & legacy callers still work.
const PORT = Number(process.env.GOLEM_CHANNEL_PORT ?? 7421);
const HOST = '127.0.0.1';
const ALLOWED_SENDERS = new Set(
  (process.env.GOLEM_CHANNEL_ALLOWED_SENDERS || 'dashboard,cli,curl')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Identity for chat-routing. Verified empirically: Claude Code does NOT
// stamp `CLAUDE_CODE_SESSION_ID` onto MCP-child env (despite some docs
// implying so) — only user-set env like GOLEM_CHANNEL_PORT propagates. The
// golem session launcher (substrate/bin/golem) explicitly exports
// `GOLEM_CEO_SESSION_ID` before exec'ing claude so the value reaches the
// MCP child. The `CLAUDE_CODE_SESSION_ID` fallback covers any future runtime
// where claude-code does propagate it.
const SESSION_ID =
  process.env.GOLEM_CEO_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '';

const CHANNELS_REGISTRY = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'golem',
  'channels.json',
);
const CHANNELS_LOCK = `${CHANNELS_REGISTRY}.lock`;

// --- Outbound: SSE listeners on /events ------------------------------------
/** @type {Set<(chunk: string) => void>} */
const listeners = new Set();

function broadcast(eventName, payload) {
  const enriched = { session_id: SESSION_ID, ...payload };
  const data = JSON.stringify(enriched);
  const chunk = `event: ${eventName}\ndata: ${data}\n\n`;
  for (const emit of listeners) {
    try {
      emit(chunk);
    } catch {
      // listener already gone; will be reaped on next request abort
    }
  }
}

// --- Channel registry ------------------------------------------------------
// Atomic mkdir-based mutex; matches the convention used by the golem CLI for
// projects.json / sessions.json. Holds the lock just long enough to
// read-modify-write the JSON file.
function withChannelLock(fn) {
  const dir = path.dirname(CHANNELS_REGISTRY);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const tries = 50;
  for (let i = 0; i < tries; i++) {
    try {
      fs.mkdirSync(CHANNELS_LOCK);
      try { return fn(); }
      finally { try { fs.rmdirSync(CHANNELS_LOCK); } catch { /* ignore */ } }
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // stale lock? if mtime > 5s drop it.
        try {
          const st = fs.statSync(CHANNELS_LOCK);
          if (Date.now() - st.mtimeMs > 5000) {
            try { fs.rmdirSync(CHANNELS_LOCK); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        // Tight retry; we're in a node single-process child so the busy
        // window is microseconds.
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* spin briefly */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to acquire ${CHANNELS_LOCK} after ${tries} tries`);
}

function readChannelsRegistry() {
  try {
    const raw = fs.readFileSync(CHANNELS_REGISTRY, 'utf8');
    const json = JSON.parse(raw);
    if (json && Array.isArray(json.channels)) return json;
  } catch { /* ignore */ }
  return { version: 1, channels: [] };
}

function writeChannelsRegistry(reg) {
  const tmp = `${CHANNELS_REGISTRY}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, CHANNELS_REGISTRY);
}

// Captured once at module load so the periodic re-register heartbeat keeps a
// stable started_at instead of advancing it every tick.
const STARTED_AT = new Date().toISOString();

function registerChannel(port) {
  if (!SESSION_ID) {
    process.stderr.write('[golem-channel] CLAUDE_CODE_SESSION_ID empty; channel will not register for multi-CEO routing\n');
    return;
  }
  withChannelLock(() => {
    const reg = readChannelsRegistry();
    reg.channels = reg.channels.filter((c) => c.session_id !== SESSION_ID);
    reg.channels.push({
      session_id: SESSION_ID,
      pid: process.pid,
      host: HOST,
      port,
      version: VERSION,
      started_at: STARTED_AT,
    });
    writeChannelsRegistry(reg);
  });
}

function unregisterChannel() {
  if (!SESSION_ID) return;
  try {
    withChannelLock(() => {
      const reg = readChannelsRegistry();
      const before = reg.channels.length;
      // Filter by PID, not session_id. When Claude Code recycles this MCP
      // child, the successor process boots and registerChannel's *before*
      // this old process's exit handler runs. Both share SESSION_ID, so a
      // session_id-based filter here would delete the successor's fresh
      // entry — wiping the session from the registry. Removing only our own
      // pid leaves the successor intact.
      reg.channels = reg.channels.filter((c) => c.pid !== process.pid);
      if (reg.channels.length !== before) writeChannelsRegistry(reg);
    });
  } catch (err) {
    process.stderr.write(`[golem-channel] failed to unregister: ${err.message}\n`);
  }
}

// --- MCP server ------------------------------------------------------------
const mcp = new Server(
  { name: 'golem', version: VERSION },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'Events from this channel arrive as <channel source="golem" kind="..."> tags.',
      'Recognised kinds:',
      '  - brief: a new user brief. Classify it (fresh idea / established idea / continuation / fix / chat) and run the relevant flow.',
      '  - interrupt: a course-correction to fold into in-flight work without restarting. Read, integrate, continue.',
      '  - halt: a request to gracefully halt the current journey, write a closing memo, and yield. Do not start new work.',
      '  - gate_approve: a verdict on a pending human gate. The gate_id meta attribute names the gate file under docs/agent-notes/gates/. Update its status to approved and resume per skills/golem-gates.',
      '  - gate_deny: same, but set status to denied (hard stop for that journey).',
      '  - gate_cancel: same, but set status to cancelled.',
      'You have TWO reply tools — both fire over the same SSE channel and surface in the dashboard chat:',
      '  • `ack` — fires IMMEDIATELY on receipt of every inbound event, no exceptions. One short sentence describing what the CEO understood and is about to do. Pass the same kind; include gate_id for gate_* events.',
      '  • `respond` — fires when the CEO has something user-facing to say BACK to the user (chat answers, clarification questions, decision asks, final results of short briefs). Body is the actual reply text. Skip it when the brief just enters the autonomy loop and has nothing immediate to communicate — the dashboard timeline shows progress in that case.',
      'Order of operations for any inbound channel event: 1) call ack on receipt, 2) do the work, 3) optionally call respond with the user-facing answer, 4) yield.',
    ].join(' '),
  },
);

// --- Reply tools: `ack` + `respond` ---------------------------------------
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ack',
      description:
        'Acknowledge a golem channel event. Fires immediately on receipt of every inbound event. One short sentence describing what was understood and what happens next.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description:
              'The kind of event being acknowledged (brief|interrupt|halt|gate_approve|gate_deny|gate_cancel).',
          },
          gate_id: {
            type: 'string',
            description: 'For gate_* kinds: the gate_id from the inbound event.',
          },
          summary: {
            type: 'string',
            description: 'One-sentence description of what the CEO did or will do next.',
          },
        },
        required: ['kind', 'summary'],
      },
    },
    {
      name: 'respond',
      description:
        'Send a user-facing reply BACK over the golem channel — surfaces as a chat bubble in the dashboard. Use this for chat answers (e.g. status questions), clarifications, decision asks, or the final result of a short brief. Do NOT use it for intermediate reasoning, tool-call narration, or sub-agent activity — that belongs in the terminal session only.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The user-facing reply, in markdown. Keep it concise — the dashboard chat is a thin client, not a full transcript.',
          },
          kind: {
            type: 'string',
            description:
              'Optional: the kind of inbound event this is responding to (brief|interrupt|halt|gate_*). Defaults to "brief".',
          },
          gate_id: {
            type: 'string',
            description: 'Optional: gate_id if this response is about a specific gate.',
          },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};

  if (name === 'ack') {
    const payload = {
      kind: args.kind || 'unknown',
      gate_id: args.gate_id,
      summary: typeof args.summary === 'string' ? args.summary : '',
      ts: new Date().toISOString(),
    };
    broadcast('ack', payload);
    return { content: [{ type: 'text', text: 'ack broadcast' }] };
  }

  if (name === 'respond') {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text.trim()) {
      throw new Error('respond: `text` is required and must be non-empty');
    }
    const payload = {
      kind: args.kind || 'brief',
      gate_id: args.gate_id,
      text,
      ts: new Date().toISOString(),
    };
    broadcast('response', payload);
    return { content: [{ type: 'text', text: 'response broadcast' }] };
  }

  throw new Error(`unknown tool: ${name}`);
});

// --- Helpers ---------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const LIMIT = 1024 * 1024; // 1 MiB cap; briefs are text
    req.on('data', (c) => {
      total += c.length;
      if (total > LIMIT) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function pushEvent(kind, content, extraMeta = {}) {
  // meta keys must be identifiers (letters/digits/underscore) — hyphens
  // are silently dropped by Claude Code. snake_case only.
  const meta = { kind, ...extraMeta };
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  });
}

// --- HTTP listener ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad url' });
  }
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    // GET /healthz — smoke endpoint
    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, { ok: true, version: VERSION });
    }

    // GET /events — SSE stream of CEO acks
    if (method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const emit = (chunk) => res.write(chunk);
      listeners.add(emit);
      const cleanup = () => listeners.delete(emit);
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    // Every other route is an inbound push — gate the sender.
    const sender = (req.headers['x-sender'] || '').toString();
    if (!ALLOWED_SENDERS.has(sender)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'forbidden',
        hint: 'set X-Sender header to one of: ' + [...ALLOWED_SENDERS].join(', '),
      });
    }

    if (method === 'POST' && path === '/brief') {
      const body = await readBody(req);
      await pushEvent('brief', extractContent(body));
      return sendJson(res, 202, { ok: true, kind: 'brief' });
    }

    if (method === 'POST' && path === '/interrupt') {
      const body = await readBody(req);
      await pushEvent('interrupt', extractContent(body));
      return sendJson(res, 202, { ok: true, kind: 'interrupt' });
    }

    if (method === 'POST' && path === '/halt') {
      const body = await readBody(req);
      await pushEvent('halt', extractContent(body) || 'halt requested');
      return sendJson(res, 202, { ok: true, kind: 'halt' });
    }

    // /gates/:id/(approve|deny|cancel)
    const gateMatch = /^\/gates\/([A-Za-z0-9._-]+)\/(approve|deny|cancel)$/.exec(path);
    if (method === 'POST' && gateMatch) {
      const gateId = gateMatch[1];
      const verdict = gateMatch[2];
      const body = await readBody(req);
      const note = extractContent(body);
      const kind = `gate_${verdict}`;
      const content = note || `${verdict} ${gateId}`;
      await pushEvent(kind, content, { gate_id: gateId });
      return sendJson(res, 202, { ok: true, kind, gate_id: gateId });
    }

    return sendJson(res, 404, { ok: false, error: 'not found', path, method });
  } catch (err) {
    // Never crash on a bad client request.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      sendJson(res, 500, { ok: false, error: msg });
    } catch {
      // headers already sent; nothing else to do.
    }
  }
});

server.on('clientError', (_err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    // socket already closed
  }
});

function extractContent(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // If JSON with a 'content' or 'brief' field, use that; otherwise treat the
  // whole parsed value (or raw text) as the brief body.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.brief === 'string') return parsed.brief;
      return JSON.stringify(parsed);
    }
    if (typeof parsed === 'string') return parsed;
  } catch {
    // not JSON — fall through
  }
  return trimmed;
}

// --- Boot ------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
  // stderr only — stdout is reserved for MCP stdio framing.
  process.stderr.write(
    `[golem-channel] http://${HOST}:${boundPort} (v${VERSION}) session=${SESSION_ID || '(none)'}\n`,
  );
  try { registerChannel(boundPort); } catch (err) {
    process.stderr.write(`[golem-channel] register failed: ${err.message}\n`);
  }
  // Re-assert registration on an interval. registerChannel only fires once at
  // listen — if this session's entry is ever lost afterward (a cross-process
  // write race, a manual edit, file corruption), it would never come back.
  // A periodic re-register makes the registry self-healing: any loss is
  // corrected within HEARTBEAT_MS. registerChannel is idempotent (it filters
  // this session's stale rows before re-adding). unref() so the timer never
  // keeps the process alive on its own.
  const HEARTBEAT_MS = 30_000;
  setInterval(() => {
    try { registerChannel(boundPort); } catch { /* transient — next tick retries */ }
  }, HEARTBEAT_MS).unref();
});

// Cleanup hooks — the channel registry should not grow ghosts when the CEO
// dies or restarts. The stale-PID GC in the dashboard is a backstop, not a
// primary cleanup path.
function shutdown(code = 0) {
  unregisterChannel();
  try { server.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP',  () => shutdown(0));
process.on('beforeExit', () => unregisterChannel());

await mcp.connect(new StdioServerTransport());
