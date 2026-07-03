// Native Claude Code session discovery (v4 contract §Dashboard.1).
//
// Surfaces ALL live Claude Code sessions on this machine — not just the
// substrated/golem ones — so the dashboard reflects every `cd any-repo &&
// claude` session. Two sources, in order of preference:
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
// Liveness = pid liveness (process.kill(pid,0), same as orchestrator.js) AND
// the native status — NOT file mtime. A registry file can linger after the
// process dies; the pid check is ground truth. The CLI list only contains
// live sessions, but we still pid-check defensively.
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
import { sessionsJsonPath } from '../../lib/golem-home.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');

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
    role: row.role ?? null,
    role_updated_at: row.role_updated_at ?? null,
    role_updated_by: row.role_updated_by ?? null,
    source: 'native',
    _from: 'golem',
  };
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
export async function readNativeSessions(registeredIdLookup) {
  const [cliRaw, registryRaw, golemRaw] = await Promise.all([
    runClaudeAgentsJson(),
    readRegistrySessions(),
    readGolemRegistrySessions(),
  ]);

  const cliRows = Array.isArray(cliRaw) ? cliRaw.map(normalizeCli).filter(Boolean) : [];
  const registryRows = registryRaw; // already normalized
  const merged = mergeSources(cliRows, registryRows, golemRaw);

  const out = [];
  for (const s of merged) {
    const harness = s.harness ?? 'claudecode';
    // Non-CC harness sessions (opencode) have no reliable pid — judge liveness
    // by recency of last_seen_at instead. CC sessions keep pid-liveness.
    const isNonCc = harness !== 'claudecode';
    const alive = isNonCc
      ? !!(s.updated_at && (Date.now() - s.updated_at) < GOLEM_SESSION_RECENT_MS)
      : pidAlive(s.pid);
    // Drop dead sessions whose only evidence is a stale registry/golem file.
    // Keep a CLI-sourced row even if pid-check disagrees (CLI just listed it
    // live), but mark alive honestly.
    if (!alive && (s._from === 'registry' || s._from === 'golem')) continue;

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
      pid: s.pid,
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
      role: s.role ?? null,
      role_updated_at: s.role_updated_at ?? null,
      role_updated_by: s.role_updated_by ?? null,
      source: 'native',
    });
  }

  // Stable, useful ordering: alive first, then most-recently-updated.
  out.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return (b.updated_at ?? b.started_at ?? 0) - (a.updated_at ?? a.started_at ?? 0);
  });
  return out;
}
