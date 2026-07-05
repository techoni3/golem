// golem tracker client — a thin HTTP client of the dashboard's tracker REST API.
//
// The dashboard server owns the SQLite tracker DB and is the SINGLE WRITER; this
// module never touches the DB directly. It only speaks HTTP to whatever URL the
// live dashboard self-registered in `<config>/golem/dashboard.json`. The golem
// channel MCP (index.js) wraps these functions as agent-facing tools so live
// Claude sessions can read/write tickets — the cross-project source of truth for
// work, replacing PLAN.md.
//
// Identity helpers (currentSessionId / currentProjectId) let the MCP tools inject
// sensible defaults so the agent rarely has to pass ids by hand.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

// --- golem-home resolution (TKT-0573, ADR-4) --------------------------------
// This is a hand-maintained MIRROR of lib/golem-home.js's golemHome(). This
// package runs from the INSTALLED plugin copy with its own node_modules — it
// cannot import the repo module — so keep the resolution order in sync by
// hand if either side changes:
//   1. GOLEM_HOME env       — explicit override.
//   2. XDG_CONFIG_HOME env  — legacy override (test isolation); outranks the
//      ~/.golem auto-detect so isolated runs never leak into production state.
//   3. ~/.golem             — once it exists as a real directory.
//   4. ~/.config/golem      — pre-migration default.
// Exported so index.js (same package) reuses this instead of duplicating it
// a second time.
export function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'golem');
  const migrated = path.join(os.homedir(), '.golem');
  try {
    if (fs.statSync(migrated).isDirectory()) return migrated;
  } catch { /* not migrated yet */ }
  return path.join(os.homedir(), '.config', 'golem');
}

const DEFAULT_BASE_URL = 'http://dashboard.golem.localhost:7420';

/**
 * Resolve the dashboard base URL.
 * Reads `<config>/golem/dashboard.json` (written by the dashboard's self-
 * registration block, shape `{url,host,port,pid,started_at}`) and returns its
 * `url`. Falls back to the dashboard's canonical URL
 * (http://dashboard.golem.localhost:7420) when the file is missing/unreadable
 * or carries no usable url.
 * @returns {string}
 */
export function dashboardBaseUrl() {
  const file = path.join(golemHome(), 'dashboard.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc && typeof doc.url === 'string' && doc.url.trim()) {
      return doc.url.replace(/\/+$/, '');
    }
    if (doc && doc.host && doc.port) {
      return `http://${doc.host}:${doc.port}`;
    }
  } catch {
    // missing / unreadable / malformed — fall through to the default bind.
  }
  return DEFAULT_BASE_URL;
}

/**
 * The session id of the live Claude session running this MCP child.
 * Mirrors index.js: golem's launcher exports GOLEM_CEO_SESSION_ID before exec'ing
 * claude (Claude Code does NOT reliably stamp CLAUDE_CODE_SESSION_ID onto MCP-child
 * env), with CLAUDE_CODE_SESSION_ID as a forward-compat fallback.
 * @returns {string|null}
 */
export function currentSessionId() {
  // Explicit launcher override wins; otherwise the LOGICAL id from the parent
  // claude process's session file (~/.claude/sessions/<ppid>.json) — this MCP
  // child is a direct child of it. CLAUDE_CODE_SESSION_ID is a per-run id that
  // diverges from the logical id on resume, so it's only a last resort. Keep in
  // lockstep with index.js deriveSessionId() so ticket actor ids match the
  // channel registry and the dashboard.
  if (process.env.GOLEM_CEO_SESSION_ID) return process.env.GOLEM_CEO_SESSION_ID;
  try {
    const f = path.join(os.homedir(), '.claude', 'sessions', `${process.ppid}.json`);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && typeof j.sessionId === 'string' && j.sessionId) return j.sessionId;
  } catch { /* missing / unreadable — fall through */ }
  // opencode sessions export NONE of the CC-shaped signals above (no launcher
  // env, no ~/.claude session file), so without this the tracker tools ran with
  // no identity: ticket_comment threw "no current session id", and ticket_
  // create/update recorded author/actor as null → the dashboard attributed
  // events to "human" (TKT-0777). The opencode runtime shim
  // (shims/opencode/index.js) already registers a bridge in opencode-bridges.json
  // keyed by opencode_pid = THIS MCP child's parent pid; resolve our session id
  // from it. MIRRORS index.js deriveSessionId()/readOpencodeBridgeForParent —
  // keep the selection (ppid match · pid-alive · newest updated_at) in lockstep.
  // Read fresh each call so a bridge that registers after MCP boot self-heals.
  const ocSid = opencodeSessionIdForParent();
  if (ocSid) return ocSid;
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

/** True if a process with this pid exists (EPERM ⇒ alive but not ours). */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

/**
 * Resolve THIS session's id from the opencode bridge registry when running as a
 * golem-MCP child of an opencode server. Filters bridges to the one whose
 * opencode_pid is our parent pid (and whose owning pid is alive), newest first.
 * Returns null off opencode / when no live bridge matches.
 * @returns {string|null}
 */
function opencodeSessionIdForParent() {
  try {
    const file = path.join(golemHome(), 'opencode-bridges.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bridges = Array.isArray(json?.bridges) ? json.bridges : [];
    const match = bridges
      .filter((b) => b && b.session_id && Number(b.opencode_pid) === Number(process.ppid) && (!b.pid || pidAlive(Number(b.pid))))
      .sort((a, b) => Date.parse(b.updated_at || b.started_at || 0) - Date.parse(a.updated_at || a.started_at || 0))[0];
    return match ? match.session_id : null;
  } catch {
    return null;
  }
}

/**
 * Derive the canonical contract project_id from an absolute project-root path.
 * project_id = `<slug>-<first 6 hex of sha256(absPath)>`, where slug is the
 * lowercased basename with non-alnum runs collapsed to '-' and trimmed. This
 * BYTE-MATCHES the plugin hooks (session-register.sh / journal-route.sh) and the
 * dashboard's project-id.js (projectIdFor) — keep it in lockstep with those.
 * @param {string} absRoot
 * @returns {string}
 */
function projectIdForPath(absRoot) {
  const abs = path.resolve(absRoot);
  const slug =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const hex = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 6);
  return `${slug}-${hex}`;
}

/**
 * Best-effort project_id for the current session.
 *   1. Read `<config>/golem/sessions.json`, find the row whose
 *      `session_id === currentSessionId()`, and return its `project_id` (the
 *      authoritative value the SessionStart hook wrote — legacy projects can
 *      have non-derived ids, so the registry wins).
 *   2. Fallback: derive from `process.cwd()` using the SAME `<slug>-<6hex>`
 *      scheme the hooks use. NOTE: the hooks derive from the project ROOT
 *      (walking up to the nearest `.git`/`CLAUDE.md`); this fallback uses cwd
 *      verbatim, so it only matches when the session's cwd *is* the project
 *      root. The registry lookup is the reliable path; this is a last resort.
 * Returns null when neither yields a value.
 * @returns {string|null}
 */
export function currentProjectId() {
  const sid = currentSessionId();
  if (sid) {
    try {
      const file = path.join(golemHome(), 'sessions.json');
      const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rows = Array.isArray(reg?.sessions) ? reg.sessions : [];
      const row = rows.find((s) => s && s.session_id === sid);
      if (row && typeof row.project_id === 'string' && row.project_id) {
        return row.project_id;
      }
    } catch {
      // no registry / unreadable — fall through to cwd derivation.
    }
  }
  try {
    return projectIdForPath(process.cwd());
  } catch {
    return null;
  }
}

// --- HTTP plumbing ---------------------------------------------------------

function buildUrl(pathname, params) {
  const u = new URL(pathname, dashboardBaseUrl());
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/**
 * Core fetch wrapper. On a non-2xx response, throws an Error carrying the
 * server's parsed `{error}` (when present) plus the HTTP status; on 2xx returns
 * the parsed JSON body (or null for an empty body). Uses the global fetch
 * (Node 18+/20+). X-Sender is set for parity with the channel server's gating —
 * the /api/* routes do NOT check it, but it is harmless.
 */
async function request(method, pathname, { params, body } = {}) {
  const url = buildUrl(pathname, params);
  const init = {
    method,
    headers: { 'X-Sender': 'cli' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `tracker request failed: ${method} ${url} — ${err?.message ?? err}. ` +
        `Is the golem dashboard running? (dashboardBaseUrl=${dashboardBaseUrl()})`,
    );
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const serverErr =
      parsed && typeof parsed === 'object' && parsed.error != null
        ? parsed.error
        : typeof parsed === 'string' && parsed
          ? parsed
          : res.statusText;
    throw new Error(`tracker ${method} ${pathname} → ${res.status} ${serverErr}`);
  }
  return parsed;
}

// --- API wrappers (one per dashboard tracker route) ------------------------

/** GET /api/tickets?project&state&assignee&kind&stream&includeArchived */
export function listTickets(params = {}) {
  return request('GET', '/api/tickets', { params });
}

/** GET /api/tickets/:id */
export function getTicket(id) {
  if (!id) throw new Error('getTicket: id is required');
  return request('GET', `/api/tickets/${encodeURIComponent(id)}`);
}

/** POST /api/tickets {project_id,kind?,title,body?,priority?,labels?,stream_id?,parent_id?,assignee?,created_by?} */
export function createTicket(body) {
  return request('POST', '/api/tickets', { body });
}

/** PATCH /api/tickets/:id {…patch, actor?} */
export function updateTicket(id, patch) {
  if (!id) throw new Error('updateTicket: id is required');
  return request('PATCH', `/api/tickets/${encodeURIComponent(id)}`, { body: patch });
}

/** POST /api/tickets/:id/comments {author,body,quote?,prefix?,suffix?,section?,section_id?,tag?,status?,parent_id?} */
export function addComment(id, input = {}) {
  if (!id) throw new Error('addComment: id is required');
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/comments`, { body: input });
}

/** PATCH /api/tickets/:id/comments/:cid {body?,tag?,status?} */
export function updateComment(id, commentId, patch) {
  if (!id) throw new Error('updateComment: id is required');
  if (!commentId) throw new Error('updateComment: commentId is required');
  return request('PATCH', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { body: patch });
}

/** POST /api/tickets/:id/comments/:cid/reply {author,body} */
export function replyComment(id, commentId, body) {
  if (!id) throw new Error('replyComment: id is required');
  if (!commentId) throw new Error('replyComment: commentId is required');
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/reply`, { body });
}

/** POST /api/tickets/:id/dispatch {session_id,note?,mode?} — when_idle:true maps to mode 'when_idle'. */
export function dispatchTicket(id, { session_id, note, when_idle, workspace } = {}) {
  if (!id) throw new Error('dispatchTicket: id is required');
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/dispatch`, {
    body: { session_id, note, mode: when_idle ? 'when_idle' : 'now', workspace: workspace || undefined },
  });
}

/** GET /api/streams?project */
export function listStreams(project) {
  return request('GET', '/api/streams', { params: project ? { project } : {} });
}

/** POST /api/streams {project_id,name,mode?,description?} */
export function createStream(body) {
  return request('POST', '/api/streams', { body });
}

/** GET /api/sessions/dispatchable?project */
export function listDispatchable(project) {
  return request('GET', '/api/sessions/dispatchable', {
    params: project ? { project } : {},
  });
}

/**
 * POST /api/brief {session_id,text} — push a channel brief to ONE live session.
 * Pure notification: the dashboard routes it to the target's channel; there are
 * no ticket state/assignment side effects. Returns the dashboard's delivery
 * result ({ok,status,body,target}); throws on a non-2xx (e.g. 502 = the target
 * channel could not be reached).
 */
export function postBrief(sessionId, text) {
  if (!sessionId) throw new Error('postBrief: sessionId is required');
  return request('POST', '/api/brief', { body: { session_id: sessionId, text } });
}

export function subscribeBus({ session_id, topic, classes } = {}) {
  return request('POST', '/api/bus/subscribe', { body: { session_id, topic, classes } });
}

export function unsubscribeBus({ session_id, topic } = {}) {
  return request('POST', '/api/bus/unsubscribe', { body: { session_id, topic } });
}

export function listBusSubscriptions(session_id) {
  return request('GET', '/api/bus/subscriptions', { params: session_id ? { session_id } : {} });
}
