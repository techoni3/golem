#!/usr/bin/env bash
# GENERATED: hooks/journal-route.sh — rendered by `golem sync` from substrate/ — edit the source, not this file.
#
# journal-route.sh — golem v4 central journal hook.
#
# Port of v3 .claude/hooks/journal-event.sh with three changes:
#   1. Writes to ~/.config/golem/journals/<project_id>/hook.jsonl (central,
#      zero repo footprint) instead of <root>/journal/hook.jsonl.
#   2. Adds project_id + project_path fields to every line so readers never
#      re-derive.
#   3. LEGACY GUARD: if the resolved project root still contains
#      .claude/hooks/journal-event.sh (a v3-wired project, including the golem
#      repo itself), exit 0 silently — v3 wiring owns that project's journal
#      until the v3 delete-list phase.
#
# Usage (from hooks.json): journal-route.sh <event-type>
#   e.g. session-start | user-prompt | stop | subagent-stop | session-end |
#        pre-compact | notification | tool-pre | tool-post | agent-spawn |
#        agent-return | send-message | send-message-post
#
# Line schema: {ts, event, session_id, cwd, project_id, project_path, payload}
#   (+ exit_reason on subagent-stop, when derivable).
#
# Safety: set -u, bash-3.2 compatible, all failures exit 0, never blocks.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./_golem-home.sh
. "$SCRIPT_DIR/_golem-home.sh"

EVENT_TYPE="${1:-unknown}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CONFIG_DIR="$GOLEM_HOME_DIR"

PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID=""
CWD="$PWD"
HARNESS=""
MODEL=""
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
  _pcwd="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "$_pcwd" ] && CWD="$_pcwd"
  HARNESS="$(printf '%s' "$PAYLOAD" | jq -r '.harness // empty' 2>/dev/null || true)"
  MODEL="$(printf '%s' "$PAYLOAD" | jq -r '.model // .modelID // .model_id // .session.model // .session.modelID // .info.model // .info.modelID // empty' 2>/dev/null || true)"
fi

# --- resolve project root (same rule as session-register.sh) ---------------
project_root() {
  local dir="$CWD"
  while [ "$dir" != "/" ] && [ "$dir" != "${HOME:-/nonexistent}" ] && [ -n "$dir" ]; do
    if [ -f "$dir/CLAUDE.md" ] || [ -d "$dir/.git" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "${CLAUDE_PROJECT_DIR:-$CWD}"
}

ROOT="$(project_root)"
[ -z "$ROOT" ] && exit 0
[ "$ROOT" = "${HOME:-/nonexistent}" ] && exit 0  # home is global rules, not a project

# --- LEGACY GUARD ----------------------------------------------------------
# A v3-wired project carries its own journaling and must own its journal.
if [ -f "$ROOT/.claude/hooks/journal-event.sh" ]; then
  exit 0
fi

# --- derive project_id -----------------------------------------------------
DIRNAME="$(basename "$ROOT")"
slug() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}
sha6() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 2>/dev/null | cut -c1-6
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-6
  else
    printf '%s' "$1" | cksum 2>/dev/null | awk '{printf "%06x", $1}' | cut -c1-6
  fi
}
SLUG="$(slug "$DIRNAME")"; [ -z "$SLUG" ] && SLUG="project"
PROJECT_ID="${SLUG}-$(sha6 "$ROOT")"

JOURNAL_DIR="$CONFIG_DIR/journals/$PROJECT_ID"
JOURNAL_FILE="$JOURNAL_DIR/hook.jsonl"
SESSIONS_JSON="$CONFIG_DIR/sessions.json"

mkdir -p "$JOURNAL_DIR" 2>/dev/null || {
  echo "journal-route: could not create $JOURNAL_DIR" >&2
  exit 0
}

# Keep ~/.golem/sessions.json fresh from per-turn/tool hook payloads. If a
# payload has no model, preserve the last reported model and only bump recency.
refresh_session_registry() {
  [ -z "$SESSION_ID" ] && return 0
  [ ! -f "$SESSIONS_JSON" ] && return 0
  command -v jq >/dev/null 2>&1 || return 0
  local tmp="$SESSIONS_JSON.tmp.$$"
  jq \
    --arg sid "$SESSION_ID" \
    --arg pid "$PROJECT_ID" \
    --arg ppath "$ROOT" \
    --arg harness "$HARNESS" \
    --arg model "$MODEL" \
    --arg now "$TS" \
    '
    (.version // 1) as $v
    | (.sessions // []) as $ss
    | {
        version: $v,
        sessions: [ $ss[]
          | if .session_id == $sid then
              . + {
                last_seen_at: $now,
                project_id: (.project_id // $pid),
                project_path: (.project_path // $ppath),
                harness: (if $harness == "" then (.harness // "claudecode") else $harness end),
                model: (if $model == "" then (.model // null) else $model end)
              }
            else . end
        ]
      }
    ' "$SESSIONS_JSON" > "$tmp" 2>/dev/null && mv "$tmp" "$SESSIONS_JSON" 2>/dev/null
  rm -f "$tmp" 2>/dev/null || true
}

with_session_lock() {
  local lock="$SESSIONS_JSON.lock" tries=50 i=0
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true
  while [ "$i" -lt "$tries" ]; do
    if mkdir "$lock" 2>/dev/null; then
      refresh_session_registry
      local rc=$?
      rmdir "$lock" 2>/dev/null || true
      return $rc
    fi
    if [ -d "$lock" ]; then
      local age
      age="$(($(date +%s) - $(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo 0)))"
      if [ "$age" -gt 5 ] 2>/dev/null; then
        rmdir "$lock" 2>/dev/null || true
      fi
    fi
    i=$((i + 1))
  done
  return 1
}

with_session_lock || true

# --- subagent-stop exit classification (ported, portable) ------------------
# clean     — closing reflex (golem-summarise-session Skill call) in tail
# premature — transcript readable, no reflex in tail
# unknown   — no/unreadable transcript or jq missing
EXIT_REASON=""
if [ "$EVENT_TYPE" = "subagent-stop" ] && command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  AGENT_TRANSCRIPT="$(printf '%s' "$PAYLOAD" | jq -r '.agent_transcript_path // .transcript_path // empty' 2>/dev/null || true)"
  if [ -n "$AGENT_TRANSCRIPT" ] && [ -f "$AGENT_TRANSCRIPT" ]; then
    REFLEX_HIT="$(tail -n 25 "$AGENT_TRANSCRIPT" 2>/dev/null \
      | jq -rs '
          [ .[]
            | (.message.content // [])
            | (if type == "array" then . else [] end)
            | .[]
            | select(.type == "tool_use" and .name == "Skill")
            | (.input.skill // "")
          ]
          | any(. == "golem-summarise-session")
        ' 2>/dev/null || true)"
    if [ "$REFLEX_HIT" = "true" ]; then
      EXIT_REASON="clean"
    else
      EXIT_REASON="premature"
    fi
  else
    EXIT_REASON="unknown"
  fi
fi

# --- compose + append the line ---------------------------------------------
if command -v jq >/dev/null 2>&1; then
  ENTRY="$(jq -cn \
    --arg ts "$TS" \
    --arg event "$EVENT_TYPE" \
    --arg session "$SESSION_ID" \
    --arg cwd "$CWD" \
    --arg pid "$PROJECT_ID" \
    --arg ppath "$ROOT" \
    --arg exit_reason "$EXIT_REASON" \
    --arg payload "$PAYLOAD" \
    '{ts: $ts, event: $event, session_id: $session, cwd: $cwd,
      project_id: $pid, project_path: $ppath, payload: $payload}
       + (if $exit_reason == "" then {} else {exit_reason: $exit_reason} end)')"
else
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }
  ENTRY="{\"ts\":\"$(esc "$TS")\",\"event\":\"$(esc "$EVENT_TYPE")\",\"session_id\":\"$(esc "$SESSION_ID")\",\"cwd\":\"$(esc "$CWD")\",\"project_id\":\"$(esc "$PROJECT_ID")\",\"project_path\":\"$(esc "$ROOT")\",\"payload\":\"$(esc "$PAYLOAD")\"}"
fi

printf '%s\n' "$ENTRY" >> "$JOURNAL_FILE" 2>/dev/null || {
  echo "journal-route: could not write to $JOURNAL_FILE" >&2
}

exit 0
