---
name: golem-agent-notes
description: When to write a learned note vs. update CONTEXT/ARCH/conventions vs. say nothing. Use when about to record a discovery, gotcha, or assumption that future agents will need.
expects:
  - The project's docs/agent-notes/ directory exists.
  - Read access to CONTEXT.md, docs/ARCH.md, docs/conventions/, docs/adr/.
produces:
  - Either a new note at docs/agent-notes/<slug>.md, or a write to a normative doc, or no artefact (when the discovery doesn't earn one).
category: substrate
---

# golem-agent-notes

Agent-notes are the project's holding area for things-we-learned that are not yet ready to be normative. They are short-lived by design — the Documentarian sweeps them and either promotes them or deletes them.

## Decision tree

Before writing, ask:

1. **Is this already in CONTEXT, ARCH, an ADR, or conventions?** → Update there. Do not write a note.
2. **Is this specific to one ticket and won't recur?** → Append to the ticket's hand-off log instead.
3. **Is this a TODO for future work?** → Create a tracker ticket instead.
4. **Is this a non-obvious gotcha, an emerging pattern, or an assumption to verify next time?** → Write a note.

If none of (4)'s three flavours fit, the discovery probably doesn't earn an artefact.

## When to write a note

- **Non-obvious gotcha.** "The Stripe SDK retries idempotently if you pass `idempotency_key`, but only on POST — PUT silently re-runs." Worth recording so the next agent doesn't re-discover it the hard way.
- **Emerging pattern.** "We've now hit two cases where async DB calls deadlock under load. Not yet a convention; flagging as a pattern."
- **Assumption to verify.** "Assumed Redis is single-node in dev; this works for now but breaks if dev moves to a cluster. Verify before relying."

## When NOT to write a note

- The fact already has a normative home — write there instead.
- It's a one-shot thing tied to one ticket — hand-off log.
- It's a vague "we should clean this up someday" — tracker ticket.
- It's just a summary of what you did — that goes in `golem-summarise-session`.

## File format

`docs/agent-notes/<slug>.md`. One concern per file. Keep slugs descriptive: `stripe-idempotency-only-on-post.md`, not `notes-1.md`.

```markdown
# <Topic>

**Last verified**: YYYY-MM-DD
**Verified by**: <agent name or "human">

<one-paragraph note. What did we learn? Where does it apply?
What's the gotcha or pattern? When does it bite?>
```

Short. Three to six sentences typically. If you find yourself writing more than a paragraph, the topic is probably ready for a normative doc — write the ADR or convention instead.

## Cross-referencing

Cross-reference normative docs by name (`see ARCH.md § Persistence`) or ADR number (`see ADR-0014`). Do not duplicate their content; the note's job is to point at where the real fact lives.

If the note refers to specific code, point at the file path: `src/api/webhooks.py`. Do not paste code blocks unless the snippet is the smallest unit of meaning.

## Promotion path

The Documentarian reads `docs/agent-notes/` on every sweep:

- A note that recurred across multiple sessions or proved load-bearing → promote into CONTEXT, ARCH, conventions, or a new ADR. **Source note is then deleted.**
- A note that's still one-off but seems sound → leave alone.
- A note older than ~30 days that has not recurred → flag for the user; likely stale.

You do not promote your own notes. The Documentarian owns promotion.

## Anti-patterns

- **Notes as TODO list.** Use the tracker.
- **Notes as substitute for ADR.** If the discovery changes the architecture, write the ADR.
- **One giant `notes.md`.** One concern per file. The Documentarian's sweep relies on per-file boundaries.
- **No `Last verified` date.** Without it, the Documentarian can't judge staleness.

## When this skill is wrong

- You're recording session-end summary — use `golem-summarise-session` and write to `journal/summary.jsonl` instead.
- You're documenting a decision you made — write an ADR.
- You're capturing how the codebase is laid out — update `docs/repo-map.md`.
