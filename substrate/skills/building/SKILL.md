---
name: building
description: Read when acting as builder — survey code to ground a design, implement one slice, test it, and post a four-part closing brief. Reads the spec chain before the ticket. Not for design, use golem:lead; not for judging the result, use golem:reviewing.
---

# building

SoT for the **builder** role. Ownership and boundaries: **Global Rules § Roles**. This skill carries
method only. In-process map: `worker`. Tracker: `golem:tracker`. Checks: `golem:test-policy`,
`golem:verify-done`. Branches and worktrees: `golem:git-conventions`.

## Two jobs, usually in this order

**Survey, when a lead asks for grounding.** Before any slice exists, a lead may engage you to answer
feasibility, blast radius, touch points, and greenfield-versus-brownfield. Load `golem:code-survey`
and report. You are asked rather than an explorer precisely because **you will build what you
surveyed** — the understanding never has to cross a boundary.

**Build one slice.** The normal case.

## Read the chain before the ticket

A slice deliberately does **not** restate its spec. It carries scope, acceptance, and a parent link,
and the reasoning lives one level up.

So the first action on any slice is: read the parent spec, then the ticket. Not the ticket alone.
The spec holds the option space, the branches that were rejected and why, and the non-goals — none
of which will be repeated for you, and all of which change what "correct" means here.

If the chain and the code disagree, **the code wins**. Comment on the ticket when supplied context
is stale, wrong, or missing; that comment is how the next slice gets a better ticket.

## Flow

1. Read the chain. Claim the slice: `ticket_transition({phase:'building'})`.
2. Read source before writing. Prefer LSP for definitions, references, and signatures when it is
   available; Glob/Grep/Read are the resilient fallback, not a reason to skip it.
3. Under a worktree directive, work only inside that worktree and put `branch: <name>` in the
   closing brief.
4. Keep to the slice. Scope you discover but were not asked for goes on the ticket as a note, not
   into the diff.
5. Run the project's **real** checks — discover the scripts, never invent them.
6. Post the four-part closing brief on the ticket:
   - What changed (files)
   - Acceptance checklist with evidence — commands and their actual output
   - Human test instructions
   - Not-done / deferred
7. Move to `built` only once that brief exists.

## Merging

Merge into the **integration target**, never into `main` directly. When the lead has a spec branch
open, that branch is the target; otherwise it is `main`. Full contract, including the worktree
lifecycle: `golem:git-conventions` § Spec branches.

You never merge your own work past that target, and you never mark it verified.

## Stop at `built`

Verification and review belong to other roles, and both must happen. A `standalone` session changes
hats and carries on through both gates itself — see `golem:standalone`.

## Blocked

Move to `blocked` with a reason, or raise a `question` on the parent spec when the blocker is
product- or design-level. A precise `BLOCKED` beats a fabricated pass every time, and it is cheaper
for everyone than a build that satisfies the letter of a wrong ticket.
