---
name: tracker
description: The tracker MCP tools and model — three doc types (spec/task/doc), the single state lifecycle, bodies, comments and anchoring. Read before creating, updating, or commenting tickets.
---
<!-- GENERATED: skills/tracker/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Tracker

The tracker is THE source of truth for work. The dashboard owns the SQLite DB; agents use the
MCP tracker tools or dashboard REST, never direct writes.

## Tools

| Tool | Use |
|---|---|
| `ticket_list({mine:true})` | find work assigned to you; filters: state, kind, assignee, project |
| `ticket_get({id})` | full read: body, comments, children, events |
| `ticket_create({title, kind, body, parent_id?})` | new ticket; kind defaults to `task`; fill the kind's template |
| `ticket_update({id, ...})` | metadata and state; `body` replaces the WHOLE body — read first, rewrite in full, preserve the sections you are not changing |
| `ticket_comment({id, body, ...})` | progress and evidence; anchor with quote/prefix/suffix/section |
| `ticket_comment_update` | resolve/reopen or edit a comment |
| `ticket_comment_reply` | thread a reply under a comment |
| `ticket_dispatch`, `sessions_dispatchable` | team transport and discovery — defined in `golem:team-ops` |

## Operating guidelines

There are three doc types in the tracker:

| Kind | Is | Template |
|---|---|---|
| `spec` | the living design doc for a workstream | `templates/spec` |
| `task` | a unit of work — its body is the implementation plan | `templates/task` |
| `doc` | a supporting page: research, survey, comparison | `templates/doc` |

### Writing and maintaining

- Tasks and docs hang under their spec via `parent_id`; specs can also parent child specs. Other
  kinds don't typically have children.
- The body is a living document: fold agreements, decisions, and outcomes in at decision
  boundaries instead of letting them rot in chat or comments.
- Editing rewrites the whole body, so batch changes at boundaries rather than folding in every
  tiny change iteratively.

### Spec driven development

- Starts when the human asks you to create a spec, or dispatches/assigns a (possibly partial)
  one directly to you.
- Human interacts in chat => interact in chat first.
- Human drops a comment on the spec => respond via a comment on the spec, as well as in chat to
  maintain continuity and flexibility for him.
- In case of ambiguity, ask for clarification rather than making assumptions.
- Most often, the goal is to end up with a locked spec with full alignment.
- Over-engineering is as bad as doing it incorrectly.

#### Intermediate brainstorming with scratchpad

- Decisions live in the spec and only there — the canonical open/locked blocks of
  `templates/spec` § Decisions. An open block may carry one comparison diagram; the master
  table keeps the human reminded of what is closed and what awaits his attention.
- The scratchpad is for understanding, not decisions: ambient exploration, topology and
  ontology explainers, tangents and wild curiosities that exceed a single decision's frame. It
  exists so transient, intermediate, visual explanation never clutters the main spec.
- Scratchpad: a supporting `doc` child of the spec (`templates/doc`, scratchpad shape). Create
  it when the human asks, or when you see the need — ask first, never implicitly.
- One section per exploration thread. Explain visually, so the human can understand and decide
  deliberately. Insights feed the spec's decision blocks — context, options, rejected reasons —
  and a locked block links its exploration back via its Trail line.
- Expect a hybrid flow: the human comments on the spec, comments on the scratchpad, and speaks
  in chat. Keep his explicit directives in mind.
- Served threads stay in the scratchpad under collapsed sections, for reference. The transient
  material itself never moves into the spec — only the insights do.

### Implementation tasks

- After the spec is finalised, decompose it into manageable tasks — a single task for a small
  spec, more when the design warrants it.
- The trade-off: a single task is faster and low-overhead but leaves things non-working until it
  finishes; multiple tasks can each land in a working, verifiable state. Choose wisely. Rough
  guidance — decompose when:
  * boundaries don't overlap and the tasks can run in parallel;
  * the features are relatively independent and can land sequentially, each stage producing a
    working, verifiable state.
- Decomposition drives builder count: parallel tasks need parallel builders — the count call
  and its confirmation thresholds live in `golem:team-ops` § Spawning.

## Lifecycle of docs

One state field: `todo -> in_progress -> review -> done`, plus `blocked` and `archived`.

- Move state with `ticket_update({id, state})` at real boundaries; do not choreograph metadata.
- `review` means finished and awaiting the human's read.
- `blocked` always carries a reason naming what unblocks it.

## Bodies

- Markdown, plus fenced ```mermaid diagrams, GitHub admonitions (`> [!NOTE]`), and `<details>`
  collapsibles — leave a blank line after `</summary>` so inner markdown renders.
- Never start a body with an HTML tag; the renderer would treat the entire body as raw HTML.

## Comments

- Evidence over claims: the commands you ran and their real output.
- The human's comments may be dispatched to your session. Reply in that comment's thread or on
  the same block — that marks them addressed; the human resolves.
- Large reports go in a comment or a child `doc`. If a report exceeds 30 lines, create a child
  doc and keep the comment to a three-line summary plus a link to that doc. Events are durable
  audit history only: they do not wake sessions, and there is no subscription path.
- Secrets: values never enter a ticket, comment, or chat. Name the required key NAMES and a
  git-ignored target file; the human writes the values there directly.

## Hygiene

- Before going idle, sweep your assigned tickets to their true state.
- Stale assigned work is a defect: comment the current status and fix the state before starting
  new work.
