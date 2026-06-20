#!/usr/bin/env bash
# SessionStart hook — inject the golem tracker working-model into the session so
# agents register/track their work as tickets BY DEFAULT (skills are opt-in; a
# fresh session has the ticket_* MCP tools but no standing instruction to use
# them). Emits a SessionStart `additionalContext` JSON. Pure printf (no node/sed)
# so it can never break session start; on any failure it simply emits nothing.
#
# The text is single-quoted; `\n` stays literal (valid JSON newline escapes) and
# there are no double-quotes in the body, so the JSON needs no further escaping.

set -euo pipefail

ctx='Golem session — the golem cross-project TRACKER is where work lives (not PLAN.md, not an ad-hoc todo). You have MCP tools: ticket_list/get/create/update/comment/dispatch, stream_create/list, sessions_dispatchable. The dashboard owns the DB and must be running (golem dashboard).\n\nWorking model — keep the tracker in sync AS YOU PLAN AND WORK on feature-sized or larger requests; do not wait to be told:\n- On a brief or dispatch: ticket_list(mine:true) or the ticket id named in the brief, then ticket_get it, then ticket_update to in_progress.\n- As you plan: ticket_create one ticket per work-item (decompose with parent_id; group related work with stream_create, mode sequential or parallel).\n- As you work: ticket_comment progress with mechanical evidence (commands + real output), and advance state in_progress -> review -> done (or blocked when stuck).\n- Blocking question for the human: ticket_create with kind:question and assignee:human, then pause that thread until they answer via a comment.\nSkip all of this for trivial questions or one-line fixes. If a ticket tool reports the dashboard is unreachable, note it and proceed without blocking. Full flow: the golem:tracker skill.'

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx" 2>/dev/null || true
