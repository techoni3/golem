---
name: tracker
description: The golem cross-project ticket tracker is THE source of truth for work — not PLAN.md. Read when picking up a dispatched/assigned ticket, decomposing work into sub-tickets, raising a blocking question for the human, or transitioning ticket state. Tools are MCP (ticket_list/get/create/update/comment/dispatch, stream_create/list, sessions_dispatchable).
---

# tracker

The tracker is THE source of truth for work — it **replaces PLAN.md**. The
dashboard owns the SQLite DB (single writer); you read/write it through the
golem channel MCP tools below. Your session id and project are injected for you,
so you rarely pass ids.

| Tool | Use |
|------|-----|
| `ticket_list({mine:true})` | find work assigned to YOU |
| `ticket_get({id})` | read a ticket: body, comments, links, history |
| `ticket_create({title, …})` | create a ticket (defaults to your project; you = created_by) |
| `ticket_update({id, state})` | transition state / patch fields (you = actor) |
| `ticket_comment({id, body})` | progress note with mechanical evidence (you = author) |
| `ticket_dispatch({id, session_id})` | hand a ticket to a live session |
| `stream_create / stream_list` | group tickets (mode sequential\|parallel) |
| `sessions_dispatchable` | live sessions that can receive a dispatch |

Kinds: `work-item | decision | spec | question | fix`.
States: `todo → in_progress → review → done` (or `blocked`, `archived`).

## Flow on a brief / dispatch

1. **Find your work** — `ticket_list({mine:true})`, or the ticket id named in the
   dispatch brief. `ticket_get` it to read the full body + thread.
2. **Claim it** — `ticket_update({id, state:'in_progress'})`. One in-progress
   ticket at a time per work-stream.
3. **Do the work**, then `ticket_comment` progress with MECHANICAL evidence
   (commands you ran + their real output), never bare claims.
4. **Verify, then advance** — run the relevant checks (`golem:verify-done`)
   BEFORE moving to `review`/`done`. A claim is not evidence.

## Decompose larger work

- Break it into sub-tickets: `ticket_create({parent_id:'<id>', …})`.
- Optionally group them: `stream_create({name, mode})` then create the children
  with that `stream_id`. `sequential` = one in-progress at a time; `parallel` =
  independent sub-work.

## Blocking question for the human

- `ticket_create({kind:'question', assignee:'human', title, body})`, then **pause
  that thread** — do not guess past the blocker.
- The human answers via a comment on that ticket. **Resume** by re-reading it with
  `ticket_get`; act on the answer and continue.

## Discipline

- One in-progress ticket at a time per work-stream.
- Verify before `done` — cross-ref `golem:verify-done`.
- Comment milestones (cross-ref `golem:journaling` for the central journal; the
  ticket thread is the work record, the journal is the mechanical trail).
