#!/usr/bin/env bash
# GENERATED: hooks/tracker-context.sh — rendered by `golem sync` from substrate/ — edit the source, not this file.
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

if command -v node >/dev/null 2>&1; then
  ctx="$(node - "$SCRIPT_DIR" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const scriptDir = process.argv[2];
const home = process.env.HOME || '';
const candidates = [
  path.join(home, '.claude', 'tracker-context.md'),
  path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'tracker-context.md'),
  path.join(scriptDir, '..', 'instructions', 'tracker-context.md'),
];
for (const candidate of candidates) {
  try {
    const text = fs.readFileSync(candidate, 'utf8').trimEnd();
    if (text) {
      process.stdout.write(JSON.stringify(text).slice(1, -1));
      process.exit(0);
    }
  } catch {}
}
NODE
)"
else
  ctx="$(cat "$SCRIPT_DIR/../instructions/tracker-context.md" 2>/dev/null || true)"
  if [ -n "$ctx" ] && command -v jq >/dev/null 2>&1; then
    ctx="$(printf '%s' "$ctx" | jq -Rs . 2>/dev/null || true)"
    ctx="${ctx#\"}"
    ctx="${ctx%\"}"
  fi
fi

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
const id = projectId(root);
const lines = [];
try {
  const projects = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects || [];
  const project = projects.find((p) => p && (p.id === id || path.resolve(p.path || '') === root));
  const servers = Array.isArray(project?.lsp?.servers) ? project.lsp.servers : [];
  if (project?.lsp?.available && servers.length) lines.push(`LSP: ${servers.join(', ')}`);
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

if command -v node >/dev/null 2>&1; then
  TEAM_BLOCK="$(node - "$GOLEM_HOME_DIR" "$START_DIR" "$SESSION_ID" "$SCRIPT_DIR" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [home, start, selfId, scriptDir] = process.argv.slice(2);
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
const id = projectId(root);
let sessions = [];
try { sessions = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions || []; } catch {}
function roleMission(role) {
  if (!role) return '';
  for (const candidate of [path.join(home, 'roles', `${role}.md`), path.join(scriptDir, '..', 'roles', `${role}.md`)]) {
    try {
      const m = fs.readFileSync(candidate, 'utf8').match(/^Mission:\s*(.+)$/m);
      if (m) return m[1].trim();
    } catch {}
  }
  return '';
}
function workload(s) {
  const inProgress = Array.isArray(s.in_progress_tickets)
    ? s.in_progress_tickets.length
    : Array.isArray(s.workload?.in_progress_tickets) ? s.workload.in_progress_tickets.length : 0;
  const pending = Number(s.pending_count ?? s.workload?.pending_count ?? 0) || 0;
  return `${inProgress} working, ${pending} queued`;
}
const rows = sessions
  .filter((s) => s && s.project_id === id)
  .sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
  .slice(0, 9);
const self = rows.find((s) => s.session_id === selfId);
const peers = rows
  .filter((s) => s.session_id !== selfId)
  .slice(0, 8)
  .map((s) => {
    const name = s.name || (s.session_id ? `session ${String(s.session_id).slice(0, 8)}` : 'session');
    const role = s.role || 'unassigned';
    const status = s.status || (s.ended_at ? 'ended' : 'unknown');
    const duty = roleMission(s.role);
    const roleText = duty ? `${role}: ${duty}` : role;
    return `${name} (${roleText}; ${status}; workload ${workload(s)})`;
  });
const lines = [];
if (self) lines.push(`You are ${self.name || self.session_id || selfId}, role ${self.role || 'unassigned'}.`);
if (peers.length) lines.push(`Team on ${id}: ${peers.join('; ')}`);
if (lines.length) lines.push('Routing hint: re-query sessions_dispatchable before dispatching; this roster is only a session-start hint.');
process.stdout.write(lines.join('\n'));
NODE
)"
  if [ -n "$TEAM_BLOCK" ] && command -v jq >/dev/null 2>&1; then
    TEAM_ESC="$(printf '\n\n%s' "$TEAM_BLOCK" | jq -Rs . 2>/dev/null || true)"
    if [ -n "$TEAM_ESC" ]; then
      TEAM_ESC="${TEAM_ESC#\"}"
      TEAM_ESC="${TEAM_ESC%\"}"
      ctx="$ctx$TEAM_ESC"
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
