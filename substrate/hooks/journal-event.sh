#!/usr/bin/env bash
#
# journal-event.sh — append a mechanical event to the project's hook journal.
#
# Wired to SessionStart, UserPromptSubmit, and SessionEnd. Reads the hook
# payload from stdin (Claude Code passes JSON), distils to a single line, and
# appends to journal/hook.jsonl in the project root.
#
# Usage (from settings.json hooks):
#   "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/journal-event.sh <event_type>"
# where <event_type> is "session-start" | "session-end" | "user-prompt".
#
# Behaviour:
#   - Resolves project root by walking up from $PWD (the agent's effective
#     working directory at hook-fire time) until it finds a CLAUDE.md or .git.
#     $PWD is the correct anchor — CLAUDE_PROJECT_DIR is inherited from the
#     parent session and would mis-route every sub-agent's events to the root
#     workspace. If the walk finds no marker, falls back to CLAUDE_PROJECT_DIR
#     (NOT $PWD) so stray cwds outside any project tree don't pollute random
#     directories — they anchor at the session's home workspace.
#   - Creates journal/ if missing.
#   - Appends one JSONL line: {ts, event, session_id, cwd, payload}.
#   - Never blocks the hook; failures log to stderr and exit 0.

set -u

EVENT_TYPE="${1:-unknown}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

project_root() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/CLAUDE.md" ]] || [[ -d "$dir/.git" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "${CLAUDE_PROJECT_DIR:-$PWD}"
}

ROOT="$(project_root)"
JOURNAL_DIR="$ROOT/journal"
JOURNAL_FILE="$JOURNAL_DIR/hook.jsonl"

mkdir -p "$JOURNAL_DIR" 2>/dev/null || {
  echo "journal-event: could not create $JOURNAL_DIR" >&2
  exit 0
}

PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID=""
if command -v jq >/dev/null 2>&1 && [[ -n "$PAYLOAD" ]]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

# --- F2 teammate-exit classification --------------------------------------
# On SubagentStop (a sub-agent / agent-team teammate terminating) classify
# whether the exit was HEALTHY or PREMATURE. The closing reflex
# (golem-summarise-session, run as the persona's final tool call before
# yielding) is the strongest healthy-exit signal: a teammate that stopped
# WITHOUT a preceding closing-reflex call is a strong premature-exit (F2
# silent end_turn termination) candidate.
#
# Evidence source: the per-subagent transcript JSONL named by
# `agent_transcript_path` in the SubagentStop payload. We scan its tail for a
# tool_use of name "Skill" with input.skill == "golem-summarise-session".
#
#   clean     — closing reflex seen in the transcript tail
#   premature — transcript readable, no closing reflex in its tail
#   unknown   — no transcript path / unreadable / jq missing (cannot tell)
#
# Never throws: any failure leaves EXIT_REASON empty and journalling proceeds.
EXIT_REASON=""
if [[ "$EVENT_TYPE" == "subagent-stop" ]] && command -v jq >/dev/null 2>&1 && [[ -n "$PAYLOAD" ]]; then
  AGENT_TRANSCRIPT="$(printf '%s' "$PAYLOAD" | jq -r '.agent_transcript_path // .transcript_path // empty' 2>/dev/null || true)"
  if [[ -n "$AGENT_TRANSCRIPT" && -f "$AGENT_TRANSCRIPT" ]]; then
    # Look at the last 25 transcript lines for the closing reflex. The reflex
    # is the persona's *final* tool call, so a generous tail suffices and we
    # avoid parsing the whole (possibly large) transcript.
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
    if [[ "$REFLEX_HIT" == "true" ]]; then
      EXIT_REASON="clean"
    else
      EXIT_REASON="premature"
    fi
  else
    EXIT_REASON="unknown"
  fi
fi

if command -v jq >/dev/null 2>&1; then
  ENTRY="$(jq -cn \
    --arg ts "$TS" \
    --arg event "$EVENT_TYPE" \
    --arg session "$SESSION_ID" \
    --arg cwd "$PWD" \
    --arg exit_reason "$EXIT_REASON" \
    --arg payload "$PAYLOAD" \
    '{ts: $ts, event: $event, session_id: $session, cwd: $cwd, payload: $payload}
       + (if $exit_reason == "" then {} else {exit_reason: $exit_reason} end)')"
else
  # jq missing — cannot inspect the transcript, so exit_reason stays absent.
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }
  ENTRY="{\"ts\":\"$(esc "$TS")\",\"event\":\"$(esc "$EVENT_TYPE")\",\"session_id\":\"$(esc "$SESSION_ID")\",\"cwd\":\"$(esc "$PWD")\",\"payload\":\"$(esc "$PAYLOAD")\"}"
fi

printf '%s\n' "$ENTRY" >> "$JOURNAL_FILE" 2>/dev/null || {
  echo "journal-event: could not write to $JOURNAL_FILE" >&2
}

# v3: on SessionEnd, release the project lock this session was holding (if any).
# No-op if the session isn't registered or holds no claim. Idempotent against
# the eventual `kill -0` GC.
if [[ "$EVENT_TYPE" == "session-end" ]] && command -v golem >/dev/null 2>&1; then
  if [[ -n "${SESSION_ID:-}" ]]; then
    golem session release --session-id "$SESSION_ID" >/dev/null 2>&1 || true
  fi
fi

exit 0
