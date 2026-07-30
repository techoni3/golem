# Writing Agent Skills That Work

> Consolidated doctrine, 2026-07-25. Synthesised from two orthogonal recon lanes — canon
> (official specs and first-party guidance) and field (marketplaces, practitioner postmortems,
> dissent) — plus an independent cross-verification pass that corrected or refuted several of the
> field lane's load-bearing statistics.
>
> Tracker: GOL-94 (spec) · GOL-95 (canon) · GOL-96 (field) · GOL-97 (verification).
> Raw lane reports are the primary material; this document is the synthesis.

---

## 0. How to read this

This is a **reference document**, not a checklist. It is deliberately long because it is meant to
be read once, in full, by anyone who is about to write or review an agent skill — and then
consulted by section afterwards. The compact, always-loaded skill derived from it is a separate
artifact; this is the thing that skill points back to when someone asks "why".

Two artifact types are in scope: **skills** (`SKILL.md`-style reusable workflow packages) and
**subagent / persona definitions** (agent role cards whose body is a system prompt). Slash
commands and always-on rules files appear only in §7, where the question is whether your idea
should be a skill *at all*.

Every non-obvious claim carries an evidence tier:

| Tier | Meaning |
|------|---------|
| `[SPEC]` | Normative in a published specification. Binding. |
| `[OFFICIAL]` | First-party vendor documentation or shipped reference implementation. |
| `[FIELD]` | Multiple independent practitioners converge, or a real before/after was demonstrated. |
| `[CONTESTED]` | Practitioners disagree, or canon and field diverge. Both sides given. |
| `[CORRECTED]` | A widely repeated claim that verification found wrong. The correct version is stated. |
| `[UNVERIFIED]` | In circulation, could not be confirmed. Do not build on it. |

§10 is an evidence ledger listing everything that was checked and what happened to it. If you
are going to quote a number from this document somewhere else, read that section first.

---

## 1. The mental model

Most bad skills are bad because their author had the wrong mental model of what a skill *is*.
The common wrong model is **"a skill is documentation the agent reads."** Under that model, more
detail is better, restating good practices is harmless, and a skill that exists has already done
its job.

The correct model:

> **A skill is a conditional, self-selected edit to the agent's context — purchased with tokens,
> triggered by a matching algorithm you do not control, which must earn its price in changed
> behaviour.**

Four independent things must all be true for a skill to be worth having. They map exactly onto
the four ways skills fail, and they are the spine of this document:

| # | Question | Fails as | Section |
|---|----------|----------|---------|
| 1 | Will it load when it should, and stay quiet when it shouldn't? | Never triggers / triggers wrong | §3 |
| 2 | Once loaded, does the agent behave differently than it would have anyway? | Generic advice, no teeth | §4 |
| 3 | Is what it costs less than what it delivers? | Bloated / context-hostile | §5 |
| 4 | Is what it says true, in this repo, today? | Not grounded in reality | §6 |

A skill that fails any one of these is net-negative: it consumed context and returned nothing.
A skill that fails #1 is invisible — which is worse, because you will believe it is working.

### 1.1 The loading model, and why it determines everything else

The canonical sequence, documented by Anthropic and mirrored in shape by every other harness
that implements skills `[OFFICIAL]`:

1. The harness discovers each skill's **name and description** and places that metadata in the
   startup system prompt.
2. The user's request is matched against that metadata.
3. If matched, the agent reads **the full `SKILL.md`** with a filesystem operation.
4. It reads **only the reference files** the task actually needs.
5. It executes scripts, or follows the instructions, to do the work.

Which produces a three-level cost structure:

| Level | Content | Context cost | When paid |
|-------|---------|--------------|-----------|
| **L1** | `name` + `description` | ~100 tokens per skill `[OFFICIAL]` | Always. Every session. Every skill you have installed. |
| **L2** | `SKILL.md` body | Under ~5,000 tokens recommended `[SPEC]`; "under 500 lines" is the recurring authoring target `[OFFICIAL]` | Only after activation |
| **L3+** | `references/`, `assets/`, data, templates | Zero until read | Only when the task needs them |
| **Scripts** | `scripts/` | Source is **not** loaded to execute it — only its output costs context `[SPEC][OFFICIAL]` | On output |

Three consequences follow directly, and they are the most useful things in this document:

**Consequence A — the description is a router, not a summary.** At match time, the body does not
exist yet. Nothing in it can influence whether it loads. Every word that determines *when this
skill should fire* must be in the description or it is inert `[OFFICIAL]`.

**Consequence B — L1 is the only cost you always pay, so it is the only place where "one more
skill" is genuinely free-ish, and simultaneously the place where a shared budget can silently
starve you.** See §3.5.

**Consequence C — scripts are the cheapest possible way to add capability.** A 400-line Python
file in `scripts/` costs zero context to *have* and costs only its stdout to *use*. The same
logic written as prose in the body costs its full length every single activation `[SPEC]`.

> [!NOTE]
> **A documented inconsistency, so you don't get confused by it.** Anthropic's current platform
> docs give the metadata budget as approximately **100 tokens**, while the shipped `skill-creator`
> source phrases it as approximately **100 words**. Separately, an Anthropic PDF guide says
> "5,000 **words**" for the body and suggests evaluating 20–50 skills, whereas the current
> specification says approximately 5,000 **tokens** and current docs discuss 100+ skills. Treat
> the current spec/platform figures as canonical and the others as dated or loose phrasing
> `[OFFICIAL]`. Do not build tooling that depends on either reading.

### 1.2 What a subagent is instead

A subagent is not a bigger skill. It is a different mechanism with a different cost model, and
conflating the two produces bad versions of both.

| Concern | Skill | Subagent / persona |
|---------|-------|--------------------|
| Unit | Reusable workflow + filesystem resources | A specialised assistant; the body **is** a system prompt |
| Discovery | Metadata available before body activation | Description routes delegation; body loads when the agent runs |
| Context | Progressively loads into the *current* session | **Fresh, isolated context.** Parent conversation is not automatically visible `[OFFICIAL]` |
| Configurable | Which files it bundles | Tools, permissions, model, MCP servers, hooks, memory, isolation |
| Output | Artifacts produced in the current task | A summary returned across a boundary |
| Use when | A repeatable multi-step method needs supporting material | Work benefits from context isolation, a different model or toolset, or parallelism |

The single most important line in that table is **fresh, isolated context**. In Claude Code a
spawned agent receives its own system prompt, its task, the applicable project-instructions
hierarchy, basic environment info, and any skills explicitly injected through its configuration —
and *not* the parent transcript or the parent's loaded skills `[OFFICIAL]`. A persona body that
assumes "you already know what we were discussing" is broken by construction.

§8 covers persona authoring in full.

---

## 2. The three tests every skill must pass before it ships

Before the failure modes, the three mechanical checks that catch most of them. These are cheap,
they are objective, and skipping them is why so many skills are quietly useless.

### Test 1 — The fresh-session trigger matrix

A skill exercised only in the session where you wrote it is **untested**. That session already
has the whole skill in context, so of course everything fires and everything gets followed
`[FIELD]`.

1. Open a genuinely fresh session.
2. Type a task phrase a real user would use. No preamble, no hint that a skill exists.
3. Run a matrix: **three phrasings that must trigger, two neighbouring tasks that must not.**
4. When a phrasing misses, the description is the only lever. The body plays no part in
   triggering.
5. Re-run the whole matrix after *every* description edit.

**The observable-marker technique** makes the diagnosis unambiguous: temporarily add a harmless
instruction to the body such as *"Begin the response with `[MODE]`"*. If the marker appears,
discovery and selection worked and your bug is later in the workflow. If it doesn't, the
description is the problem. Remove the marker afterwards `[FIELD]`.

### Test 2 — The A/B delta

Run the same realistic task **with the skill and without it**. Score both. The delta is the
skill's entire value.

If bare agent scores 80 and your skill scores 82, hundreds of lines bought you two points, and
you are paying for those lines on every activation forever `[FIELD]`. Anthropic's own
`skill-creator` builds this in: blind A/B comparison where the comparator does not know which
output came from which configuration `[OFFICIAL]`.

This is the test almost nobody runs, and it is the one that would delete most skills in
circulation.

### Test 3 — The deletion test

Read the skill line by line and ask: **if I deleted this line, would the agent do anything
different?**

If no, it is noise. Not neutral — noise. It costs tokens, it dilutes the lines that do matter,
and it competes for a limited instruction-following budget.

Anthropic states the principle directly as *"don't state the obvious"* `[OFFICIAL]`. Practitioners
report dramatic compression when applying it honestly — one reported build log took a
meeting-summary skill from 612 words to 184 and an SEO-audit skill from 891 to 240, with no loss
`[FIELD]`.

---

## 3. Failure mode 1 — never triggers, or triggers wrong

The most damaging failure, because it is silent. The skill is installed, `/skill-name` works
manually, and it simply never fires on its own. The author concludes skills don't work.

### 3.1 The diagnosis chain

Run in this order; each step rules out the ones below it `[FIELD]`:

1. **Is it loaded at all?** List your skills. Not present → path, directory-name, or YAML problem
   (§3.6), not a description problem.
2. **Is it listed but marked user-only?** Then model invocation is disabled for it — deliberately
   or accidentally (§3.7).
3. **Listed, manually invocable, never auto-fires?** The description is too vague. Go to §3.2.
4. **It used to work and stopped?** Suspect listing-budget pressure — newer skills crowding it
   out (§3.5).
5. **It fires on everything?** The description is too broad and has no anti-triggers (§3.4).

### 3.2 The description formula

The description is the only routing surface. Write it for the matcher, not for a human browsing
a README.

```
<What it does, concretely, in third person, leading with verbs>.
Use when <the situations and the literal words a user would actually type>.
Do not use for <the nearest neighbours it keeps stealing work from>.
```

Rules, in descending order of impact:

1. **Third person, always** `[OFFICIAL]`. Not "I help you…", not "You should…".
2. **State both halves: what it does AND when to use it.** This is the one thing the spec itself
   asks for — a description that "says what the skill does and when to use it" `[SPEC]`.
3. **Include the exact words a user types, not synonyms.** If people say "audit", the word
   "audit" must appear. The matcher is matching *your text* against *their text*.
4. **Lead with verbs**, not with a noun phrase describing a category.
5. **Name the artifact, tool, format, or environment** when it disambiguates — the shipped
   first-party skills consistently do this `[OFFICIAL]`.

Real before/after, from a practitioner guide `[FIELD]`:

> **Before:** `"A collection of utilities and best practices for working with PDF documents."`
>
> **After:** `"Extract form fields, fill forms, redact text, or parse tables from PDF files. Use
> when the user asks to fill, redact, or parse a PDF, or mentions form fields, AcroForms, or PDF
> extraction."`

The "before" is a shelf label. The "after" is a routing rule containing the words a user would
actually type.

For calibration, here are **verbatim descriptions from Anthropic's own shipped skills**
`[OFFICIAL]`:

| Skill | Description | What it demonstrates |
|-------|-------------|----------------------|
| `skill-creator` | "Create new skills, modify and improve existing skills, and measure skill performance." | Names the concrete verbs — create/modify/measure — not just the noun "skills" |
| `mcp-builder` | "Guide for creating high-quality MCP servers that enable LLMs to interact with external services through well-designed tools." | Artifact + purpose + integration boundary |
| `webapp-testing` | "Toolkit for interacting with and testing local web applications using Playwright." | Environment + tool + intent |
| `brand-guidelines` | "Applies Anthropic's official brand colors and typography to any sort of artifact." | The transformation and its subject matter |
| `slack-gif-creator` | "Knowledge and utilities for creating animated GIFs optimized for Slack." | Output format + target platform |

Note what is *absent* from all five: no role-priming, no "best practices", no adjectives about
quality.

**Length.** The spec allows 1–1,024 characters `[SPEC]`. Field practice converges on roughly
200–400 characters as the sweet spot: specific enough to match, short enough not to crowd the
shared listing budget `[FIELD]`. A widely repeated claim that the combined listing text is
truncated at exactly 1,536 characters **could not be verified** and should not be designed
around `[UNVERIFIED]`.

### 3.3 The "pushy" question — resolved

This is worth reading carefully, because a contradiction is widely repeated here and
**verification found it isn't real**.

The claim in circulation: *Anthropic's best-practices doc calls "pushy" descriptions an
anti-pattern, while Anthropic's own `skill-creator` tells you to be pushy.*

What the sources actually say `[CORRECTED]`:

- The current official best-practices page contains **no** warning about "pushy" or
  "over-triggering" at all. What it warns against is **vagueness**, and what it asks for is
  third person, specificity, and explicit triggers `[OFFICIAL]`.
- The shipped `skill-creator` source does say, verbatim, that *"Claude has a tendency to
  'undertrigger' skills … make the skill descriptions a little bit 'pushy'"* `[OFFICIAL]`.

So there is no conflict between two official rules — there is one official rule (be specific and
trigger-oriented) plus one official recall-oriented heuristic (lean against undertriggering).
The correct synthesis:

> **Optimise for recall, then test for precision.** A false trigger costs a few tokens — the
> agent loads the skill, sees it doesn't apply, and moves on. A missed trigger costs the entire
> value of the skill *and* the user's belief that skills work at all. So bias toward firing. Then
> run the negative half of your trigger matrix and add anti-triggers until the false positives
> stop. "Pushy" is not a licence to be indiscriminately broad.

On the underlying numbers: a frequently cited community measurement reports roughly **20%**
activation for unoptimised descriptions, **50%** for optimised ones, and up to **90%** once
examples are added. Verification confirmed the source exists and says this — but it is a
community self-report over 200+ prompts, **not** a vendor benchmark `[FIELD]`. Treat the shape
of the finding (optimisation matters a lot) as sound and the specific percentages as indicative
only.

### 3.4 Anti-triggers

Without explicit boundaries, skills over-activate on loose keyword matches, and overlapping
skills fight over the same requests. A short "when NOT to use" block is repeatedly reported as
one of the highest-leverage additions available `[FIELD]`:

```markdown
## When NOT to use

- For Twitter/X content — use the `x-thread-writer` skill.
- For long-form blog posts — use `blog-post-writer`.
- For internal memos or status updates — plain prompting is fine.
- When the user shares a link without asking for content to be produced.
```

The pattern that makes this work is **naming the neighbour**. "Don't use this for X" is weak;
"don't use this for X, use `other-skill`" both suppresses the false positive and routes the
request correctly.

### 3.5 The shared listing budget

Every installed skill's description sits in the same startup budget. When that budget overflows,
descriptions get **dropped**, and your least-used skill loses its trigger keywords first — which
is exactly the skill you are least likely to notice failing.

Here the field reporting outruns the documentation, so be precise about what is actually
established `[CORRECTED]`:

- **Verified:** a real listing-budget/truncation phenomenon exists and is reported in tracked
  issues. One documents **175 descriptions dropped** against a **1% `skillListingBudgetFraction`**
  with a roughly 11k-token cost. Another documents an undocumented **~16,000-character**
  `available_skills` budget with **42 of 63** skills visible.
- **Not verified:** `skillListingMaxDescChars`, `SLASH_COMMAND_TOOL_CHAR_BUDGET=30000`, and the
  claim that drops were silent before a specific version. Do not state these as settings.

The actionable version is version-independent and doesn't depend on any of the unverified
specifics:

> If a skill that used to fire stops firing and nothing about it changed, suspect budget
> pressure from skills added since. Prune what you don't use, tighten long descriptions, and
> prefer project-scoped skills over global ones.

### 3.6 Silent structural failures

These skip discovery entirely and produce no error `[FIELD]`:

| Cause | Symptom | Fix |
|-------|---------|-----|
| YAML doesn't parse | Skill absent from the list, no warning | Validate frontmatter. Watch for smart quotes pasted from a doc, tabs used for indentation, a missing closing `---`, and formatters rewriting a long single-line description into a folded scalar |
| Directory name ≠ frontmatter `name` | Skipped or ambiguous | The spec **requires** they match `[SPEC]` |
| Invalid `name` grammar | Rejected | 1–64 chars, lowercase alphanumeric + hyphens; no leading, trailing, or consecutive hyphens `[SPEC]` |
| Created mid-session | Not found | Skills are scanned at session start; restart |

### 3.7 Deliberate non-triggering

Anything with real side effects — deploys, commits, outbound messages, destructive operations —
should **not** be model-invocable. Make it explicitly user-invoked only `[FIELD]`. The failure
mode here is inverted: authors set this on a workflow skill, forget, and then spend a week
debugging why it "never triggers". It is working as configured.

---

## 4. Failure mode 2 — generic advice, no teeth

**Symptom:** the skill loads, the agent follows it, and the output is indistinguishable from
what you'd have got without it.

**Diagnosis:** read the body. If it contains *"write clean code"*, *"handle errors gracefully"*,
*"follow best practices"*, or *"you are an expert in…"*, you have found it. These are defaults
the model already gravitates toward. They change nothing.

### 4.1 Role-priming is close to a no-op

*"You are a senior front-end engineer with 10 years of experience"* had real effects on weaker,
older models. On frontier models it is approximately free-floating text — the model is already
operating as the expert you're describing `[FIELD]`.

This is worth internalising because role-priming is the single most common opening paragraph in
community skills, and it is pure cost.

### 4.2 Encode the decision, not the principle

The transformation that gives a skill teeth is replacing **universal principles** with
**local decisions**. A principle is something the model already knows. A decision is something
only your codebase knows.

| Principle (noise) | Decision (signal) |
|---|---|
| "Handle errors gracefully." | "Wrap external calls in `withRetry`. Surface failures through `AppError`, never raw exceptions." |
| "Write good tests." | "Journey-level integration tests against a real DB. No unit fan-out." |
| "Follow our conventions." | "Branch names are `<type>/gol-<n>-<kebab-slug>`. Commits are conventional. Never merge your own branch to main." |
| "Be careful with migrations." | "Run `$(cat db/schema.sql)` first and diff against it before writing the migration." |

The test: **could this line have been written by someone who had never seen this repository?**
If yes, delete it.

### 4.3 Don't railroad

The opposite over-correction is equally damaging: a skill written as a rigid script of `ALWAYS`,
`NEVER`, and `MUST` in capitals. The model follows the letter and misses every edge case the
script didn't anticipate. It works the day you write it and breaks the first time reality
differs `[FIELD]`. Anthropic's own `skill-creator` flags all-caps `MUST`/`ALWAYS`/`NEVER` as a
yellow flag `[FIELD]`.

The resolution is not "fewer instructions" but a different *kind* of instruction:

> **Give the goal and the constraints. Let the agent choose the path. Reserve hard imperatives
> for the small number of things that are genuinely inviolable — usually safety, irreversibility,
> and independence properties.**

One reported before/after is instructive: an author replaced eight detailed email-processing
rules — all of which the agent followed correctly, producing useless output — with two
outcome-focused sentences: *"Which emails need my action, and which do I just need to know
about?"* They report roughly 3× better results `[FIELD]`. The eight rules specified the
procedure. The two sentences specified the outcome.

The complementary official guidance: **explain why a non-obvious instruction matters**
`[OFFICIAL]`. A rule with its rationale generalises to situations you didn't foresee; a bare rule
doesn't.

### 4.4 Gotchas are the highest-signal section you can write

The single most valuable block in a mature skill is its **Gotchas** section — the accumulated
list of specific places the agent trips `[OFFICIAL][FIELD]`.

It is valuable precisely because it cannot be derived. It is the residue of real failures:

```markdown
## Gotchas

- The staging DB rejects connections from outside the VPN — check first, the error is a
  confusing timeout rather than an auth failure.
- `make test` passes with a stale build. Run `make clean test` when a fix "doesn't take".
- The API returns 200 with an error body on validation failure. Check the body, not the status.
```

Treat it as a living artifact: every time the agent trips on something, add a line. This is the
mechanism by which a skill on day 90 is meaningfully better than the same skill on day 1 — not
because the model improved, but because the skill absorbed three months of corrections `[FIELD]`.

### 4.5 Give the agent code, not descriptions of code

*"One of the most powerful tools you can give Claude is code"* `[OFFICIAL]`. A checked-in script
is versioned, reviewable, testable, and — critically — costs no context to exist. Prose that
reconstructs the same procedure costs its full length on every activation and can be
misremembered.

If your skill contains a multi-line shell block that is the same every time, that block belongs
in `scripts/` and the skill should invoke it `[FIELD]`.

---

## 5. Failure mode 3 — bloated and context-hostile

**Symptom:** 800-line `SKILL.md`, everything front-loaded. Responses get slower and more verbose;
instructions start getting missed.

The underlying reason this hurts is not merely token cost. Context is a **finite attention
budget** `[OFFICIAL]`. Every line you add competes with every other line, including the harness's
own core behavioural programming. There is also a practical ceiling on how many instructions a
frontier model reliably follows — reported in the 150–200 range, with the harness's own system
prompt already consuming a chunk of it `[FIELD]`. You are not filling an empty container.

### 5.1 The budgets

| Thing | Target | Tier |
|---|---|---|
| `description` | 1–1,024 chars allowed; 200–400 in practice | `[SPEC]` / `[FIELD]` |
| `SKILL.md` body | Under ~5,000 tokens recommended; "under 500 lines" is the recurring authoring target | `[SPEC]` / `[OFFICIAL]` |
| Reference files | No documented limit; keep each focused | `[OFFICIAL]` |
| Reference depth | One level from `SKILL.md`. Never `SKILL.md → advanced.md → details.md` | `[SPEC][FIELD]` |
| Long reference files | Add a table of contents above ~100 lines | `[FIELD]` |

The one-level rule matters more than it looks: nested chains materially increase the odds the
agent reads part of the target and silently misses the rest `[FIELD]`.

### 5.2 Hub and spoke

The structural fix for a bloated skill is to make `SKILL.md` a **routing table** rather than a
container:

```
skill-name/
├── SKILL.md          ← 30–80 lines: when to use, the method, and a symptom→file routing table
├── references/
│   ├── api.md        ← loaded only when the task touches the API
│   ├── migrations.md ← loaded only when the task touches migrations
│   └── gotchas.md    ← loaded when something goes wrong
├── scripts/
│   └── validate.py   ← executed; source never enters context
└── assets/
    └── template.json
```

The hub dispatches on symptoms; the spokes hold depth; the agent pays only for what it opens
`[FIELD]`.

> [!IMPORTANT]
> **Progressive disclosure is a tool, not a virtue.** A 60-line skill that says everything it
> needs to say in 60 lines should be one flat file. Splitting it into a hub plus three spokes
> adds indirection, adds the risk that a spoke never gets read, and buys nothing. Reach for
> hub-and-spoke when the body is genuinely over budget or when different tasks need genuinely
> different subsets — not as a default aesthetic.

### 5.3 One job per skill

If the description needs an "and", consider splitting `[FIELD]`. Smaller skills trigger more
reliably (a tighter description matches more sharply) and cost less when they do.

The finish-this-sentence test: **"This skill exists to ______."** If you need a conjunction, you
have two skills.

### 5.4 Sprawl is the systemic version

Individual skills stay reasonable while the *collection* becomes the problem. One documented
audit tracked a personal collection growing from 16 to 48 skills in 15 days `[FIELD]`. The
practical disciplines:

- Audit whenever any single scope exceeds ~10 skills.
- Sorting rule: **used in only one project → move it to that project. Otherwise → global.**
  Project-specific skills sitting in a global scope pollute every other project's budget.
- Disable rather than accumulate.

The strongest practitioners in the field reporting run **3–4 well-chosen skills**, not 40
`[FIELD][CONTESTED]` — though this is opinion converging, not measurement, and it comes from
people using skills as personal productivity tools rather than as a team's shared operating
manual. Weigh it accordingly.

---

## 6. Failure mode 4 — not grounded in reality

**Symptom:** the skill confidently references an API that doesn't exist, a convention nobody
follows, or a command that isn't installed. The agent follows it and hallucinates downstream.

This is the failure mode most specific to **agent-written skills**, because a model writing a
skill about a codebase it has only partially read will fill gaps with plausible invention — and
the resulting document reads exactly as confidently as a correct one.

### 6.1 Verify at authoring time

**Every factual claim in a skill must be traceable to something the author actually read.** One
documented approach makes this mechanical: extract each factual claim into a table, verify it
against source with a `file:line` reference, and tag it `VERIFIED`, `INFERRED`, or `UNCERTAIN` —
with a shipping gate of **zero `UNCERTAIN` claims** `[FIELD]`.

You do not need the full ceremony for a small skill. You do need the rule behind it: *if you
did not read it, do not assert it.*

### 6.2 Verify at run time

Authoring-time truth decays. Three mechanisms, in increasing strength:

**Preconditions.** Skills that depend on environment state the agent cannot see fail
mysteriously in fresh contexts. Put a check at the top and make the agent confirm its
assumptions before acting `[FIELD]`.

```markdown
## Preconditions

Before anything else, confirm:
1. `git rev-parse --show-toplevel` — you are in the repo root, not a worktree.
2. `docker compose ps` — the stack is up. If not, start it and wait for health.
3. The dashboard is on :7420. If not, everything below will fail confusingly.
```

**Inject live state instead of describing it.** Rather than documenting the schema in the skill —
where it will drift — have the skill pull the real thing at invocation time, e.g. reading
`db/schema.sql` as a first step. The agent then reasons against actual current state rather than
a snapshot someone wrote months ago `[FIELD]`.

**Ship scripts that fail loudly.** A script that exits non-zero with a useful message is a
verification mechanism. The spec asks for exactly this: self-contained, documented dependencies,
real error handling, useful output `[SPEC]`. Test the helper independently against a small
fixture before blaming skill selection when something goes wrong `[FIELD]`.

### 6.3 Skills expire

A skill written to compensate for a model weakness has a natural retirement date. When the
weakness goes away, the skill becomes training wheels — and can actively degrade output. One
documented case: a PDF skill that had run well for six weeks was making outputs *worse* after a
model update `[FIELD]`.

The retirement check, run after major model updates `[FIELD]`:

1. Run your standard tasks with the skill **disabled**. If scores land within ~5% of with-skill,
   the skill is coasting.
2. Price the token overhead against that delta.
3. Read transcripts, not just outputs — a skill can make the agent take a longer path to the
   same place.
4. Test on **new** prompts. Your original test set may be accidentally tuned to the skill's
   strengths.

Note that this applies to *capability-uplift* skills. A skill that encodes **your** conventions,
**your** infrastructure, or **your** process does not expire, because no model update will teach
the model your branch naming.

---

## 7. When not to write a skill

The most valuable thing this doctrine can do is stop you writing skills that shouldn't exist.

### 7.1 The unit-selection table

| What you actually have | Right unit | Why |
|---|---|---|
| A durable rule that must hold for *every* task | Rules file (`AGENTS.md` / `CLAUDE.md`) | Ambient instruction is loaded by scope, not selected by routing |
| A one-off, user-selected action | Slash command or plain prompt | The user selects it; no semantic routing needed |
| A reusable multi-step capability with references or scripts | **Skill** | Progressive discovery and on-demand resources are exactly the fit |
| A live read/write against an external service | Tool / MCP server | Needs a typed action surface, not prose |
| A separate role, context window, model, or permission set | Subagent | Isolation and capability config are first-class |
| A reusable prompt template with arguments | MCP prompt | The protocol defines discovery and argument passing |
| **A rule that must never be violated** | **Hook / linter / CI** | See below |

`[OFFICIAL][SPEC][INFERRED]` — the mechanics are documented; the mapping is a design inference,
not a normative rule.

### 7.2 Enforcement does not belong in prose

This is the strongest single argument in the field literature, and it deserves to be taken at
full strength rather than softened.

Instructions are **context, not enforcement**. The agent reads them and tries to comply. There is
no guarantee. And compliance measurably decays as a conversation goes on — one widely cited
curve reports 95%+ adherence in the first couple of messages, 60–80% by messages 3–5, and 20–60%
by messages 6–10 `[FIELD]`. That figure is a secondary report attributed to an individual
developer rather than a controlled study, so hold it loosely — but the *direction* matches
everyone's lived experience.

The conclusion practitioners draw `[FIELD]`:

> If you would reject a PR for violating it, it belongs in a hook, a linter, or CI — not in a
> markdown file. Putting *"use 2-space indentation"* in a rules file means the agent must
> remember and apply it on every edit. Putting `prettier --write` in a post-edit hook means it
> happens every time, forever, without consuming a single token of instruction budget.

One analysis classified a real rules file and found **84% of its rules were mechanically
enforceable**, leaving 16% that genuinely needed to be prose `[FIELD]`. That ratio is a good
prompt for your own: read your skill and ask which lines a script could enforce instead.

### 7.3 The dissent, stated fairly

A serious body of practitioner opinion holds that skills are over-used and mostly net-zero. The
doctrine is stronger for engaging with it than for ignoring it.

**The strongest empirical version, with verification applied:**

A benchmark of **49** skills reports **39 with no measurable improvement, 7 with meaningful
gains, and 3 that made things worse** `[CORRECTED]`. This finding circulates attached to a
separate article that tested **20** skills — the two are different studies and the 39/7/3
breakdown does **not** belong to the 20-skill test. Cite it as the 49-skill benchmark or not at
all.

A study of LLM-generated context files across four coding agents and 300 SWE-bench Lite tasks is
widely quoted as showing a **~20% decrease in success rate**. That is wrong `[CORRECTED]`. The
paper reports roughly a **20% increase in cost**, with resolution changes of **−0.5%** and
**−2%** on its two benchmarks — and explicitly notes the performance changes were **not
statistically significant**. The honest reading is: *auto-generated context files cost real money
and bought nothing measurable*, which is damning enough without the exaggeration.

A frequently cited claim that a marketplace audit found 36% of ~4,000 skills had security issues
with 76 confirmed malicious traces only to a secondary retelling; the primary audit could not be
located `[UNVERIFIED]`. The underlying caution is still sound and independent of the numbers:
**a skill is executable influence over your agent's behaviour.** Install only what you can read.

**The qualitative dissent**, which needs no statistics:

- Instruction budget is finite and every line competes.
- The best rules file is the one that actually gets read — a short one gets read, a 2,000-line
  one gets skimmed.
- A widely circulated "template" rules file is a menu to choose from, not a thing to append
  wholesale.
- Deterministic mechanisms don't sleep, don't deprioritise, and don't decay over a long session.

**The synthesis.** The dissent is not that skills are useless. It is that (a) skills are routinely
misapplied to enforcement, where deterministic mechanisms are strictly better, and (b) most
published skills restate model defaults and therefore buy nothing. Both critiques are answered by
the same discipline this document argues for: the A/B delta test (§2.2) and the deletion test
(§2.3). A skill that survives both is not what the dissent is complaining about.

---

## 8. Subagent and persona definitions

Everything in §3 about descriptions applies here — with the stakes raised, because a subagent's
description is the *only* thing routing work to it, and a subagent that never gets delegated to
is invisible in exactly the same way.

### 8.1 The description is a delegation router

Write it as **when to delegate here**, not **what this agent is** `[OFFICIAL][FIELD]`. Vague
descriptions produce essentially random invocation. If you want proactive delegation, say so
explicitly — phrasings like *"use proactively"* or *"use immediately after X"* are reported to
work `[FIELD]`.

Be aware of a real limitation: even with a matching description, the main session frequently just
handles the task itself. The reliable path to invoking a specific agent is explicit — naming it
`[FIELD]`. Design for that: your description should make *explicit* selection easy for a human
too, and your architecture shouldn't depend on automatic delegation firing every time.

### 8.2 The body is a job brief for someone who just walked in

A subagent starts with **no conversation history, no files read, and no skills loaded** beyond
what its configuration injects `[OFFICIAL]`. The body must stand entirely alone.

The six-part contract:

1. **Mission and non-goals.** What this agent exists to do, and explicitly what it must not do.
2. **Inputs it may trust**, and how to inspect for missing context rather than assuming it.
3. **Allowed tools and permitted side effects.**
4. **An ordered method, including when to stop.**
5. **Evidence standard and output schema** — exactly what to return and in what shape.
6. **Escalation path** for ambiguity, missing credentials, or anything unsafe.

`[INFERRED]` — this layout is authoring synthesis from the documented fresh-context model, not a
schema any harness enforces.

Three things make a persona body actually work in practice `[FIELD]`: a **trigger procedure**
("When invoked: 1… 2… 3…"), a **checklist rather than prose**, and an explicit **output
contract**. The output contract is the one most often omitted and most often regretted — without
it, you get a different report shape every time and the orchestrator can't parse results
reliably.

### 8.3 Tool scoping is a safety mechanism, not a config detail

Restricting tools is the single most effective way to make a subagent focused and safe `[FIELD]`.

The canonical example is worth stating plainly: **a reviewer that cannot write files cannot
"fix" a problem by quietly rewriting it — it has to report it.** The restriction doesn't just
prevent damage; it forces the behaviour you actually wanted.

Default to the smallest set that lets the work happen. Note that tool restriction is capability
control, not a substitute for permission review `[OFFICIAL]`.

### 8.4 Model selection by role

Smaller/faster models for search, file discovery, and routine summarisation; mid-tier for
analysis and most coding; the largest only for genuinely hard reasoning. The field observation
worth remembering: **bigger models with long mandatory reading tend to lose focus, and faster
models often produce better results on tightly scoped tasks** `[FIELD]`.

### 8.5 Independence is structural, not declared

If you spawn an agent to review work, and that agent inherits the full context in which the work
was produced, you have not got fresh eyes — you have your own eyes running in a second process.
Confirmation bias follows. One documented case had a context-inheriting reviewer miss a
constant-time comparison security bug that a fresh-context reviewer caught `[FIELD]`.

> [!WARNING]
> A related claim is widely circulated: that a **32.3 percentage point** performance drop occurs
> when the same model evaluates outputs generated in shared context, citing a specific paper.
> Verification found the paper exists but is about **homogeneous multi-agent debate and
> consensus collapse**, reporting an "oracle gap up to 32.3 percentage points" — it does **not**
> establish the evaluator-in-shared-context claim `[CORRECTED]`. The architectural principle
> stands on the documented case and on plain reasoning; the statistic does not belong to it.

The practical rule: **reviews and audits get fresh context. Design-continuity work gets inherited
context.** Choose deliberately.

### 8.6 Over-delegation is a real failure mode

Spawning a subagent has genuine overhead — each is a full session with its own startup and
context. Spawning one to answer something the main session could have answered directly is pure
waste, and current models have a documented tendency to over-delegate `[FIELD]`.

Multi-agent *teams* are more expensive again — one practitioner estimate puts coordinated teams
at roughly 15× the tokens of a single session versus ~4–7× for subagents `[FIELD]`. That figure
is a secondary report without a retrieved primary source, so treat it as an order-of-magnitude
signal rather than a price list. The directional guidance is solid: use coordinated teams only
when workers genuinely benefit from each other's findings *during* execution. Sequential work,
same-file edits, and mostly independent tasks are faster and cheaper without them.

### 8.7 Persona drift

Agents demonstrably violate their own explicitly-loaded behavioural rules mid-session — reading
them at startup, citing them correctly when challenged, and then not following them. Reported
attempts to fix it with more memory files, more rules, and repeated verbal correction did not
reliably work `[FIELD]`.

The design conclusion is the same as §7.2: **if a behaviour genuinely must hold, do not rely on
the persona to hold it.** Put it in a gate, a hook, a tool restriction, or a check that runs.
Tool scoping (§8.3) is persona enforcement that actually enforces.

---

## 9. Testing and evaluation

### 9.1 Three layers

| Layer | Question | Method |
|---|---|---|
| **Trigger** | Given this phrasing, does it activate? | ~20 queries, half should-trigger and half should-not. The negatives must be **near-misses**, not obviously unrelated. Run each several times — activation is not deterministic |
| **Quality** | Is the output better than without? | Same task with and without. The delta is the value (§2.2) |
| **Process** | Is every part of the skill pulling weight? | Read the execution transcript. If the agent skips the same step across three runs, delete that step |

`[FIELD]`

### 9.2 First-party tooling

Anthropic's `skill-creator` ships an evaluation loop: define test prompts, describe expected
output, run with and without, compare, revise from observed failures, expand the test set, and
separately optimise the description for triggering accuracy across positive, negative, and
ambiguous queries `[OFFICIAL]`. Later versions add parallel evaluation in clean contexts, blind
A/B comparison, benchmark mode, and automated trigger tuning.

The one hard published result: description tuning **improved triggering on 5 of 6 public skills**
`[OFFICIAL]`. Commonly attached methodology details — a 60/40 train/test split, up to 5
iterations — are **not** in the official announcement `[UNVERIFIED]`.

Also reported: an unedited generated draft is worth roughly nothing without editing `[FIELD]` —
which is precisely the problem this doctrine exists to solve. **Generate a draft, then apply
§2's three tests to it.** The draft is a starting point, not a deliverable.

### 9.3 Regression

Skills fail silently and stay failing. Two protections `[FIELD]`:

- Keep the trigger matrix as a regression suite and re-run it after adding skills, editing
  descriptions, or updating the harness.
- Keep a baseline of graded outputs so quality drift is visible rather than vibes-based.

**Write the rubric before you run the eval.** The rubric is the specification of what good looks
like; writing it afterwards means grading against whatever you happened to get `[FIELD]`.

---

## 10. Evidence ledger

Everything the verification pass checked, and what happened to it. Consult before quoting any
number from this document elsewhere.

| Claim | Verdict | The accurate version |
|---|---|---|
| Trigger rates: ~20% unoptimised → ~50% optimised → up to 90% with examples | **CONFIRMED, weak source** | Source exists and says this. Community self-report over 200+ prompts, not a vendor benchmark. Use the shape, not the digits |
| "Tested 20 skills; 39 no difference / 7 gains / 3 worse" | **CORRECTED** | Two different studies conflated. The 39/7/3 breakdown belongs to a separate **49**-skill benchmark |
| LLM-generated context files cut success ~20% (4 agents, 300 SWE-bench Lite) | **CORRECTED** | Setup is right. The finding is ~20% **cost increase**, with −0.5% / −2% resolution, **not statistically significant** |
| Marketplace audit: 3,984 skills, 36% with issues, 76 malicious | **UNSUPPORTED** | Traces only to a secondary retelling; primary audit not found. Don't cite the numbers; the caution stands independently |
| Listing budget: `skillListingBudgetFraction` 1%, `skillListingMaxDescChars`, `SLASH_COMMAND_TOOL_CHAR_BUDGET=30000`, silent pre-2.1.129 | **PARTIAL** | The phenomenon is real and issue-documented (175 descriptions dropped at 1%; ~16,000-char budget, 42 of 63 visible). The other three specifics are unverified |
| Official docs call "pushy" descriptions an anti-pattern | **REFUTED** | No such warning exists. Docs warn against **vagueness**. `skill-creator` genuinely does recommend "a little bit pushy". There is no contradiction — see §3.3 |
| `description` capped at 1,024 chars | **CONFIRMED** | Spec: 1–1,024 |
| Combined listing text truncated at 1,536 chars | **UNVERIFIED** | Not found in official sources. Folklore until shown otherwise |
| `SKILL.md` under 500 lines | **CONFIRMED** | Current official authoring guidance |
| 32.3pp drop when the same model evaluates shared-context outputs | **REFUTED as stated** | Paper exists but concerns homogeneous multi-agent debate and consensus collapse ("oracle gap up to 32.3pp") |
| Compliance decay 95% → 60–80% → 20–60% | **CONFIRMED as secondary quotation** | Real quote in the cited article, attributed to an individual developer. No primary measurement retrieved |
| Agent teams ~15× tokens vs ~4–7× subagents | **CONFIRMED as secondary statement** | Stated in the cited analysis; primary vendor cost table not retrieved |
| Trigger tuning improved 5 of 6 public skills | **CONFIRMED** | Official announcement. The 60/40 split and 5 iterations are **not** in it |
| Repo star counts (67k / 50k / 14k) | **UNVERIFIED** | Budget exhausted before checking. Not used anywhere in this document |

**Overall posture on field statistics:** keep the qualitative findings, which held up well; treat
the numbers as attributed claims rather than facts unless this ledger marks them CONFIRMED
against a primary source.

---

## Appendix A — Agent Skills mechanics

### A.1 Directory layout `[SPEC]`

| Path | Status | Role |
|---|---|---|
| `skill-name/SKILL.md` | **Required** | Metadata is discoverable; body is read on activation. Directory name **must** equal frontmatter `name` |
| `skill-name/scripts/` | Optional | Executed when needed; source need not enter context |
| `skill-name/references/` | Optional | Read on demand. Keep focused, relative paths, avoid deep chains |
| `skill-name/assets/` | Optional | Templates, images, data |
| Other directories | Allowed | Host-dependent; don't assume portability |

### A.2 Frontmatter `[SPEC]`

| Field | Required | Type | Limit / grammar |
|---|---|---|---|
| `name` | **Yes** | String | 1–64 chars; lowercase alphanumeric + hyphens; no leading/trailing/consecutive hyphens; equals parent directory |
| `description` | **Yes** | String | 1–1,024 chars, non-empty. What it does **and** when to use it |
| `license` | No | String | Short name or pointer |
| `compatibility` | No | String | 1–500 chars. Environment/dependency requirements |
| `metadata` | No | String→string map | No fixed keys; semantics are **not** portable |
| `allowed-tools` | No, experimental | Space-separated string | Host support varies |

Host caveat: current vendor examples emphasise `name` and `description` as the generally required
fields; a client may ignore an optional field even in a formally valid document `[INFERRED]`.

### A.3 What is *not* specified `[SPEC][INFERRED]`

Worth knowing, because a lot of confident writing pretends otherwise:

- No universal package registry, marketplace protocol, version field, signature, or update
  semantics.
- **No specified matching algorithm, threshold score, trigger telemetry format, false-negative
  recovery behaviour, or portable way to force activation.** "It didn't trigger" is an observed
  harness outcome, not proof your description violated a formal matcher.
- No hard maximum on installed skills or total metadata budget.
- No standard way for a skill to request credentials, network access, or human approval.
- **No specification of an agent/subagent/persona file format at all** — every harness's agent
  file is host-specific.

### A.4 Claude Code subagent frontmatter `[OFFICIAL]`

| Field | Required | Behaviour |
|---|---|---|
| `name` | Yes | Unique, lowercase letters/hyphens; filename need not match |
| `description` | Yes | When to delegate here; the automatic-delegation router |
| `tools` | No | Allowlist; omitting inherits all available |
| `disallowedTools` | No | Denylist |
| `model` | No | Alias, full model ID, or `inherit` |
| `permissionMode` | No | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual` |
| `maxTurns` | No | Cap on agentic turns |
| `skills` | No | Injects the **full contents** of named skills at startup — not just descriptions |
| `mcpServers` / `hooks` / `memory` / `background` / `effort` / `isolation` / `color` / `initialPrompt` | No | As documented |

Discovery precedence: managed settings → session `--agents` → project → user → plugin; nested
project directories are walked and the closest definition wins.

Operational defaults: **200 subagents per session**, **20 concurrent**. A default subagent
**cannot spawn another subagent** unless nesting depth is explicitly configured.

---

## Appendix B — Cross-harness portability

| Harness | Unit & location | Routing fields | Trigger | Portable? |
|---|---|---|---|---|
| **Agent Skills spec** | `skill-name/SKILL.md` + optional `scripts`/`references`/`assets` | `name`, `description` required | Host's choice | The **format** is portable; matching and packaging are not specified |
| **Claude Code skill** | `~/.claude/skills`, `.claude/skills`, plugins | SKILL.md metadata | Auto-match + explicit `/name` | CC implementation |
| **Claude Code subagent** | agents dirs (see A.4) | `name`, `description` + rich optional config | Description-routed delegation or explicit | CC implementation, **not** the skills spec |
| **Codex skill** | Skill dir with SKILL.md; plugin-packageable | Minimal `name`/`description` | Explicit request or applicability | Compatible SKILL.md shape |
| **Codex `AGENTS.md`** | Global + repo + nested | No frontmatter schema | Ambient by scope; closer overrides | Not a skill. Default 32 KiB project-doc cap |
| **Codex custom agent** | `~/.codex/agents`, `.codex/agents` | `name`, `description`, `developer_instructions` | Applicability + explicit spawn | Codex implementation |
| **OpenCode skill** | `.opencode/skills`, config dir, and compatible `.claude`/`.agents` paths | Recognises `name`, `description`, `license`, `compatibility`, `metadata`; **ignores unknown keys** | Native skill tool exposes metadata; body read on demand | Portable frontmatter subset |
| **OpenCode agent** | `opencode.json` or Markdown agent files | `description` required; `mode`, `model`, `prompt`, `permission`, `steps` | Description delegation or `@` mention | OpenCode implementation |
| **Cursor rule** | `.cursor/rules/*.mdc` | `description`, `globs`, `alwaysApply` | Always / glob-attached / agent-requested / manual | Cursor implementation; not SKILL.md |
| **MCP prompt** | Server prompt definition | `name`, `description`, typed arguments | **User-selected**, not model-matched | Portable protocol, but a different thing entirely |

**What is genuinely portable:** the SKILL.md *shape* (frontmatter + markdown body + bundled
resources), the discipline of description-as-router, progressive disclosure as a cost strategy,
and every principle in §§2–7.

**What is an implementation detail:** all trigger mechanics, every token budget, all agent/persona
file formats, packaging and distribution, and permission models. Never hardcode these into a
skill that is meant to be portable — and note that OpenCode silently ignores frontmatter keys it
doesn't recognise, so a skill authored against one harness's extended fields degrades quietly
rather than loudly.

---

## Appendix C — Applying this to golem

Grounding the doctrine in the local corpus, since a doctrine that can't be applied to the repo
it lives in isn't grounded.

**Current shape** (`substrate/skills/`, 19 skills, measured 2026-07-25): bodies run **29–168
lines / 210–1,261 words**. Only 3 of 19 bundle subdirectories (`references/`, `templates/`,
`agents/`). Agent cards live in `substrate/agents/` with `model` and `tools` set explicitly.

**Where golem is already ahead of the median community skill:**

- **Descriptions are trigger-shaped, not summaries.** `verify-done` opens *"Read before moving
  any ticket to `built`, `verifying`, `verified`, or `done`, or before accepting a worker's DONE
  or PR-open claim"* — that is a routing rule naming literal state values. Same pattern across
  the role skills and the `reviewer` agent card.
- **Bodies are well inside budget.** The largest is 168 lines against a 500-line target; nothing
  is close to bloated.
- **Tool scoping is already practised.** `reviewer` ships `tools: Read, Bash, Glob, Grep` — it
  structurally cannot fix what it finds, which is §8.3 done correctly.
- **Enforcement already partly lives outside prose** — phase machines and transition artifacts
  are enforced server-side rather than requested politely, which is §7.2's argument.

**Where the doctrine says there is room:**

1. **No trigger matrices exist.** Descriptions are well-shaped by inspection, but nothing
   verifies they fire — particularly for near-neighbour pairs that plainly compete:
   `standalone` vs `managing`, `reviewing` vs `verify-done`, `tracker` vs `verify-done`,
   `live-team` vs `standalone`. §2.1 applied to those four pairs is the highest-value next action.
2. **No anti-triggers anywhere.** Given those competing pairs, "do not use for X, use Y" lines
   are indicated (§3.4). `live-team` already does this in prose — it should be in the
   description, where routing actually happens.
3. **No A/B delta has ever been measured** for any golem skill. §2.2 is unrun. This is the honest
   gap: the skills are well-built by construction, and unproven by measurement.
4. **Progressive disclosure is correctly *not* over-applied.** The flat-file default is right at
   these sizes; don't add hub-and-spoke for its own sake (§5.2).

---

## Appendix D — Worked template

A skill that passes all three tests in §2, with commentary. Delete the commentary when you use it.

```markdown
---
name: deploying-staging
description: Deploy the API to staging, verify health, and roll back on failure. Use when the
  user asks to deploy, ship, push to staging, or cut a staging release, or asks to roll back a
  staging deploy. Do not use for production deploys — use `deploying-production`.
---

# deploying-staging

<!-- No role-priming. No "you are an expert". Straight to the contract. -->

## Preconditions

Confirm before anything else; these fail confusingly if skipped:

1. `git rev-parse --abbrev-ref HEAD` — must not be `main`.
2. `doctl auth list` — credentials present. If not, stop and ask; do not guess.
3. `curl -sf https://staging.example.com/health` — record the pre-deploy state so a rollback
   has something to compare against.

## Method

<!-- Goals and constraints, not a rigid script. The one hard rule is the irreversible one. -->

1. Run `scripts/preflight.sh`. It exits non-zero with a specific message on failure — read the
   message rather than re-running.
2. Deploy with `scripts/deploy.sh staging`.
3. Poll health for up to 90s. Two consecutive 200s counts as healthy.
4. **If health does not recover, roll back immediately with `scripts/rollback.sh` before
   investigating.** Debugging a broken staging environment while it is broken costs the team
   more than the information is worth.
5. Report: the deployed SHA, health status, and elapsed time.

## Gotchas

<!-- Living section. One line per real failure. This is the highest-signal block here. -->

- The health endpoint returns 200 with an error body during migrations. Check the body.
- `deploy.sh` needs the VPN. The failure surfaces as a DNS timeout, not an auth error.
- A stale build can make a fix appear not to apply. `make clean` first when that happens.

## When NOT to use

- Production deploys → `deploying-production`.
- Local dev environments → `docker compose up`, no skill needed.
- Investigating an already-broken staging environment → `debugging-staging`.
```

What makes this pass:

- **Triggers** — literal user vocabulary ("ship", "push to staging"), plus a named neighbour to
  route away from.
- **Teeth** — every instruction is repo-specific. Not one line could have been written by someone
  who had never seen this system.
- **Economy** — the real logic lives in scripts, which cost nothing to have and only their output
  to use. The body is a method, not an implementation.
- **Grounded** — preconditions verify environment state; scripts fail loudly; gotchas record
  actual observed failures rather than imagined ones.

---

## Sources

Primary specifications and first-party documentation (lane A, GOL-95):

- Agent Skills specification — <https://agentskills.io/specification>
- Agent Skills overview — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
- Agent Skills best practices — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
- Equipping agents for the real world with Agent Skills — <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- Effective context engineering for AI agents — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Building effective agents — <https://www.anthropic.com/engineering/building-effective-agents>
- Writing tools for agents — <https://www.anthropic.com/engineering/writing-tools-for-agents>
- `skill-creator` source — <https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md>
- Shipped skills corpus — <https://github.com/anthropics/skills>
- Claude Code subagents — <https://code.claude.com/docs/en/sub-agents>
- Claude Code plugins — <https://code.claude.com/docs/en/plugins>
- OpenAI Codex skills — <https://developers.openai.com/plugins/build/skills>
- Codex `AGENTS.md` — <https://developers.openai.com/codex/guides/agents-md>
- Codex subagents — <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- OpenCode skills / agents / permissions — <https://opencode.ai/docs/skills>, <https://opencode.ai/docs/agents>, <https://opencode.ai/docs/permissions>
- Cursor rules — <https://docs.cursor.com/context/rules-for-ai>
- MCP server prompts — <https://modelcontextprotocol.io/specification/2025-06-18/server/prompts>

Field evidence (lane B, GOL-96) spans ~76 sources — community skill collections and
marketplaces, trigger-failure troubleshooting guides, skill-sprawl postmortems, eval harnesses,
subagent design guides, tracked harness issues, and the dissenting analyses. The full inventory
with per-source value notes is in the lane B report; every statistic drawn from it into this
document has been through §10's ledger.

Verification pass (GOL-97) re-checked twelve load-bearing claims against primary sources; its
verdict table is §10 and its own source list is appended to the lane A report.
