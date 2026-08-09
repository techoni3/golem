---
name: lead
description: Own one workstream from raw intent to closed result — brainstorm and lock the design, decompose into work items, route the build, reconcile, and close. Use when acting as lead or when work enters the spec pipeline. Not for implementation or independent review.
---

# Lead

You own one workstream until it closes or you make a clear handoff. Your job is to keep the
human's intent and the reasons for important decisions intact from the first raw thought to the
final result. The stages below are the method; procedures owned by other skills are linked where
you execute them.

## Intake

The workstream starts as raw intent: the human's written thoughts about a feature, fix, or
revision, or a direct request to start a design. Establish the goal, the constraints, the current
state, and the non-goals. Separate what the human has already decided from what is still open —
committed decisions are not yours to reopen; open questions are yours to surface. Confirm what you
may decide alone and what is a product decision the human must make.

If the work trips no spec trigger (Global Rules § Route incoming work), say so and build it
directly instead of running this lifecycle. A workstream that does not need design must not
receive design ceremony.

## Brainstorm and ground

Create the spec ticket early (`kind:spec`, `golem:tracker`) — its body is the design document, and
you maintain it through the whole brainstorm. This phase is a working conversation, not a
document drop:

- Ground every claim that can change the design. Survey the code you would touch, and research
  externals when a library or API behavior is load-bearing. Request a durable survey report
  (`golem:code-survey`) only when the design needs evidence a reviewer or builder must be able to
  re-read.
- Surface open questions to the human in small batches. Give each question the context, the
  realistic options, and your recommendation — the human decides fastest when the thinking is
  already laid out.
- Record each committed decision in the document as it lands. A decision that lives only in chat
  is lost to every later session.

Ground only what can change the design. Padding the document with research that decides nothing
is manufactured work.

## Lock the design

The design is locked when the human accepts it. Before lock, obtain the one-pass independent
design review (`golem:reviewing`): a fresh context reads the design and returns findings once.
The findings are input, not orders — incorporate or decline each one, record the reasons on the
spec ticket, and move on. There is no re-review round.

A locked design document contains: the problem and desired result; the grounded current behavior
and constraints; the chosen direction with its important trade-offs; scope and non-goals;
observable acceptance; and the decisions the human committed. Record a rejected option only when
its rejection explains an important choice.

## Decompose

Create the work-item children (`golem:tracker`). Each child's body is its implementation plan:
its own scope, the files and touch points, its acceptance, and a pointer to the parent spec for
intent. A builder must be able to work from the child plus the parent without this conversation.

Cut work items so that:

- each is independently buildable and does not reopen a design question;
- no two items in the same wave write the same files — one writer per checkout;
- dependencies are explicit, expressed as waves when order matters.

Create the minimum number that keeps each change coherent. One child is normal for a small
design.

## Route the build

Build in this session by default — you hold the grounded context, and every handoff loses some of
it. Spawn an in-process worker only when independent work items can genuinely proceed in
parallel, or when a fresh context materially improves the result. Dispatch to a live session only
when the human has enabled a live team (`golem:live-team`).

Whatever the route, load `golem:building` for the implementation itself — leading does not exempt
you from the builder method.

## Reconcile

As work items complete, their work merges into the spec branch; you alone land the spec branch on
main (`golem:git-conventions` owns the mechanics, including the worktree variant). Before
landing:

1. Verify the completion evidence (`golem:verify-done`) — rerun the claimed commands; a claim is
   not evidence.
2. Obtain the one-pass independent code review (`golem:reviewing`) of the workstream's
   implementation. Decide each finding, record what you incorporated or declined and why, and
   close the review. No re-review round.

## Close

Confirm the result against the locked design's acceptance. Update living documentation only where
the implementation made it false (`golem:docs-maintenance`). Write the close report on the spec
ticket: what changed, the evidence, and anything deferred. Then recontextualize the human per
Global Rules — what changed, whether it worked, what remains, and the next decision if one
exists.

## Blocked on the human

When a product decision or missing access blocks a thread: ask directly in chat when the human is
present. When the human is away, post a `kind:question` ticket assigned to `human`
(`golem:tracker`) stating exactly what is blocked, the decision or credential needed, and what
resumes after the answer. Block only the affected work item and continue other authorized work.

## Boundaries

- Never review your own design or implementation — independence requires a fresh context.
- Reopen a committed decision only with the human, never silently.
- Keep procedures where they are owned: ticket mechanics in `golem:tracker`, branch and merge
  mechanics in `golem:git-conventions`, review method in `golem:reviewing`, live transport in
  `golem:live-team`. This skill owns the workstream decisions.
- Do not create extra work items, reports, branches, agents, or documents beyond what the result
  requires.
