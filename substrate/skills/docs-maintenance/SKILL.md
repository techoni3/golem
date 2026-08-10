---
name: docs-maintenance
description: Read when bootstrapping a project's agent docs, after a structural change, at spec close to fix what a feature invalidated, or to sweep docs and project memory for drift. Covers the knowledge layers a project owns in git. Not for golem hook-journal milestones, use golem:journaling.
---

# docs-maintenance

A project owns **three** layers of durable knowledge, all of them ordinary files in git. Golem
derives a fourth and renders it; nobody writes that one by hand.

| | What | Lives | Loaded | Rots? |
|---|---|---|---|---|
| **L1 — invariants** | what stays true if this were rewritten in another language | root `AGENTS.md` | always | no, if the admission test is applied |
| **L2 — durable knowledge** | architecture, conventions, `REPO-MAP.md`, ADRs | `docs/` + the map, behind a trigger index | on demand | the living half does; ADRs do not |
| **L3 — episodic memory** | what a session *learned* | `docs/memory.jsonl` in the repo | last ~50 records | no, it is append-only — but it fills |
| **L4 — current state** | live sessions, recent spec closes, recent commits | nowhere — derived at session start | every session | cannot; it is derived |

**All three project layers live in the repo, and that is load-bearing.** A colleague working on the
same codebase without golem gets L1, L2, and L3 in full, because they are just files. Move any of
them into golem's own storage and that stops being true — the knowledge becomes a private benefit
of a tool the rest of the team does not run. L4 is the only layer golem owns, because coordination
state is genuinely the tool's job.

**L3 is not the golem journal.** `~/.golem/journals/<project_id>/hook.jsonl` is central hook
telemetry — per-tool-call, machine-local, never swept, and its milestone line has no evidence field.
It is fine for "this session hit a milestone"; it is not the project's memory. `golem:journaling`
owns that file. This skill owns `docs/memory.jsonl`.

Docs and memory share a trigger and have opposite write semantics, which is the whole distinction:
**a doc update *replaces* a description of current reality** — idempotent, it rots, the audit sweeps
it. **A memory record *appends* what a session learned** — immutable, never rewritten, but swept for
promotion. They sit next to each other at spec close only because that is when you know both.

## Invariants — root `AGENTS.md`

**Admission test: would this still be true if the codebase were rewritten in another language?** Why
the project exists, what must never happen, boundaries that outlive any implementation. If the
answer is no, it belongs in durable knowledge instead.

**One file, never two.** Codex and opencode read `AGENTS.md` natively; Claude Code reads
`CLAUDE.md`, which should be a one-line `@AGENTS.md` import. Two hand-maintained copies drift in
*both* directions — each ends up holding invariants the other lacks, so agents on different
harnesses work from different rules. This is observed, not theoretical: a repo audited during this
design had one file uniquely holding an ownership invariant and the other uniquely holding a
container gotcha.

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

## Episodic memory — `docs/memory.jsonl`

One append-only JSONL in the repo. **JSONL, not a JSON array**, for a concrete reason: several agents
on several machines append through git, and an array requires rewriting the closing bracket, so it
conflicts on every concurrent write. Line appends usually merge, and the resolution rule is just
"keep both lines".

```json
{"ts":"2026-07-30T09:12:00Z","scope":"project","claim":"…","evidence":"GOL-123 | commit abc1234","author":"lead:session-name"}
```

`scope` is `gateway | project | global`. **The `evidence` reference is what keeps the file from
becoming a pile of unfalsifiable assertions** — a record no one can check is a rumour with a
timestamp. If you cannot name a ticket, commit, or file, you probably have an opinion rather than a
finding.

**Admission bar, and it is high:** *a future session working on something else would be wrong
without this.* Most closing briefs fail it, correctly — they belong on the ticket.

**Elicit remembrance, not description.** A field called `claim` invites a restatement of what was
built, which is worthless. Ask instead: what surprised you, what did you have to discover the hard
way, what would you tell someone starting this tomorrow, what would you do differently. "Implemented
X per spec Y" is a log line. "The retry wrapper silently swallows 429s, so the integration looked
healthy for a week" is a lesson.

**Written at spec close by whoever closed it**, not by each builder at ticket close. Ten builders
appending "implemented X per spec Y" reaches the read window in a fortnight and evicts real insight
at the rate of routine work.

L3 is a **staging area, not an archive.** The window is bounded, so an unpromoted insight at position
600 is unreachable and its absence is silent. That is what the sweep is for.

## Mode: bootstrap — the project has none of this

**Run this mode only when the human explicitly requests documentation bootstrap.** A request to
update one document is never authority to create a map, index, ADR directory, or memory store.

Lay the pattern down once, then hand off. These become ordinary project files — no golem markers, no
re-render, no ownership claim.

1. Root `AGENTS.md` with an invariants section; apply the admission test to every line. If
   `CLAUDE.md` is a separate hand-maintained copy, replace its body with `@AGENTS.md`.
2. `docs/` with a trigger-table index, and `adr/` with a `0000-template.md` carrying the four
   fields an ADR needs: **Status · Context · Decision · Consequences**. The decision is worthless
   without the rejected alternative, so say so in the template rather than hoping.
3. `REPO-MAP.md` per the contract above.
4. `docs/memory.jsonl`, empty. Create the file rather than waiting for the first record — an absent
   file reads as "this project does not do that" and nobody starts it later.
5. Wire the pointers into `AGENTS.md` — including where memory lives and its admission bar, since
   L1 is what tells a session the other layers exist — then run the verify pass.

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
  # Stop BEFORE the top level. Walking all the way to "." greps bare `lib`,
  # `test`, `substrate` — which match nearly every doc and drown the signal.
  while [ "$(dirname "$d")" != "." ]; do
    grep -rl -- "$d" docs/ AGENTS.md REPO-MAP.md 2>/dev/null
    d=$(dirname "$d")
  done
done | sort -u
```

Grepping the full changed path is the trap: it finds almost nothing, and the drift it misses is
exactly the structural kind the map is for.

Then walk the incremental triggers, decide whether the work earned an **ADR** (a load-bearing choice
with a rejected alternative — append one, never edit an old one), and append an L3 record to
`docs/memory.jsonl` if anything clears its bar. Usually nothing does — and the bar is the point, so
resist the urge to record that the feature shipped. The tracker already knows.

## Mode: audit — map versus reality

Run when asked, after a refactor that moved many files, when the stamp is months old, or when a doc
has lied to you twice. **Living docs only** — dated artifacts are out of scope by construction.

1. Directory section versus the actual tree.
2. Every named path, entry point, and command — confirm it exists.
3. Spot-check two or three stated invariants against the code they describe.
4. Delete stale claims aggressively. A shorter true doc beats a longer doubtful one.
5. Re-stamp.

## Mode: sweep — memory, on demand

No fixed trigger. Run it when `docs/memory.jsonl` has grown past the read window, when a record has
stopped being true, or when asked. **Every record gets exactly one of three outcomes**, and the
middle one is the reason the file stays useful:

| Outcome | When | Action |
|---|---|---|
| **Promote** | it has stopped being episodic and is now just how this codebase works | write it into the relevant L2 doc, or open an ADR if it was a decision. Then drop the record — it is not lost, it moved |
| **Discard** | superseded, fixed, or it was never true | delete the line |
| **Keep** | still a live lesson, not yet general | leave it |

Promotion is the whole point. An insight that never leaves L3 falls out of the read window and is
silently unreachable — the file grows while its usefulness drops.

**L2 → L1 is not a promotion path.** L1 is what survives a rewrite in another stack; L2 is by
definition stack and implementation knowledge. Anything crossing that line was misfiled when it was
written, so it is a correction, not a promotion, and it needs no mechanism.

Rewriting history is allowed here and only here: the sweep is the one writer permitted to delete
lines. Everything else appends.

## Precedence

Compare the document's purpose with the current source. A *living description of current
behavior* that disagrees with the code is stale — fix it in the same session; a disagreement you
noticed and left is a defect you chose. An *approved future design* is not stale just because the
implementation has not reached it — do not overwrite intent with the present. Dated artifacts are
history and are never edited to match today.

## Do not add a store

The project has exactly one memory file, `docs/memory.jsonl`. If you find yourself designing a
second place to record what a session learned — a `LESSONS.md`, a notes directory, a table in the
tracker — you are duplicating it, and two stores with the same admission bar means neither gets
swept and both get half the records. Sprawl is a garbage-collection failure, not a storage failure;
a new store makes it worse.

The same rule cuts the other way: **do not redirect L3 into golem's hook journal.** It is central,
machine-local, unswept, and has no evidence field, so records put there are invisible to the repo,
to a colleague not running golem, and to the sweep below.

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
