import path from 'node:path';
import url from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { CONFIG } from './config.js';
import { createState } from './state.js';
import { ROLES } from './roles.js';
import { TRACKER_COLUMNS } from './tracker.js';
import { pushBrief, pushInterrupt, pushHalt, pushGate, channelHealth, listChannels } from './brief.js';
import { writeGateVerdict } from './orchestrator.js';
import { createChat } from './chat.js';
import { readNativeSessionPeek } from './native-session-peek.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

const DECISION_PAST = { approve: 'approved', deny: 'denied', cancel: 'cancelled' };

async function main() {
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const state = createState();
  await state.init();
  const chat = createChat();
  chat.start();

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

  fastify.get('/api/snapshot', async () => ({
    ...state.snapshot(),
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
            payload: { ...state.snapshot(), chat: chat.snapshot() },
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

  // Clean shutdown.
  const shutdown = async () => {
    fastify.log.info('shutting down…');
    try {
      chat.stop();
      await state.close();
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
