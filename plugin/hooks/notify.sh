#!/usr/bin/env bash
# GENERATED: hooks/notify.sh — rendered by `golem sync` from substrate/ — edit the source, not this file.
#
# notify.sh — Notification hook for the golem v4 plugin. Pushes the
# notification message to an ntfy.sh topic so the user gets a phone ping when a
# session needs input or goes idle.
#
# Topic source (first set wins):
#   1. $GOLEM_NTFY_TOPIC
#   2. ~/.config/golem/ntfy_topic   (file, first non-empty line)
# Silent no-op when neither is set.
#
# The curl is backgrounded with `&` so the network call never delays the hook.
# Safety: set -u, bash-3.2 compatible, all failures exit 0.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./_golem-home.sh
. "$SCRIPT_DIR/_golem-home.sh"

CONFIG_DIR="$GOLEM_HOME_DIR"

# --- resolve topic ---------------------------------------------------------
TOPIC="${GOLEM_NTFY_TOPIC:-}"
if [ -z "$TOPIC" ] && [ -f "$CONFIG_DIR/ntfy_topic" ]; then
  TOPIC="$(grep -m1 -v '^[[:space:]]*$' "$CONFIG_DIR/ntfy_topic" 2>/dev/null | tr -d '[:space:]')"
fi
[ -z "$TOPIC" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

# --- read payload ----------------------------------------------------------
PAYLOAD="$(cat 2>/dev/null || true)"

MESSAGE="golem notification"
CWD="$PWD"
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  _m="$(printf '%s' "$PAYLOAD" | jq -r '.message // empty' 2>/dev/null || true)"
  [ -n "$_m" ] && MESSAGE="$_m"
  _c="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "$_c" ] && CWD="$_c"
fi

# --- resolve project name (repo dirname) -----------------------------------
project_root() {
  local dir="$CWD"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -f "$dir/CLAUDE.md" ] || [ -d "$dir/.git" ]; then
      printf '%s\n' "$dir"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "${CLAUDE_PROJECT_DIR:-$CWD}"
}
NAME="$(basename "$(project_root)")"
[ -z "$NAME" ] && NAME="session"

# --- push (backgrounded; never blocks the hook) ----------------------------
curl -s \
  -H "Title: golem: $NAME" \
  -d "$MESSAGE" \
  "https://ntfy.sh/$TOPIC" >/dev/null 2>&1 &

exit 0
