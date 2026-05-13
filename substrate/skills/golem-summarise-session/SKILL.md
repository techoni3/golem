---
name: golem-summarise-session
description: Append a one-line semantic summary of the just-finished session to journal/summary.jsonl. Use when ending a working session — the closing reflex every persona invokes as its final tool call before yielding control.
expects:
  - In-context memory of what was done in this session (intent, decisions, deviations).
  - Knowledge of the current session_id (from the hook context or environment).
  - The project's journal/ directory exists.
produces:
  - One JSON line appended to journal/summary.jsonl.
category: substrate
---

# golem-summarise-session

The closing reflex. Every persona invokes this as its **last** action before yielding control. Without it, the semantic journal silently goes blank for this session and the Documentarian only has the mechanical hook log to work from.

## When to invoke this skill

- Right before yielding control back to the orchestrator (CEO, TL).
- Right before ending the working session for any reason — even partial work, even abandoned work.
- Even if the work was trivial. The line is cheap; the missing line is expensive.

**This is non-skippable.** If the persona invoking this skill is uncertain whether to invoke it, it should invoke it.

## When this skill is wrong

- The session was a pure read with zero intent — no brief, no work, no decisions. (In practice this is rare; document it as `outcome: read-only` instead of skipping.)
- A previous reflex already appended the line for this session — check the last line of `journal/summary.jsonl`; if its `session_id` matches, do not append a second.

## The procedure

1. **Locate the journal file.** `journal/summary.jsonl` at the project root (the directory containing `CLAUDE.md`).

2. **Resolve the session_id.** Use the value from the current Claude Code session context. If unavailable, fall back to a synthetic `unknown-<UTC-timestamp>`.

3. **Compose one JSON object** matching this schema. Single line, no prettyprinting:

   ```json
   {
     "ts": "<ISO-8601 UTC timestamp>",
     "session_id": "<session id>",
     "cwd": "<project root path>",
     "recipe": "<one-token classification: bring-up | feature | fix | spec | review | infra | docs | spike | ad-hoc>",
     "brief": "<the user's brief or the ticket's brief, one sentence>",
     "path_chosen": "<one-line summary of the actual route taken>",
     "outcome": "shipped | blocked | abandoned | partial | read-only",
     "human_interventions": ["<list of points where the user intervened>"],
     "substrate_signals": ["<flags for the Meta-agent — drift, friction, missing-skill, etc.>"],
     "notes": "<free-form prose. What surprised us, what we'd do differently.>"
   }
   ```

4. **Append (do not overwrite).** Open the file in append mode and write the line followed by `\n`. Never rewrite existing lines.

5. **Verify the append.** `tail -n 1 journal/summary.jsonl` and confirm the just-written line is the last one.

## Field rules

- `recipe` — one token, no spaces. Classifies the session for Meta-agent pattern-matching across projects.
- `brief` — verbatim or near-verbatim from the user's brief or the ticket. One sentence. No editorial.
- `path_chosen` — one line. Which personas were invoked, in order, and where the work landed (e.g. "TL → Diagnoser → Engineer; PR #42 merged"). Not a transcript.
- `outcome` — strictly one of the listed values. If unsure between `partial` and `blocked`, use `blocked` if there's an external dependency; `partial` if the session simply ran out of scope.
- `human_interventions` — array of short strings. Empty array `[]` if none. Each entry is one phrase: "user redirected from X to Y", "user vetoed Stripe SDK choice", "user clarified ambiguous brief". This is the Meta-agent's friction signal — do not skip when interventions happened.
- `substrate_signals` — array of short strings the Meta-agent looks for: "missing-skill: golem-pgvector", "convention drift: tests living in /tests/ vs colocated", "persona friction: TL had to re-route after Engineer over-scoped". Empty array if nothing notable.
- `notes` — prose. Two to four sentences typically. Surprises, tradeoffs, "we'd do this differently next time" reflections.

## Anti-patterns

- **Writing it before the work is done.** This is the *last* tool call. If you write it then keep going, the next agent has stale signal.
- **Pretty-printing the JSON.** Multi-line JSON breaks the JSONL contract. One object, one line.
- **Empty or boilerplate `notes`.** "Did the work" is useless. The Meta-agent reads `notes` for pattern recognition; vague entries are noise.
- **Inventing `recipe` values.** Stick to the closed list. Add new values only by amending this skill.
- **Skipping when uncertain.** A degraded line beats a missing line — the SessionEnd hook will write a `missing-reflex` marker if you skip, which is strictly worse signal than a partial summary you wrote.

## Reading order

If something feels wrong about what to write, read in this order:
1. The current ticket's hand-off log (most recent entries).
2. Today's `journal/hook.jsonl` lines for this session_id.
3. The brief that started the session.

That's enough to compose the line.
