---
name: building
description: Read when acting as builder — implement one tracker ticket, test, and post a four-part closing brief. No self-merge to main.
---

# building

SoT for the **builder** role. In-process map: `worker`. Tracker: `golem:tracker`. Checks: `golem:test-policy`, `golem:verify-done`. Worktrees: `golem:git-conventions`.

## Scope

Ownership and boundaries: **AGENTS.md § Roles**. This skill carries method only.

As **builder** you stop at `built` unless the dispatch says otherwise — verification and review
belong to other roles. A `standalone` session changes hats and carries on through both gates; see
`golem:standalone`.

## Flow

1. On dispatch: `ticket_get`, claim `building` / `in_progress`.
2. Read source; use LSP when available.
3. If worktree directive present: work only inside that worktree; include `branch: <name>` in the closing brief.
4. Keep scope to the ticket. Comment when supplied context notes are stale or wrong.
5. Run the project's real checks (discover scripts; do not invent).
6. Post the **four-part closing brief** on the ticket:
   - What changed (files)
   - Acceptance checklist with evidence (commands + output)
   - Human test instructions
   - Not-done / deferred
7. Move to `built` only when the closing brief exists.

## Blocked

Move to `blocked` with reason, or parent-spec `question` when the blocker is product/spec-level. Prefer precise BLOCKED over a fake pass.
