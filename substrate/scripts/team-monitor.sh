#!/usr/bin/env bash
# team-monitor.sh — supervise an iterative-team's liveness from the CEO main thread.
#
# Invoked by the CEO via Claude Code's Monitor tool:
#
#   Monitor(
#     description: "team supervision: <team_name>",
#     command: "bash $GOLEM_ROOT/substrate/scripts/team-monitor.sh <team_name>",
#     timeout_ms: 3600000
#   )
#
# Polls ~/.claude/teams/<team_name>/ and the teammates' transcript files every
# ~5 s. Emits one stdout line per meaningful transition; the Monitor tool
# delivers each line as a fresh conversation turn for the CEO. The CEO reads
# the signal and applies the decision table in golem-handoff-protocol §"Team
# supervision".
#
# Exit conditions:
#   • Convergence: both members isActive=false AND all inboxes empty → exit 0
#   • Team config missing for > 30 s (premature TeamDelete?)             → exit 1
#   • Anything emitting > 1000 events (runaway filter)                   → exit 2
#
# Environment:
#   GOLEM_TEAM_STALL_MS   Stall threshold in milliseconds (default: 120000)
#   GOLEM_TEAM_POLL_MS    Poll interval in milliseconds (default: 5000)

set -euo pipefail

TEAM_NAME="${1:-}"
[[ -n "$TEAM_NAME" ]] || { echo "monitor: missing <team_name>" >&2; exit 2; }

TEAMS_DIR="$HOME/.claude/teams/$TEAM_NAME"
CONFIG_FILE="$TEAMS_DIR/config.json"
INBOX_DIR="$TEAMS_DIR/inboxes"

STALL_MS="${GOLEM_TEAM_STALL_MS:-120000}"
POLL_MS="${GOLEM_TEAM_POLL_MS:-5000}"
POLL_SEC="$(awk -v m=$POLL_MS 'BEGIN{printf "%.1f", m/1000}')"
STALL_SEC=$(( STALL_MS / 1000 ))

emit() {
  # Each line becomes a CEO conversation turn — be precise.
  printf '%s\n' "$*"
}

now_epoch() { date +%s; }

# Where Claude Code stores transcript jsonl for tmux-backed teammates.
# The project-level transcript path is <encoded-cwd>/<session-uuid>.jsonl under
# ~/.claude/projects/. We don't know the project cwd in this script — we map
# from team config (which contains the teammate's session_id) to the actual
# jsonl by globbing every projects subdir.
find_transcript() {
  local sid="$1"
  local f
  for f in "$HOME/.claude/projects/"*"/$sid.jsonl"; do
    [[ -f "$f" ]] && { printf '%s\n' "$f"; return 0; }
  done
  return 1
}

# Count `read: false` entries in an inbox file.
inbox_unread() {
  local file="$1"
  [[ -f "$file" ]] || { echo 0; return; }
  jq '[.[] | select(.read == false)] | length' "$file" 2>/dev/null || echo 0
}

# Get isActive[member] from config.json. Echo "true" / "false" / "".
member_is_active() {
  local member="$1"
  jq -r --arg n "$member" '
    (.members // []) | map(select(.name == $n)) | .[0].isActive // "" | tostring
  ' "$CONFIG_FILE" 2>/dev/null || true
}

# Get session_id for a member (used to locate transcript).
member_session_id() {
  local member="$1"
  jq -r --arg n "$member" '
    (.members // []) | map(select(.name == $n)) | .[0].agentId // .[0].session_id // ""
  ' "$CONFIG_FILE" 2>/dev/null || true
}

# Read the list of members from config.json.
list_members() {
  jq -r '(.members // []) | .[].name' "$CONFIG_FILE" 2>/dev/null || true
}

# Last mtime of a teammate's transcript. Echoes seconds-since-epoch or empty.
transcript_mtime() {
  local sid="$1"
  local f
  f="$(find_transcript "$sid")" || return 0
  stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || true
}

# Sanitise a member name into something usable as a shell variable suffix.
mangle() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_' '_'
}

# Get a per-member state value: get_state <map_name> <member>
get_state() {
  local map="$1" key
  key="$(mangle "$2")"
  eval "printf '%s' \"\${${map}_${key}:-}\""
}

# Set a per-member state value: set_state <map_name> <member> <value>
set_state() {
  local map="$1" key value
  key="$(mangle "$2")"
  value="$3"
  eval "${map}_${key}=\"\$value\""
}

# Find new transcript lines emitted since last_size; emit verdict tokens.
# Stores last_size in the named variable (member-specific via dynamic eval).
scan_verdict_tokens() {
  local member="$1" sid="$2"
  local f
  f="$(find_transcript "$sid")" || return 0
  local size cur_size
  size="$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null || echo 0)"
  cur_size="$(get_state transcript_size "$member")"
  cur_size="${cur_size:-0}"
  if [[ "$size" -gt "$cur_size" ]]; then
    # Tail the new bytes; grep for verdict tokens. case-insensitive, word-ish.
    tail -c $(( size - cur_size )) "$f" 2>/dev/null \
      | grep -iE -o '\b(approve|approved|request-changes|request changes|block(ed)?)\b' \
      | sort -u \
      | while IFS= read -r token; do
          emit "verdict $member: $token"
        done
  fi
  set_state transcript_size "$member" "$size"
}

# ---- Main loop --------------------------------------------------------------

# Wait briefly for the team config to appear after spawn.
config_grace=0
while [[ ! -f "$CONFIG_FILE" ]] && [[ $config_grace -lt 6 ]]; do
  sleep "$POLL_SEC"
  config_grace=$((config_grace + 1))
done
if [[ ! -f "$CONFIG_FILE" ]]; then
  emit "team-config-missing $TEAM_NAME (no $CONFIG_FILE after $config_grace polls)"
  exit 1
fi

emit "monitor: armed for $TEAM_NAME"

# bash 3.2 compatibility: simulate associative arrays via dynamic variable
# names (`<map>_<mangled-key>`) using mangle/get_state/set_state above.
# Maps in use: inbox_count, is_active, transcript_size, stall_emitted_at.

events_emitted=0
config_missing_streak=0
no_config_threshold=$(( 30 / (POLL_MS / 1000 > 0 ? POLL_MS / 1000 : 1) ))

while true; do
  # Detect config disappearance (premature TeamDelete).
  if [[ ! -f "$CONFIG_FILE" ]]; then
    config_missing_streak=$((config_missing_streak + 1))
    if (( config_missing_streak >= no_config_threshold )); then
      emit "team-config-missing $TEAM_NAME (deleted while supervising)"
      exit 1
    fi
    sleep "$POLL_SEC"
    continue
  else
    config_missing_streak=0
  fi

  members=()
  while IFS= read -r m; do [[ -n "$m" ]] && members+=("$m"); done < <(list_members)

  any_active=0
  any_unread=0
  ts_now=$(now_epoch)

  for member in "${members[@]}"; do
    sid="$(member_session_id "$member")"
    active="$(member_is_active "$member")"
    mtime="$(transcript_mtime "$sid")"
    inbox_file="$INBOX_DIR/$member.json"
    unread="$(inbox_unread "$inbox_file")"

    # isActive transitions
    prev_active="$(get_state is_active "$member")"
    [[ -z "$prev_active" ]] && prev_active="__init__"
    if [[ "$prev_active" != "__init__" && "$prev_active" != "$active" ]]; then
      emit "isActive $member: $prev_active → $active"
      events_emitted=$((events_emitted + 1))
    fi
    set_state is_active "$member" "$active"
    [[ "$active" == "true" ]] && any_active=1

    # Inbox transitions
    prev_inbox="$(get_state inbox_count "$member")"
    prev_inbox="${prev_inbox:-0}"
    if [[ "$unread" -gt "$prev_inbox" ]]; then
      # New message(s) — emit one line per unread peer message (truncated).
      body_lines="$(jq -r '.[] | select(.read == false) | ((.from // "?") + ": " + ((.body // .message // "")[0:120]))' "$inbox_file" 2>/dev/null | tail -n $(( unread - prev_inbox )))"
      while IFS= read -r line; do
        [[ -n "$line" ]] && { emit "inbox $member+1 $line"; events_emitted=$((events_emitted + 1)); }
      done <<< "$body_lines"
    fi
    set_state inbox_count "$member" "$unread"
    [[ "$unread" -gt 0 ]] && any_unread=1

    # Verdict token scan (only when transcript advances)
    scan_verdict_tokens "$member" "$sid"

    # Stall detection
    if [[ "$active" == "true" && -n "$mtime" ]]; then
      age=$(( ts_now - mtime ))
      if (( age >= STALL_SEC )); then
        last_stall="$(get_state stall_emitted_at "$member")"
        last_stall="${last_stall:-0}"
        # Re-emit at most once every (STALL_SEC * 2).
        if (( ts_now - last_stall >= STALL_SEC * 2 )); then
          emit "stall $member: mtime stale ${age}s (threshold ${STALL_SEC}s)"
          events_emitted=$((events_emitted + 1))
          set_state stall_emitted_at "$member" "$ts_now"
        fi
      fi
    fi
  done

  # Convergence: all members inactive AND all inboxes clean.
  if (( any_active == 0 && any_unread == 0 )) && [[ ${#members[@]} -gt 0 ]]; then
    emit "converged $TEAM_NAME"
    exit 0
  fi

  # Runaway-event safety valve.
  if (( events_emitted > 1000 )); then
    emit "monitor: too many events (>${events_emitted}); exiting to protect main-thread context"
    exit 2
  fi

  sleep "$POLL_SEC"
done
