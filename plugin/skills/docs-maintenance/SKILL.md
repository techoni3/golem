---
name: docs-maintenance
description: Read when bootstrapping a project agent docs, after any structural change, at spec close to fix what a feature invalidated, or to sweep docs and memory for drift. Covers the knowledge layers a project owns. Not for milestone journal lines, use golem:journaling.
---
<!-- GENERATED: skills/docs-maintenance/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# docs-maintenance

A project owns three layers of durable knowledge. Golem owns a fourth and renders it; you never
write that one.

| | What | Lives | Loaded | Rots? |
|---|---|---|---|---|
| **L1** | invariants — what stays true if this were rewritten in another language | root `AGENTS.md` | always, every session | no, if the admission test is applied |
| **L2** | durable knowledge — architecture, conventions, ADRs | `docs/`, behind a trigger index | on demand | the docs half does; ADRs do not |
| **L3** | episodic memory — what was learned | one append-only JSONL in the repo | last ~50 records | no, it is append-only — but it fills |
| **L4** | current state — live sessions, recent closes, recent commits | nowhere | every session start | cannot; it is derived |

**L4 is golem's, and it is derived from the tracker, the session registry, and git.** Never write
it, never mirror it into a file. Anything you hand-write about current state is a staleness
generator with a slow fuse.

## L1 — invariants

**Admission test: would this still be true if the codebase were rewritten in another language?** Why
the project exists, who it serves, what must never happen, the boundaries that outlive any
implementation. If the answer is no, it is L2 and it is misfiled here.

**One file, never two.** Codex and opencode read `AGENTS.md` natively; Claude Code reads
`CLAUDE.md`, which becomes a one-line `@AGENTS.md` import. Two hand-maintained copies is not a
theoretical risk — a repo audited during this design had `AGENTS.md` and `CLAUDE.md` drifted in
**both** directions, each holding invariants the other lacked, so agents on different harnesses were
working from different rules.

L1 also carries the pointers to L2 and L3. Keep it short: every line is paid on every session.

## L2 — durable knowledge

Two regimes live here and only one of them rots.

**Docs** describe current reality and must be *replaced* when reality moves. `REPO-MAP.md`,
architecture notes, conventions. These are what the sweep inspects.

**ADRs** are append-only and timestamped. A decision that no longer holds is superseded by a newer
ADR, never edited. They cannot go stale, so the sweep skips them entirely — which makes the audit
much cheaper than it first looks.

**The index is the mechanism.** `docs/` needs an index whose entries are **"read when…" triggers,
not topic labels**:

```markdown
| File | Read when… |
|------|-----------|
| `architecture.md` | You need the big-picture model — services, request lifecycle, trust boundaries. |
| `testing.md` | You are writing or running tests. |
```

A table of contents does not enable on-demand loading; a trigger table does. Same principle as a
skill description being the only routing surface.

### REPO-MAP.md — the one map

The hand-curated ~60 lines an agent needs before exploring. Never generated: if grep, git, or LSP
can answer it, it does not belong.

- One at the repo root. Budget **≤3KB** for an ordinary repo; a repo with several delivery targets
  and its own control plane earns up to ~4KB. Over budget → trim, never append.

  **But do not cut true content to hit a number.** If every remaining line is verified, distinct,
  and says something the code cannot say about itself, the budget was wrong and you re-budget —
  stating the new number and why. This repo has been through that once already for its root
  instructions, where a stale line budget nearly cost load-bearing content. Deleting a fact to
  satisfy an estimate is a worse outcome than a map that runs 15% long.
- Directory/module granularity. File-level only for files agents actually edit. Symbol-level never.
- Every line says something the code cannot say about itself — an invariant, a constraint, a gotcha,
  a why.
- Header stamp: `> Last verified: YYYY-MM-DD @ <short-sha> — maintained via golem:docs-maintenance.`
- Referenced from `AGENTS.md`: `**Codebase map:** [REPO-MAP.md](REPO-MAP.md) — read it before exploring.`

```markdown
# REPO-MAP.md
> Last verified: <YYYY-MM-DD> @ <short-sha> — maintained via golem:docs-maintenance.

## Directory structure
- `<dir>/` — <purpose, one line; note the invariant if it has one>

## Key modules & entry points
### <path/to/file>
- <what it does, one sentence>
- Invariant: <what must not be broken>

## Data flow
<one paragraph: entry → processing → state → output>

## Constraints & gotchas
- <true-but-not-obvious fact>
```

## L3 — episodic memory

One append-only JSONL in the repo. **JSONL, not a JSON array**, for a concrete reason: several
agents on several machines append through git, and an array requires rewriting the closing bracket
so it conflicts on every concurrent write. Line appends usually merge, and the resolution rule is
just "keep both lines".

```json
{"ts":"2026-07-30T09:12:00Z","scope":"project","claim":"…","evidence":"GOL-123 | commit abc1234","author":"lead:name"}
```

**Admission bar, and it is high:** *a future session working on something else would be wrong
without this.* Most closing briefs fail it, correctly — they belong on the ticket.

**Elicit remembrance, not description.** A field called `claim` invites a restatement of what was
built, which is worthless. Ask instead: what surprised you, what did you have to discover the hard
way, what would you tell someone starting this tomorrow, what would you do differently.
"Implemented X per spec Y" is a log line. "The retry wrapper silently swallows 429s, so the
integration looked healthy for a week" is a lesson.

The evidence reference is what keeps the file from becoming unfalsifiable assertions.

L3 is a **staging area, not an archive.** The window is bounded, so an unpromoted insight at
position 600 is unreachable and its absence is silent. That is what the sweep is for.

## Mode: bootstrap — the project has none of this

Lay the pattern down once, then hand off. These become ordinary project files: no golem markers, no
re-render, nobody's tool output. Golem does not own them and will not rewrite them.

1. **L1.** Create or extend root `AGENTS.md` with an invariants section. Apply the admission test to
   every line you put there. If `CLAUDE.md` exists as a separate hand-maintained copy, replace its
   body with `@AGENTS.md` plus anything genuinely Claude-Code-specific.
2. **L2.** Create `docs/` with a trigger-table index and an `adr/` directory with a `0000-template.md`.
   Bootstrap `REPO-MAP.md` per the contract above.
3. **L3.** Create the JSONL with a single record explaining what the file is for.
4. Wire the pointers into L1, then run the verify pass.

Do not invent content to fill sections. An honest short L1 beats a padded one, and a section with
nothing true to say should not exist.

## Mode: at spec close — what did this feature invalidate?

The lead runs this, because it is the only role that saw the whole feature. **Ownership without
method is why the usual rule fails** — a repo audited during this design already carried "fix the
doc in the same PR or flag it" in writing, and still had a testing doc two months behind the code.

So do not ask "did I break a doc". Check:

1. `git diff --name-only <spec-branch-base>..HEAD` — the actual surface that moved.
2. For each changed path, grep the docs for it: `grep -rl "<path or symbol>" docs/ AGENTS.md REPO-MAP.md`.
   Anything that names something you changed is a candidate, and the grep is the part that stops
   this being a memory test.
3. Walk the L2 triggers: did you add, move, or delete a module or entry point? Change a data flow,
   an invariant, a convention? Any yes → update that doc now, in this session.
4. Decide whether the work produced an **ADR** — a load-bearing choice with a rejected alternative.
   If so, append one; never edit an old one to match the new reality.
5. Append the L3 record if anything clears the bar. Usually nothing does, and that is fine.

"No doc trigger fired" is a valid, reportable outcome. State it with the grep you ran.

## Mode: sweep — on demand, no fixed trigger

Run when asked, after a refactor that moved many files, when the map stamp is months old, or when a
doc has lied to you twice.

**Docs half of L2:**

1. Directory section vs the actual tree.
2. Every named path and entry point — confirm it exists.
3. Spot-check two or three stated invariants by reading the code they describe.
4. Delete stale claims aggressively. A shorter true doc beats a longer doubtful one.
5. Re-stamp.

**L3, with three outcomes per record — this is the part that keeps the file useful:**

| Outcome | When |
|---|---|
| **Promote to L2** | it has proven durable and general — it is now a convention or an architectural fact, not an episode |
| **Discard** | superseded, or it described a state of the world that no longer exists |
| **Keep** | still true, still specific, not yet general enough to be a doc |

Promotion is the whole point of the bounded window. A file that only ever grows is a file nobody
reads.

**L2 → L1 is not a promotion path.** L1 survives a rewrite in another stack; L2 is by definition
stack and implementation knowledge. Anything crossing that line was misfiled at birth — correct it,
do not ceremonially promote it.

## Precedence

**Code outranks docs, always.** When they disagree, trust the code, then fix the doc in the same
session. A disagreement you noticed and left is a defect you chose.

## Verify pass — mechanical, after every write

- `wc -c REPO-MAP.md` ≤ ~3000.
- Every path named in any doc you touched exists.
- L1 pointer lines present and resolving.
- Stamp date and sha current.
- L3 file still parses line by line: `while read -r l; do echo "$l" | jq -e . >/dev/null || echo "BAD: $l"; done < <file>`.

## Anti-patterns

1. **Generating a map with a tool.** Generators drift silently and restate what grep already knows.
2. **Restating code.** "Engine orchestrates tasks" is noise; "Engine is single-threaded per
   instance" is signal.
3. **A second map.** One source; everything else links to it.
4. **Hand-writing current state** into any file — that is L4, it is derived, and your copy starts
   rotting immediately.
5. **Detail creep.** If updating a doc feels like a chore, it is too detailed. Cut until updates are
   cheap, or it will simply stop happening.
6. **Padding a bootstrap.** A section with nothing true to say is worse than no section.
