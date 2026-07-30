---
name: docs-maintenance
description: Read when bootstrapping a repo's REPO-MAP.md, after any structural change — module added, moved, or deleted; entry point, invariant, or data flow changed — or to audit docs against code. Stale docs are defects. Not for milestones, use golem:journaling.
---

# docs-maintenance

REPO-MAP.md is the one hand-curated map of a repository — the ~60 lines of judgment an
agent needs before exploring: structure, entry points, invariants, gotchas, data flow.
It is linked from CLAUDE.md/AGENTS.md and read as plain context. It is NEVER generated
by tooling; if grep, git, or LSP can answer something, it does not belong in the map.

## The contract

- One `REPO-MAP.md` at the repo root. Budget: **≤3KB** (~500 words / ~60 lines). Over
  budget → trim, never append.
- Directory/module granularity. File-level detail only for the handful of files agents
  actually edit. Symbol-level never — that is LSP/grep territory.
- Every line must say something the code cannot say about itself: an invariant, a
  constraint, a gotcha, a why. Delete lines that restate the obvious.
- Header stamp, first line under the title:
  `> Last verified: YYYY-MM-DD @ <short-sha> — maintained via golem:docs-maintenance.`
- CLAUDE.md and AGENTS.md (where present) each carry one reference line near the top:
  `**Codebase map:** [REPO-MAP.md](REPO-MAP.md) — read it before exploring.`
- Stale content is a defect: a wrong map line noticed during ANY work gets fixed in the
  same session, same PR — never deferred.

## Template

```markdown
# REPO-MAP.md
> Last verified: <YYYY-MM-DD> @ <short-sha> — maintained via golem:docs-maintenance.

## Directory structure
- `<dir>/` — <purpose, one line; note the invariant if it has one>

## Key modules & entry points
### <path/to/file>
- <what it does, one sentence>
- Invariant: <what must not be broken>
- Depends on: <cross-module dependency worth knowing>

## Data flow
<one paragraph: entry → processing → state → output>

## Constraints & gotchas
- <true-but-not-obvious fact>

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
```

## Mode: bootstrap — repo has no REPO-MAP.md

1. Explore: top-level dirs, existing CLAUDE.md/AGENTS.md/docs, entry points (servers,
   CLIs, hooks, exported tools), where state lives, one end-to-end data-flow trace.
2. Fill the template. Spend the budget on Constraints & gotchas — those lines pay the
   most rent.
3. Wire the reference line into CLAUDE.md and AGENTS.md. Do not create AGENTS.md (or
   any new context file) just for this — wire into what exists.
4. Stamp, then run the verify pass.

## Mode: incremental update — after your own change

Walk the triggers. If none hit, state "no map trigger" in your evidence and move on —
that is a valid outcome, not a skipped step.

Update **if and only if** you:
- added/moved/removed a module or top-level directory
- added/removed an externally visible entry point (API route, CLI verb, MCP tool,
  exported service, hook)
- created or discovered an invariant, constraint, or gotcha
- changed the data flow

Non-triggers: internal refactors, bug fixes without contract change, test-only changes,
private renames, dependency bumps.

Touch only the affected sections. Re-stamp. Verify pass on what you touched.

## Mode: audit — map vs reality

Run when a refactor moved many files, the stamp is >3 months old, you're asked to, or
the map has lied to you twice.

1. Directory section vs the actual tree — fix drift.
2. Every named path and entry point: confirm it exists (grep/LSP). Spot-check 2–3
   invariants by reading the code they describe.
3. Delete stale claims aggressively — a shorter true map beats a longer doubtful one.
4. Re-stamp with the current date and sha.

## Verify pass — mechanical, after every write

- `wc -c REPO-MAP.md` ≤ ~3000.
- Every path named in the map exists (check against `git ls-files` / `ls`).
- Reference lines present in CLAUDE.md/AGENTS.md.
- Stamp date and sha are current.

## Wider docs hygiene

The same trigger discipline governs architecture docs (e.g. `docs/claude/*.md`): a
change that alters models, services, workflows, schemas, or interfaces updates the
matching doc in the same session. REPO-MAP.md links to those docs; it never duplicates

## Anti-patterns — hard guards

1. **Generating the map with a tool.** Hand-curated only; generators drift silently and
   restate what grep already knows.
2. **Restating code.** "class Engine orchestrates tasks" is noise; "Engine is
   single-threaded per instance" is signal.
3. **Essay prose.** Bullets, active voice, one-line claims. Write for an agent, not a
   blog reader.
4. **A second map.** No structure summaries in README/ARCHITECTURE — one source, others
   link to it.
5. **Detail creep.** If updating the map feels like a chore, the map is too detailed —
   cut it until updates are cheap.
