---
name: tracker
description: Read when picking up a dispatched or assigned ticket, decomposing work into work items, transitioning phase, or blocking on a human answer. Covers the MCP ticket tools and the phase model. The tracker is the source of truth, not PLAN.md. Cross-session messaging lives in golem:live-team.
---

# Tracker

The tracker is THE source of truth for work. The dashboard owns the SQLite DB; agents use MCP
tracker tools or dashboard REST, never direct writes.
Tickets store Markdown bodies and comments. Use the genre template that matches the kind:
`work-item -> feature`, `fix -> bug`, `spec -> spec`, `decision -> decision`.

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

The server derives board state from phase and enforces transition artifacts. If a transition
fails, add the required comment or evidence, or stay put.

Prefer `ticket_transition({id, phase, reason?, skip_reason?})` over `ticket_update({state})` for
every lifecycle move. Legacy state cannot express `verifying` or `verified` — `built`,
`verifying`, and `verified` all collapse to `review`, so state-based lifecycle writes are lossy.

## Flow on a brief or dispatch

1. Find the ticket: `ticket_list({mine:true})` or `ticket_get` the id named in the brief.
2. Builders claim dispatched work with `ticket_transition({phase:'building'})` and move to
   `built` only after posting the closing brief.
3. Close by route. **Delegated**: the owner moves `built -> verifying` (the server requires the
   dispatch record naming the verifier); the verifier posts its PASS/FAIL report and moves
   `verifying -> verified` or `-> rejected`; the owner moves `verified -> done`. **In-session**
   (no dispatch): verify the evidence yourself (`golem:verify-done`), then move
   `built -> done` with a `skip_reason` recording that self-verification — the `verifying` lane
   is reserved for dispatched verifiers.
4. Comment milestones with mechanical evidence: commands and real output, not claims.
5. For a live handoff or return, follow `golem:live-team`.

## Event ledger

Ticket mutations emit tracker events on `ticket/<display_id>`; child mutations mirror to
`spec/<parent-display-id>/tree`. Events are durable audit history. They do not wake sessions, and
there is no subscription or passive-delta delivery path. Use ticket comments for large reports;
the recipient fetches them with `ticket_get`.

## The spec is the intent record

A spec carries more than the plan: the option space, the directions that were rejected **and
why**, and the non-goals. Those are the parts that cannot be recovered later — everything else
eventually shows up in the code. Write them while the conversation is still live.

Supporting documents attach to the spec. Every code survey, research report, and finding lands
there, so a work item can point at work it did not commission and nothing an agent discovered
dies with its session.

## Decompose larger work

**Default to one work item per spec.** Split only for a reason stated on the ticket, and only
these qualify:

- a genuine wave dependency — B cannot start until A lands;
- parallelism you will actually use;
- a surface boundary needing different hands or a different skill.

**Never split to make tickets smaller or clearer.** That instinct turns a medium spec into eight
tickets, and every extra work item is another cold start for whoever picks it up. The test: if
two work items would go to the same builder one after the other, they should have been one.

**Work items point; they do not restate.** Each child carries its implementation plan, its
acceptance, its non-goals, and a link to the parent — not a copy of the parent's reasoning. The
builder reads the chain instead.

- Create children with `parent_id` and group them with a stream when useful.
- **Every child needs a `wave`, including the only one — start at 1.** `planning -> planned` is
  rejected without waves. Wave N+1 must not start until every open wave N child is terminal.
- Give each child a checkable acceptance list of its own, derived from the parent's behavior
  items.

## Blocked on the human

When work needs an answer, approval, or credential that only the human can give:

- Ask directly in chat when the human is present.
- Otherwise create a `kind:question` ticket assigned to `human`, stating in plain language what
  is blocked, the exact decision or input needed, and what resumes after the answer. For
  spec-level design ambiguity, prefer a `tag:'question'` comment on the parent spec so the
  design thread stays coherent.
- Mark only the affected work `blocked` and continue other authorized work.
- **Secrets:** the question names the required key NAMES and the git-ignored target file. The
  human writes VALUES into that file directly; secret values never enter a ticket, comment,
  chat, or journal. After the answer, verify each required key is present and non-empty without
  echoing values.
- The dashboard notifies your session when the human resolves the question; resuming does not
  require polling.
- Do not guess past a missing credential, approval, or product decision.

## GitHub bridge

Specs may link to a GitHub issue; work items never leave golem. GitHub is touched at exactly two
moments — ingest and spec close. No daemon, no background sync.

**Precondition**: the project's `origin` remote is a GitHub repo; otherwise skip entirely.

- **Link**: `source_ref: "github:<owner>/<repo>#<N>"` on the spec, set at creation. Agent tools
  cannot rewrite it afterwards; a wrong ref needs the human (REST `PATCH /api/tickets/:id`).
- **GitHub-origin**: the ingested issue seeds the brief and the spec MUST carry the source_ref.
  The issue stays open and untouched while the spec is in flight. At spec close: post the spec's
  high-level content (design and outcome) as an issue comment, then close the issue with the
  spec (`gh`).
- **Golem-origin** (no source_ref): at spec close, create the replica issue with the same
  high-level content, then close it immediately — a durable record for collaborators, not a work
  item.
- **Append-only on pre-existing issues**: never edit a title or body you did not author.
- The spec's closing artifact records the issue URL as evidence.

## Body annotations

Inline comments use the same comments table as thread comments. The UI assigns rendered blocks a
`block_id`; agents usually write clear Markdown and let the dashboard handle anchoring. If
anchoring via MCP, provide `quote`, optional `prefix`/`suffix`, `section`, `section_id`, and
`tag`.

## State hygiene

- Keep at most one active in-progress ticket per writing stream.
- Before going idle, sweep assigned work. Advance finished work with `ticket_transition` to the
  correct phase; never use legacy `review`. Parked work gets a reason and moves to `blocked`, or
  is unassigned.
- Stale assigned work is a defect: comment current status and fix the state before starting new
  work.
