---
name: golem-tracker-update
description: How to create, transition, and append to tickets in the project tracker. Use when filing a new ticket, moving one between states, or appending to its hand-off log.
expects:
  - Access to the golem tracker MCP tools (ticket_create, ticket_get, ticket_update, ticket_comment, ticket_list, ticket_dispatch).
  - Knowledge of the tracker schema: HTML bodies, states, kinds, labels, streams, parent_id.
  - For state transitions: authority to mutate state (only the orchestrator has this).
produces:
  - A new ticket row in the dashboard SQLite DB, or an updated ticket row.
  - Comments appended to a ticket's thread.
category: substrate
---

# golem-tracker-update

The tracker is the project's source of truth for work. It lives in the golem dashboard's SQLite database and is read/written through the tracker MCP tools. There is no `tracker/` directory in the project; the canonical ticket is a database row with an id like `TKT-0042`.

## State machine

```
todo → in_progress → review → done
            ↑         ↓
            └─ blocked ←┘
```

- **todo**: just landed. The orchestrator routes / refines / decomposes.
- **in_progress**: actively being worked. One in-progress ticket at a time per work-stream.
- **review**: verification passed; PR open; Code Reviewer to verdict.
- **blocked**: waiting on something. The hand-off thread records what.
- **done**: archived; final.

`done` is final. Reopening creates a *new* ticket linked back via `parent_id`.

## Authority

**Only the orchestrator mutates ticket state.** Other personas append comments; the orchestrator reads and decides the transition. This is load-bearing — without it, two personas can race the same ticket.

Anyone can:
- Create a ticket via `ticket_create`.
- Append a comment via `ticket_comment`.
- Read any ticket via `ticket_get` or list via `ticket_list`.

## Tracker tools

| Tool | Purpose |
|------|---------|
| `ticket_create({title, body, …})` | Create a ticket. The server assigns the id (`TKT-NNNN`). |
| `ticket_get({id})` | Read the full ticket: HTML body, comments, links. |
| `ticket_update({id, state, …})` | Patch fields; state transitions go through this. |
| `ticket_comment({id, body, …})` | Append a comment to the ticket thread. |
| `ticket_list({mine: true})` | List tickets assigned to you, or filter by state/kind/labels. |
| `ticket_dispatch({id, session_id})` | Hand a ticket to a live session. |
| `stream_create({name, mode})` / `stream_list` | Group related tickets into sequential or parallel streams. |

Tool shape is provided by the dashboard MCP channel; the session and project are injected for you.

## Ticket schema

- **id**: `TKT-NNNN`, assigned by the server on `ticket_create`. Never reused.
- **kind**: `work-item | decision | spec | question | fix`.
- **state**: `todo | in_progress | review | blocked | done | archived`.
- **priority**: optional (`low`, `medium`, `high`, `critical`).
- **labels**: array of free-form strings. Use for grouping and filtering.
- **stream_id**: optional; groups tickets into a sequential or parallel stream.
- **parent_id**: optional; links sub-tickets to a parent.
- **assignee**: who is working it; stamped by dispatch or the orchestrator.
- **title**: short imperative.
- **body**: HTML using the html-report house style.

For the HTML body vocabulary, see `plugin/skills/tracker/SKILL.md` and `~/.claude/skills/html-report/SKILL.md`. Agent-authored bodies should start with an HTML tag; the server tolerates plain text and Markdown from humans, but agents should always send HTML.

## Procedure: create a ticket

1. Compose the title (short imperative) and body (HTML, html-report house style).
2. Choose `kind` and an initial `state` (usually `todo`).
3. Set `labels` and `priority` if the orchestrator's routing depends on them.
4. Call `ticket_create({title, body, kind, state, labels, priority, …})`.
5. Use the returned `id` as the canonical reference from then on.

The server assigns the id; do not attempt to pick or guess a `TKT-NNNN`.

## Procedure: transition a ticket

(Orchestrator only, unless the orchestrator has explicitly delegated a state change.)

1. Read the ticket with `ticket_get({id})`; confirm the comment thread supports the transition.
2. Call `ticket_update({id, state, actor})`. Always include `actor` so the event log records who moved it.
3. If transitioning to `blocked`, first append a `ticket_comment` explaining the blocker, then update state.
4. If the ticket is being assigned or dispatched, also call `ticket_dispatch({id, session_id})` or set `assignee`.

Forbidden transitions:
- `done → anything`. Reopen creates a new ticket.
- Skip-step transitions (e.g. `todo → review`). Each step is meaningful; do not bypass.

## Procedure: append a comment

Anyone with relevant context. No state change required.

1. Read the ticket thread with `ticket_get({id})`.
2. Call `ticket_comment({id, body, tag, …})`.

Comment body rules:
- Use HTML (html-report house style).
- Include mechanical evidence: commands you ran and their real output. Bare claims are not evidence.
- Use `tag` when the comment has a verdict: `confirmed`, `partial`, `disputed`, `fix`, `risk`, `question`, `note`.
- For an anchored comment on the body, include `quote`, `prefix`, `suffix`, `section`, and `section_id`.

## Procedure: decompose a ticket

For work too large for one ticket:

1. Create sub-tickets with `ticket_create({parent_id: '<parent-id>', …})`.
2. Optionally group them under a stream: `stream_create({name, mode})` returns a `stream_id`; pass it to each child `ticket_create`.
3. Update the parent ticket's body or add a comment listing the sub-ticket ids so the thread stays coherent.

## Procedure: create a stream

1. Call `stream_create({name, mode})` where `mode` is `sequential` or `parallel`.
2. Pass the returned `stream_id` to related `ticket_create` calls.
3. Sequential streams mean one child should be `in_progress` at a time; parallel streams allow multiple `in_progress` children.

## Anti-patterns

- **Guessing a ticket id.** Ids come from `ticket_create`; never synthesise `TKT-NNNN` yourself.
- **Mutating state without commenting.** The thread is the contract that lets the next persona pick up. Without a comment, the transition is unsafe.
- **Writing Markdown bodies as an agent.** Agent bodies should be HTML; use the html-report components.
- **Skip-step state transitions.** `todo → review` bypasses the in-progress signal.
- **Editing prior comments.** The thread is append-only; add a new comment if the picture changes.
- **Using labels as free prose.** Labels are for filtering; keep them short and consistent.

## When this skill is wrong

- You want to add a TODO to your future-self — append a comment on your current ticket or write to agent-notes; do not create a ticket as a personal reminder.
- You want to record a per-decision rationale — write an ADR.
- You want to record session-level intent / outcome — that's `golem-summarise-session` writing to `journal/summary.jsonl`.
