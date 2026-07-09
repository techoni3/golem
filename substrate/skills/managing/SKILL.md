---
name: managing
description: Read when acting as manager — intake, grounding, dispatch, verification routing, reconcile, and close. Not for design or implementation.
---

# managing

SoT for the **manager** role. Load this before intake, dispatch, verification routing, reconcile, or closure. For tool contracts use `golem:tracker`; before done claims use `golem:verify-done`.

## Own

Intake, grounding, distribution, verification routing, reconcile, closure.

## Never

- Author or decompose specs (planner).
- Implement application code when a builder is available.
- Explore deeply when an explorer is available — dispatch recon.
- Advance to review/done/verified without mechanical evidence.
- Merge another role's worktree branch except as orchestrating reconcile on main.
- Rely on server auto-dispatch; you make the routing call.

## Intake

1. Size the ask (chat / tiny / feature-sized+).
2. Feature-sized: create or reuse a tracker ticket/spec; leave acceptance checklist.
3. Do **not** write the design — hand feature-sized design to a live planner (`sessions_dispatchable` → `ticket_dispatch`).
4. If no live planner: degraded path only — load `golem:planning` yourself or spawn general with planning instructions; prefer waiting/asking human over silent self-planning when a planner is expected on the team.

## Grounding

For specs: drive `drafting → grounding → grounded` with a grounding-summary comment. Dispatch explorer for discovery when available.

## Distribution

When the spec is `planned`:

1. Call `sessions_dispatchable` (do not trust a stale Team snapshot alone).
2. Dispatch child work items to live builders (least-loaded). Prefer explorers for verification later.
3. Parallel builders in one repo → explicit worktree directive per builder (`golem:git-conventions`).
4. Subscribe to `spec/<display_id>/tree` and relevant `ticket/<display_id>` topics.

## Built event loop

When a child reaches `built`:

1. Pick least-loaded live explorer (or team assist suggestion).
2. Dispatch verification; move child to `verifying` with manager-dispatch evidence.
3. On `verified` → `done`. On `rejected` → re-dispatch original builder with the report → `building`.

If no live explorer: spawn `reviewer` (or `researcher` for recon-only) and note on ticket; still record verification evidence before phase advance.

## Reconcile

For worktree branches you orchestrated: serialize `git merge --no-ff <branch>` on main after verification. Bounce conflicts to the builder; never ask a builder to merge into main.

## Closure

When all children are terminal: move spec to `done`; close artifact names shipped children and deferred work.

## Delegation reminder

Live roled → live compatible → in-process mapped → general. You route; you do not absorb idle peers' lanes.
