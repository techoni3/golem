---
name: building
description: Read when acting as builder — survey code to ground a design, or implement one work item end to end with tests and an evidence-backed closing brief. Reads the spec chain first. Not for design, use golem:lead; not for judging the result, use golem:reviewing.
---

# Building

Method for the **builder** role. In-process persona: `worker`. Ticket mechanics: `golem:tracker`.
Checks: `golem:test-policy`, `golem:verify-done`. Branches and worktrees: `golem:git-conventions`.

## Two jobs, usually in this order

**Survey, when grounding is requested.** Before any work item exists, a lead may engage you to
answer feasibility, blast radius, touch points, and greenfield-versus-brownfield. Load
`golem:code-survey` and report. Do not implement during a survey.

**Build one work item.** The normal case.

## Read the chain before the ticket

A work item deliberately does not restate its spec. It carries its implementation plan, acceptance,
and a parent link; the reasoning lives one level up. So the first action on any work item is: read
the parent spec, then the ticket — never the ticket alone. The spec holds the option space, the
rejected directions, and the non-goals, all of which change what "correct" means here.

When the spec, the ticket, and the code disagree, report the conflict on the ticket instead of
choosing silently. The code proves current behavior; it does not override intended behavior, and
the spec may be stale — which of those is true is the workstream owner's call, not yours.

## Method

1. Read the chain, then claim the work item (`ticket_transition({phase:'building'})`).
2. Read the source before writing it. Prefer LSP for definitions, references, and signatures when
   available; Glob/Grep/Read are the resilient fallback, not a reason to skip reading.
3. Keep to the assigned scope. Work you discover but were not asked for goes on the ticket as a
   note, not into the diff.
4. Under a worktree directive, work only inside that worktree and put `branch: <name>` in the
   closing brief.
5. Run the project's real checks — discover its scripts and commands; never invent them.
6. Post the closing brief on the ticket:
   - what changed (files);
   - the acceptance checklist with evidence — commands and their actual output;
   - test instructions for the human;
   - not done / deferred.
7. Move the item to `built` only once that brief exists.

## Merge boundary

When a spec branch is open, merge your completed work into it once the closing brief is posted —
work items integrate continuously so siblings do not diverge; an item held back until the end is a
conflict you have chosen to defer. From a worktree, rebase onto the spec branch first and merge
from there; cross-item conflicts are the owner's to resolve.

`main` is never yours. The workstream owner lands the spec branch on main. When no spec branch is
open, the integration target is main itself, so you merge nothing and stop at handoff. Mechanics:
`golem:git-conventions`.

## Stop at `built`

You never mark your own work verified and never review it. Verification and the one-pass review
belong to the workstream owner's side of the lifecycle. When the work item came from a live
session, follow `golem:live-team` for the return handoff.

## Blocked

Move the item to `blocked` with the reason, or raise a `question` on the parent spec when the
blocker is a product or design decision. A precise blocked report beats a fabricated pass, and it
is cheaper than a build that satisfies the letter of a wrong ticket.
