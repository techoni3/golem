// Orchestrator visibility — surfaces the live CEO Claude Code session, the
// most recent journey/handoff memo per workspace, and open gates across all
// workspaces.
//
// CEO session detection
//   Claude Code stores transcripts at:
//     ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//   where <encoded-cwd> is the cwd with `/` → `-`. The golem-ceo launcher
//   cd's to $GOLEM_ROOT before exec'ing claude, so its sessions live in a
//   predictable directory. The most-recently-modified jsonl is the active
//   session.
//
// Journey + gates
//   Each workspace's CEO writes:
//     docs/agent-notes/ceo-handoff-<date>.md      (per-brief journey memo)
//     docs/agent-notes/gates/<gate_id>.md         (one file per gate)
//   We read these and surface counts + the most-recent journey.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';

const HOME = os.homedir();

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'),
  'golem',
);
const SESSIONS_REGISTRY = path.join(CONFIG_DIR, 'sessions.json');
const CHANNELS_REGISTRY = path.join(CONFIG_DIR, 'channels.json');

function pidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is owned by another user — treat as alive.
    return err && err.code === 'EPERM';
  }
}

async function readRegistry(file, listKey) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(raw);
    return Array.isArray(json[listKey]) ? json[listKey] : [];
  } catch (err) {
    console.error('[orchestrator] failed to parse', file, err.message);
    return [];
  }
}

// Read all live CEO sessions from the v3 session registry. Each row records
// {session_id, pid, boot_time, claimed_project, claimed_at, ...}. Stale rows
// (dead pid) are filtered out — the CLI's gc_stale_sessions is the primary
// cleanup path but only fires on `session claim/list/start/status`. Filtering
// here means the dashboard never surfaces ghost CEOs even when no CLI command
// has run.
//
// Joins the channels.json registry to expose `channel_port` / `channel_host`
// per session so the dashboard can fan out one SSE per CEO.
export async function readSessions() {
  const [sessions, channels] = await Promise.all([
    readRegistry(SESSIONS_REGISTRY, 'sessions'),
    readRegistry(CHANNELS_REGISTRY, 'channels'),
  ]);
  const channelBySession = new Map(channels.map((c) => [c.session_id, c]));
  return sessions
    .filter((s) => pidAlive(s.pid))
    .map((s) => {
      const ch = channelBySession.get(s.session_id) || null;
      return {
        ...s,
        live: true,
        channel_host: ch?.host ?? null,
        channel_port: ch?.port ?? null,
        channel_url: ch ? `http://${ch.host}:${ch.port}` : null,
      };
    });
}

// Channels registry passthrough — separate exporter so chat.js can poll it
// directly and reconcile its SSE fanout without re-running the full
// orchestrator snapshot.
export async function readChannels() {
  const channels = await readRegistry(CHANNELS_REGISTRY, 'channels');
  return channels
    .filter((c) => pidAlive(c.pid))
    .map((c) => ({ ...c, url: `http://${c.host}:${c.port}` }));
}

// Set of session_ids the registry knows about but whose pids are dead. Used
// by the journal store to demote ghost CEO agents that never got to journal a
// session-end event (e.g. the claude process was SIGKILL'd).
export async function readDeadSessionIds() {
  const sessions = await readRegistry(SESSIONS_REGISTRY, 'sessions');
  const dead = new Set();
  for (const s of sessions) {
    if (s.session_id && !pidAlive(s.pid)) dead.add(s.session_id);
  }
  return dead;
}

function encodeCwdToProjectKey(cwd) {
  // Claude Code uses cwd with `/` and (on macOS) `.` replaced by `-`.
  // We replicate the same encoding so we can find the right sessions dir.
  return cwd.replace(/[/.]/g, '-');
}

export function ceoSessionsDir() {
  return path.join(HOME, '.claude', 'projects', encodeCwdToProjectKey(CONFIG.golemRoot));
}

/**
 * Detect the live CEO session, if any.
 * @returns {Promise<{session_id, last_modified, age_ms, live, path} | null>}
 */
export async function detectCeoSession() {
  const dir = ceoSessionsDir();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const sessions = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await fs.stat(full);
      sessions.push({
        session_id: e.name.replace(/\.jsonl$/, ''),
        path: full,
        last_modified: st.mtimeMs,
        size: st.size,
      });
    } catch { /* ignore */ }
  }
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => b.last_modified - a.last_modified);
  const recent = sessions[0];
  const age = Date.now() - recent.last_modified;
  return {
    session_id: recent.session_id,
    path: recent.path,
    last_modified: recent.last_modified,
    age_ms: age,
    live: age < CONFIG.ceoLiveWindowMs,
    size: recent.size,
  };
}

/**
 * Find the most-recent ceo-handoff / ceo-plan memo in a workspace.
 * @returns {Promise<{path, name, mtime, summary} | null>}
 */
export async function latestJourneyMemo(workspace) {
  const dir = workspace.agentNotesDir;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isFile() && /^(ceo|retrofit|substrator)[-_].*\.md$/i.test(e.name));
  if (candidates.length === 0) return null;
  const enriched = [];
  for (const e of candidates) {
    const full = path.join(dir, e.name);
    try {
      const st = await fs.stat(full);
      enriched.push({ path: full, name: e.name, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  enriched.sort((a, b) => b.mtime - a.mtime);
  const top = enriched[0];
  // Pull a short summary (first ~3 non-empty lines after the first heading).
  let summary = '';
  try {
    const md = await fs.readFile(top.path, 'utf8');
    const afterFirstHeading = md.split(/\n#+\s+/).slice(1).join('\n');
    const lines = afterFirstHeading.split('\n').map((l) => l.trim()).filter(Boolean);
    summary = lines.slice(0, 3).join(' ').slice(0, 320);
  } catch { /* ignore */ }
  return { ...top, summary };
}

/**
 * Read all gates in a workspace.
 * @returns {Promise<Array<{gate_id, status, phase_just_completed, next_phase, path, mtime}>>}
 */
export async function readGates(workspace) {
  const dir = workspace.gatesDir;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const full = path.join(dir, e.name);
    let md;
    try {
      md = await fs.readFile(full, 'utf8');
    } catch { continue; }
    let st;
    try { st = await fs.stat(full); } catch { /* ignore */ }
    const frontmatter = parseFrontmatter(md);
    if (!frontmatter) continue;
    out.push({
      gate_id: frontmatter.gate_id || e.name.replace(/\.md$/, ''),
      status: frontmatter.status || 'unknown',
      phase_just_completed: frontmatter.phase_just_completed || null,
      next_phase: frontmatter.next_phase || null,
      created_at: frontmatter.created_at || null,
      acted_at: frontmatter.acted_at || null,
      brief_ref: frontmatter.brief_ref || null,
      journey_id: frontmatter.journey_id || null,
      workspace: workspace.id,
      workspace_name: workspace.name,
      path: full,
      mtime: st?.mtimeMs ?? null,
    });
  }
  return out;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // Strip optional quotes.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[kv[1]] = v;
  }
  return out;
}

/**
 * Build the full orchestrator snapshot used by /api/orchestrator and the WS.
 */
export async function orchestratorSnapshot(workspaces) {
  const [ceo, sessions, ...rest] = await Promise.all([
    detectCeoSession(),
    readSessions(),
    ...workspaces.map(async (w) => {
      const [memo, gates] = await Promise.all([latestJourneyMemo(w), readGates(w)]);
      return { workspace: w.id, kind: w.kind, name: w.name, memo, gates };
    }),
  ]);
  const perWorkspace = rest;

  // Aggregate gate counts.
  const allGates = perWorkspace.flatMap((w) => w.gates);
  const gateCounts = { awaiting: 0, approved: 0, denied: 0, cancelled: 0, total: allGates.length };
  for (const g of allGates) {
    if (gateCounts[g.status] !== undefined) gateCounts[g.status]++;
  }
  // Newest journey memo wins for the headline.
  const headlineMemo = perWorkspace
    .map((w) => w.memo ? { ...w.memo, workspace: w.workspace, workspace_name: w.name } : null)
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)[0] ?? null;

  return {
    ceo,
    sessions,       // v3: array of live CEO sessions (multi-CEO ready)
    workspaces: perWorkspace,
    headlineMemo,
    gates: allGates.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)),
    gateCounts,
  };
}
