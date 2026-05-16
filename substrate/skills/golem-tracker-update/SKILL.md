---
name: golem-tracker-update
description: How to create, transition, and append to tickets in the project tracker. Use when filing a new ticket, moving one between states, or appending to its hand-off log.
expects:
  - The project's tracker/ directory exists with state subdirectories.
  - Knowledge of the ticket schema (frontmatter + body sections).
  - For state transitions: authority to mutate state (only the orchestrator has this).
produces:
  - A new ticket file, or a moved/edited ticket file with updated frontmatter.
  - An optional regeneration of tracker/INDEX.md.
category: substrate
---

# golem-tracker-update

The tracker is the project's source of truth for work. One ticket = one markdown file. Filename: `tracker/<state>/<NNNN>-<kebab-slug>.md`.

## State machine

```
triage → open → in-progress → review → done
                   ↑              ↓
                   └─ blocked ←──┘
```

- **triage**: just landed. The orchestrator routes / refines / decomposes.
- **open**: ready to be picked up.
- **in-progress**: actively being worked.
- **review**: PR open; Code Reviewer to verdict.
- **blocked**: waiting on something. Hand-off log records what.
- **done**: archived; final.

`done` is final. Reopening creates a *new* ticket linked back via `parent_ticket`.

## Authority

**Only the orchestrator mutates ticket state.** Other personas append to the hand-off log; the orchestrator reads and decides the transition. This is load-bearing — without it, two personas can race the same ticket.

Anyone can:
- Create a ticket in `triage/` (the orchestrator processes from there).
- Append to a ticket's hand-off log.
- Read any ticket.

## Frontmatter schema

```yaml
---
id: TKT-NNNN                   # zero-padded, project-unique, never reused
title: "<short imperative>"    # quoted to allow colons
state: triage                  # one of: triage, open, in-progress, review, blocked, done
category: feature              # feature | fix | infra | docs | spike
created: YYYY-MM-DD
updated: YYYY-MM-DD            # update on every mutation
related_adrs: [ADR-0007]       # optional; list of ADR ids the ticket touches
parent_ticket: TKT-0040        # optional; for sub-tickets
assignee: <subagent_type or agent name>   # optional; who is working it. Stamped by the CEO on dispatch.
team: <team_name>                          # optional; set when dispatched to an agent team, else empty.
labels: [stripe, webhooks]     # optional; free-form tags
afk_safe: true                 # OK to run unattended in parallel via worktree
---
```

`afk_safe: false` only when the ticket touches an invariant or has a `parent_ticket` still in-progress. Default to `true`.

`assignee` and `team` are empty/absent while the ticket is unassigned (triage/open). When the CEO transitions a ticket to `in-progress`, it stamps `assignee` (and `team` if dispatched to an agent team); these are cleared or left as history on `done`.

## Body sections

```markdown
# <Title>

## Brief
Original brief (from the user or parent ticket). Verbatim.

## Acceptance criteria
What does done look like? Observable behaviour, not implementation hints.

## Hand-off log
Append-only. Each persona appends one entry on hand-off:
- Date & persona.
- What you did in one or two sentences.
- What you leave for the next persona.
- Pointers (PR link, ADR file, agent-note file, file paths).

## Diagnoser verdict (if fix ticket)
Filled by Diagnoser. Reproduction, root cause, classification (code | architecture | infra), suggested routing.
```

## Procedure: create a ticket

1. Pick the next free `TKT-NNNN` (look at `tracker/done/`, `tracker/open/`, etc., max id + 1).
2. Compose the slug: kebab-case, ≤6 words.
3. Write the file at `tracker/triage/<NNNN>-<slug>.md` with full frontmatter and body sections (acceptance can be `<TBD by orchestrator>` if filed by the user).
4. Update `tracker/INDEX.md` (or invoke the regeneration step).

Anyone can do this. The orchestrator handles routing from `triage/`.

## Procedure: transition a ticket

(Orchestrator only.)

1. Read the current ticket; confirm hand-off log supports the transition.
2. Update frontmatter: `state:` and `updated:`. If transitioning to `blocked`, append a "Reason: …" line to the hand-off log first.
3. **Move the file** with `git mv` from the current state directory into the new one. Filename stays the same; only the directory changes. Git tracks the rename, preserving history.
4. Regenerate `tracker/INDEX.md`.

Forbidden transitions:
- `done` → anything. Reopen creates a new ticket.
- Skip-step transitions (e.g. `triage → review`). Each step is meaningful; do not bypass.

## Procedure: append to hand-off log

Anyone with relevant context. No state change required.

1. Read the current hand-off log.
2. Append a new entry at the bottom in this shape:

   ```
   ### YYYY-MM-DD · <persona>
   Did X. Leaving Y for the next persona. <pointers>
   ```

3. Update `updated:` in frontmatter.

Do not edit prior entries. The log is append-only.

## Procedure: regenerate INDEX.md

Walk the state directories, count tickets per state, write a table per active state with id / title / category / updated. Footer line `Last regenerated: <ts>`. Never edit by hand.

## Anti-patterns

- **Editing INDEX.md directly.** It is generated. Edits are overwritten on next regeneration.
- **Mutating state without moving the file.** Frontmatter and directory must agree. If they disagree, treat the directory as authoritative and fix the frontmatter.
- **Skipping the hand-off log entry on transition.** The log is the contract that lets the next persona pick up. Without an entry, the transition is unsafe.
- **Reusing TKT-NNNN ids.** Once issued, never reused, even if the ticket was abandoned. Increment.
- **Renaming the slug after creation.** The id is the canonical reference; renaming the file makes git history harder to follow.

## When this skill is wrong

- You want to add a TODO to your future-self — append to a ticket or write to agent-notes; do not abuse triage as a TODO.
- You want to record a per-decision rationale — write an ADR.
- You want to record session-level intent / outcome — that's `golem-summarise-session` writing to `journal/summary.jsonl`.
