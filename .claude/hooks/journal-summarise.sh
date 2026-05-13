#!/usr/bin/env bash
#
# journal-summarise.sh — SessionEnd reflex check.
#
# Wired to SessionEnd, runs AFTER journal-event.sh's session-end entry has
# been appended.
#
# Per design v1 §7.2.4 (Q-001), the *primary* mechanism for the semantic
# journal is `golem-summarise-session` — a reflex skill the working agent
# invokes as its final tool call before yielding control. That writes one
# JSON line to journal/summary.jsonl.
#
# This hook's job is the graceful-degradation backstop: if the working agent
# did NOT invoke the reflex (crash, abnormal termination, forgot), we want
# the Documentarian to know there's a missing summary at the next sweep.
# We do that by appending a single "abnormal" marker line so the trailhead is
# in the same file as real summaries.
#
# Detection:
#   - Read the session_id from the SessionEnd payload (stdin).
#   - Tail journal/summary.jsonl and check whether its last line's session_id
#     matches.
#   - If yes: reflex worked — exit silently.
#   - If no:  append a degraded {session_id, ended_at, status: "missing-reflex"}
#             line. Documentarian backfills the rest at next sweep.
#
# Never blocks the hook; failures log to stderr and exit 0.

set -u

TS_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
SUMMARY_FILE="$ROOT/journal/summary.jsonl"

mkdir -p "$(dirname "$SUMMARY_FILE")" 2>/dev/null || exit 0

PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID=""
if command -v jq >/dev/null 2>&1 && [[ -n "$PAYLOAD" ]]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi
[[ -z "$SESSION_ID" ]] && SESSION_ID="unknown-$(date -u +%Y%m%dT%H%M%SZ)"

# Did the working agent's reflex already write a line for this session?
LAST_SESSION=""
if [[ -f "$SUMMARY_FILE" ]] && command -v jq >/dev/null 2>&1; then
  LAST_SESSION="$(tail -n 1 "$SUMMARY_FILE" 2>/dev/null | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

if [[ "$LAST_SESSION" == "$SESSION_ID" ]] && [[ -n "$SESSION_ID" ]]; then
  exit 0
fi

# Append degraded marker so Documentarian sees a trailhead.
if command -v jq >/dev/null 2>&1; then
  ENTRY="$(jq -cn \
    --arg ts "$TS_END" \
    --arg session "$SESSION_ID" \
    --arg cwd "$PWD" \
    '{ts: $ts, session_id: $session, cwd: $cwd, status: "missing-reflex", note: "session ended without golem-summarise-session reflex; backfill from hook.jsonl + ticket hand-off log"}')"
else
  ENTRY="{\"ts\":\"$TS_END\",\"session_id\":\"$SESSION_ID\",\"cwd\":\"$PWD\",\"status\":\"missing-reflex\",\"note\":\"session ended without golem-summarise-session reflex\"}"
fi

printf '%s\n' "$ENTRY" >> "$SUMMARY_FILE" 2>/dev/null || {
  echo "journal-summarise: could not write to $SUMMARY_FILE" >&2
  exit 0
}

exit 0
