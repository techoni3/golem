#!/usr/bin/env bash
#
# journal-event.sh — append a mechanical event to the project's hook journal.
#
# Wired (per .claude/settings.json) to:
#   - SessionStart       → session-start
#   - UserPromptSubmit   → user-prompt
#   - SessionEnd         → session-end
#   - Stop               → stop
#   - SubagentStop       → subagent-stop
#   - PreToolUse(Agent)  → agent-spawn
#   - PreToolUse(SendMessage) → send-message
#   - PreToolUse(Bash|Read|Write|Edit|Skill) → tool-pre
#   - PostToolUse(Agent) → agent-return
#   - PostToolUse(SendMessage) → send-message-post
#   - PostToolUse(Bash|Read|Write|Edit|Skill) → tool-post
#   - Notification       → notification
#   - PreCompact         → pre-compact
#
# Usage:
#   "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/journal-event.sh <event_type>"
#
# Behaviour:
#   - Resolves project root via $CLAUDE_PROJECT_DIR (falls back to walking up
#     from $PWD looking for CLAUDE.md / .git).
#   - Creates journal/ if missing.
#   - Reads hook payload (JSON) from stdin.
#   - Extracts canonical fields for the dashboard's consumption (session_id,
#     tool_name, subagent_type/name/team_name, file_path, command, skill, etc.).
#   - Appends one JSONL line to journal/hook.jsonl.
#   - Schema-tagged with "schema": 1 so we can evolve the format.
#   - Never blocks the hook; failures log to stderr and exit 0.

set -u

EVENT_TYPE="${1:-unknown}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

project_root() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/CLAUDE.md" ]] || [[ -d "$dir/.git" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "$PWD"
}

ROOT="$(project_root)"
JOURNAL_DIR="$ROOT/journal"
JOURNAL_FILE="$JOURNAL_DIR/hook.jsonl"

mkdir -p "$JOURNAL_DIR" 2>/dev/null || {
  echo "journal-event: could not create $JOURNAL_DIR" >&2
  exit 0
}

PAYLOAD="$(cat 2>/dev/null || true)"

if command -v jq >/dev/null 2>&1; then
  ENTRY="$(printf '%s' "${PAYLOAD:-{}}" | jq -c \
    --arg ts "$TS" \
    --arg event "$EVENT_TYPE" \
    --arg cwd "$PWD" \
    '{
      schema: 1,
      ts: $ts,
      event: $event,
      cwd: $cwd,
      session_id: (.session_id // null),
      transcript_path: (.transcript_path // null),
      hook_event_name: (.hook_event_name // null),
      source: (.source // null),
      tool_name: (.tool_name // null),
      tool_input: (.tool_input // null),
      tool_response: (
        if .tool_response then
          (.tool_response | if type == "object" then
            { ok: (.success // null), summary: ((.message // .text // null) | tostring | .[0:500]) }
          else (. | tostring | .[0:500]) end)
        else null end
      ),
      subagent_type: (.tool_input.subagent_type // null),
      subagent_name: (.tool_input.name // null),
      team_name: (.tool_input.team_name // null),
      send_to: (.tool_input.to // null),
      file_path: (.tool_input.file_path // null),
      command: (.tool_input.command // null),
      skill_name: (.tool_input.skill // null),
      message: (.message // null),
      stop_hook_active: (.stop_hook_active // null)
    }' 2>/dev/null)"
  if [[ -z "$ENTRY" ]]; then
    ENTRY="$(jq -cn \
      --arg ts "$TS" \
      --arg event "$EVENT_TYPE" \
      --arg cwd "$PWD" \
      --arg payload "$PAYLOAD" \
      '{schema: 1, ts: $ts, event: $event, cwd: $cwd, payload_raw: $payload, parse_failed: true}')"
  fi
else
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }
  ENTRY="{\"schema\":1,\"ts\":\"$(esc "$TS")\",\"event\":\"$(esc "$EVENT_TYPE")\",\"cwd\":\"$(esc "$PWD")\",\"payload_raw\":\"$(esc "$PAYLOAD")\",\"jq_missing\":true}"
fi

printf '%s\n' "$ENTRY" >> "$JOURNAL_FILE" 2>/dev/null || {
  echo "journal-event: could not write to $JOURNAL_FILE" >&2
  exit 0
}

exit 0
