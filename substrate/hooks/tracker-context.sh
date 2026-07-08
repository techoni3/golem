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
