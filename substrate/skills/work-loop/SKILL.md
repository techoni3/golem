---
name: work-loop
description: Dispatcher loop for feature-sized or larger work — intake questions, spec-ready fan-out, tracker-ticket-driven execution, closing-brief review, and spec close-out. Read when starting a feature or multi-step build (not a chat answer or one-line fix).
---

# work-loop

For feature-sized+ work only. Skip intake entirely for chat answers and tiny fixes — just do + verify.

The **golem tracker** is the source of truth for the work — there is no PLAN.md.
Tickets are the unit of work; you create them, transition their state, and comment
milestones via the tracker MCP tools. Read `golem:tracker` for the tool contract.

## 1. Intake — ask via AskUserQuestion (2–4 questions), then proceed on defaults

- **Journey size** — confirm this is feature-sized+ (not a one-off fix).
- **Spec depth** — default: a one-paragraph PRD in the lead ticket's body (no separate spec doc).
- **Test budget** — default: 10–20 journey-level integration/e2e (see test-policy).
- **Gates wanted** — default: pre-merge gate only (no mid-phase approval gates).

## 2. Shape or finalise the spec before fan-out

For spec-led work (GOL-158), the spec body is the contract. Before finalising a
spec, run a readiness gate:

- **Clarify pass** — any underspecified behaviour becomes a `tag:'question'`
  comment on the spec, not a side ticket and not a hidden worker note.
- **Coverage check** — every Behaviour item maps to at least one planned work
  item; every Open Question is answered or explicitly deferred.
- Verdict is `PASS`, `CONCERNS`, or `FAIL`. `CONCERNS` moves the spec back to
  Shaped with notes on the spec. `FAIL` stops the fan-out.

Finalisation is a state transition after human sign-off (dashboard button) or an
explicit agent go-ahead in the spec thread. Do not infer sign-off from silence.

## 3. Lay down wave-grouped tickets in the tracker

Create one ticket per work item (`ticket_create`, kind `work-item`), in your current
project. Capture the journey context / PRD section in the lead ticket's `body`.
For spec fan-out, group all children under one stream and set `tickets.wave` on
each child: wave 1 for foundation work, wave N+1 only for work unblocked by wave
N. Do not dispatch wave N+1 until every wave N child is `done` or `archived`.
Reuse any pre-existing tickets the brief/dispatch already points at instead of
duplicating them.

When fan-out comes from a spec, extract the acceptance checklist for each child
from the parent spec's Behaviour section and preserve it in the child ticket or
its context notes. Spec-less fixes use the original brief as the checklist.

## 4. Execute — one item at a time

- Pick the next ticket; `ticket_update` it to `in_progress` (one in-progress per
  work-stream).
- If a mid-item blocker needs human input, write a `tag:'question'` comment on
  the **parent spec** in spec-level language. Do not create a human-assigned
  question ticket and do not bury the question only inside the work item.
- **Role-aware delegation preference** — before cross-session delegation, check
  `sessions_dispatchable` for same-project teammates: role, status,
  `pending_count`, and `current_in_progress_ticket`.
- Prefer a live teammate with the matching role when the work is separable;
  otherwise spawn the inline subagent that fits the work. Keep sensitive,
  ambiguous, or tightly-coupled work local.
- Typical handoffs: planner → researcher for web/codebase discovery; planner →
  builder for implementation; builder → ui-tester for UI verification;
  ui-tester files follow-up bug tickets with evidence.
- Same-project only. Never reassign tickets away from `human` autonomously.
  Delegated work of substance gets a child ticket so lineage is explicit and
  duplicate work is avoided.
- Spawn exactly ONE worker subagent (`model: opus`) for it. Prompt = the ticket id +
  its title/body + the names of relevant skills (e.g. test-policy, pr-conventions,
  verify-done, tracker).
- **Never two writer agents in the same repo concurrently** — serialize all writes.
  Read-only research may fan out in parallel.
- Prefer LSP for targeted symbol resolution (definitions, references,
  signatures) when available. Glob/Grep/Read remain the fallback; fallback is
  resilience, not a reason to skip LSP.
- On worker return, require a closing comment before the ticket advances to
  `review`. The closing brief MUST contain all four parts:
  1. What was done — prose plus commits/files changed.
  2. Acceptance checklist — copied from the parent spec Behaviour section at
     fan-out, or from the original brief for spec-less fixes; every item checked
     with mechanical evidence.
  3. Testing instructions for the human — exact commands, URLs, or clicks.
  4. Not-done/deferred — explicit, even when the answer is "nothing".
- Run `golem:verify-done` BEFORE advancing the ticket. Claims are not evidence,
  and a missing/incomplete closing brief means the ticket is not ready for
  `review`.
- If the item changed repo structure (module, entry point, invariant, data flow), read `golem:docs-maintenance` and update REPO-MAP.md before advancing the ticket — "no map trigger" is an acceptable recorded outcome.
- Then `ticket_update` the ticket to `review`/`done` (per your gate policy), and
  `ticket_comment` the mechanical evidence (commands + output).

## 5. Spec close-out and retrospective

For GOL-158 spec-led work, milestones are spec-close artifacts, not a mandatory
per-item journal step. When the spec closes, fill the auto-posted retrospective
comment with:

- What shipped — link or name accepted child tickets and their closing briefs.
- Lessons — concise process/product notes from execution.
- Proposed doc deltas — changes needed in `CLAUDE.md`, `AGENTS.md`,
  `REPO-MAP.md`, or `docs/claude/*`; apply the deltas that are in scope and
  leave explicit follow-ups for the rest.

The ticket thread remains the work record; the spec retrospective is the close
artifact the human reviews.
