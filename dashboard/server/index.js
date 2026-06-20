import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { CONFIG } from './config.js';
import { createState } from './state.js';
import { ROLES } from './roles.js';
import { TRACKER_COLUMNS } from './tracker.js';
import { pushBrief, pushInterrupt, pushHalt, pushGate, channelHealth, listChannels } from './brief.js';
import { writeGateVerdict, readChannels } from './orchestrator.js';
import { createChat } from './chat.js';
import { readNativeSessionPeek } from './native-session-peek.js';
import { openTrackerDb } from './tracker-db.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

const DECISION_PAST = { approve: 'approved', deny: 'denied', cancel: 'cancelled' };

// ── Canonical project_id scheme (WS2) ───────────────────────────────────────
// Tickets, the projects list, and native sessions are reconciled on ONE id:
// the CONTRACT project_id `<slug>-<6hex>` derived from the absolute project
// root (see project-id.js → projectIdFor). It is what every project summary
// exposes as `project_id`, what native-sessions.js derives, and therefore what
// tickets must carry as `project_id`. The dashboard registry `id` (dir name like
// `sudoku`, or a hand-set external id like `trialroom-ai`) is NOT canonical and
// is deliberately NOT used to key tickets — it diverges across project kinds.
// `/api/tickets?project=` and `/api/sessions/dispatchable?project=` both expect
// this contract id. We tolerate a registry-`id` being passed by resolving it to
// the contract id via the projects list before querying (resolveProjectId).

// The golem config dir — same resolution as tracker-db.js / orchestrator.js
// (XDG_CONFIG_HOME ?? ~/.config, then /golem). Used for dashboard.json.
function golemConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'golem');
}

async function main() {
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const state = createState();
  await state.init();
  const chat = createChat();
  chat.start();

  // WS2: the dashboard is the SINGLE WRITER of the tracker DB. Open it once
  // here (it auto-inits / migrates). GOLEM_TRACKER_DB override flows through
  // openTrackerDb → defaultDbPath. Closed in shutdown() below.
  const tracker = openTrackerDb();

  // Resolve a caller-supplied `project` query value to the canonical contract
  // project_id. Accepts either the contract id (passed straight through) OR a
  // dashboard registry id (e.g. `sudoku`, `trialroom-ai`) which we map to its
  // project_id via the projects list. Unknown values pass through unchanged so
  // a not-yet-discovered project still filters correctly on its raw id.
  function resolveProjectId(value) {
    if (!value) return null;
    for (const p of state.projects()) {
      if (p.project_id === value) return value; // already canonical
      if (p.id === value && p.project_id) return p.project_id; // registry id → contract id
    }
    return value;
  }

  // WS2: all streams across every project (no all-streams helper on the DB,
  // and discovered projects may lag behind tickets an agent just created — so
  // read the table directly rather than iterating the projects list).
  function listAllStreams() {
    return tracker.raw().prepare('SELECT * FROM streams ORDER BY created_at ASC, id ASC').all();
  }

  await fastify.register(websocket);
  await fastify.register(fastifyStatic, {
    root: WEB_ROOT,
    prefix: '/',
    cacheControl: false,
    // Force browsers to revalidate every asset on each load. Without this the
    // browser will hold onto JSX/CSS via Last-Modified/ETag for the session
    // and dashboard edits won't show up without a hard refresh. The dashboard
    // is an internal-only dev surface — no point in any caching.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  });

  // ---- REST API ----

  fastify.get('/api/health', async () => ({
    ok: true,
    projects_root: CONFIG.projectsRoot,
    project_count: state.projects().length,
    server_time: new Date().toISOString(),
  }));

  fastify.get('/api/meta', async () => ({
    roles: ROLES,
    columns: TRACKER_COLUMNS,
    config: {
      projectsRoot: CONFIG.projectsRoot,
      ideasRoot: CONFIG.ideasRoot,
      golemRoot: CONFIG.golemRoot,
      channelUrl: CONFIG.channelUrl,
      agentActiveWindowMs: CONFIG.agentActiveWindowMs,
      agentIdleTimeoutMs: CONFIG.agentIdleTimeoutMs,
      ceoLiveWindowMs: CONFIG.ceoLiveWindowMs,
    },
  }));

  fastify.get('/api/projects', async () => state.projects());

  fastify.get('/api/workspaces', async () => state.workspaces());

  fastify.get('/api/orchestrator', async () => state.orchestrator());

  // WS2: fold the tracker tables into every snapshot so a fresh client renders
  // the board immediately (no extra round-trip). NOTE: state.snapshot() already
  // carries a `tickets` key (legacy markdown tickets). We deliberately overlay
  // the tracker-DB tickets here — the new board reads these — while keeping all
  // other snapshot fields intact, and add `streams`.
  function trackerSnapshot() {
    return {
      tickets: tracker.listTickets({}),
      streams: listAllStreams(),
    };
  }

  fastify.get('/api/snapshot', async () => ({
    ...state.snapshot(),
    ...trackerSnapshot(),
    chat: chat.snapshot(),
  }));

  fastify.get('/api/chat', async () => chat.snapshot());

  // ---- Orchestrator intrusion proxy (dashboard → golem MCP channel server) ----

  // Accept either { brief: "..." } / { text: "..." } / raw string, or any
  // serialisable JSON the user wants to attach. We forward what we get.
  function extractBody(req) {
    const b = req.body;
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (typeof b.brief === 'string') return b.brief;
    if (typeof b.text === 'string') return b.text;
    return b;
  }

  function bodyToText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof body.brief === 'string') return body.brief;
    if (typeof body.text === 'string') return body.text;
    try { return JSON.stringify(body); } catch { return String(body); }
  }

  // Record the user/system message FIRST so the chat lane updates even if the
  // channel server is unreachable. On forward failure, emit a system note so
  // the user sees what went wrong instead of a silent vanish.
  function noteForwardFailure(label, result) {
    const detail = result?.error || `status ${result?.status ?? '?'}`;
    chat.record('system', 'error', `${label} not delivered — channel ${detail}. Is the CEO session running?`);
  }

  // session_id is taken from the body OR the ?session= query string. The
  // frontend always passes it through the body so a single brief can be
  // routed to a specific CEO; query string is for curl convenience.
  function extractSessionId(req) {
    const sid = (req.body && typeof req.body === 'object' && typeof req.body.session_id === 'string'
      ? req.body.session_id
      : null) ?? (typeof req.query?.session === 'string' ? req.query.session : null);
    return sid && sid.trim() ? sid.trim() : null;
  }

  fastify.post('/api/brief', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('user', 'brief', bodyToText(body), sessionId ? { session_id: sessionId } : {});
    const result = await pushBrief(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('brief', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  fastify.post('/api/interrupt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('user', 'interrupt', bodyToText(body), sessionId ? { session_id: sessionId } : {});
    const result = await pushInterrupt(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('interrupt', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  fastify.post('/api/halt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('system', 'halt', bodyToText(body) || 'halt requested', sessionId ? { session_id: sessionId } : {});
    const result = await pushHalt(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('halt', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  fastify.post('/api/gates/:gateId/:decision', async (req, reply) => {
    const { gateId, decision } = req.params;
    if (!['approve', 'deny', 'cancel'].includes(decision)) {
      return reply.code(400).send({ error: `unknown gate decision: ${decision}` });
    }
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    const extras = { gate_id: gateId };
    if (sessionId) extras.session_id = sessionId;
    chat.record('system', `gate_${decision}`, bodyToText(body) || `${decision} ${gateId}`, extras);

    // 1) Authoritatively flip the gate file's status. The dashboard owns the
    //    gate files, so a verdict is recorded on disk regardless of whether a
    //    CEO is live to consume the channel push. This is the source of truth.
    const fileResult = await writeGateVerdict(state.rawWorkspaces(), gateId, decision);

    // 2) Best-effort: wake a live CEO via the channel so it resumes from the
    //    verdict. A missing/unreachable channel is NOT a hard failure when the
    //    file already flipped — the CEO (or the user) picks it up on resume.
    let channelResult = null;
    try {
      channelResult = await pushGate(gateId, decision, body, sessionId);
    } catch (err) {
      channelResult = { ok: false, error: String(err?.message ?? err) };
    }

    state.refreshOrchestrator().catch(() => {});

    if (!fileResult.ok) {
      // The file didn't flip. If the channel push also failed, surface the
      // error; if the channel accepted it, a live CEO will action it.
      if (channelResult && !channelResult.ok) {
        chat.record('system', 'error', `gate ${decision} ${gateId} failed: ${fileResult.error}`);
        return reply.code(404).send({ ok: false, error: fileResult.error, channel: channelResult });
      }
    } else if (channelResult && !channelResult.ok) {
      // File flipped but no channel to notify — surface a soft note, still 200.
      chat.record('system', `gate_${decision}`, `gate ${gateId} ${DECISION_PAST[decision]} (no live CEO to notify — will resume on next session)`, extras);
    }

    return { ok: true, gate_id: gateId, decision, file: fileResult, channel: channelResult };
  });
  fastify.get('/api/channel/health', async (req) => channelHealth(typeof req.query?.session === 'string' ? req.query.session : null));
  fastify.get('/api/channels', async () => listChannels());

  fastify.get('/api/projects/:id', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return state
      .projects()
      .find((x) => x.id === req.params.id);
  });

  fastify.get('/api/projects/:id/agents', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return state.projectAgents(req.params.id);
  });

  fastify.get('/api/projects/:id/agents/:agentId', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const a = state.agentDetail(req.params.id, req.params.agentId);
    if (!a) return reply.code(404).send({ error: 'agent_not_found' });
    return a;
  });

  fastify.get('/api/projects/:id/tickets', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return state.projectTickets(req.params.id);
  });

  // v4: PLAN.md progress for a single project. Returns {total, done, items}
  // (+ title). 404 if the project is unknown; {total:0,...} if it has no plan.
  fastify.get('/api/projects/:id/plan', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const plan = state.projectPlan(req.params.id);
    if (!plan) return { title: null, total: 0, done: 0, items: [] };
    return plan;
  });

  // v4: all native Claude Code sessions on this machine (merged CLI + registry,
  // pid-checked). Already inside /api/snapshot as native_sessions[]; this is a
  // convenience route + the polling target for any external scripting.
  fastify.get('/api/native-sessions', async () => state.nativeSessions());

  // v4 (fix round 2, defect 1): per-session peek for the native-session drawer.
  // Returns { session, events, milestones, transcript_path, note } where events
  // are the recent central-journal hook lines filtered by this session_id.
  fastify.get('/api/native-sessions/:sessionId/peek', async (req) => {
    const sessionId = req.params.sessionId;
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    return readNativeSessionPeek(sessionId, session);
  });

  // ---- WS2: tracker REST (the dashboard is the SINGLE WRITER) ----
  // Every mutation persists via `tracker` then broadcasts a WS delta. The
  // legacy markdown routes (/api/projects/:id/tickets, /plan) stay untouched.

  // GET /api/tickets — consolidated/filtered board feed. No `project` = all
  // projects. The DB filter key is `project_id`; the REST param is `project`.
  fastify.get('/api/tickets', async (req) => {
    const q = req.query ?? {};
    const filter = {};
    if (q.project != null) filter.project_id = resolveProjectId(q.project);
    if (q.state != null) filter.state = q.state;
    if (q.assignee != null) filter.assignee = q.assignee;
    if (q.kind != null) filter.kind = q.kind;
    if (q.stream != null) filter.stream_id = q.stream;
    if (q.includeArchived != null) {
      filter.includeArchived = q.includeArchived === 'true' || q.includeArchived === true || q.includeArchived === '1';
    }
    return tracker.listTickets(filter);
  });

  // POST /api/tickets — create. 400 on validation error.
  fastify.post('/api/tickets', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const ticket = tracker.createTicket({
        project_id: b.project_id,
        kind: b.kind,
        title: b.title,
        body: b.body,
        priority: b.priority,
        labels: b.labels,
        stream_id: b.stream_id,
        parent_id: b.parent_id,
        assignee: b.assignee,
        created_by: b.created_by,
      });
      broadcastWS({ type: 'ticket-created', ticket });
      return reply.code(201).send(ticket);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/tickets/:id — ticket (+ comments/links from getTicket) plus its
  // event history. 404 if unknown.
  fastify.get('/api/tickets/:id', async (req, reply) => {
    const ticket = tracker.getTicket(req.params.id);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    return { ...ticket, events: tracker.listEvents({ ticket_id: req.params.id }) };
  });

  // PATCH /api/tickets/:id — partial update. 404 if missing, 400 on invalid.
  fastify.patch('/api/tickets/:id', async (req, reply) => {
    const id = req.params.id;
    if (!tracker.getTicket(id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const ticket = tracker.updateTicket(id, req.body ?? {});
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/tickets/:id/comments — add a comment. Broadcasts both the comment
  // delta AND a ticket-updated (addComment bumps the ticket's updated_at).
  fastify.post('/api/tickets/:id/comments', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    try {
      const comment = tracker.addComment(id, { author: b.author, body: b.body });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send(comment);
    } catch (err) {
      // addComment throws on unknown ticket / missing author|body. Treat a
      // missing ticket as 404, everything else as 400.
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/links — add a link from this ticket. Re-fetch + send
  // the from-ticket as a ticket-updated delta.
  fastify.post('/api/tickets/:id/links', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    try {
      tracker.addLink(id, b.to_ticket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send({ from_ticket: id, to_ticket: b.to_ticket, type: b.type });
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // DELETE /api/tickets/:id/links — remove a link. Re-fetch + send the
  // from-ticket as a ticket-updated delta.
  fastify.delete('/api/tickets/:id/links', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    try {
      const result = tracker.removeLink(id, b.to_ticket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/tickets/:id/dispatch — assign a ticket to a live native session
  // and push it a self-contained brief so that session picks the work up.
  //
  // Durable-first (mirrors the gate handler): setDispatched flips assignee +
  // dispatched_to + dispatched_at and records a `dispatched` event BEFORE we
  // touch the channel. The channel push is best-effort — an unreachable session
  // never fails the request, since the assignment is already on disk and the
  // session (or the user) can pick it up on resume.
  fastify.post('/api/tickets/:id/dispatch', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    const sessionId = typeof b.session_id === 'string' && b.session_id.trim() ? b.session_id.trim() : null;
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;

    const existing = tracker.getTicket(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });

    // 1) Durable write — assign + record the dispatched event. Source of truth.
    tracker.setDispatched(id, { session_id: sessionId, actor: 'human' });

    // 2) Build a clear, self-contained brief so the receiving session knows
    //    exactly what it's been handed and how to pick it up. The tracker MCP
    //    tools (ticket_get, etc.) land in WS3 — naming them now is intentional.
    const briefString =
      `You've been assigned tracker ticket ${id}: "${existing.title}" (project ${existing.project_id}, kind ${existing.kind}).\n\n` +
      `${note ? note + '\n\n' : ''}` +
      `Load it with the golem tracker tools (ticket_get ${id}) to read the full body, acceptance criteria, and comment thread, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete. ` +
      `If you have blocking questions, create a question-kind ticket in this project assigned to 'human'.`;

    // 3) Best-effort channel push — never fail the request on a push miss.
    let channelResult = null;
    try {
      channelResult = await pushBrief(briefString, sessionId);
    } catch (err) {
      channelResult = { ok: false, error: String(err?.message ?? err) };
    }
    if (channelResult && channelResult.ok) {
      chat.record('user', 'brief', briefString, { session_id: sessionId });
    } else {
      const detail = channelResult?.error || `status ${channelResult?.status ?? '?'}`;
      chat.record('system', 'error', `dispatch of ${id} to ${sessionId} — channel ${detail} (ticket assigned; session will pick it up on resume)`);
    }

    const ticket = tracker.getTicket(id);
    broadcastWS({ type: 'ticket-updated', ticket });
    return { ok: true, ticket, channel: channelResult };
  });

  // GET /api/streams — streams for one project, or all if `project` omitted.
  fastify.get('/api/streams', async (req) => {
    const project = req.query?.project;
    if (project != null) return tracker.listStreams(resolveProjectId(project));
    return listAllStreams();
  });

  // POST /api/streams — create a stream. 400 on validation error.
  fastify.post('/api/streams', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const stream = tracker.createStream({
        project_id: b.project_id,
        name: b.name,
        mode: b.mode,
        description: b.description,
      });
      broadcastWS({ type: 'stream-updated', stream });
      return reply.code(201).send(stream);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // PATCH /api/streams/:id — update a stream. 404 if missing, 400 on invalid.
  fastify.patch('/api/streams/:id', async (req, reply) => {
    try {
      const stream = tracker.updateStream(req.params.id, req.body ?? {});
      broadcastWS({ type: 'stream-updated', stream });
      return stream;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // GET /api/sessions/dispatchable — live native sessions in a project that can
  // actually receive a brief: alive === true AND mapping to the requested
  // project (canonical contract id), INTERSECTed with channels.json by
  // session_id (only registered channels are reachable). `project` omitted →
  // all dispatchable sessions (each annotated with its project_id).
  fastify.get('/api/sessions/dispatchable', async (req) => {
    const wanted = req.query?.project != null ? resolveProjectId(req.query.project) : null;
    let channels = [];
    try {
      channels = await readChannels();
    } catch {
      channels = [];
    }
    const channelBySession = new Map();
    for (const c of channels) if (c.session_id) channelBySession.set(c.session_id, c);

    const out = [];
    for (const s of state.nativeSessions()) {
      if (!s.alive) continue;
      if (wanted != null && s.project_id !== wanted) continue;
      const ch = channelBySession.get(s.session_id);
      if (!ch) continue; // no channel → not reachable for dispatch
      out.push({
        session_id: s.session_id,
        name: s.name ?? null,
        label: s.name || `session ${String(s.session_id ?? '').slice(0, 8)}`,
        status: s.status ?? null,
        project_id: s.project_id ?? null,
        channel_url: ch.url ?? (ch.host && ch.port ? `http://${ch.host}:${ch.port}` : null),
        started_at: s.started_at ?? null,
        updated_at: s.updated_at ?? null,
      });
    }
    return out;
  });

  // ---- WebSocket ----

  const sockets = new Set();

  fastify.register(async (fast) => {
    fast.get('/ws', { websocket: true }, (socket /*, req*/) => {
      sockets.add(socket);

      // Send full snapshot on connect.
      try {
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            payload: { ...state.snapshot(), ...trackerSnapshot(), chat: chat.snapshot() },
            ts: Date.now(),
          }),
        );
      } catch (err) {
        fastify.log.warn({ err }, 'ws snapshot send failed');
      }

      socket.on('message', (raw) => {
        let msg = null;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') {
          try {
            socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          } catch {
            /* ignore */
          }
          return;
        }
        if (msg.type === 'subscribe-agent' && msg.projectId && msg.agentId) {
          const a = state.agentDetail(msg.projectId, msg.agentId);
          if (a) {
            socket.send(
              JSON.stringify({
                type: 'agent-detail',
                projectId: msg.projectId,
                agent: a,
                ts: Date.now(),
              }),
            );
          }
        }
      });

      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
  });

  function broadcastWS(payloadObj) {
    if (sockets.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify({ ...payloadObj, ts: Date.now() });
    } catch (err) {
      fastify.log.warn({ err }, 'failed to serialise ws payload');
      return;
    }
    for (const sock of sockets) {
      if (sock.readyState !== 1) continue;
      try {
        sock.send(payload);
      } catch {
        sockets.delete(sock);
      }
    }
  }

  // Chat messages → all connected sockets.
  chat.on('message', (m) => {
    broadcastWS({ type: 'chat-message', message: m });
  });

  // Forward state events → all connected sockets.
  state.on('event', (ev) => {
    if (sockets.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify({ ...ev, ts: Date.now() });
    } catch (err) {
      fastify.log.warn({ err }, 'failed to serialise state event');
      return;
    }
    for (const sock of sockets) {
      if (sock.readyState !== 1) continue;
      try {
        sock.send(payload);
      } catch {
        sockets.delete(sock);
      }
    }
  });

  // Try to bind on configured port; if busy, increment up to +20.
  const tryListen = async (startPort) => {
    let lastErr;
    for (let port = startPort; port < startPort + 20; port++) {
      try {
        await fastify.listen({ host: CONFIG.host, port });
        return port;
      } catch (err) {
        if (err.code === 'EADDRINUSE') {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('Could not bind any port');
  };

  const boundPort = await tryListen(CONFIG.port);
  fastify.log.info(
    `Substrate dashboard listening on http://${CONFIG.host}:${boundPort}` +
      ` — projects root: ${CONFIG.projectsRoot}`,
  );

  // WS2: self-register so WS3's MCP discovery can find the live dashboard.
  // Atomic write (tmp + rename) into ~/.config/golem/dashboard.json. Best-effort
  // — a write failure logs a warning and must NOT crash the server. We LEAVE the
  // file on shutdown (a stale entry is harmless: consumers health-check the URL).
  try {
    const dir = golemConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'dashboard.json');
    const tmp = path.join(dir, `.dashboard.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const doc = {
      url: `http://${CONFIG.host}:${boundPort}`,
      host: CONFIG.host,
      port: boundPort,
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
    fastify.log.info(`self-registered at ${target}`);
  } catch (err) {
    fastify.log.warn({ err }, 'dashboard self-registration failed (non-fatal)');
  }

  // Clean shutdown.
  const shutdown = async () => {
    fastify.log.info('shutting down…');
    try {
      chat.stop();
      await state.close();
      tracker.close();
      await fastify.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
