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

// --- config-dir resolution (matches index.js / tracker-db.js) --------------
// XDG_CONFIG_HOME ?? ~/.config, then /golem. Single source of the golem config
// dir for this module; identical to the resolution used by the channel server
// and the dashboard, so all three agree on where dashboard.json / sessions.json
// live.
function golemConfigDir() {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'golem',
  );
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:7420';

/**
 * Resolve the dashboard base URL.
 * Reads `<config>/golem/dashboard.json` (written by the dashboard's self-
 * registration block, shape `{url,host,port,pid,started_at}`) and returns its
 * `url`. Falls back to the dashboard's default bind (http://127.0.0.1:7420)
 * when the file is missing/unreadable or carries no usable url.
 * @returns {string}
 */
export function dashboardBaseUrl() {
  const file = path.join(golemConfigDir(), 'dashboard.json');
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
  return (
    process.env.GOLEM_CEO_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    null
  );
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
      const file = path.join(golemConfigDir(), 'sessions.json');
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

/** POST /api/tickets/:id/comments {author,body} */
export function addComment(id, { author, body } = {}) {
  if (!id) throw new Error('addComment: id is required');
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/comments`, {
    body: { author, body },
  });
}

/** POST /api/tickets/:id/dispatch {session_id,note?} */
export function dispatchTicket(id, { session_id, note } = {}) {
  if (!id) throw new Error('dispatchTicket: id is required');
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/dispatch`, {
    body: { session_id, note },
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
