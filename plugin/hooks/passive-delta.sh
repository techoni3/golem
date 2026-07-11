#!/usr/bin/env bash
# GENERATED: hooks/passive-delta.sh — rendered by `golem sync` from substrate/ — edit the source, not this file.
# GOL-423 UserPromptSubmit hook — claim a deterministic passive batch only
# while Claude Code is already about to process a real human prompt. No channel
# notification is sent here, so an ordinary tracker mutation never creates work.
# Fail-open by design: a missing dashboard, jq, curl, or session identity emits
# no context and always exits zero.

set -u

PAYLOAD="$(cat 2>/dev/null || true)"
SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
if [ -z "$SESSION_ID" ] && command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // .sessionId // empty' 2>/dev/null || true)"
fi
[ -n "$SESSION_ID" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

BASE_URL="${GOLEM_DASHBOARD_URL:-http://127.0.0.1:7420}"
SESSION_PATH="$(jq -rn --arg value "$SESSION_ID" '$value|@uri' 2>/dev/null || true)"
[ -n "$SESSION_PATH" ] || exit 0

CLAIM="$(curl -fsS --connect-timeout 0.2 --max-time 0.6 -X POST -H "X-Golem-Caller-Session: $SESSION_ID" \
  "$BASE_URL/api/passive-deltas/$SESSION_PATH/claim" 2>/dev/null || true)"
[ -n "$CLAIM" ] || exit 0
BODY="$(printf '%s' "$CLAIM" | jq -r '.batch.body // empty' 2>/dev/null || true)"
LEASE_ID="$(printf '%s' "$CLAIM" | jq -r '.lease_id // empty' 2>/dev/null || true)"
[ -n "$BODY" ] && [ -n "$LEASE_ID" ] || exit 0

# Serialize the hook output before committing. If commit cannot reach the
# dashboard, the lease eventually releases and this exact durable batch replays.
OUTPUT="$(jq -cn --arg context "$BODY" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$context}}' 2>/dev/null || true)"
[ -n "$OUTPUT" ] || exit 0
printf '%s\n' "$OUTPUT"
COMMIT_BODY="$(jq -cn --arg lease_id "$LEASE_ID" '{lease_id:$lease_id}' 2>/dev/null || true)"
[ -n "$COMMIT_BODY" ] || exit 0
curl -fsS --connect-timeout 0.2 --max-time 0.6 -H 'content-type: application/json' -H "X-Golem-Caller-Session: $SESSION_ID" \
  -d "$COMMIT_BODY" "$BASE_URL/api/passive-deltas/$SESSION_PATH/commit" >/dev/null 2>&1 || true
exit 0
