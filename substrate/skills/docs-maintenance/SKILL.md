---
name: docs-maintenance
description: Read when bootstrapping a project's agent docs, after a structural change, at spec close to fix what a feature invalidated, or to audit docs against code. Stale docs are defects. Not for journal or memory lines, use golem:journaling.
---

# docs-maintenance

A project owns two layers of durable knowledge in git. Golem derives a third and renders it; nobody
writes that one by hand.

| | What | Lives | Loaded |
|---|---|---|---|
| **Invariants** | what stays true if this were rewritten in another language | root `AGENTS.md` | always |
| **Durable knowledge** | architecture, conventions, `REPO-MAP.md`, ADRs | `docs/` + the map, behind a trigger index | on demand |
| **Current state** | live sessions, recently closed work, recent commits | nowhere — derived at session start | every session |

Episodic memory — what a session *learned* — is not a third store here. It is
`~/.golem/journals/<project_id>/summary.jsonl`, and `golem:journaling` owns its location, schema,
and append recipe. Do not invent a second one; see § Do not add a store.

## Invariants — root `AGENTS.md`

**Admission test: would this still be true if the codebase were rewritten in another language?** Why
the project exists, what must never happen, boundaries that outlive any implementation. If the
answer is no, it belongs in durable knowledge instead.

**One file, never two.** Codex and opencode read `AGENTS.md` natively; Claude Code reads
`CLAUDE.md`, which should be a one-line `@AGENTS.md` import. Two hand-maintained copies drift in
*both* directions — each ends up holding invariants the other lacks, so agents on different
harnesses work from different rules. This repo uses the import-stub pattern; `~/Documents/software/yitfit/trialroomai`
does not, and its two files have already diverged.

Keep it short. Every line is paid on every session, on every harness.

## Durable knowledge — `docs/` and the map

**Two regimes, and only one rots.**

*Living docs* describe current reality and must be **replaced** when reality moves: `REPO-MAP.md`,
architecture notes, conventions. These are what the audit inspects.

*Dated artifacts* are written once against a moment and superseded rather than edited — ADRs,
research reports, design records, anything filed under a date. A superseded ADR is not stale, it is
history, and **the audit must leave them alone.** Rewriting one to match today destroys the record
of why the decision looked right at the time.

**The index is the mechanism.** `docs/` needs an index whose entries are **"read when…" triggers,
not topic labels** — a table of contents does not enable on-demand loading:

```markdown
| File | Read when… |
|------|-----------|
| `architecture.md` | You need services, request lifecycle, trust boundaries. |
| `testing.md` | You are writing or running tests. |
```

### `REPO-MAP.md` — the one map

The hand-curated ~60 lines an agent needs before exploring. Never generated: if grep, git, or LSP
can answer it, it does not belong.

- One at the repo root. **Budget ≤3KB** — the same figure the verify pass checks.
- Directory/module granularity. File-level only for files agents actually edit. Symbol-level never.
- Every line says something the code cannot say about itself — an invariant, a constraint, a gotcha.
- Header stamp: `> Last verified: YYYY-MM-DD @ <short-sha> — maintained via golem:docs-maintenance.`
- Referenced from `AGENTS.md`: `**Codebase map:** [REPO-MAP.md](REPO-MAP.md) — read it before exploring.`

```markdown
# REPO-MAP.md
> Last verified: <YYYY-MM-DD> @ <short-sha> — maintained via golem:docs-maintenance.

## Directory structure
- `<dir>/` — <purpose; note the invariant if it has one>

## Key modules & entry points
### <path/to/file>
- <what it does> · Invariant: <what must not be broken>

## Data flow
<one paragraph: entry → processing → state → output>

## Constraints & gotchas
- <true-but-not-obvious fact>

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
```

**On the budget.** If every remaining line is verified, distinct, and says something the code cannot
say about itself, then the budget is wrong and you re-budget — stating the new number, the reason,
and **updating the verify pass to match**. A contract whose own check disagrees with it is not a
re-budget, it is an exception someone granted themselves. Before concluding you are there, cut the
sections the template does not list: that is where the slack usually is.

## Mode: bootstrap — the project has none of this

Lay the pattern down once, then hand off. These become ordinary project files — no golem markers, no
re-render, no ownership claim.

1. Root `AGENTS.md` with an invariants section; apply the admission test to every line. If
   `CLAUDE.md` is a separate hand-maintained copy, replace its body with `@AGENTS.md`.
2. `docs/` with a trigger-table index, and `adr/` with a `0000-template.md`.
3. `REPO-MAP.md` per the contract above.
4. Wire the pointers into `AGENTS.md`, then run the verify pass.

Do not invent content to fill sections. A section with nothing true to say should not exist.

## Mode: incremental — after your own change

Walk the triggers. If none fire, say "no map trigger" in your evidence and move on; that is a valid
outcome, not a skipped step.

Update **if and only if** you:

- added, moved, or removed a module or top-level directory
- added or removed an externally visible entry point (route, CLI verb, MCP tool, hook, exported service)
- created or discovered an invariant, constraint, or gotcha
- changed the data flow

Non-triggers: internal refactors, bug fixes without a contract change, test-only changes, private
renames, dependency bumps.

Touch only the affected sections. Re-stamp. Verify what you touched.

## Mode: at spec close — what did this feature invalidate?

Run by whoever closes the spec — the `lead`, or a `standalone` session closing its own work. Either
way it is the actor that saw the whole feature, which is why the job sits here rather than on each
builder.

**Ownership without method is why the usual rule fails.** A repo audited during this design already
carried "fix the doc in the same PR or flag it" in writing, and still had `docs/for_agents/testing.md`
two months behind its code. So do not ask yourself whether you broke a doc. Check:

```bash
# 1. What actually moved — as directories, because the map is directory-granular.
git diff --name-only <base>..HEAD | xargs -n1 dirname | sort -u

# 2. Which docs name any of it. Grep ancestors too: a doc that says `lib/compiler/`
#    will never match a search for `lib/compiler/engine.js`.
for d in $(git diff --name-only <base>..HEAD | xargs -n1 dirname | sort -u); do
  while [ "$d" != "." ]; do grep -rl -- "$d" docs/ AGENTS.md REPO-MAP.md 2>/dev/null; d=$(dirname "$d"); done
done | sort -u
```

Grepping the full changed path is the trap: it finds almost nothing, and the drift it misses is
exactly the structural kind the map is for.

Then walk the incremental triggers, decide whether the work earned an **ADR** (a load-bearing choice
with a rejected alternative — append one, never edit an old one), and append a milestone line via
`golem:journaling` if anything clears its bar. Usually nothing does.

## Mode: audit — map versus reality

Run when asked, after a refactor that moved many files, when the stamp is months old, or when a doc
has lied to you twice. **Living docs only** — dated artifacts are out of scope by construction.

1. Directory section versus the actual tree.
2. Every named path, entry point, and command — confirm it exists.
3. Spot-check two or three stated invariants against the code they describe.
4. Delete stale claims aggressively. A shorter true doc beats a longer doubtful one.
5. Re-stamp.

## Precedence

**Code outranks docs, always.** When they disagree, trust the code and fix the doc in the same
session. A disagreement you noticed and left is a defect you chose.

## Do not add a store

Episodic memory already has a home in `golem:journaling`. If you find yourself designing a second
place to record what a session learned, you are duplicating it — and two stores with the same
admission bar means neither gets swept and both get half the records. Sprawl is a
garbage-collection failure, not a storage failure; a new store makes it worse.

## Verify pass — after every write

- `wc -c REPO-MAP.md` — at or under the budget recorded in the contract above.
- Every path, command, and test name you touched exists.
- The `AGENTS.md` pointer lines resolve.
- Stamp date and sha are current.

## Anti-patterns

1. **Generating the map with a tool.** Generators drift silently and restate what grep knows.
2. **Restating code.** "Engine orchestrates tasks" is noise; "Engine is single-threaded per
   instance" is signal.
3. **A second map.** One source; everything else links to it.
4. **Hand-writing current state.** It is derived; your copy starts rotting immediately.
5. **Detail creep.** If updating a doc feels like a chore, it is too detailed — cut until updates
   are cheap, or they will stop happening.
