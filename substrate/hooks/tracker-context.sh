#!/usr/bin/env bash
# SessionStart hook — inject the golem tracker working-model into the session so
# agents register/track their work as tickets BY DEFAULT (skills are opt-in; a
# fresh session has the ticket_* MCP tools but no standing instruction to use
# them). Emits a SessionStart `additionalContext` JSON and, when the session has
# a role in sessions.json, appends that compact role card. Fail-open: on any
# failure it emits base tracker context rather than breaking session start.
#
# The text is single-quoted; `\n` stays literal (valid JSON newline escapes) and
# there are no double-quotes in the body, so the JSON needs no further escaping.

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

ctx='Golem session — the golem cross-project TRACKER is where work lives (not PLAN.md, not an ad-hoc todo). You have MCP tools: ticket_list/get/create/update/comment/dispatch, stream_create/list, sessions_dispatchable. The dashboard owns the DB and must be running (golem dashboard).\n\nWorking model — keep the tracker in sync AS YOU PLAN AND WORK on feature-sized or larger requests; do not wait to be told:\n- On a brief or dispatch: ticket_list(mine:true) or the ticket id named in the brief, then ticket_get it, then ticket_update to in_progress.\n- As you plan: ticket_create one ticket per work-item (decompose with parent_id; group related work with stream_create, mode sequential or parallel).\n- As you work: ticket_comment progress with mechanical evidence (commands + real output), and advance state in_progress -> review -> done (or blocked when stuck).\n- Blocking question for the human: ticket_create with kind:question and assignee:human, then pause that thread until they answer via a comment.\nSkip all of this for trivial questions or one-line fixes. If a ticket tool reports the dashboard is unreachable, note it and proceed without blocking. Full flow: the golem:tracker skill.\n\nState hygiene — never leave a ticket you own in the wrong state:\n- Never end a turn with a ticket in a wrong state: finished work -> review (or done after verify-done), abandoned/parked -> comment WHY + blocked or unassign. A dispatched ticket leaves todo the moment you start it.\n- Before going idle, sweep ticket_list(mine:true): any in_progress you are not actively working must be advanced, commented, or released.\n- Stale tickets are a defect: your own ticket untouched >1 day -> fix its state before starting new work.'

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
    if (fs.existsSync(path.join(cur, '.git')) || fs.existsSync(path.join(cur, 'CLAUDE.md'))) return cur;
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
    MAP_ESC="$(printf '%s' "\n\n$MAP_BLOCK" | jq -Rs . 2>/dev/null || true)"
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
  CARD="$SCRIPT_DIR/../roles/$ROLE.md"
  if [ -n "$ROLE" ] && [ -f "$CARD" ]; then
    NAME="$(jq -r --arg sid "$SESSION_ID" '(.sessions // [])[] | select(.session_id == $sid) | .name // .session_id // $sid' "$SESSIONS_JSON" 2>/dev/null | head -n 1 || true)"
    ROSTER="Roster: ${NAME:-$SESSION_ID} is assigned role $ROLE."
    ROLE_ESC="$( { printf '\n\n'; cat "$CARD"; printf '\n\n%s' "$ROSTER"; } | jq -Rs . 2>/dev/null || true)"
    if [ -n "$ROLE_ESC" ]; then
      ROLE_ESC="${ROLE_ESC#\"}"
      ROLE_ESC="${ROLE_ESC%\"}"
      ctx="$ctx$ROLE_ESC"
    fi
  fi
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx" 2>/dev/null || true
