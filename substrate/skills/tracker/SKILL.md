---
name: tracker
description: Read when picking up a dispatched or assigned ticket, decomposing work into sub-tickets, or transitioning phase. Covers the MCP ticket tools and the phases, streams, and subscriptions model. The tracker is the source of truth, not PLAN.md. Cross-session dispatch lives in golem:live-team.
---

# tracker

The tracker is THE source of truth for work. The dashboard owns the SQLite DB; agents use MCP tracker tools or dashboard REST, never direct writes.

Tickets store Markdown bodies and comments. Use the genre template that matches the kind: `work-item -> feature`, `fix -> bug`, `spec -> spec`, `decision -> decision`, with `prd` and `brainstorm` as optional templates.

## Tools

| Tool | Use |
|------|-----|
| `ticket_list({mine:true})` | find work assigned to you |
| `ticket_get({id})` | read body, comments, links, children, events |
| `ticket_create({title, body, ...})` | create a ticket in the current project |
| `ticket_update({id, ...})` | patch fields or legacy state |
| `ticket_comment({id, body, ...})` | add progress/evidence/commentary |
| `ticket_comment_update` / `ticket_comment_reply` | resolve/edit/thread comments |
| `ticket_dispatch({id, session_id, when_idle})` | dispatch to a live session |
| `stream_create` / `stream_list` | group related tickets |
| `sessions_dispatchable` | inspect live sessions, roles, workload, pending queue |

Kinds: `work-item | decision | spec | question | fix`.

Legacy states: `todo -> in_progress -> review -> done`, plus `blocked` and `archived`.

Phase-backed workflow is canonical when `phase` is present:

- Specs: `drafting`, `grounding`, `grounded`, `designing`, `designed`, `planning`, `planned`, `building`, `done`, `parked`.
- Work items/fixes: `queued`, `building`, `blocked`, `built`, `verifying`, `verified`, `rejected`, `done`.
- Questions: `open`, `answered`, `closed`.
- Decisions: `open`, `decided`, `closed`.

The server derives board state from phase and enforces transition artifacts. If a transition fails, add the required comment/evidence or stay put.

Prefer `ticket_transition({id, phase, reason?, skip_reason?})` over `ticket_update({state})` for every lifecycle move. Legacy state cannot express `verifying` or `verified`: `built`, `verifying`, and `verified` all collapse to `review`, so state-based lifecycle writes are lossy. Session attempts to close with `ticket_update({state:'done'})` will be rejected once phase enforcement lands.

## Flow On A Brief Or Dispatch

1. Find the ticket: `ticket_list({mine:true})` or `ticket_get` the id named in the brief.
2. Builders claim dispatched implementation work with `ticket_transition({id, phase:'building'})`: `queued -> building`. After posting the four-part closing brief, they call `ticket_transition({id, phase:'built'})`: `building -> built`.
3. Managers route verification with `ticket_transition({id, phase:'verifying'})`: `built -> verifying`.
4. Verifiers do not claim. The manager has already set `verifying`; the explorer posts its PASS/FAIL report, then calls `ticket_transition({id, phase:'verified'})` for PASS or `ticket_transition({id, phase:'rejected'})` for FAIL. A verifier never writes legacy state.
5. Managers close verified work with `ticket_transition({id, phase:'done'})`: `verified -> done`.
6. Subscribe when you are waiting on handoffs: use `ticket/<display_id>` for one ticket or `spec/<display_id>/tree` for a spec and its children. This is quiet next-turn interest, not a wake-up: the four passive ticket deltas appear only on your next real user turn or actionable envelope.
7. Do the work. Comment milestones with mechanical evidence: commands and real output, not claims.
8. Verify before advancing to `built`, `verified`, `rejected`, or `done`; read `golem:verify-done`.

## Bus Topics

- Ticket mutations emit tracker events on `ticket/<display_id>`.
- Child ticket mutations also mirror to `spec/<parent-display-id>/tree`.
- Subscriptions preserve durable event history/cursors; normal delivery is disabled by default, so they never create a standalone model turn.
- Manual exact ticket/spec subscriptions contribute only passive phase, assignment, blocker, and result deltas. Activity/raw history is never injected into a prompt.

## Decompose Larger Work

- Create children with `parent_id` and group them with a stream when useful.
- Set `wave` for dependency order. Wave N+1 must not dispatch until every open wave N child is terminal.
- Copy the relevant acceptance checklist into each child.

## Blocking Human Input

- For ticket-local blockers, create a `question` ticket assigned to `human` and pause that thread.
- For spec-level ambiguity, prefer a `tag:'question'` comment on the parent spec so the design thread remains coherent.
- Do not guess past missing credentials, approvals, or product decisions.

## Body Annotations

Inline comments use the same comments table as thread comments. The UI assigns rendered blocks a `block_id`; agents usually write clear Markdown and let the dashboard handle anchoring. If anchoring via MCP, provide `quote`, optional `prefix`/`suffix`, `section`, `section_id`, and `tag`.

## State Hygiene

- Keep at most one active in-progress ticket per writing stream.
- Before going idle, sweep assigned work. Advance finished work with `ticket_transition({id, phase, reason?})` to the lane-appropriate phase (`built`, `verified`, or `done`); never use legacy `review`. Parked work gets a reason and transitions to `blocked`/`parked` or is unassigned.
- Stale assigned work is a defect: comment current status and fix the state before starting new work.
