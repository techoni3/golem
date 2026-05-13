#!/usr/bin/env bash
#
# git-guardrails.sh — PreToolUse hook that blocks irrecoverable git operations.
#
# Reads the tool-use payload from stdin (Claude Code provides JSON describing
# the pending Bash command). Blocks the tool call if the command matches a
# destructive git pattern. Exit 2 = block; exit 0 = allow.
#
# Patterns blocked (per design v1 §7.4.1):
#   - force-push (push --force, push -f, push --force-with-lease)
#   - reset --hard
#   - clean -fd / clean -df
#   - branch -D
#   - checkout . / restore .
#   - commit --no-verify
#
# Lifted in spirit from mattpocock's git-guardrails-claude-code.

set -u

PAYLOAD="$(cat 2>/dev/null || true)"

CMD=""
if command -v jq >/dev/null 2>&1; then
  CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
fi

# If we couldn't read it, allow (don't block on parser failure).
[[ -z "$CMD" ]] && exit 0

# Pattern → human-readable reason.
block_reasons=(
  'git[[:space:]]+push[[:space:]]+.*--force(-with-lease)?[[:space:]]*$|force-push'
  'git[[:space:]]+push[[:space:]]+.*--force[[:space:]]+|force-push'
  'git[[:space:]]+push[[:space:]]+-f([[:space:]]|$)|force-push'
  'git[[:space:]]+reset[[:space:]]+.*--hard|hard-reset (destroys uncommitted work)'
  'git[[:space:]]+clean[[:space:]]+.*-f.*d|clean -fd (removes untracked files)'
  'git[[:space:]]+clean[[:space:]]+.*-d.*f|clean -df (removes untracked files)'
  'git[[:space:]]+branch[[:space:]]+-D[[:space:]]+|branch -D (force-delete)'
  'git[[:space:]]+checkout[[:space:]]+\.[[:space:]]*$|checkout . (discards working changes)'
  'git[[:space:]]+restore[[:space:]]+\.[[:space:]]*$|restore . (discards working changes)'
  'git[[:space:]]+commit[[:space:]]+.*--no-verify|commit --no-verify (skips hooks)'
)

for entry in "${block_reasons[@]}"; do
  pattern="${entry%%|*}"
  reason="${entry#*|}"
  if [[ "$CMD" =~ $pattern ]]; then
    cat <<EOF >&2
git-guardrails: blocked by golem.

Command: $CMD
Reason:  $reason

If this is genuinely intended, run it from your own shell (not via the agent),
or temporarily disable the hook in .claude/settings.local.json with explicit
reasoning recorded in the session.
EOF
    exit 2
  fi
done

exit 0
