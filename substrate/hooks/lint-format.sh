#!/usr/bin/env bash
#
# lint-format.sh — PostToolUse hook that runs the project's lint/format command.
#
# Wired to PostToolUse on Edit and Write. Reads the tool-use payload from
# stdin to learn which file was edited, then defers to a project-defined
# script at .claude/lint-format-runner.sh, passing the changed file path as $1.
#
# Why a thin dispatcher: the actual lint command is stack-specific (ruff for
# Python, prettier+eslint for TS/JS, etc.). The substrate hook stays generic;
# the project owns the command. Local DevOps fills in the runner at bring-up.
#
# Contract for .claude/lint-format-runner.sh:
#   - Receives one argument: the changed file path (absolute).
#   - Runs whatever lint/format command is appropriate for the file's stack.
#   - Exits 0 always (lint failures are surfaced via stderr, not by blocking
#     the tool call). Use a separate pre-commit / verification gate for hard
#     enforcement.
#
# If the runner does not exist, this hook is a silent no-op — Local DevOps
# may not have wired it yet.

set -u

PAYLOAD="$(cat 2>/dev/null || true)"

# Extract the file path. Edit and Write tools both pass it as
# tool_input.file_path.
FILE=""
if command -v jq >/dev/null 2>&1; then
  FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
fi
[[ -z "$FILE" ]] && exit 0
[[ ! -f "$FILE" ]] && exit 0

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
RUNNER="$ROOT/.claude/lint-format-runner.sh"

if [[ ! -x "$RUNNER" ]]; then
  exit 0
fi

# Run the project-specific runner. Suppress stdout (we don't want
# noise on every tool call); let stderr pass through so real failures
# surface.
"$RUNNER" "$FILE" >/dev/null 2>&1 || true
exit 0
