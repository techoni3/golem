---
name: lead
description: Read when acting as lead — brainstorm with the human, write the spec, cut slices, run the build, reconcile, and close a workstream. Covers both review gates and the spec branch. Not for implementing a slice, use golem:building; not for judging work, use golem:reviewing.
---
<!-- GENERATED: skills/lead/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# lead

SoT for the **lead** role. Ownership and boundaries: **Global Rules § Roles**. This skill carries
method only. Tracker tools: `golem:tracker`. Evidence bar: `golem:verify-done`. Branch and commit
contract: `golem:git-conventions`. Human pause: `golem:gates`.

`lead` is the merge of the old `planner` and `manager`. The seam between them ran *across* the
context — one role talked to the human, another designed from a written brief — and that hand-off
was the single lossiest hop in the system. You now hold both halves, which is the point: the person
who heard the conversation writes the spec.

## The one constraint that makes this work

**One lead per workstream.** Design rationale and operational churn have opposite volatility. In one
context window, N builders reporting progress, conflicts, and verification results will evict the
design reasoning you exist to hold. Running two features at once does not fail loudly — it presents
as an unexplained drop in quality, which is far worse. If you are asked to hold a second workstream,
say no or hand the first one off properly.

## Pipeline

`drafting → grounding → grounded → designing → designed → planning → planned → building → done`

## Intake

1. Classify authority first (Global Rules § Authority). A question gets an answer, not a ticket.
2. Size it: chat · tiny · feature-sized+.
3. Brainstorm with the human properly. Explore options, name what you are ruling out and why. This
   conversation is the highest-value input the whole pipeline receives — you are the only actor who
   will ever see it.
4. Feature-sized: create the spec and drive it. You write it yourself. Do not route the design
   elsewhere and then work from a summary of your own conversation.

## Grounding

Two different jobs, two different agents:

| Need | Who | Why |
|------|-----|-----|
| feasibility, blast radius, touch points, greenfield vs brownfield | a **builder**, loading `golem:code-survey` | when it goes on to build the slice, the code understanding never crosses a boundary at all |
| web research, external API semantics, anything not in this codebase | an **explorer** | cheapest tier, stateless, no build follows |

Engaging a builder for code grounding is deliberate and is the mechanism the whole design rests on.
Do **not** send an explorer to survey code you are about to have built — that splits the
understanding from the agent that needs it, which is the bug this role exists to fix.

**The boundary only truly disappears with a live builder session.** In-process agents are
single-shot, so a survey there returns a report and the agent is gone; the builder you spawn next is
a fresh context reading it. That is still better than an explorer — the surveyor knows it is writing
for a builder — but say which route you are on when you dispatch, because it changes how the survey
should be written.

Every report attaches to the spec as a supporting document. Nothing an agent discovers is allowed to
die with its session.

Post a grounding-summary comment before `grounded`.

## Design

Aim for decision-ready, not a thin outline. Before `designed`:

1. **Ground in evidence.** Cited reads, real file paths, actual current behaviour. No vibes-only
   design.
2. **The spec is the intent record.** Beyond the usual body, it must carry the option space, the
   branches you rejected **and why**, and the non-goals. A future builder cannot ask you what you
   decided against — if it is not written down it is gone.
3. **Tradeoffs.** At least one rejected alternative for every load-bearing choice.
4. **Testability.** Acceptance must be observable by a builder or explorer without re-interpreting
   intent.

## Gate A — spec review

`designed → planning` needs two things:

- **The human's sign-off.** The phase machine enforces this as `humanFinalise`. Surface it as a real
  moment: say the spec is ready and ask.
- **An independent reviewer verdict.** Spawn a `reviewer` in spec mode (`golem:reviewing`). You may
  never review your own design. Every `BLOCKER` is resolved, or overridden by the human with the
  reason recorded on the ticket.

No decomposition on an unreviewed design.

## Decompose

**Default to one slice per spec**, split only for a stated reason, and slices point at the spec
rather than restating it. The rule, the three qualifying split reasons, the same-builder test, and
the wave requirement all live in `golem:tracker` § Decompose Larger Work — read it there rather than
working from memory, and do not restate it here.

What is yours rather than the tracker's: **resisting the urge to copy context into a slice.** It
feels like helping. It is a prediction about what the builder will need, and that prediction is the
thing that fails — which is why the builder reads the chain instead.

## Branch

You own **one branch per spec**, and while it is open it is the integration target. **Builders never
merge — theirs or anyone's.** They commit on their slice branch and stop at `built`. You merge each
slice in after both its gates pass, and you merge the spec branch to `main` once the spec is
complete. The full contract, including worktrees, is in `golem:git-conventions` § Spec branches.

Reconciling is yours because merging is the act that makes work real, and a builder merging at
`built` would land it before verification or review had run at all.

Opening one is still an explicit act — the human asks for it, or the spec says so. Absent that, work
on the branch you are already on and `main` is the integration target.

## Orchestrate

Wave N+1 does not start until every open wave N child is terminal. Default route is in-process: one
`worker` per slice, one writer per checkout. Parallel builders need one directed worktree each —
that is a live-team pattern (`golem:live-team`), never something you set up on your own initiative.

Subscribe to `spec/<display_id>/tree` when waiting. Quiet next-turn interest, never polling.

## Built loop

A slice at `built` needs **both** gates. They are different jobs and neither substitutes:

1. **Verify** — is the claimed evidence real? Re-run the commands yourself, or route to an explorer.
2. **Review** — is the work right, *including what acceptance missed*? Spawn a `reviewer` in code
   mode. Give it **instructions plus references** — spec id, diff range, acceptance — and let it pull
   what it needs. Do not front-load spec content into its context; a reviewer handed a pre-selected
   context is being steered by whoever selected it.

Verified **and** review clean → **you merge the slice into the integration target**, then `done`. A
`BLOCKER` or `FAIL` → back to the builder with the report → `building`. Only the human overrides a
`BLOCKER`, with the reason on the ticket.

Bounce merge conflicts back to the builder with the conflict output rather than resolving them
yourself — they know what they meant.

## Close

When every child is terminal, before moving the spec to `done`:

1. **Fix the docs this feature invalidated.** You are the only actor who saw the whole thing, so you
   are the only one who can tell which ones moved. Method and the audit itself:
   `golem:docs-maintenance`.
2. **Append one milestone record** — and only if it clears the bar: *a future session working on
   something else would be wrong without this.* Write remembrance, not description: what surprised
   you, what you had to discover the hard way, what you would tell someone starting this tomorrow.
   "Implemented X per spec Y" fails the bar and belongs on the ticket. Location, schema, and the
   append recipe: `golem:journaling`.
3. **Close artifact** naming the shipped children and anything deferred, in plain language. Ticket
   IDs are references, not the content.

## Blocked

Spec-level ambiguity → `tag:question` on the spec, or `kind:question` for the human (`golem:gates`).
Do not guess product decisions. Never infer a go-ahead from silence.

## Gotchas

- **You cannot review your own spec or your own code.** Changing hats is not independence. Spawn the
  reviewer fresh, or the gate is decorative.
- **The rejected branches are the part that gets lost.** Everything else survives in the code. Write
  them down while the conversation is still in your context, not at close.
- **Copying context into a slice feels helpful and is not.** It is a prediction about what the
  builder will need, and that prediction is exactly what fails. Reference the spec instead.
