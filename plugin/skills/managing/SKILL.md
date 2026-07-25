---
name: managing
description: Read when acting as manager — intake, grounding, routing, review and verification routing, reconcile, and close. Not for design or implementation.
---
<!-- GENERATED: skills/managing/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# managing

Method for the **manager** role. Tool contracts: `golem:tracker`. Evidence bar:
`golem:verify-done`. Live-peer dispatch is opt-in and lives in `golem:live-team`.

## Scope

Ownership and boundaries: **Global Rules § Roles**. This skill carries method only.

## Intake

1. Classify authority first (Global Rules § Authority). A question gets an answer, not a ticket.
2. Size the ask: chat · tiny · feature-sized+.
3. Feature-sized: create or reuse a tracker ticket/spec and leave an acceptance checklist.
4. Do **not** write the design yourself. Route it: a live planner only if the user asked for a
   live hand-off (`golem:live-team`); otherwise load `golem:planning` and act as planner for
   that step, or hand the design to an in-process agent with planning instructions.

## Grounding

For specs, drive `drafting → grounding → grounded` with a grounding-summary comment. Route
discovery to an in-process `researcher` (or a live explorer under `golem:live-team`).

## Distribution

When the spec is `planned`, its children are already scoped and sequenced by wave. Wave N+1
does not start until every open wave N child is terminal.

Default route is in-process: one `worker` per child, one at a time in this checkout. Parallel
builders require one directed worktree each — that is a live-team pattern
(`golem:live-team` + `golem:git-conventions`), never something you set up on your own initiative.

Subscribe to `spec/<display_id>/tree` when you are waiting on a hand-off. Quiet next-turn
interest — never poll.

## Built event loop

When a child reaches `built`, it needs **both** gates before it can close. They are different
jobs and neither substitutes for the other:

1. **Verify** — is the claimed evidence real? Re-run the commands yourself or route to an
   in-process `researcher`. Move to `verifying` with evidence naming the verifier.
2. **Review** — is the work right, *including what acceptance missed*? Route to an in-process
   `reviewer` in code mode (`golem:reviewing`). You are never the reviewer of record for work
   you routed.
3. Verified **and** review clean → `done`. A `BLOCKER` finding or a `FAIL` → back to the
   builder with the report → `building`. A `BLOCKER` may only be overridden by the human, with
   the reason recorded on the ticket.

## Reconcile

Only for worktree branches you orchestrated, and only after both gates pass. Serialise one
branch at a time on main; bounce conflicts back to the builder rather than resolving them
yourself. Full lifecycle: `golem:git-conventions`.

## Closure

When all children are terminal, move the spec to `done`. The close artifact names the shipped
children and any deferred work, in plain language — ticket IDs are references, not the content.
