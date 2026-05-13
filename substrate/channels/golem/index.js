#!/usr/bin/env node
// golem channel server — pushes briefs / interrupts / halts / gate verdicts
// into a live `golem-ceo` Claude Code session, and exposes a `GET /events`
// SSE stream so the dashboard can subscribe to CEO acks.
//
// See substrate/channels/golem/README.md for setup. Authoritative protocol
// docs: https://code.claude.com/docs/en/channels-reference.md
import http from 'node:http';
import { URL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.GOLEM_CHANNEL_PORT || 7421);
const HOST = '127.0.0.1';
const ALLOWED_SENDERS = new Set(
  (process.env.GOLEM_CHANNEL_ALLOWED_SENDERS || 'dashboard,cli,curl')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// --- Outbound: SSE listeners on /events ------------------------------------
/** @type {Set<(chunk: string) => void>} */
const listeners = new Set();

function broadcast(eventName, payload) {
  const data = JSON.stringify(payload);
  const chunk = `event: ${eventName}\ndata: ${data}\n\n`;
  for (const emit of listeners) {
    try {
      emit(chunk);
    } catch {
      // listener already gone; will be reaped on next request abort
    }
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
  // stderr only — stdout is reserved for MCP stdio framing.
  process.stderr.write(`[golem-channel] http://${HOST}:${PORT} (v${VERSION})\n`);
});

await mcp.connect(new StdioServerTransport());
