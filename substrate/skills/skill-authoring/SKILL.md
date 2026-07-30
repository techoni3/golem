---
name: skill-authoring
description: Read before writing or editing a skill, SKILL.md, subagent, or persona/role card, or before asking an agent to write one. Covers trigger design, the three gates a skill must pass, context economy, and when a hook or rules file is the right answer instead.
---

# skill-authoring

A skill is not documentation the agent reads. It is a **conditional, self-selected edit to the
agent's context, purchased with tokens**, selected by a matcher you do not control, that must earn
its price in changed behaviour.

Four things must be true. A skill failing any one is net-negative: it spent context and returned
nothing. A skill failing the first is *invisible*, which is worse — you will believe it works.

| # | Must be true | Fails as | Depth |
|---|--------------|----------|-------|
| 1 | Loads when it should, quiet when it shouldn't | Never triggers, or fires on everything | [references/description-craft.md](references/description-craft.md) |
| 2 | Behaviour changes once loaded | Generic advice, no teeth | § Teeth |
| 3 | Costs less than it delivers | Bloated, context-hostile | § Economy |
| 4 | What it says is true here, today | Invented APIs, stale conventions | § Grounding |

## Before anything: should this be a skill?

Most bad skills should not have existed. Check the unit first.

| What you actually have | Right unit |
|------------------------|------------|
| A rule that must hold for **every** task | Rules file (`AGENTS.md` / `CLAUDE.md`) |
| A rule that must **never** be violated | Hook, linter, or CI check — not prose |
| A one-off action the user picks | Slash command or a plain prompt |
| A reusable multi-step method with references or scripts | **Skill** |
| A live read/write against an external service | Tool or MCP server |
| A separate role, context window, model, or permission set | Subagent — [references/persona-contract.md](references/persona-contract.md) |

> [!IMPORTANT]
> **Enforcement does not belong in prose.** Instructions are context, not guarantees, and
> adherence decays as a session runs long. If you would reject a PR over it, it belongs in a
> hook or CI. Writing "use 2-space indent" in a skill means the agent must remember it on every
> edit; a formatter in a post-edit hook means it happens every time, forever, for zero tokens.

## The three gates

Run all three before shipping. Each is mechanical; none takes long. Skipping them is why most
published skills are net-zero.

**Gate 1 — fresh-session trigger matrix.** A skill exercised only in the session that wrote it is
untested: that session already holds the whole skill, so everything fires. In a *fresh* session,
type what a real user would type, with no preamble and no hint a skill exists. Three phrasings
that must trigger, two neighbouring tasks that must not. Re-run the whole matrix after **every**
description edit — the body cannot affect triggering.

**Gate 2 — the A/B delta.** Run a realistic task with the skill and without it. The delta is the
skill's entire value. If bare agent scores 80 and the skill scores 82, hundreds of lines bought
two points and you pay for them on every activation forever. This is the gate nobody runs and the
one that deletes the most skills.

**Gate 3 — the deletion test.** Line by line: *if I deleted this, would the agent do anything
different?* If no, it is not neutral — it is noise competing with the lines that matter.

Diagnosing failures and building the eval loop: [references/evaluation.md](references/evaluation.md).

## Teeth

Symptom: it loads, the agent follows it, and the output is what you'd have got anyway.

Delete on sight — these are defaults the model already gravitates toward and they change nothing:
*"write clean code"*, *"handle errors gracefully"*, *"follow best practices"*, *"you are an expert
in…"*. Role-priming in particular is close to a no-op on frontier models; the model is already
operating as the expert being described.

**Replace universal principles with local decisions.** A principle is something the model already
knows. A decision is something only this codebase knows.

| Principle (noise) | Decision (signal) |
|---|---|
| "Handle errors gracefully." | "Wrap external calls in `withRetry`; surface failures as `AppError`, never raw exceptions." |
| "Write good tests." | "Journey-level integration against a real DB. No unit fan-out." |
| "Be careful with migrations." | "Read the live schema first and diff against it before writing the migration." |

**The test:** could this line have been written by someone who had never seen this repository? Then
delete it.

**Do not railroad.** A rigid script of `ALWAYS`/`NEVER`/`MUST` in capitals makes the agent follow
the letter and miss every edge case the script did not anticipate. Give the goal and the
constraints; let the agent choose the path. Reserve hard imperatives for what is genuinely
inviolable — safety, irreversibility, independence. State *why* a non-obvious rule exists: a rule
with its rationale generalises to situations you did not foresee.

**Gotchas are the highest-signal section you can write** — the accumulated list of specific places
the agent trips. It is valuable precisely because it cannot be derived. Add a line every time
something goes wrong; this is how a skill gets better without the model getting better.

## Economy

Context is a finite attention budget, and there is a practical ceiling on how many instructions
get followed reliably. You are not filling an empty container — every line competes with every
other line, including the harness's own programming.

| Thing | Target |
|-------|--------|
| `description` | 1–1024 chars allowed; ~200–400 in practice |
| Body | Under ~5k tokens; "under 500 lines" is the standing target |
| Reference depth | **One level.** Never `SKILL.md` → `advanced.md` → `details.md` |
| Long references | Table of contents above ~100 lines |

Three moves, in order of leverage:

1. **Ship code, not prose about code.** A script costs *zero* context to exist and only its output
   to run. The same procedure written as prose costs its full length on every activation and can
   be misremembered. A repeated multi-line shell block belongs in `scripts/`.
2. **One job per skill.** Finish the sentence "this skill exists to ___." If you need an "and",
   that is two skills. Tighter skills also trigger more sharply.
3. **Hub and spoke** *only when earned* — make `SKILL.md` a routing table and push depth into
   `references/`, loaded on demand.

> [!WARNING]
> Progressive disclosure is a tool, not a virtue. A 60-line skill that says everything it needs in
> 60 lines should be one flat file. Splitting it adds indirection and the risk a spoke never gets
> read. Reach for hub-and-spoke when the body is genuinely over budget, or when different tasks
> need genuinely different subsets.

## Grounding

Symptom: the skill confidently names an API, convention, or command that does not exist, and the
agent hallucinates downstream. This is the failure mode most specific to **agent-written skills** —
a model writing about a codebase it half-read fills gaps with invention that reads exactly as
confidently as fact.

- **If you did not read it, do not assert it.** Every factual claim traces to something actually
  read. Where a claim cannot be verified, say so in the skill rather than smoothing it over.
- **State preconditions and make the agent check them.** Environment state the agent cannot see is
  the classic mystery failure in a fresh context.
- **Pull live state instead of describing it.** A schema documented inside a skill drifts; a
  schema read at invocation time cannot.
- **Ship scripts that fail loudly.** Self-contained, documented dependencies, real error handling,
  useful non-zero exits. A script that fails clearly is a verification mechanism.
- **Skills that compensate for model weakness expire.** After a major model update, re-run the A/B
  delta; if the without-skill result lands within a few points, retire it. Skills encoding *your*
  conventions and infrastructure do not expire — no model update teaches the model your branch
  naming.

## Pre-ship checklist

Mechanical. Run it top to bottom; every line is checkable without judgment.

- [ ] Directory name equals frontmatter `name`; lowercase, hyphens, 1–64 chars, no leading,
      trailing, or doubled hyphens.
- [ ] Frontmatter parses. No smart quotes, no tabs, closing `---` present, formatter has not
      rewrapped the description into a folded scalar.
- [ ] `description` states **what it does** and **when to use it**, in third person, containing
      the literal words a user would type.
- [ ] Nearest-neighbour skills named in a "when NOT to use" line, each pointing where to go
      instead.
- [ ] Gate 1 run in a fresh session: 3 must-trigger phrasings pass, 2 near-miss phrasings do not.
- [ ] Gate 2 run: the with/without delta is stated somewhere a future reader can find.
- [ ] Gate 3 run: no line survives that would change nothing if deleted.
- [ ] No line could have been written by someone who never saw this repository.
- [ ] Every referenced path, command, and API was read, not assumed. Every bundled script runs.
- [ ] Body under 500 lines; references one level deep; every bundled file is linked from
      `SKILL.md` — an unreferenced `scripts/` or `examples/` directory is never discovered.
- [ ] Side effects (deploy, commit, outbound message, destructive ops) are **not** model-invocable.

## References

| Read when | File |
|-----------|------|
| Writing or fixing a description; a skill won't fire, or fires constantly | [references/description-craft.md](references/description-craft.md) |
| Writing a subagent, persona, or role card | [references/persona-contract.md](references/persona-contract.md) |
| Building the trigger matrix, A/B harness, or retirement check | [references/evaluation.md](references/evaluation.md) |
| Needing exact frontmatter fields, limits, or cross-harness portability | [references/mechanics.md](references/mechanics.md) |
