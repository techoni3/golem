#!/usr/bin/env bash
# SessionStart hook — assemble tracker context, team hints, and a compact role
# card. Fail-open: emit the rendered tracker context, or the substrate source if
# sync is stale, rather than breaking session start.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./_golem-home.sh
. "$SCRIPT_DIR/_golem-home.sh"

SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --session=*)
      SESSION_ID="${1#--session=}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD="$(cat 2>/dev/null || true)"
fi
if [ -z "$SESSION_ID" ] && command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // .sessionID // empty' 2>/dev/null || true)"
fi
START_DIR="$PWD"
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  PAYLOAD_CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // .directory // empty' 2>/dev/null || true)"
  if [ -n "$PAYLOAD_CWD" ]; then
    START_DIR="$PAYLOAD_CWD"
  fi
fi

ctx=""

if command -v node >/dev/null 2>&1; then
  MAP_BLOCK="$(node - "$GOLEM_HOME_DIR" "$START_DIR" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [home, start] = process.argv.slice(2);
function rootFrom(dir) {
  let cur = path.resolve(dir);
  const homeDir = process.env.HOME || '';
  for (let i = 0; i < 64; i++) {
    if (cur === homeDir) break;
    const gitPath = path.join(cur, '.git');
    // Worktree remap: if .git is a file, parse gitdir to find the main repo root.
    if (fs.existsSync(gitPath)) {
      try {
        const st = fs.statSync(gitPath);
        if (st.isFile()) {
          const content = fs.readFileSync(gitPath, 'utf8');
          const m = content.match(/^gitdir:\s*(.+)$/m);
          if (m) {
            const mainRoot = m[1].trim().replace(/\/\.git\/worktrees\/[^/]+$/, '');
            if (fs.existsSync(mainRoot)) return mainRoot;
          }
        }
      } catch (_) { /* fall through */ }
    }
    if (fs.existsSync(gitPath) || fs.existsSync(path.join(cur, 'CLAUDE.md'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(dir);
}
function projectId(root) {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${slug}-${crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 6)}`;
}
const root = rootFrom(start);
const derivedId = projectId(root);
const lines = [];
let registryId = derivedId;
try {
  const projects = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects || [];
  const project = projects.find((p) => p && (p.id === derivedId || path.resolve(p.path || '') === root));
  if (project?.id) registryId = project.id;
  const servers = Array.isArray(project?.lsp?.servers) ? project.lsp.servers : [];
  if (project?.lsp?.available && servers.length) lines.push(`LSP: ${servers.join(', ')}`);
} catch {}
try {
  const sessions = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions || [];
  const channels = JSON.parse(fs.readFileSync(path.join(home, 'channels.json'), 'utf8')).channels || [];
  const rootResolved = path.resolve(root);
  function pidAlive(pid) {
    if (!pid || Number(pid) <= 0) return false;
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  }
  const liveChannelIds = new Set(channels.filter((c) => pidAlive(c?.pid)).map((c) => c.session_id));
  const live = sessions.filter((s) => {
    if (!s || s.ended_at || s.status === 'ended') return false;
    // A registry row without a live channel or parent process is stale. The
    // channel is the dispatchable-session authority; hook_ppid covers the
    // brief interval before a newly started channel registers.
    if (!liveChannelIds.has(s.session_id) && !pidAlive(s.hook_ppid)) return false;
    if (s.project_id && (s.project_id === registryId || s.project_id === derivedId)) return true;
    if (s.project_path && path.resolve(s.project_path) === rootResolved) return true;
    return false;
  });
  // Prefer freshest rows per session_id
  const byId = new Map();
  for (const s of live) {
    const prev = byId.get(s.session_id);
    const t = Date.parse(s.last_seen_at || s.status_updated_at || s.boot_time || 0) || 0;
    const pt = prev ? (Date.parse(prev.last_seen_at || prev.status_updated_at || prev.boot_time || 0) || 0) : -1;
    if (!prev || t >= pt) byId.set(s.session_id, s);
  }
  const rows = [...byId.values()].sort((a, b) => {
    const ra = String(a.role || '—');
    const rb = String(b.role || '—');
    if (ra !== rb) return ra.localeCompare(rb);
    return String(a.name || a.session_id).localeCompare(String(b.name || b.session_id));
  });
  if (rows.length) {
    const parts = rows.map((s) => {
      const role = s.role || 'unassigned';
      const status = s.status || 'unknown';
      const label = s.name || String(s.session_id || '').slice(0, 12);
      return `${role}:${status}:${label}`;
    });
    lines.push(`Team on ${registryId}: ${parts.join(' · ')}`);
    lines.push('Team roster is a snapshot — call sessions_dispatchable before dispatch.');
  } else {
    lines.push(`Team on ${registryId}: (no live sessions)`);
  }
} catch {}
process.stdout.write(lines.join('\n'));
NODE
)"
  if [ -n "$MAP_BLOCK" ] && command -v jq >/dev/null 2>&1; then
    MAP_ESC="$(printf '\n\n%s' "$MAP_BLOCK" | jq -Rs . 2>/dev/null || true)"
    if [ -n "$MAP_ESC" ]; then
      MAP_ESC="${MAP_ESC#\"}"
      MAP_ESC="${MAP_ESC%\"}"
      ctx="$ctx$MAP_ESC"
    fi
  fi
fi

if [ -n "$SESSION_ID" ] && command -v jq >/dev/null 2>&1; then
  SESSIONS_JSON="$GOLEM_HOME_DIR/sessions.json"
  ROLE="$(jq -r --arg sid "$SESSION_ID" '(.sessions // [])[] | select(.session_id == $sid) | .role // empty' "$SESSIONS_JSON" 2>/dev/null | head -n 1 || true)"
  # Resolve the role card with the same precedence as lib/session-role.js#readRoleCard:
  #   1. overlay  -> $GOLEM_HOME_DIR/roles/<role>.md   (per-user override, single source of truth)
  #   2. custom   -> $GOLEM_ROLES_DIR/<role>.md         (env override; preserves the lib's contract)
  #   3. default  -> $SCRIPT_DIR/../roles/<role>.md     (packaged substrate card)
  # Fail-open: if nothing resolves we just skip the card and the session still
  # gets the base tracker context.
  CARD=""
  if [ -n "$ROLE" ]; then
    for candidate in "$GOLEM_HOME_DIR/roles/$ROLE.md" "${GOLEM_ROLES_DIR:+$GOLEM_ROLES_DIR/$ROLE.md}" "$SCRIPT_DIR/../roles/$ROLE.md"; do
      if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        CARD="$candidate"
        break
      fi
    done
  fi
  if [ -n "$ROLE" ] && [ -n "$CARD" ]; then
    ROLE_ESC="$( { printf '\n\n'; cat "$CARD"; } | jq -Rs . 2>/dev/null || true)"
    if [ -n "$ROLE_ESC" ]; then
      ROLE_ESC="${ROLE_ESC#\"}"
      ROLE_ESC="${ROLE_ESC%\"}"
      ctx="$ctx$ROLE_ESC"
    fi
  fi
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx" 2>/dev/null || true
