---
name: work-loop
description: Dispatcher loop for feature-sized or larger work — manager front door, phase-driven specs, role playbooks, tracker-ticket execution, verification routing, and close-out. Read when starting a feature or multi-step build (not a chat answer or one-line fix).
---
<!-- GENERATED: skills/work-loop/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# work-loop

For feature-sized+ work only. Skip intake entirely for chat answers and tiny fixes: do the change, verify it, and report evidence.

The golem tracker is the source of truth. Tickets carry both a board `state` and a workflow `phase`; the server derives state from phase for phase-backed tickets. Use `golem:tracker` for tool contracts and `golem:verify-done` before review/done.

## Shared Spine

1. Size the request. Feature-sized work gets a tracker ticket or spec; tiny work does not need ceremony.
2. Use a manager front door when available. The dashboard defaults new ticket dispatch to a live `manager` session; explicit user/session targets always override.
3. Subscribe before waiting. For long-running handoffs, subscribe to `ticket/<display_id>` or `spec/<display_id>/tree` instead of polling.
4. Keep one owner for each writing lane. Never run two writer agents in the same checkout concurrently; parallel builders require one orchestrator-directed worktree each. Read-only exploration may fan out.
5. Advance by phase, not vibes. If `transitionTicket` rejects a move, add the missing artifact or stay in the current phase.
6. Close every implementation with the four-part closing brief: what changed, acceptance checklist with evidence, human test instructions, and not-done/deferred.
7. Verify with mechanical evidence before moving to `review`, `built`, `verified`, `done`, or claiming closure.
8. If repo structure changed, read `golem:docs-maintenance` and update the map/doc in the same session.

## Phase Model

Specs: `drafting -> grounding -> grounded -> designing -> designed -> planning -> planned -> building -> done`, with `parked` as the blocked path.

Work items and fixes: `queued -> building -> built -> verifying -> verified -> done`; rejection routes `verifying -> rejected -> building`; blockers use `blocked -> building`.

Questions: `open -> answered -> closed`. Decisions: `open -> decided -> closed`.

## Manager Playbook

Own intake, grounding, distribution, verification routing, and closure.

- Intake: clarify only what blocks execution. Create or reuse a tracker ticket/spec and leave the acceptance checklist in the body.
- Grounding: for specs, drive `drafting -> grounding -> grounded` with a grounding-summary comment. Use explorer help for discovery.
- Distribution: when the spec is `planned`, dispatch child work items to live role-matching sessions from the team surface. Prefer least-loaded builders for implementation and explorers for verification.
- Worktree dispatches: when parallel builders are needed in one repo, include an explicit worktree directive per builder. This satisfies the branching gate; builders then follow `golem:worktrees`.
- Subscriptions: subscribe to `spec/<display_id>/tree` for child progress and to direct `ticket/<display_id>` topics when actively shepherding one item.
- Built event loop: when a child reaches `built`, pick the suggested explorer from the team surface (or the least-loaded live explorer), dispatch verification, and move the child to `verifying` with `managerDispatch` evidence.
- Verification close: on `verified`, move the child to `done`. On `rejected`, re-dispatch to the original builder with the verification report and move it to `building`.
- Reconcile: for worktree branches you orchestrated, serialize `git merge --no-ff <branch>` on the main checkout after verification. Bounce conflicts back to the builder; never ask a builder to merge into main.
- Closure: when all children are terminal, move the spec to `done` and ensure the auto-retro/close artifact names shipped child tickets and deferred work.
- Server assists are suggestions only. Do not rely on autonomous server-side dispatch; the manager makes the routing call.

## Planner Playbook

Own design and fan-out. Avoid repo write ownership when a builder is available. If acting as the orchestrator for worktree-based parallel work, you may reconcile finished branches on main; builders still never do.

- Shape the spec body as the contract: Intent, Behaviour, Decisions, Non-goals, Open questions.
- Before finalising, run a readiness gate: every Behaviour item maps to work, every Open Question is answered/deferred, and the verdict is `PASS`, `CONCERNS`, or `FAIL`.
- Move `grounded -> designing -> designed` only when the design comment exists and concerns are addressed.
- Human or explicit agent go-ahead is required for `designed -> planning`; do not infer sign-off from silence.
- Fan out one child ticket per work item, grouped in a stream. Set `wave` so wave N+1 waits for wave N terminal.
- Move the spec to `planned` only after children and waves exist; move to `building` when the first child starts.
- Preserve each child's acceptance checklist from the parent Behaviour section.

## Builder Playbook

Own implementation for assigned tickets.

- On dispatch, `ticket_get`, then move/confirm the item in `building`/`in_progress`.
- Read source before editing. Use LSP when available for definitions/references; Glob/Grep/Read are fallback.
- Keep changes scoped to the ticket. Do not edit unrelated lanes or dispatch-directive internals unless assigned.
- If the dispatch includes a worktree directive, follow `golem:worktrees`; edit only inside that worktree and include `branch: <name>` in the closing brief.
- If blocked, move to `blocked` with a reason or add a parent-spec `question` comment when the blocker is product/spec-level.
- Before handoff, post the four-part closing brief and run the relevant checks.
- Move to `built` only when the closing brief exists. The manager/explorer owns verification unless explicitly assigned otherwise.

## Explorer Playbook

Own recon and verification reports.

- For recon, return evidence: files, flows, observed behaviour, risks, and a recommended path. Do not implement unless reassigned.
- For verification, start from the builder closing brief and acceptance checklist. Re-run or inspect the claimed evidence yourself.
- Post a verification report that states `PASS` or `FAIL`, commands/clicks run, outputs observed, and any follow-up defects.
- PASS lets the manager move `verifying -> verified`; FAIL means `verifying -> rejected` with the report copied into the re-dispatch.

## Close-Out

For spec-led work, the ticket thread is the work record. The spec close artifact should include what shipped, accepted child tickets, lessons, doc deltas applied, and explicit follow-ups for deferred items.
