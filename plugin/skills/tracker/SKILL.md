---
name: tracker
description: The golem cross-project ticket tracker is THE source of truth for work — not PLAN.md. Read when picking up a dispatched/assigned ticket, decomposing work into sub-tickets, raising a blocking question for the human, annotating a ticket body, or transitioning ticket state. Tools are MCP (ticket_list/get/create/update/comment/comment_update/comment_reply/dispatch, stream_create/list, sessions_dispatchable).
---

# tracker

The tracker is THE source of truth for work — it **replaces PLAN.md**. The
dashboard owns the SQLite DB (single writer); you read/write it through the
golem channel MCP tools below. Your session id and project are injected for you,
so you rarely pass ids.

Agents: send HTML. The server tolerates plain text and markdown for human
authors, but you (the agent) should always send a body that starts with an HTML
tag.

```html
<header class="hero">
  <div class="kicker">Workstream · category</div>
  <h1>Headline goes here<span class="l2">with an accent line.</span></h1>
  <p class="blurb">Single paragraph summarising the ticket. One or two sentences is plenty.</p>
</header>

<section>
  <div class="kicker">01 — Context</div>
  <h2>Why this matters</h2>
  <p class="lead">A one-paragraph thesis that the rest of the section supports.</p>
  <p>Body paragraph. Use additional paragraphs, lists, or tables as needed.</p>
  <div class="note"><div class="h">Default callout</div><p>Use .note for neutral, .note.no for risks, .note.go for wins, .note.solid for summaries.</p></div>
</section>

<section>
  <div class="kicker">02 — Acceptance</div>
  <h2>What done looks like</h2>
  <ul>
    <li>First concrete outcome.</li>
    <li>Second concrete outcome.</li>
  </ul>
</section>
```

Full vocabulary: see the `html-report` skill (SKILL.md and template.html at
`~/.claude/skills/html-report/`). The dashboard's `.td-html-body` CSS already
styles hero, kicker, h2, p.lead, .note, .card, .statgrid, .profile, .quote,
.badge, table, inline SVG — copy any of those class names from the html-report
template and they will render correctly.

If the `html-report` skill isn't loaded in this session, request it (e.g. via
the Skill tool) so you can see the full template and component list.

| Tool | Use |
|------|-----|
| `ticket_list({mine:true})` | find work assigned to YOU |
| `ticket_get({id})` | read a ticket: HTML body, anchored comments, thread, history |
| `ticket_create({title, body, …})` | create a ticket (defaults to your project; you = created_by) |
| `ticket_update({id, state})` | transition state / patch fields (you = actor) |
| `ticket_comment({id, body, …})` | progress note with mechanical evidence (you = author) |
| `ticket_comment_update({id, comment_id, body, tag, status})` | edit a comment or mark it resolved/open |
| `ticket_comment_reply({id, comment_id, body})` | thread a reply under an existing comment |
| `ticket_dispatch({id, session_id})` | hand a ticket to a live session |
| `stream_create / stream_list` | group tickets (mode sequential\|parallel) |
| `sessions_dispatchable` | live sessions that can receive a dispatch |

Kinds: `work-item | decision | spec | question | fix`.
States: `todo → in_progress → review → done` (or `blocked`, `archived`).

Comment tags: `confirmed | partial | disputed | fix | risk | question | note`.
Comment status: `open | resolved`.

## Flow on a brief / dispatch

1. **Find your work** — `ticket_list({mine:true})`, or the ticket id named in the
   dispatch brief. `ticket_get` it to read the full HTML body + thread.
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
- The human answers via a comment on that ticket. **Resume** by re-reading it
  with `ticket_get`; act on the answer and continue.

## Annotating the HTML body

Inline comments on the ticket body share the same `comments` table as thread
comments. To anchor a comment to a selection in the HTML body, include:

- `quote`: the exact selected text.
- `prefix`/`suffix`: a short text snippet immediately before and after the quote
  (helps disambiguate repeated phrases).
- `section` / `section_id`: optional heading or id of the section containing the
  selection.
- `tag`: what kind of annotation it is (`confirmed`, `partial`, `disputed`,
  `fix`, `risk`, `question`, `note`).

Plain thread comments leave these anchor fields empty.

## Discipline

- One in-progress ticket at a time per work-stream.
- Verify before `done` — cross-ref `golem:verify-done`.
- Comment milestones (cross-ref `golem:journaling` for the central journal; the
  ticket thread is the work record, the journal is the mechanical trail).
