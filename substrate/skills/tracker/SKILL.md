---
name: tracker
description: Read when picking up a dispatched/assigned ticket, decomposing work into sub-tickets, raising a blocking question, or transitioning state. Covers MCP tool contracts (`ticket_list/get/create/update/comment/dispatch` + `sessions_dispatchable`) and the phases + streams + subscriptions model. The tracker is the source of truth, not PLAN.md.
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

## Flow On A Brief Or Dispatch

1. Find the ticket: `ticket_list({mine:true})` or `ticket_get` the id named in the brief.
2. Claim it: move to `in_progress`/`building` as appropriate. A dispatched ticket leaves `todo` immediately when work starts.
3. Subscribe when you are waiting on handoffs: use `ticket/<display_id>` for one ticket or `spec/<display_id>/tree` for a spec and its children. Subscription digests replace manual polling for long waits.
4. Do the work. Comment milestones with mechanical evidence: commands and real output, not claims.
5. Verify before advancing to `review`, `built`, `verified`, or `done`; read `golem:verify-done`.

## Bus Topics

- Ticket mutations emit tracker events on `ticket/<display_id>`.
- Child ticket mutations also mirror to `spec/<parent-display-id>/tree`.
- Hook/session events use lifecycle/activity/custom classes and are delivered only to subscriptions whose class filter matches.
- Default subscription classes are `tracker`, `lifecycle`, and `custom`; activity is opt-in to keep digests small.

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
- Before going idle, sweep assigned work. Finished work goes to `review`/`built`/`done`; parked work gets a reason and moves to `blocked`/`parked` or is unassigned.
- Stale assigned work is a defect: comment current status and fix the state before starting new work.
