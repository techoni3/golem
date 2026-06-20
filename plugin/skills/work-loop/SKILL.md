---
name: work-loop
description: Dispatcher loop for feature-sized or larger work — intake questions, tracker-ticket-driven execution, one-opus-worker-per-item, verify-then-advance, milestone logging. Read when starting a feature or multi-step build (not a chat answer or one-line fix).
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

## 2. Lay down the tickets in the tracker

Create one ticket per work item (`ticket_create`, kind `work-item`), in your current
project. Capture the journey context / PRD section in the lead ticket's `body`. For a
larger build, group the items under a stream (`stream_create`, mode `sequential` so one
runs at a time) and create each child with that `stream_id`. Reuse any pre-existing
tickets the brief/dispatch already points at instead of duplicating them.

## 3. Execute — one item at a time

- Pick the next ticket; `ticket_update` it to `in_progress` (one in-progress per
  work-stream).
- Spawn exactly ONE worker subagent (`model: opus`) for it. Prompt = the ticket id +
  its title/body + the names of relevant skills (e.g. test-policy, pr-conventions,
  verify-done, tracker).
- **Never two writer agents in the same repo concurrently** — serialize all writes.
  Read-only research may fan out in parallel.
- On worker return, run `golem:verify-done` BEFORE advancing the ticket. Claims aren't
  evidence.
- Then `ticket_update` the ticket to `review`/`done` (per your gate policy), and
  `ticket_comment` the mechanical evidence (commands + output).

## 4. Milestone — per completed item

Append ONE journal line per the `golem:journaling` one-liner (`event:"milestone"`,
`text` = the ticket title), after the ticket reaches `done`. The ticket thread is the
work record; the journal is the mechanical trail.
