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
// See plugin/README.md for setup. Authoritative protocol
// docs: https://code.claude.com/docs/en/channels-reference.md
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as tracker from './tracker-client.js';
import { SESSION_ROLES, pushRoleBriefDirect, setSessionRole } from '../../lib/session-role.js';

const VERSION = '0.1.0';
// Port selection (multi-CEO safe by default):
//   - Default is 0 → kernel-assigned ephemeral port. This lets any number of
//     channel servers coexist without EADDRINUSE — critical because Claude
//     Code probes this plugin MCP standalone (e.g. `claude mcp list`) with no
//     env set, often while a real CEO session already holds a fixed port.
//   - Set GOLEM_CHANNEL_PORT explicitly (e.g. to 7421) only for single-CEO
//     smoke tests or legacy callers that need a known, pinnable port.
// An empty/unset/blank value resolves to 0. A non-numeric value also falls
// back to 0 rather than NaN (which would crash listen()).
const _rawPort = process.env.GOLEM_CHANNEL_PORT;
const PORT =
  _rawPort != null && _rawPort.trim() !== '' && Number.isFinite(Number(_rawPort))
    ? Number(_rawPort)
    : 0;
const HOST = '127.0.0.1';
const ALLOWED_SENDERS = new Set(
  (process.env.GOLEM_CHANNEL_ALLOWED_SENDERS || 'dashboard,cli,curl,consult')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Identity for chat-routing, dispatch, and consult.
//
// The id everything else keys by — `/rename`, `claude agents --json`, the
// dashboard, the tracker — is the session's LOGICAL id. On a RESUMED session
// Claude Code spawns this MCP child with a FRESH per-run `CLAUDE_CODE_SESSION_ID`
// that does NOT equal that logical id; keying the channel off the env var then
// makes channels.json diverge from every other registry (breaking name lookup,
// dispatch, and chat routing for resumed sessions).
//
// The logical id (and the user's chosen /rename name) live in the parent claude
// process's per-session file at ~/.claude/sessions/<pid>.json. This MCP child is
// a DIRECT child of that claude process, so process.ppid points straight at it.
// Prefer that file; fall back to the env ids only when it is unreadable.
function readParentSessionFile() {
  try {
    const f = path.join(os.homedir(), '.claude', 'sessions', `${process.ppid}.json`);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch { /* missing / unreadable — fall through */ }
  return null;
}
function deriveSessionId() {
  // Explicit launcher override wins; else the logical id from the parent session
  // file; else the per-run CLAUDE_CODE_SESSION_ID (last resort — diverges on resume).
  if (process.env.GOLEM_CEO_SESSION_ID) return process.env.GOLEM_CEO_SESSION_ID;
  const j = readParentSessionFile();
  if (j && typeof j.sessionId === 'string' && j.sessionId) return j.sessionId;
  const bridge = readOpencodeBridgeForParent();
  if (bridge?.session_id) return bridge.session_id;
  return process.env.CLAUDE_CODE_SESSION_ID || '';
}
function deriveSessionName() {
  const j = readParentSessionFile();
  if (j && typeof j.name === 'string' && j.name) return j.name;
  const bridge = readOpencodeBridgeForParent();
  return bridge && typeof bridge.name === 'string' && bridge.name ? bridge.name : null;
}
// golem-home resolution (TKT-0573, ADR-4) lives in tracker-client.js's
// golemHome() — reused here so this file doesn't carry a second hand-rolled
// mirror of lib/golem-home.js within the same package.
const CHANNELS_REGISTRY = path.join(tracker.golemHome(), 'channels.json');
const CHANNELS_LOCK = `${CHANNELS_REGISTRY}.lock`;
const OPENCODE_BRIDGES_REGISTRY = path.join(tracker.golemHome(), 'opencode-bridges.json');

// Mutable: re-derived on each (re)register so a session file that wasn't written
// yet at module load, or a later /rename, is picked up within one heartbeat.
let SESSION_ID = deriveSessionId();
let SESSION_NAME = deriveSessionName();

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

function pidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readOpencodeBridgeForParent() {
  try {
    const raw = fs.readFileSync(OPENCODE_BRIDGES_REGISTRY, 'utf8');
    const json = JSON.parse(raw);
    const bridges = Array.isArray(json?.bridges) ? json.bridges : [];
    const candidates = bridges.filter((b) => {
      if (!b || Number(b.opencode_pid) !== Number(process.ppid)) return false;
      if (b.pid && !pidAlive(Number(b.pid))) return false;
      return !!(b.session_id && b.host && b.port);
    });
    candidates.sort((a, b) => Date.parse(b.updated_at || b.started_at || 0) - Date.parse(a.updated_at || a.started_at || 0));
    return candidates[0] || null;
  } catch {
    return null;
  }
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
  // Re-derive each call: the parent session file may not have existed at module
  // load, and the name changes on /rename. Correcting SESSION_ID here also
  // self-heals a channel that first registered under a fallback run-id.
  SESSION_ID = deriveSessionId() || SESSION_ID;
  SESSION_NAME = deriveSessionName();
  const bridge = readOpencodeBridgeForParent();
  if (!SESSION_ID) {
    process.stderr.write('[golem-channel] no session id (parent session file + GOLEM_CEO_SESSION_ID/CLAUDE_CODE_SESSION_ID all empty); channel will not register\n');
    return;
  }
  withChannelLock(() => {
    const reg = readChannelsRegistry();
    // Drop any prior row for THIS process (covers an id corrected from a run-id
    // to the logical id between heartbeats) and any stale row under our id.
    reg.channels = reg.channels.filter((c) => c.pid !== process.pid && c.session_id !== SESSION_ID);
    reg.channels.push({
      session_id: SESSION_ID,
      name: SESSION_NAME,
      pid: process.pid,
      host: HOST,
      port,
      version: VERSION,
      harness: bridge && bridge.session_id === SESSION_ID ? 'opencode' : undefined,
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

// --- Session-to-session consult -------------------------------------------
// A live session can ask ANOTHER live session for a "fresh pair of eyes" on a
// hard problem. It rides the same channel transport: the asker POSTs to the
// consultant's /consult route; the consultant investigates and POSTs its
// proposal back to the asker's /consult/reply route. Fully async — the asker
// never blocks. Targeting is by /rename name (resolved to a session_id that has
// a live channel) or by session_id directly.

function channelUrlForSession(sessionId) {
  if (!sessionId) return null;
  const reg = readChannelsRegistry();
  const ch = reg.channels.find((c) => c.session_id === sessionId);
  return ch ? `http://${ch.host}:${ch.port}` : null;
}

// `claude agents --json` — a FALLBACK name source only now (the channel registry
// carries names directly). Bounded and never-throws.
function runClaudeAgentsJson() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = execFile(
        'claude', ['agents', '--json'],
        { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) return finish(null);
          const t = (stdout ?? '').trim();
          if (!t) return finish([]);
          try { const p = JSON.parse(t); return finish(Array.isArray(p) ? p : null); }
          catch { return finish(null); }
        },
      );
      child?.on?.('error', () => finish(null));
    } catch { finish(null); }
  });
}

// Resolve a consult target (`to` = a /rename name OR a session_id) to a live
// channel. Primary source is the channel registry's own `name` field (kept fresh
// by the heartbeat); `agents` (a preloaded `claude agents --json` array, or null)
// is only a fallback for channels registered before names were stored.
function resolveConsultTarget(toRaw, agents) {
  const to = String(toRaw || '').trim();
  if (!to) return { ok: false, error: 'consult: `to` is required (a session name or session_id).' };
  const reg = readChannelsRegistry();
  // 1) direct session_id match
  const direct = reg.channels.find((c) => c.session_id === to);
  if (direct) return { ok: true, session_id: to, name: direct.name || to, url: `http://${direct.host}:${direct.port}` };
  // 2) by the name stored in the channel registry (reliable, no external call)
  const byName = reg.channels.filter((c) => (c.name || '') === to);
  if (byName.length === 1) {
    const c = byName[0];
    return { ok: true, session_id: c.session_id, name: to, url: `http://${c.host}:${c.port}` };
  }
  if (byName.length > 1) {
    return { ok: false, error: `consult: multiple live channels named "${to}" (${byName.map((c) => c.session_id).join(', ')}) — pass an exact session_id as \`to\`.` };
  }
  // 3) fallback: claude agents --json ∩ live channels (older channels w/o a name)
  if (Array.isArray(agents)) {
    const live = new Set(reg.channels.map((c) => c.session_id));
    const named = agents.filter((a) => a && (a.name || '') === to && a.sessionId);
    const consultable = named.filter((a) => live.has(a.sessionId));
    if (consultable.length === 1) {
      const a = consultable[0];
      const ch = reg.channels.find((c) => c.session_id === a.sessionId);
      return { ok: true, session_id: a.sessionId, name: to, url: `http://${ch.host}:${ch.port}` };
    }
    if (consultable.length > 1) {
      return { ok: false, error: `consult: multiple live sessions named "${to}" — pass an exact session_id as \`to\`.` };
    }
  }
  return { ok: false, error: `consult: no live channel named "${to}". Check the name in the dashboard, or pass an exact session_id as \`to\`.` };
}

// Resolve a target, trying the registry first and only spawning `claude agents
// --json` if the registry name lookup comes up empty.
async function resolveTargetWithFallback(to) {
  let t = resolveConsultTarget(to, null);
  if (!t.ok && /no live channel named/.test(t.error || '')) {
    t = resolveConsultTarget(to, await runClaudeAgentsJson());
  }
  return t;
}

async function postToChannel(baseUrl, pathSuffix, bodyObj) {
  const url = `${baseUrl.replace(/\/$/, '')}${pathSuffix}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-Sender': 'consult', 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: ctl.signal,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postToOpencodeBridge(bridge, bodyObj) {
  const url = `http://${bridge.host}:${bridge.port}/push`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: ctl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`opencode bridge ${resp.status}: ${text}`);
    return { ok: true, status: resp.status, body: text };
  } finally {
    clearTimeout(timer);
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
      '  - consult: a peer session asking YOU for a fresh pair of eyes on a hard problem (meta: consult_id, from_session). This is NOT delegation — read the golem:provide-consult skill, investigate the problem independently (their question, the code, web research), and reply with the `consult_reply` tool. Do not enter the work-loop or edit their repo.',
      '  - consult_reply: a consultant\'s proposal returning for a consult YOU asked (meta: consult_id). Treat it as advice to weigh critically — keep what holds up, discard the rest; you keep the final say. See golem:get-consult.',
      'You have TWO reply tools — both fire over the same SSE channel and surface in the dashboard chat:',
      '  • `ack` — fires IMMEDIATELY on receipt of every inbound event, no exceptions. One short sentence describing what the CEO understood and is about to do. Pass the same kind; include gate_id for gate_* events.',
      '  • `respond` — fires when the CEO has something user-facing to say BACK to the user (chat answers, clarification questions, decision asks, final results of short briefs). Body is the actual reply text. Skip it when the brief just enters the autonomy loop and has nothing immediate to communicate — the dashboard timeline shows progress in that case.',
      'Order of operations for any inbound channel event: 1) call ack on receipt, 2) do the work, 3) optionally call respond with the user-facing answer, 4) yield.',
      'Peer help (separate from ack/respond): `consult_request` asks another live session for a fresh pair of eyes — you do NOT block, the reply returns later as a consult_reply event; `consult_reply` returns your proposal to an asker; `consult_status` nudges a pending consult.',
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
              'The user-facing reply text. Keep it concise — the dashboard chat is a thin client, not a full transcript. Plain text is wrapped into paragraphs; existing HTML is rendered as-is.',
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
    // --- Golem tracker tools (thin HTTP clients of the dashboard REST API) ---
    // The tracker is the cross-project source of truth for work — it REPLACES
    // PLAN.md. The dashboard owns the SQLite DB (single writer); these tools speak
    // HTTP to it. Identity (your session id, your project) is injected for you, so
    // you rarely pass ids: `mine:true` resolves to YOUR session, `project` defaults
    // to YOUR project.
    {
      name: 'ticket_list',
      description:
        'Golem tracker — the cross-project source of truth for work (replaces PLAN.md). List tickets. Pass mine:true to find work assigned to YOU (this session). Defaults to your current project; pass project:"<contract-id>" for another, or all:true (or project:"*") to list across every project. Optional filters: state (todo|in_progress|blocked|review|done|archived), assignee, kind (work-item|decision|spec|question|fix).',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Contract project_id `<slug>-<6hex>`. Defaults to your current project. Use "*" to list across all projects.' },
          all: { type: 'boolean', description: 'List across all projects (same as project:"*").' },
          mine: { type: 'boolean', description: 'Only tickets assigned to you (this session).' },
          state: { type: 'string', description: 'todo|in_progress|blocked|review|done|archived' },
          assignee: { type: 'string', description: 'session_id | "human" | null. Overridden by mine:true.' },
          kind: { type: 'string', description: 'work-item|decision|spec|question|fix' },
        },
      },
    },
    {
      name: 'ticket_get',
      description:
        'Golem tracker — fetch one ticket by id, including its Markdown body, anchored comments, links, and event history. Read this before starting work on a dispatched/assigned ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'ticket_create',
      description:
        'Golem tracker — create a ticket (the unit of work; replaces a PLAN.md line item). The body is Markdown (+ fenced ```mermaid; GitHub-style > [!NOTE]/[!WARNING]/[!IMPORTANT] admonitions). Pick the genre template matching the kind — work-item→feature, fix→bug, spec→design-doc, decision→decision (prd/brainstorm selectable) — from plugin/skills/tracker/templates/ or GET /api/templates, and fill it in. Defaults to your current project and records you as created_by. Use parent_id to decompose larger work; stream_id to group. For a blocking human question, pass kind:"question" and assignee:"human", then pause.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title.' },
          body: { type: 'string', description: 'Full description / acceptance criteria. Markdown (+ fenced ```mermaid; GitHub-style > [!NOTE]/[!WARNING]/[!IMPORTANT] admonitions). Pick the template matching the kind: work-item→feature, fix→bug, spec→design-doc, decision→decision; prd/brainstorm selectable (plugin/skills/tracker/templates/ or GET /api/templates).' },
          kind: { type: 'string', description: 'work-item|decision|spec|question|fix (default work-item).' },
          priority: { type: 'string', description: 'Optional priority label.' },
          state: { type: 'string', description: 'todo|in_progress|blocked|review|done (default todo).' },
          stream_id: { type: 'string', description: 'Optional stream to group this ticket under.' },
          parent_id: { type: 'string', description: 'Optional parent display ticket id (sub-ticket).' },
          wave: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Optional positive dependency wave number; null/omitted means not wave-managed.' },
          assignee: { type: 'string', description: 'session_id | "human" | null. Use "human" for questions.' },
          project: { type: 'string', description: 'Contract project_id. Defaults to your current project.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'ticket_update',
      description:
        'Golem tracker — patch a ticket. The common case is a STATE transition (todo→in_progress→review→done, or →blocked). The body field is Markdown (+ fenced ```mermaid). Records you as the actor. Verify work mechanically before moving to review/done (see golem:verify-done).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.' },
          state: { type: 'string', description: 'todo|in_progress|blocked|review|done|archived' },
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown body replacement (+ fenced ```mermaid; GitHub-style admonitions).' },
          kind: { type: 'string', description: 'work-item|decision|spec|question|fix' },
          priority: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Full replacement label set.' },
          stream_id: { type: 'string' },
          parent_id: { type: 'string' },
          wave: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Optional positive dependency wave number; pass null to clear.' },
          assignee: { type: 'string', description: 'session_id | "human" | null.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'ticket_comment',
      description:
        'Golem tracker — append a progress comment to a ticket. Comment milestones with MECHANICAL evidence (commands you ran + their output), not claims. Records you as the author. For inline anchored comments, include quote (selected text), prefix/suffix context, section, and a tag (confirmed|partial|disputed|fix|risk|question|note).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.' },
          body: { type: 'string', description: 'Markdown comment text (fenced ```mermaid ok for diagrams).' },
          quote: { type: 'string', description: 'Optional: exact selected text being commented on.' },
          prefix: { type: 'string', description: 'Optional: text immediately before quote, for anchoring.' },
          suffix: { type: 'string', description: 'Optional: text immediately after quote, for anchoring.' },
          section: { type: 'string', description: 'Optional: section title where quote appears.' },
          section_id: { type: 'string', description: 'Optional: section id where quote appears.' },
          tag: { type: 'string', description: 'confirmed|partial|disputed|fix|risk|question|note (default note).' },
          status: { type: 'string', description: 'open|resolved (default open).' },
          parent_id: { type: 'string', description: 'Optional: parent comment id for threading.' },
        },
        required: ['id', 'body'],
      },
    },
    {
      name: 'ticket_comment_update',
      description:
        'Golem tracker — update an existing comment (change status to resolved/reopen, change tag, or edit body).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.' },
          comment_id: { type: 'string', description: 'Comment id to update.' },
          body: { type: 'string', description: 'Replacement comment text.' },
          tag: { type: 'string', description: 'confirmed|partial|disputed|fix|risk|question|note' },
          status: { type: 'string', description: 'open|resolved' },
        },
        required: ['id', 'comment_id'],
      },
    },
    {
      name: 'ticket_comment_reply',
      description:
        'Golem tracker — add a reply to an existing comment.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.' },
          comment_id: { type: 'string', description: 'Parent comment id.' },
          body: { type: 'string', description: 'Reply text.' },
        },
        required: ['id', 'comment_id', 'body'],
      },
    },
    {
      name: 'session_role',
      description: 'Set or clear this live session role. role must be planner|builder|researcher|ui-tester|general or null/clear.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'planner|builder|researcher|ui-tester|general|clear' },
        },
        required: ['role'],
      },
    },
    {
      name: 'ticket_dispatch',
      description:
        'Golem tracker — dispatch a ticket to a live session: assigns the ticket and pushes a brief to it over the channel. Use sessions_dispatchable to find live session ids (each carries a status: idle|busy|waiting, and a pending_count of queued dispatches). The target session must be a channel consumer (golemc) to receive the push. By default the brief is pushed immediately (mode "now"); pass when_idle:true to queue it until the target is idle — use this when the session is busy/waiting so the brief is not buried mid-turn.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Display ticket id to dispatch, e.g. GOL-244. Legacy TKT refs still resolve.' },
          session_id: { type: 'string', description: 'Live session id to dispatch to (from sessions_dispatchable).' },
          note: { type: 'string', description: 'Optional note to include with the dispatch.' },
          when_idle: { type: 'boolean', description: 'Queue the dispatch until the target session is idle instead of pushing immediately. Use when the target is busy/waiting so the brief is delivered when it can be acted on.' },
        },
        required: ['id', 'session_id'],
      },
    },
    {
      name: 'stream_create',
      description:
        'Golem tracker — create a stream (a named group of tickets) in your current project. mode "sequential" = one in-progress at a time; "parallel" = independent sub-work. Defaults to your current project.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Stream name.' },
          mode: { type: 'string', description: 'sequential|parallel (default sequential).' },
          description: { type: 'string', description: 'Optional description.' },
          project: { type: 'string', description: 'Contract project_id. Defaults to your current project.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'stream_list',
      description:
        'Golem tracker — list streams for a project (defaults to your current project; omit project / pass nothing for all-project view depends on dashboard).',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Contract project_id. Defaults to your current project.' },
        },
      },
    },
    {
      name: 'sessions_dispatchable',
      description:
        'Golem tracker — list live native Claude sessions that can receive a dispatched ticket, in your current project (or pass project for another). Returns session ids + labels for use with ticket_dispatch. Each entry carries a status (idle|busy|waiting) and a pending_count of queued dispatches — pass when_idle:true on ticket_dispatch for a busy/waiting target so the brief lands when it next goes idle.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Contract project_id. Defaults to your current project.' },
        },
      },
    },

    {
      name: 'subscribe',
      description: 'Subscribe this session to a named golem event-bus topic such as ticket/GOL-311 or spec/GOL-306/tree. Classes default to tracker,lifecycle,custom; include activity explicitly for the firehose.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Exact topic to subscribe to, e.g. ticket/GOL-311 or spec/GOL-306/tree.' },
          classes: { type: 'array', items: { type: 'string' }, description: 'Optional event classes: tracker, lifecycle, activity, custom.' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'unsubscribe',
      description: 'Unsubscribe this session from a named golem event-bus topic.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Exact topic to unsubscribe from.' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'subscriptions_list',
      description: 'List this session\'s golem event-bus subscriptions and cursors.',
      inputSchema: { type: 'object', properties: {} },
    },

    // --- Session-to-session notification -----------------------------------
    {
      name: 'session_notify',
      description:
        'Push a short progress/notification brief to ANOTHER live session, delivered as a channel event via the dashboard. Use it for milestone / review-ready / blocked pings to a coordinating session (e.g. a builder notifying its planner). This is NOT a ticket comment — the tracker stays the audit trail, so still comment there; NOT delegation — it makes no ticket assignment or state change; and NOT a consult — use consult_request for a second opinion. Target by session_id or by label (e.g. "golem:fable:planner"); resolves against the same live-session surface as sessions_dispatchable.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target session: its label/name (e.g. "golem:fable:planner") or an exact session_id. Must be a live, reachable session (see sessions_dispatchable).' },
          text: { type: 'string', description: 'The notification text — keep it short (a status line, not a full report).' },
          ticket: { type: 'string', description: 'Optional ticket id (e.g. "GOL-267") prefixed to the message for context.' },
        },
        required: ['to', 'text'],
      },
    },

    // --- Session-to-session consult ----------------------------------------
    {
      name: 'consult_request',
      description:
        'Ask ANOTHER live golem session for a fresh pair of eyes on a hard problem — a second opinion, NOT delegation. Use when you are genuinely stuck (a bug you cannot crack, a suspected architectural blind spot, tunnel vision) and your own subagents have not cracked it. Fire-and-forget: you keep working; the consultant investigates independently and its proposal pushes back to you later as a `consult_reply` channel event. Target by /rename name (e.g. "ogolem") or session_id.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The session to consult: its /rename name (e.g. "ogolem") or an exact session_id. Must be a live session running the golem plugin.' },
          question: { type: 'string', description: 'The problem: what you are stuck on, what you have already tried, and the specific question / what a fresh perspective should focus on.' },
          context: { type: 'string', description: 'Optional supporting context — error output, key file paths or snippets, the relevant repo/branch, constraints. The consultant does its own investigation, so give it enough to start.' },
        },
        required: ['to', 'question'],
      },
    },
    {
      name: 'consult_reply',
      description:
        'Deliver your proposal back to a session that asked YOU for a consult. Call this when you (as the consultant) have investigated and formed a fresh-perspective analysis. The reply pushes into the asker as a `consult_reply` channel event. Read the consult event for the to_session (its from_session) and consult_id.',
      inputSchema: {
        type: 'object',
        properties: {
          to_session: { type: 'string', description: 'The asker session id — the `from_session` carried on the consult event you are answering.' },
          consult_id: { type: 'string', description: 'The consult_id from the consult event, so the asker can correlate the reply.' },
          text: { type: 'string', description: 'Your analysis + proposal: suspected root cause(s), blind spots, and a concrete recommended approach. It is advice — the asker weighs it and keeps the final say.' },
        },
        required: ['to_session', 'text'],
      },
    },
    {
      name: 'consult_status',
      description:
        'Nudge a session you previously consulted for progress on a pending consult, without blocking. Optional — only when a reply is taking a while and you want a status check.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The consultant session: /rename name or session_id (the one you sent consult_request to).' },
          consult_id: { type: 'string', description: 'The consult_id returned by consult_request.' },
          note: { type: 'string', description: 'Optional extra note for the nudge.' },
        },
        required: ['to'],
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

  if (name === 'session_role') {
    const role = args.role === 'clear' ? null : args.role;
    if (role != null && !SESSION_ROLES.includes(role)) {
      return { isError: true, content: [{ type: 'text', text: `invalid role: ${args.role}` }] };
    }
    if (!SESSION_ID) {
      return { isError: true, content: [{ type: 'text', text: 'session_role: no current session id' }] };
    }
    try {
      const row = setSessionRole(SESSION_ID, role, { by: 'self:mcp' });
      if (role) await pushRoleBriefDirect(SESSION_ID, role, row);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, session_id: row.session_id, role: row.role }, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  }

  // --- Session-to-session consult tools --------------------------------------
  if (name === 'consult_request') {
    if (!args.to) return { isError: true, content: [{ type: 'text', text: 'consult_request: `to` is required (the session name to consult, e.g. "ogolem", or a session_id).' }] };
    if (!args.question || !String(args.question).trim()) return { isError: true, content: [{ type: 'text', text: 'consult_request: `question` is required — describe what you are stuck on and what you have tried.' }] };
    const target = await resolveTargetWithFallback(args.to);
    if (!target.ok) return { isError: true, content: [{ type: 'text', text: target.error }] };
    const consult_id = `cns-${crypto.randomBytes(3).toString('hex')}`;
    const r = await postToChannel(target.url, '/consult', {
      consult_id,
      from_name: SESSION_NAME || SESSION_ID || 'unknown',
      from_session: SESSION_ID,
      question: String(args.question),
      context: args.context ? String(args.context) : '',
    });
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: `consult_request: could not deliver to "${target.name}" (${r.status} ${r.error || r.body}). Is it still running with the golem plugin?` }] };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, consult_id, to: target.name, to_session: target.session_id, note: 'Consult sent. Keep working — the reply pushes back asynchronously as a consult_reply channel event.' }, null, 2) }] };
  }

  if (name === 'consult_reply') {
    if (!args.to_session) return { isError: true, content: [{ type: 'text', text: 'consult_reply: `to_session` is required (the from_session id carried on the consult event you are answering).' }] };
    if (!args.text || !String(args.text).trim()) return { isError: true, content: [{ type: 'text', text: 'consult_reply: `text` (your proposal) is required.' }] };
    const url = channelUrlForSession(String(args.to_session));
    if (!url) return { isError: true, content: [{ type: 'text', text: `consult_reply: asker session ${args.to_session} has no live channel (it may have ended) — the reply cannot be delivered.` }] };
    const r = await postToChannel(url, '/consult/reply', {
      consult_id: args.consult_id ? String(args.consult_id) : '',
      from_name: SESSION_NAME || SESSION_ID || 'consultant',
      from_session: SESSION_ID,
      text: String(args.text),
    });
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: `consult_reply: delivery failed (${r.status} ${r.error || r.body}).` }] };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, delivered_to: String(args.to_session), consult_id: args.consult_id || null }, null, 2) }] };
  }

  if (name === 'consult_status') {
    if (!args.to) return { isError: true, content: [{ type: 'text', text: 'consult_status: `to` is required.' }] };
    const target = await resolveTargetWithFallback(args.to);
    if (!target.ok) return { isError: true, content: [{ type: 'text', text: target.error }] };
    const r = await postToChannel(target.url, '/consult', {
      consult_id: args.consult_id ? String(args.consult_id) : '',
      from_name: SESSION_NAME || SESSION_ID || 'unknown',
      from_session: SESSION_ID,
      question: `Any progress on consult ${args.consult_id || ''}?${args.note ? ' ' + String(args.note) : ''}`.trim(),
      context: '',
      status_ping: true,
    });
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: `consult_status: ping failed (${r.status} ${r.error || r.body}).` }] };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, pinged: target.name, consult_id: args.consult_id || null }, null, 2) }] };
  }

  // --- Session-to-session notification --------------------------------------
  // Resolve `to` (session_id or label) against the dispatchable surface, then
  // deliver via the dashboard's POST /api/brief. No ticket side effects.
  if (name === 'session_notify') {
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!to) return { isError: true, content: [{ type: 'text', text: 'session_notify: `to` (session_id or label) is required.' }] };
    if (!text) return { isError: true, content: [{ type: 'text', text: 'session_notify: `text` is required.' }] };

    let sessions;
    try {
      sessions = await tracker.listDispatchable(); // no project ⇒ all live sessions
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `session_notify: could not list live sessions — ${err instanceof Error ? err.message : String(err)}` }] };
    }
    sessions = Array.isArray(sessions) ? sessions : [];

    let target = sessions.find((s) => s && s.session_id === to);
    if (!target) {
      const matches = sessions.filter((s) => s && (s.label === to || s.name === to));
      if (matches.length === 0) {
        return { isError: true, content: [{ type: 'text', text: `session_notify: no live dispatchable session matches "${to}". Call sessions_dispatchable to see valid targets (session_id or label).` }] };
      }
      if (matches.length > 1) {
        const ids = matches.map((s) => `${s.label || s.name} (${s.session_id})`).join(', ');
        return { isError: true, content: [{ type: 'text', text: `session_notify: "${to}" is ambiguous across ${matches.length} sessions — pass an exact session_id. Candidates: ${ids}` }] };
      }
      target = matches[0];
    }
    if (target.reachable === false) {
      return { isError: true, content: [{ type: 'text', text: `session_notify: target "${target.label || target.session_id}" has no live channel (unreachable) — it cannot receive a push right now.` }] };
    }

    const message = args.ticket ? `${args.ticket}: ${text}` : text;
    try {
      const delivery = await tracker.postBrief(target.session_id, message);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, to: target.label || target.name || target.session_id, session_id: target.session_id, delivery }, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `session_notify: delivery failed — ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  if (name === 'subscribe' || name === 'unsubscribe' || name === 'subscriptions_list') {
    if (!SESSION_ID) return { isError: true, content: [{ type: 'text', text: `${name}: no current session id` }] };
    try {
      if (name === 'subscribe') {
        if (!args.topic) throw new Error('subscribe: topic is required');
        const out = await tracker.subscribeBus({ session_id: SESSION_ID, topic: String(args.topic), classes: args.classes });
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      if (name === 'unsubscribe') {
        if (!args.topic) throw new Error('unsubscribe: topic is required');
        const out = await tracker.unsubscribeBus({ session_id: SESSION_ID, topic: String(args.topic) });
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      const out = await tracker.listBusSubscriptions(SESSION_ID);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }

  // --- Golem tracker tools ---------------------------------------------------
  // Each delegates to the HTTP client and returns compact JSON the agent can act
  // on. Identity defaults are injected here so the agent rarely passes ids.
  if (name.startsWith('ticket_') || name.startsWith('stream_') || name === 'sessions_dispatchable') {
    const displayCache = new Map();
    const displayForRef = async (ref) => {
      if (typeof ref !== 'string' || !/^TKT-/.test(ref)) return ref;
      if (displayCache.has(ref)) return displayCache.get(ref);
      try {
        const ticket = await tracker.getTicket(ref);
        const display = ticket?.display_id || null;
        displayCache.set(ref, display);
        return display;
      } catch {
        return null;
      }
    };
    const publicTicketIds = async (value, ticketDisplayId = null) => {
      if (Array.isArray(value)) return Promise.all(value.map((v) => publicTicketIds(v)));
      if (!value || typeof value !== 'object') return value;
      const out = { ...value };
      const display = out.display_id || ticketDisplayId;
      const canonical = typeof out.id === 'string' && /^TKT-/.test(out.id) ? out.id : null;
      if (display && canonical) {
        out.id = display;
      }
      if (display && typeof out.ticket_id === 'string' && /^TKT-/.test(out.ticket_id)) out.ticket_id = display;
      for (const key of ['parent_id', 'from_ticket', 'to_ticket', 'current_in_progress_ticket']) {
        if (typeof out[key] === 'string') out[key] = await displayForRef(out[key]);
      }
      for (const key of ['comments', 'children', 'links', 'events', 'active_unacked_dispatches']) {
        if (Array.isArray(out[key])) out[key] = await Promise.all(out[key].map((v) => publicTicketIds(v, display)));
      }
      if (out.ticket && typeof out.ticket === 'object') out.ticket = await publicTicketIds(out.ticket);
      return out;
    };
    const jsonResult = async (value) => ({
      content: [{ type: 'text', text: JSON.stringify(await publicTicketIds(value), null, 2) }],
    });
    try {
      const sessionId = tracker.currentSessionId();
      const defaultProject = tracker.currentProjectId();

      // Resolve the `project` query value for LIST-style tools. `all:true` or
      // project "*" ⇒ list across all projects (omit the filter). Otherwise an
      // explicit project wins, else the session's current project.
      const resolveListProject = () => {
        if (args.all === true || args.project === '*') return undefined;
        if (args.project) return args.project;
        return defaultProject ?? undefined;
      };

      if (name === 'ticket_list') {
        const params = {};
        const proj = resolveListProject();
        if (proj) params.project = proj;
        if (args.mine === true) {
          if (!sessionId) throw new Error('ticket_list mine:true — no current session id (GOLEM_CEO_SESSION_ID/CLAUDE_CODE_SESSION_ID unset)');
          params.assignee = sessionId;
        } else if (args.assignee != null) {
          params.assignee = args.assignee;
        }
        if (args.state != null) params.state = args.state;
        if (args.kind != null) params.kind = args.kind;
        return await jsonResult(await tracker.listTickets(params));
      }

      if (name === 'ticket_get') {
        if (!args.id) throw new Error('ticket_get: id is required');
        return await jsonResult(await tracker.getTicket(args.id));
      }

      if (name === 'ticket_create') {
        const project_id = args.project || defaultProject;
        if (!project_id) throw new Error('ticket_create: could not resolve a project — pass project:"<contract-id>"');
        const body = {
          project_id,
          title: args.title,
          body: args.body,
          kind: args.kind,
          priority: args.priority,
          state: args.state,
          labels: args.labels,
          stream_id: args.stream_id,
          parent_id: args.parent_id,
          wave: args.wave,
          assignee: args.assignee,
          created_by: sessionId ?? undefined,
        };
        return await jsonResult(await tracker.createTicket(body));
      }

      if (name === 'ticket_update') {
        if (!args.id) throw new Error('ticket_update: id is required');
        const patch = { actor: sessionId ?? undefined };
        for (const k of ['state', 'title', 'body', 'kind', 'priority', 'labels', 'stream_id', 'parent_id', 'wave', 'assignee']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        return await jsonResult(await tracker.updateTicket(args.id, patch));
      }

      if (name === 'ticket_comment') {
        if (!args.id) throw new Error('ticket_comment: id is required');
        if (!sessionId) throw new Error('ticket_comment: no current session id to record as author');
        const comment = {
          author: sessionId,
          body: args.body,
          quote: args.quote,
          prefix: args.prefix,
          suffix: args.suffix,
          section: args.section,
          section_id: args.section_id,
          tag: args.tag,
          status: args.status,
          parent_id: args.parent_id,
        };
        return await jsonResult(await tracker.addComment(args.id, comment));
      }

      if (name === 'ticket_comment_update') {
        if (!args.id) throw new Error('ticket_comment_update: id is required');
        if (!args.comment_id) throw new Error('ticket_comment_update: comment_id is required');
        const patch = {};
        for (const k of ['body', 'tag', 'status']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        return await jsonResult(await tracker.updateComment(args.id, args.comment_id, patch));
      }

      if (name === 'ticket_comment_reply') {
        if (!args.id) throw new Error('ticket_comment_reply: id is required');
        if (!args.comment_id) throw new Error('ticket_comment_reply: comment_id is required');
        if (!sessionId) throw new Error('ticket_comment_reply: no current session id to record as author');
        return await jsonResult(await tracker.replyComment(args.id, args.comment_id, {
          author: sessionId,
          body: args.body,
        }));
      }

      if (name === 'ticket_dispatch') {
        if (!args.id) throw new Error('ticket_dispatch: id is required');
        if (!args.session_id) throw new Error('ticket_dispatch: session_id is required');
        return await jsonResult(await tracker.dispatchTicket(args.id, {
          session_id: args.session_id,
          note: args.note,
          when_idle: args.when_idle === true,
        }));
      }

      if (name === 'stream_create') {
        const project_id = args.project || defaultProject;
        if (!project_id) throw new Error('stream_create: could not resolve a project — pass project:"<contract-id>"');
        return await jsonResult(await tracker.createStream({
          project_id,
          name: args.name,
          mode: args.mode,
          description: args.description,
        }));
      }

      if (name === 'stream_list') {
        const proj = args.project || defaultProject || undefined;
        return await jsonResult(await tracker.listStreams(proj));
      }

      if (name === 'sessions_dispatchable') {
        const proj = args.project || defaultProject || undefined;
        return await jsonResult(await tracker.listDispatchable(proj));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
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
  const bridge = readOpencodeBridgeForParent();
  if (bridge && bridge.session_id === SESSION_ID) {
    await postToOpencodeBridge(bridge, { session_id: SESSION_ID, kind, content, meta });
    return;
  }
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

    // POST /consult — a peer asks THIS session for a fresh pair of eyes.
    if (method === 'POST' && path === '/consult') {
      const raw = await readBody(req);
      let p = {};
      try { p = JSON.parse(raw || '{}'); } catch { p = {}; }
      const consult_id = String(p.consult_id || '');
      const fromName = String(p.from_name || 'a peer session');
      const fromSession = String(p.from_session || '');
      const question = String(p.question || extractContent(raw) || '');
      const context = String(p.context || '');
      const isPing = !!p.status_ping;
      const content = isPing
        ? [
            `CONSULT STATUS PING from session "${fromName}" (consult_id ${consult_id}).`,
            '',
            question,
            '',
            'If you are still investigating, a brief consult_reply with your current status is courteous; otherwise send your final proposal.',
          ].join('\n')
        : [
            `CONSULT REQUEST from session "${fromName}" (consult_id ${consult_id}).`,
            '',
            'A peer session is stuck and wants a FRESH PAIR OF EYES — this is NOT delegation. Read the golem:provide-consult skill, investigate INDEPENDENTLY (their problem, the code, web research), look for root causes and blind spots they may be tunnel-visioned past, and reply with a proposal. Do NOT edit their repo, create tickets, or enter the work-loop.',
            '',
            'PROBLEM:',
            question,
            context ? '\nCONTEXT THEY PROVIDED:\n' + context : '',
            '',
            `When ready, deliver your proposal with the consult_reply tool: consult_reply({ to_session: "${fromSession}", consult_id: "${consult_id}", text: "<your analysis + proposal>" }).`,
          ].join('\n');
      await pushEvent('consult', content, { consult_id, from_name: fromName, from_session: fromSession });
      broadcast('consult', { consult_id, from_name: fromName, from_session: fromSession, status_ping: isPing, text: content });
      return sendJson(res, 202, { ok: true, kind: 'consult', consult_id });
    }

    // POST /consult/reply — a consultant returns its proposal to THIS asker.
    if (method === 'POST' && path === '/consult/reply') {
      const raw = await readBody(req);
      let p = {};
      try { p = JSON.parse(raw || '{}'); } catch { p = {}; }
      const consult_id = String(p.consult_id || '');
      const fromName = String(p.from_name || 'the consultant');
      const fromSession = String(p.from_session || '');
      const text = String(p.text || extractContent(raw) || '');
      const content = [
        `CONSULT REPLY from session "${fromName}" (consult_id ${consult_id}) — your consult came back.`,
        '',
        'This is ADVICE: a second opinion / fresh perspective to weigh, not orders. Read it critically, keep what holds up, discard what does not, and decide for yourself. You have the final say.',
        '',
        text,
      ].join('\n');
      await pushEvent('consult_reply', content, { consult_id, from_name: fromName, from_session: fromSession });
      broadcast('consult_reply', { consult_id, from_name: fromName, from_session: fromSession, text });
      return sendJson(res, 202, { ok: true, kind: 'consult_reply', consult_id });
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
function shutdown(code = 0, why = 'signal') {
  try { process.stderr.write(`[golem-channel] shutdown (${why})\n`); } catch { /* stderr gone */ }
  unregisterChannel();
  try { server.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGINT',  () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGHUP',  () => shutdown(0, 'SIGHUP'));
process.on('beforeExit', () => unregisterChannel());
// TKT-0369: the channel died mid-session with zero trace (no stderr, no crash
// report) — every abnormal exit must say why, or the next death is
// undiagnosable. Claude Code persists this stderr into its MCP log.
process.on('uncaughtException', (err) => {
  try { process.stderr.write(`[golem-channel] uncaughtException: ${err?.stack || err}\n`); } catch { /* stderr gone */ }
  shutdown(1, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  try { process.stderr.write(`[golem-channel] unhandledRejection: ${msg}\n`); } catch { /* stderr gone */ }
  shutdown(1, 'unhandledRejection');
});
process.on('exit', (code) => {
  // Sync-safe on 'exit'; catches any path the handlers above missed.
  try { process.stderr.write(`[golem-channel] exit code=${code}\n`); } catch { /* stderr gone */ }
});

await mcp.connect(new StdioServerTransport());
// TKT-0369: if the host closes the MCP stdio transport without killing us, the
// HTTP server would keep this process alive as a ZOMBIE channel — registered in
// channels.json, accepting briefs, but unable to deliver the notifications push
// (the transport is gone). Shut down cleanly instead so the registry reflects
// reality. (onclose is supported: @modelcontextprotocol/sdk 1.29.0
// Protocol._onclose invokes this.onclose.)
mcp.onclose = () => shutdown(0, 'mcp transport closed by host');
