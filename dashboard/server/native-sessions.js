// Native Claude Code session discovery (v4 contract §Dashboard.1).
//
// Surfaces ALL live Claude Code sessions on this machine — not just the
// substrated/golem ones — so the dashboard reflects every `cd any-repo &&
// claude` session. Sources, in order of preference:
//
//   (a) `claude agents --json`  — authoritative; the CLI's own view of live
//       background/interactive sessions. Observed schema (claude 2.1.x):
//         [{ pid, cwd, kind, startedAt(ms), sessionId, status,
//            name?, waitingFor? }]
//       status ∈ {idle, busy, waiting, ...}. We run it first and fall back
//       only on absence / non-zero exit / unparseable output.
//
//   (b) ~/.claude/sessions/<pid>.json registry files — written by Claude Code
//       per session. Observed fields:
//         { pid, sessionId, cwd, startedAt(ms), procStart, version,
//           peerProtocol, kind, entrypoint, name?, updatedAt(ms),
//           status?, statusUpdatedAt?, bridgeSessionId? }
//
//   (c) ~/.golem/sessions.json — written by golem hooks/shims for Claude Code
//       and non-CC harnesses. Claude Code rows here carry hook_ppid (the hook's
//       shell), not the session pid, so they use a short recency window rather
//       than pid-liveness. opencode rows require a live channel and use either
//       bridge pid liveness or a bounded recency fallback when the bridge is gone.
//
// Liveness is source-specific: the CLI list is authoritative, ~/.claude files
// use pid liveness (process.kill(pid,0)), golem-registry Claude Code rows use
// recency, and opencode rows require a live channel plus bridge pid liveness or
// recent registry activity.
// Registry files can linger after death; stale files must not be resurrected by
// pid reuse.
//
// project_id is derived per the v4 contract from the session cwd's nearest
// project root (walk up to .git / CLAUDE.md), via the shared project-id helper.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import {
  projectIdFor,
  resolveProjectRoot,
} from './project-id.js';
import { channelsJsonPath, golemHome, sessionsJsonPath } from '../../lib/golem-home.js';
import { readCodexSupervisors } from '../../lib/codex-supervisor.js';
import { isSessionFactTerminal, readSessionFacts } from '../../lib/session-facts.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const OPENCODE_BRIDGES_REGISTRY = path.join(golemHome(), 'opencode-bridges.json');
const CHANNELS_REGISTRY = channelsJsonPath();
const CODEX_SESSION_INDEX = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'session_index.jsonl');

// Non-CC harness sessions (opencode, TKT-0577) self-register into
// ~/.golem/sessions.json but have no `claude agents` row, no ~/.claude/sessions
// file, and no reliable session pid (hook_ppid is the hook's shell). We surface
// them by RECENCY instead of pid-liveness — a session whose last_seen_at is
// within this window is shown as live.
const GOLEM_SESSION_RECENT_MS = 15 * 60 * 1000;

function msFromIso(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function pidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: pid exists but owned by another user — treat as alive.
    return err && err.code === 'EPERM';
  }
}

async function readCodexThreadNames() {
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    const names = new Map();
    // Codex 0.144.5 owns this append-only index and resolves the latest entry
    // for each thread id. Mirror that exact rule as a fail-open dashboard
    // fallback so already-running managed sessions gain their real TUI name
    // before they are restarted onto the protocol notification fix.
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry?.id !== 'string') continue;
      const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
      if (name) names.set(entry.id, name); else names.delete(entry.id);
    }
    return names;
  } catch {
    return new Map();
  }
}

function readCodexSupervisorRows() {
  try { return readCodexSupervisors(); } catch { return []; }
}

function managedCodexPresentation(record, endpoint, fallbackStatus, fallbackWaitingFor) {
  if (!record) return { status: fallbackStatus, waiting_for: fallbackWaitingFor };
  // A ready typed lease is stricter than a hook fact: it proves the canonical
  // TUI is connected, MCP-bound, thread-bound, and has no active turn.
  if (endpoint?.delivery_ready === true) return { status: 'idle', waiting_for: null };
  if (['dead', 'failed', 'stopped'].includes(record.health?.state)) {
    return { status: 'error', waiting_for: null };
  }
  const flags = Array.isArray(record.thread_status?.activeFlags) ? record.thread_status.activeFlags : [];
  if (flags.includes('waitingOnApproval')) return { status: 'waiting', waiting_for: 'approval' };
  if (flags.includes('waitingOnUserInput')) return { status: 'waiting', waiting_for: 'user input' };
  if (record.thread_status?.type === 'active') return { status: 'busy', waiting_for: null };
  if (record.thread_status?.type === 'systemError') return { status: 'error', waiting_for: null };
  if (record.thread_status?.type === 'idle') return { status: 'idle', waiting_for: null };
  const turnState = record.turn?.state;
  if (turnState === 'busy' || turnState === 'starting') return { status: 'busy', waiting_for: null };
  if (turnState === 'recovery_pending' || turnState === 'failed') return { status: 'error', waiting_for: null };
  if (turnState === 'idle') return { status: 'idle', waiting_for: null };
  return { status: fallbackStatus, waiting_for: fallbackWaitingFor };
}

// Run `claude agents --json`. Resolves to a parsed array, or null when the CLI
// is absent / errors / emits non-JSON. Never throws — the caller falls back to
// the registry files. Bounded by a short timeout so a wedged CLI can't stall
// the orchestrator refresh tick.
function runClaudeAgentsJson() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    let child;
    try {
      child = execFile(
        'claude',
        ['agents', '--json'],
        { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // ENOENT (CLI missing), non-zero exit, or timeout → fall back.
            return finish(null);
          }
          const text = (stdout ?? '').trim();
          if (!text) return finish([]);
          try {
            const parsed = JSON.parse(text);
            return finish(Array.isArray(parsed) ? parsed : null);
          } catch {
            return finish(null);
          }
        },
      );
    } catch {
      return finish(null);
    }
    child?.on?.('error', () => finish(null));
  });
}

function normalizeCli(row) {
  if (!row || typeof row !== 'object') return null;
  const pid = Number(row.pid) || null;
  const sessionId = row.sessionId ?? row.session_id ?? null;
  if (!sessionId && !pid) return null;
  return {
    session_id: sessionId,
    pid,
    cwd: row.cwd ?? null,
    name: row.name ?? null,
    status: row.status ?? null,
    waiting_for: row.waitingFor ?? null,
    model: row.model ?? row.modelID ?? row.model_id ?? null,
    started_at: Number.isFinite(row.startedAt) ? row.startedAt : null,
    updated_at: Number.isFinite(row.startedAt) ? row.startedAt : null,
    kind: row.kind ?? null,
    source: 'native',
    _from: 'cli',
  };
}

function normalizeRegistry(row) {
  if (!row || typeof row !== 'object') return null;
  const pid = Number(row.pid) || null;
  const sessionId = row.sessionId ?? row.session_id ?? null;
  if (!sessionId && !pid) return null;
  return {
    session_id: sessionId,
    pid,
    cwd: row.cwd ?? null,
    name: row.name ?? null,
    status: row.status ?? null,
    waiting_for: null,
    model: row.model ?? row.modelID ?? row.model_id ?? null,
    started_at: Number.isFinite(row.startedAt) ? row.startedAt : null,
    updated_at: Number.isFinite(row.updatedAt) ? row.updatedAt : (Number.isFinite(row.startedAt) ? row.startedAt : null),
    kind: row.kind ?? null,
    source: 'native',
    _from: 'registry',
  };
}

function normalizeGolemRegistry(row) {
  if (!row || typeof row !== 'object') return null;
  const sessionId = row.session_id ?? null;
  if (!sessionId) return null;
  return {
    session_id: sessionId,
    pid: Number(row.hook_ppid) || null,
    cwd: row.project_path ?? null,
    name: row.name ?? null,
    status: row.status ?? null,
    waiting_for: null,
    started_at: msFromIso(row.boot_time),
    updated_at: msFromIso(row.last_seen_at) ?? msFromIso(row.boot_time),
    kind: null,
    harness: row.harness ?? 'claudecode',
    model: row.model ?? null,
    role: row.role ?? null,
    role_updated_at: row.role_updated_at ?? null,
    role_updated_by: row.role_updated_by ?? null,
    ended_at: msFromIso(row.ended_at),
    source: 'native',
    _from: 'golem',
  };
}

async function readOpencodeBridges() {
  let raw;
  try {
    raw = await fs.readFile(OPENCODE_BRIDGES_REGISTRY, 'utf8');
  } catch {
    return new Map();
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Map();
  }
  const rows = Array.isArray(json?.bridges) ? json.bridges : [];
  const bySession = new Map();
  for (const b of rows) {
    if (!b?.session_id) continue;
    const bridgePid = Number(b.opencode_pid || b.pid) || null;
    if (!pidAlive(bridgePid)) continue;
    const prev = bySession.get(b.session_id);
    const bt = Date.parse(b.updated_at || b.started_at || 0) || 0;
    const pt = prev ? (Date.parse(prev.updated_at || prev.started_at || 0) || 0) : -1;
    if (!prev || bt > pt) bySession.set(b.session_id, b);
  }
  return bySession;
}

async function readLiveChannelSessionIds() {
  let raw;
  try {
    raw = await fs.readFile(CHANNELS_REGISTRY, 'utf8');
  } catch {
    return new Set();
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Set();
  }
  const rows = Array.isArray(json?.channels) ? json.channels : [];
  return new Set(rows.filter((c) => c?.session_id && pidAlive(Number(c.pid) || null)).map((c) => c.session_id));
}

// Read ~/.golem/sessions.json (the golem session registry written by
// session-register.sh for BOTH harnesses). CC entries here duplicate the
// ~/.claude sources and merge by session_id; opencode entries are unique.
async function readGolemRegistrySessions() {
  let raw;
  try {
    raw = await fs.readFile(sessionsJsonPath(), 'utf8');
  } catch {
    return [];
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(json?.sessions) ? json.sessions : [];
  return rows.map(normalizeGolemRegistry).filter(Boolean);
}

async function readRegistrySessions() {
  let entries;
  try {
    entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    let raw;
    try {
      raw = await fs.readFile(path.join(SESSIONS_DIR, e.name), 'utf8');
    } catch {
      continue;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const n = normalizeRegistry(json);
    if (n) out.push(n);
  }
  return out;
}

// Merge CLI + registry rows keyed by session_id (falling back to pid). CLI
// wins on conflict (it is the live, authoritative view); registry fills gaps
// (e.g. updatedAt, sessions the CLI momentarily omits).
function mergeSources(cliRows, registryRows, golemRows = []) {
  const byKey = new Map();
  const keyOf = (r) => r.session_id || `pid:${r.pid}`;
  // Priority (last write wins on shared fields): golem < registry < cli.
  for (const r of golemRows) byKey.set(keyOf(r), r);
  const overlay = (rows) => {
    for (const r of rows) {
      const k = keyOf(r);
      const prev = byKey.get(k);
      if (prev) {
        byKey.set(k, {
          ...prev,
          ...r,
          // Preserve fields the higher-priority source doesn't supply.
          updated_at: r.updated_at ?? prev.updated_at,
          name: r.name ?? prev.name,
          harness: r.harness ?? prev.harness, // only the golem source sets harness
          model: r.model ?? prev.model,
          role: r.role ?? prev.role, // only the golem source sets role metadata
          role_updated_at: r.role_updated_at ?? prev.role_updated_at,
          role_updated_by: r.role_updated_by ?? prev.role_updated_by,
        });
      } else {
        byKey.set(k, r);
      }
    }
  };
  overlay(registryRows);
  overlay(cliRows);
  return [...byKey.values()];
}

function dropTransientClaudeGolemRows(golemRows, nativeRows) {
  const nativeByPid = new Map();
  const nativeIds = new Set();
  for (const r of nativeRows) {
    if (r.session_id) nativeIds.add(r.session_id);
    if (r.pid && r.session_id) nativeByPid.set(Number(r.pid), r.session_id);
  }
  return golemRows.filter((r) => {
    const harness = r.harness ?? 'claudecode';
    if (harness !== 'claudecode') return true;
    // Claude Code liveness must come from Claude's own CLI/registry sources.
    // sessions.json is enrichment (role/model/project recency), not standalone
    // evidence of a live Claude session; otherwise transient hook ids survive as
    // unnamed phantom cards after resume/reload.
    if (!nativeIds.has(r.session_id)) return false;
    const nativeSessionId = r.pid ? nativeByPid.get(Number(r.pid)) : null;
    // Claude resume/reload can hand hooks a transient per-run id while the
    // parent ~/.claude/sessions/<pid>.json carries the logical renamed id. If a
    // golem row points at a live native pid under a different id, it is an
    // orphaned transient and must not surface as a second unnamed session.
    return !(nativeSessionId && nativeSessionId !== r.session_id);
  });
}

// project_id cache keyed by resolved cwd → avoids re-walking the FS every tick.
const projectIdCache = new Map();

async function deriveProjectId(cwd) {
  if (!cwd) return null;
  if (projectIdCache.has(cwd)) return projectIdCache.get(cwd);
  let root;
  try {
    root = await resolveProjectRoot(cwd);
  } catch {
    root = cwd;
  }
  const id = projectIdFor(root);
  const result = { project_id: id, project_root: root };
  projectIdCache.set(cwd, result);
  return result;
}

export function dedupeNativeSessions(rows) {
  try {
    const claimed = new Map();
    return rows.filter((row) => {
      const name = row.name && row.name.trim();
      if (!name) return true;
      const scope = `${row.project_id ?? row.cwd ?? ''}\0${name}`;
      const winner = claimed.get(scope);
      if (!winner) {
        claimed.set(scope, row);
        return true;
      }
      // Alive-first ordering normally makes the winner authoritative. Still,
      // never collapse a live resume-rekey row behind a dead winner if that
      // ordering is changed or removed.
      if (row.harness === 'claudecode' && winner.harness === 'claudecode'
          && row.pid && Number(row.pid) === Number(winner.pid)) {
        return row.alive === true && winner.alive !== true;
      }
      return row.alive === true;
    });
  } catch {
    return rows;
  }
}

/**
 * Build the merged, pid-checked native_sessions array for the snapshot.
 *
 * @param {(absRoot: string, cwd: string|null) => string | null} [registeredIdLookup]
 *   Optional: given the resolved project root AND the raw session cwd, return
 *   the dashboard's registered project id if either maps to a known project,
 *   else null. Used to flag sessions whose project is NOT registered (UI
 *   badge). Pure/sync.
 * @returns {Promise<Array<object>>}
 */
export async function readNativeSessions(registeredIdLookup, verifiedChannels = []) {
  const [cliRaw, registryRaw, golemRaw, opencodeBridges, liveChannelSessionIds, codexThreadNames] = await Promise.all([
    runClaudeAgentsJson(),
    readRegistrySessions(),
    readGolemRegistrySessions(),
    readOpencodeBridges(),
    readLiveChannelSessionIds(),
    readCodexThreadNames(),
  ]);

  const cliRows = Array.isArray(cliRaw) ? cliRaw.map(normalizeCli).filter(Boolean) : [];
  const registryRows = registryRaw; // already normalized
  const filteredGolemRows = dropTransientClaudeGolemRows(golemRaw, [...registryRows, ...cliRows]);
  const merged = mergeSources(cliRows, registryRows, filteredGolemRows);
  const facts = readSessionFacts();
  const verifiedBySession = new Map(verifiedChannels.filter((channel) => channel.endpoint_health === 'healthy').map((channel) => [channel.session_id, channel]));
  const supervisors = readCodexSupervisorRows();
  const supervisorByCanonical = new Map(supervisors.map((row) => [row.canonical_id, row]));
  // Shadow raw-as-canonical hook facts whenever ANY supervisor row maps that
  // thread — not only while the lease is healthy. Lease-down used to leave a
  // nameless twin card beside the (dead or recovering) canonical row.
  const managedOwnerByRawThread = new Map(supervisors
    .filter((row) => row.thread_id)
    .map((row) => [row.thread_id, row.canonical_id]));
  const mergedById = new Map(merged.filter((row) => row.session_id).map((row) => [row.session_id, row]));
  for (const fact of facts) {
    // A managed TUI also emits ordinary Codex hook facts under the raw thread
    // id. That raw row is the same actor as the supervisor canonical — never a
    // second session card.
    if (fact.harness === 'codex'
      && fact.canonical_id === fact.locator?.raw_session_id
      && managedOwnerByRawThread.has(fact.canonical_id)) continue;
    const previous = mergedById.get(fact.canonical_id) || {};
    const supervisor = supervisorByCanonical.get(fact.canonical_id);
    const rawThreadId = fact.locator?.raw_session_id;
    const presentation = managedCodexPresentation(
      supervisor,
      verifiedBySession.get(fact.canonical_id),
      fact.status ?? previous.status ?? null,
      fact.waiting_for ?? previous.waiting_for ?? null,
    );
    mergedById.set(fact.canonical_id, {
      ...previous,
      session_id: fact.canonical_id,
      cwd: fact.project_path ?? previous.cwd ?? null,
      name: fact.name ?? supervisor?.thread_name ?? codexThreadNames.get(rawThreadId) ?? previous.name ?? null,
      status: presentation.status,
      waiting_for: presentation.waiting_for,
      model: fact.model ?? previous.model ?? null,
      harness: fact.harness,
      updated_at: msFromIso(fact.observed_at),
      // Prefer explicit fact retirement; keep prior registry ended_at if set.
      ended_at: msFromIso(fact.ended_at) ?? previous.ended_at ?? null,
      _fact: fact,
    });
  }

  const out = [];
  for (const s of mergedById.values()) {
    const harness = s.harness ?? 'claudecode';
    // Golem-registry Claude Code rows carry hook_ppid (the hook shell), not the
    // real session pid, so pid-liveness can be faked by pid reuse; only native
    // CLI / ~/.claude registry rows trust pid-liveness. opencode rows require a
    // live channel; a live bridge pid is authoritative, while recent registry
    // activity is a bounded fallback for bridge-loss windows.
    const isNonCc = harness !== 'claudecode';
    const isGolemRegistryCc = harness === 'claudecode' && s._from === 'golem';
    const bridge = harness === 'opencode' ? opencodeBridges.get(s.session_id) : null;
    const bridgePid = Number(bridge?.opencode_pid || bridge?.pid) || null;
    const factFresh = !s._fact || (s.updated_at && Date.now() - s.updated_at < GOLEM_SESSION_RECENT_MS);
    // Explicit session retirement only — never bare turn-stop `status: ended`
    // (Codex fires stop per turn). Terminal = ended_at or dead|stopped|failed|superseded.
    const factTerminal = isSessionFactTerminal(s._fact);
    const rowEnded = !!s.ended_at || factTerminal;
    const verifiedEndpoint = verifiedBySession.get(s.session_id);
    const managedCodexHealthy = harness === 'codex' && verifiedEndpoint?.kind === 'codex-supervisor';
    const alive = managedCodexHealthy
      ? !rowEnded
      : harness === 'opencode'
      ? !!(!factTerminal && !s.ended_at && factFresh && (verifiedEndpoint || (!s._fact && liveChannelSessionIds.has(s.session_id) && (bridge
        ? pidAlive(bridgePid)
        : (s.updated_at && (Date.now() - s.updated_at) < GOLEM_SESSION_RECENT_MS)))))
      : (isNonCc || isGolemRegistryCc
        ? !!(!factTerminal && !s.ended_at && s.updated_at && (Date.now() - s.updated_at) < GOLEM_SESSION_RECENT_MS)
        : pidAlive(s.pid));
    // Drop dead sessions whose only evidence is a stale registry/golem file.
    // Keep a CLI-sourced row even if pid-check disagrees (CLI just listed it
    // live), but mark alive honestly. Fact-only terminal Codex rows must not
    // linger as ghost agents either.
    if (!alive && (s._from === 'registry' || s._from === 'golem' || (harness === 'codex' && rowEnded))) continue;

    let project_id = null;
    let project_root = null;
    if (s.cwd) {
      const d = await deriveProjectId(s.cwd);
      if (d) {
        project_id = d.project_id;
        project_root = d.project_root;
      }
    }

    let registered = false;
    if (typeof registeredIdLookup === 'function') {
      try {
        // Pass both the resolved root AND the raw cwd: a registered project
        // path may be MORE specific than the walked-up root (the contract's
        // root rule can walk past a registered subdir to a parent .git/CLAUDE.md
        // — e.g. a home-level CLAUDE.md). The lookup decides which wins.
        registered = !!registeredIdLookup(project_root, s.cwd);
      } catch {
        registered = false;
      }
    }

    out.push({
      session_id: s.session_id,
      pid: bridgePid || s.pid,
      alive,
      cwd: s.cwd,
      project_id,
      project_root,
      registered,
      name: s.name,
      status: s.status,
      waiting_for: s.waiting_for ?? null,
      started_at: s.started_at,
      updated_at: s.updated_at,
      harness,
      model: s.model ?? null,
      role: s.role ?? null,
      role_updated_at: s.role_updated_at ?? null,
      role_updated_by: s.role_updated_by ?? null,
      source: 'native',
      fact_fresh: !!s._fact && factFresh,
      fact_observed_at: s._fact?.observed_at ?? null,
      fact_revision: s._fact?.revision ?? null,
      endpoint_health: verifiedEndpoint ? 'healthy' : (s._fact ? 'unverified' : 'legacy'),
      endpoint_expires_at: verifiedEndpoint?.expires_at ?? null,
    });
  }

  // Stable, useful ordering: alive first, then most-recently-updated. The
  // dedup filter below consumes this order to choose its preferred winner.
  out.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return (b.updated_at ?? b.started_at ?? 0) - (a.updated_at ?? a.started_at ?? 0);
  });

  return dedupeNativeSessions(out);
}
