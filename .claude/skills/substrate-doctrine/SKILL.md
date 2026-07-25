---
name: substrate-doctrine
description: Accumulated doctrine for revising golem's agent instructions — substrate/instructions/AGENTS.md, role cards, skills, the work loop, delegation, and authority. Load BEFORE editing any of those, before adding or removing a role or skill, before "fixing" an instruction bug, and before proposing a memory/continuity layer. Carries the shipping mechanics, the operator model, the known-contradiction inventory with file:line, the role-vs-mode test, and the decision log so a fresh session does not re-derive a 1,600-line audit.
---

# Substrate doctrine

Reference for anyone revising how golem's agents are instructed. Everything here was
derived from a full audit of `substrate/` plus a ~1,579-session transcript retrospective
(2026-04-30 → 07-16). It exists so a future session does not repeat that work.

**Status:** doctrine as of 2026-07-25. The audit inventory in §6 is a snapshot — verify
line numbers before quoting them, and update this file when you fix an item.

---

## 1. Mechanics — where things live, how they ship

**`substrate/` is the source of truth. `plugin/` is a generated render.**

| What | Path |
|------|------|
| Root agent rules | `substrate/instructions/AGENTS.md` |
| Role cards (thin, 3–6 lines) | `substrate/roles/<role>.md` |
| Skills (detailed SOPs) | `substrate/skills/<name>/SKILL.md` |
| In-process subagents | `substrate/agents/{worker,researcher,reviewer}.md` |
| Golem-repo-only project skills | `.claude/skills/<name>/SKILL.md` ← *this file* |

### Never edit these directly

- `plugin/**` — generated. Regenerate with `golem sync --target cc --out ./plugin --force`.
- `~/.claude/CLAUDE.md` — the global rules are a *render* of `substrate/instructions/AGENTS.md`.
  Editing the global file directly gets silently overwritten on next sync.

### Edits are inert until synced

```bash
golem sync --target cc          # re-render ~/.golem/renders/cc-plugin/
# bump version in root package.json
claude plugin update golem@golem-workspace
# then /reload-plugins in the session
```

Skipping the version bump is the classic trap: the render updates, the installed plugin
does not, and you spend an hour debugging an instruction that never shipped.

### Multi-harness guards

Substrate is templated with Handlebars: `{{#if claudecode}}…{{/if}}` and
`{{#if opencode}}…{{/if}}`. Anything harness-specific **must** be guarded — opencode has
no golem lifecycle hooks, so hook-dependent instructions are false there. See
`substrate/skills/journaling/SKILL.md` for the pattern.

### Scope rule for skill content

A skill under `substrate/skills/` ships to **every** project. Golem-repo specifics
(port 7420, `mcp/channel/node_modules`, `golem sync`, `GOL-` ticket prefixes,
`dashboard/scripts/_scratch.mjs`) belong in the golem repo's own `AGENTS.md`, not in a
global skill. Two skills currently violate this — see §6.

---

## 2. The operator model

Instructions here are written for one human with a specific, well-documented working
style. Design *for* the strengths; compensate *for* the weaknesses.

### Strengths to lean on

- **Writes execution contracts, not prompts.** 595/773 sub-agent briefs carried explicit
  scope boundaries; 251 named read-first files. Assume dispatch briefs will be good.
  Instructions can rely on the brief being specific.
- **Falsifiability instinct.** Caught a *fabricated* PR approval via independent `gh`;
  caught cross-file fixture drift a 69/69 subset missed; caught an "auth implemented"
  claim that was a local-env bypass on a read-only socket. Evidence rules will be
  honoured and enforced — write them tightly, they will be used.
- **Demands mechanism before options.** Wants the causal model, not a comparison table.
  Skills that explain *why* get followed; skills that only prescribe get argued with.
- **Recomputes from changed premises.** State a premise change and the analysis gets
  rerun, not patched.

### Weaknesses the substrate must absorb

| Weakness | What the substrate must do |
|---|---|
| **Authority mode is under-signalled** — same words for "explain this" and "build this" | Encode answer-first as the *default* for interrogative turns. Never make the agent infer intent from enthusiasm |
| **Constraint tax** — re-types the same rules every session ("single-file zero deps", "deep probe not summary", "JSON only no fences") | Durably encode recurring constraints. Every re-typed constraint is a substrate bug |
| **Rule sprawl, never retires** — 107 memory files, 29 feedback rules, reversals still live | Every durable rule needs scope + trigger + why + review condition. Adding a rule without a retirement path is net-negative |
| **Insight rarely converts** — ~50 analysed recommendations sit unadopted | Any analysis must land in a durable slot (decision record / spec / skill) in the same session, or it evaporates |
| **Meta-work crowds product work** | Keep substrate changes small and reversible. A quarter-long harness rewrite is the failure mode, not the fix |
| **Many parallel fronts** (24 namespaces / ~11 weeks) | Optimise for cold re-entry. Assume the reader has forgotten everything |

### Output contract

Compact full-width prose. Tables over paragraphs for lookups. Plain language before IDs —
ticket numbers are references, never the load-bearing noun. Every substantial turn ends
with done / in-progress / next. Two deliberate resolutions for decisions: a glanceable
brief *and* an evidence dossier — never one compromised middle. Rewrites are recomposed
from source, never written as diffs against an old draft.

---

## 3. Why instruction bugs happen here — three structural diagnoses

Every instruction bug found so far traces to one of these. Check them first.

### 3.1 Two operating models layered on top of each other

*Fixed in GOL-92 (2026-07-25); recorded because it is the pattern most likely to recur.*

`AGENTS.md` disabled cross-session delegation while roughly **40% of the substrate still
described the cross-session team model** — role cards, `managing`'s Distribution and Built
event loop, `consulting`'s Ask section, `night-shift`. A session loaded a confident,
complete, **action-shaped** SOP for a world that did not exist, then had to improvise.

**Improvisation under conflicting instructions resolves toward action**, because
action-shaped guidance outweighs a short restraint clause. That was the generator of the
whole bug class — not any single badly worded rule.

Corollary: **the pipeline dead-ended.** A planner could not dispatch builds and had to hand
off to a manager it could not reach, so feature work had no legal path to completion in the
default configuration.

**How to avoid recreating it:** when you disable a capability, move its SOP out in the same
change. A disabled capability whose instructions remain is worse than either state alone.
Cross-session content now lives in `golem:live-team` and nowhere else — keep it that way.

### 3.2 The same fact is stated in three places and has drifted

Ownership lives in `AGENTS.md`'s table, each role card's `Boundaries:` line, *and* each
role skill's `Own`/`Never` sections. All three disagree already. Whenever you find an
instruction bug, check whether the fact has copies — the bug is usually the disagreement,
not any single copy.

### 3.3 Size and authority are different axes, and conflating them inverts behaviour

The original `Size, Then Act` classified on **magnitude** (`question/chat | tiny | feature-sized+`).
But the highest-cost failure is *feature-sized in magnitude, question in authority*:
"how hard would it be to add retry semantics?" Size wins the classification, the
feature-sized branch fires, and the agent starts working on a question.

**Resolve authority before size. Size never grants authority.**

---

## 4. Design principles

### 4.1 Authority is not identity

- **Role** = *who you are.* Persistent for the session. Determines what class of work you
  own and **what "execute" means for you** (builder writes code; explorer reads and reports).
- **Authority/mode** = *what this turn permits.* Volatile, per-turn. Determines **whether
  you may change state at all.**

```
authority = f(inbound event kind, ticket kind, role)
```

All three inputs already exist. Do **not** add a mode field, a mode entity, or a mode
picker — write down the truth table instead.

**Proof they are orthogonal:** a builder asked "how hard would this be?" must answer, not
implement. A manager asked "what do you think?" must answer, not dispatch. Role constant,
authority different. And every documented instance of the mode failure was a **direct user
turn**, not a dispatch — i.e. precisely the case roles and dispatch do *not* cover.

**Historical proof that storage is not the fix:** `feedback_questions_are_not_work_orders.md`
already existed, was loaded, and the failure still happened. The classification problem is
at the **input**, not at retrieval.

### 4.2 When does a new role earn a row?

The pressure to add roles comes from authority being baked into identity. Decouple them
and few roles cover everything. Before adding one, it must pass **all four**:

1. **Distinct authority** — it may permit or *reject* something no existing role can.
   (Read-only is a *tool* constraint, not an authority. Do not confuse them — that mistake
   nearly cost us the `reviewer` role.)
2. **Distinct failure mode** — it fails differently, so it needs different guardrails.
3. **Structural independence** — the work is invalid if the same actor does it and
   something else (e.g. authoring and reviewing).
4. **Not a situation.** Situations change per turn; identities per session. `consultant`
   failed this test (it is a mode any session enters on inbound `consult`).

Sockets already in the substrate are strong evidence a role is real: `planning/SKILL.md`'s
`designed` gate says *"or agent sign-off"* — an empty socket that waited for `reviewer`.

### 4.3 Verify and review are complementary, not redundant

| | Verification | Review |
|---|---|---|
| Asks | did the claimed evidence actually happen? | is this correct and complete, **including what the checklist missed**? |
| Standard from | the acceptance checklist | the reviewer's judgment + norms + stated intent |
| Catches | fabrication, stale claims | inadequacy, wrong premises, unasked questions |
| Fails by | rubber-stamping | missing the unasked; inventing findings to look thorough |

**Verification is bounded by acceptance criteria, so it cannot catch a wrong spec.** If the
design is flawed, the checklist derived from it is flawed, the builder satisfies it, the
verifier confirms every command ran, and a broken product reaches `done` with every gate
green. That is why review is a separate authority: *the authority to reject work that meets
its stated criteria.*

Both incidents in the record are real and distinct: the fabricated PR (verification would
have caught it) and the WebSocket auth bypass (only review would have).

### 4.4 Single-sourcing

Every fact appears **exactly once**. `AGENTS.md` carries authority, the loop, invariants,
the role table, and routing. Role cards *point*; they do not restate. Skills carry method.
If you find yourself writing a fact that exists elsewhere, delete one.

### 4.5 Loop steps and invariants are different things

A numbered list mixing "do this, then this" with "always be true" reads as neither. The
original 8-item Spine mixed sequence (1, 6, 7) with invariants (2, 3, 4, 5, 8), which is
why nobody followed it as a loop. Keep them in separate sections.

### 4.6 Never self-review

No actor verifies or reviews its own output. Solo sessions satisfy this with the in-process
`reviewer`/`researcher` subagents — fresh context, did not author the artifact. This is a
structural requirement, not a preference; it is what makes the review gates enforceable
without a live team.

---

## 5. Decision log

| Decision | Why | Rejected alternative | Why not |
|---|---|---|---|
| Authority resolved before size, in `AGENTS.md`'s opening section | The size-first taxonomy actively inverts behaviour on the highest-cost turn class | Prefix markers (`[Q]`, `[GO]`) on every prompt | Puts the tax on the human every turn; the whole point is to remove per-session tax |
| **Inverted default**: interrogative/evaluative turns are answer-first; only *authorization* is marked | Asymmetric cost — a wrong pause costs one turn, a wrong action costs real work and takes the decision away before the option space is seen | Symmetric marking, or agent judgment | Judgment is what already fails; symmetric marking is the tax again |
| Answer-first still permits **unlimited read-only** investigation | Otherwise the rule forces shallow answers and gets abandoned | Full freeze until authorized | Would trade one failure mode for a worse one |
| Detection via **explicit surface cue lists**, not intent inference | Models pattern-match enumerated cues reliably; "use judgment" is what broke | Semantic intent classification, or a `UserPromptSubmit` regex hook | Fragile NL regex, per-turn noise, Claude-Code-only |
| `standalone` becomes the **default** role | Cross-session is off; the operator works single-session-plus-subagents. Every documented failure came from a session that was effectively standalone while loading a team-shaped role card | Keep specialised roles as default | Recreates the dead-end and the improvisation pressure |
| `consultant` dropped as a role | It is a mode any session enters on inbound `consult` | Keep it | Phantom row with no file; fails test 4.2#4 |
| `reviewer` **added** as a role | Passes all four tests: distinct authority (may reject work meeting its criteria), distinct failure modes, requires independence from the author, fills an existing empty socket | Fold review into `explorer` | Conflated read-only with same-authority. Verification is checklist-bounded and structurally cannot catch a wrong spec |
| `explorer` **not** split into explorer + verifier | Authority is identical (read-only, report, never implement); the transition power comes from the dispatch, not the identity. Recon and verify are two methods in one skill | Split them | Would be adding a role for a *situation* — the exact mistake 4.2 forbids |
| Review is **blocking with a recorded override** | Advisory findings get waved through — that is the unadopted-insight failure again. A recorded override keeps the human in control without making the gate decorative | Advisory-only; or hard-blocking | Advisory is decorative; hard-blocking makes a wrong finding stall work |
| Reviewer **never fixes** what it finds | A reviewer who edits becomes an author and loses standing | Let it fix trivia | Destroys the independence the role exists for |
| Cross-session content **quarantined** into an opt-in skill, not deleted | Default is off; the fabricated-PR incident came from live-session trust; 40% dead content is actively harmful. Reversible — capability preserved | Restore cross-session; or delete it | Restoring recreates the trust surface that burned us; deleting loses a real capability |
| Self-verification allowed; self-**review** never | Re-running a command whose output you did not author carries no fabrication risk. Blanket "never verify your own work" made the default solo role illegal | Forbid both | Would have made `standalone` — the default — unable to close anything |
| `Never` rows bind the **hat**, review-independence binds the **session** | One session must be able to plan then build; it must never review its own output. Stated in § Roles so the single source carries its own resolution rule | Leave the hat-change doctrine only in `golem:standalone` | Then `manager`/`planner` skills appear to violate their own `Never` rows |
| Effort/mechanism/evaluative probes outrank build verbs | "How hard would it be to *add* X?" matched both cue lists, and the tie-break sent it to *act* — self-defeating on the exact motivating example | Rely on "imperative build verb" implying mood | That is intent inference, which is what failed originally |
| Solo close is `built → done` with a `skip_reason` naming the re-run and the reviewer verdict | `built → verifying` requires manager dispatch evidence a solo session cannot produce, and self-dispatch is not a workaround | Add a solo path to `phase-machine.js` | Server change for a documentation gap; the escape hatch already exists |
| Lint guards the single source | Deleting the whole `## Roles` section left lint green while 12 files pointed at it. `golem:` refs inside skills now fail rather than warn | Leave it to review | The whole point of single-sourcing is one place to break; that place needs a guard |
| Continuity work reframed: *"add goals + a decision log, a render, and a janitor"* | Five of six continuity layers already have authoritative stores (tracker, git, channel, journals). What is missing is a **render** and a **janitor**, not a system | Build the full GOL-88 program (Mem0 + local observer + pack evaluator) | It is the biggest meta-project yet, and the associative layer is the least-justified piece — nearly every high-value finding wants *deterministic loading of current truth*, not semantic search over history |

---

## 6. Contradiction inventory — ALL CLOSED 2026-07-25 (GOL-92)

> Every C / R / G row below was closed by commits `ed0c011..HEAD`. The tables are kept as the
> historical record of what this architecture used to get wrong — **line numbers are from the
> pre-fix tree and no longer resolve.** Do not treat them as open work.

**What remains open after GOL-92:**

| Open item | Detail |
|---|---|
| **Review gates are session-enforced, not server-enforced** | `dashboard/server/phase-machine.js` requires nothing review-shaped for `designed → planning` or `verified → done`, and `verificationReport` matches `/verification\|verify-done\|smoke\|test/i` — almost any comment satisfies it. A close that ignored a `BLOCKER` is invisible to the tracker. `verify-done` now says this plainly instead of overclaiming. Adding real `phase-machine` requirements plus a walk test is the follow-up. |
| **`AGENTS.md` is 157 lines, not the ~75 budgeted** | The budget predated the authority table (~45 lines) and the six-row Roles table. Every line is load-bearing and single-sourced, so the number was wrong, not the content. Re-budget; do not cut to hit it. |
| **Two commits bundle unrelated work** | `git add -A` swept pre-existing uncommitted CLI, tracker-client, and `.claude/settings.json` changes into `016fced` / `633c697`. Nothing was lost, but a substrate revert would take the CLI with it. Stage explicitly next time. |
| **In-process `reviewer` has no tracker tools** | Its verdict always reaches the ticket second-hand via the session that routed the work, which weakens the independence the gate exists for. |

### Contradictions (historical — all closed)

| # | Conflict | Locations |
|---|---|---|
| C1 | Cross-session delegation forbidden vs mandated | `AGENTS.md:74` forbids `sessions_dispatchable`; `roles/manager.md:4` says "never skip `sessions_dispatchable`"; all 5 role cards line 6; `managing/SKILL.md:27,34-41,43-51,63`; `consulting/SKILL.md:10-20`; `night-shift:12-16` |
| C2 | `AGENTS.md` self-contradiction | `:74` forbids the call; `:79` lists it as a tool trigger |
| C3 | Pipeline dead-end | `planning/SKILL.md:66` forbids planner build-dispatch and requires manager handoff; `managing/SKILL.md:28` tells a manager with no live planner to wait/ask. No legal completion path |
| C4 | `review` canonical *and* forbidden | `AGENTS.md:12,32` and `verify-done` frontmatter treat it as a target; `tracker/SKILL.md:78` says "never use legacy `review`"; `tracker:39` says legacy state writes are lossy |
| C5 | `AGENTS.md:14` teaches the deprecated pattern | says "mark it in progress"; `tracker/SKILL.md` requires `ticket_transition({phase})` |
| C6 | `night-shift` contradicts three rules | 15-min wake cron vs the no-unattended-background-loops rule and the no-Monitors preference; live-peer monitoring (disabled); introduces a `planner > manager > builder > explorer` tier ladder that exists nowhere else and inverts the ownership table |

### Redundancies (historical — all closed)

| # | Duplicated fact | Copies |
|---|---|---|
| R1 | Role ownership | `AGENTS.md:41-47` · each `roles/*.md:4` · each role skill's `Own`/`Never` — **all three disagree** |
| R2 | Role → skill routing | `AGENTS.md:51-58` Skill index · each role card's `Leads with:` |
| R3 | In-process agent map | `AGENTS.md:84-89` duplicates the ladder at `:66-72` |
| R4 | Tracker rhythm | `AGENTS.md:14` duplicates `tracker/SKILL.md:41-51` |
| R5 | Evidence rule × 3 | `AGENTS.md:12`, `:32`, `:93` |
| R6 | No-guessing × 4 | `AGENTS.md:5` · `roles/builder.md:4` · `building/SKILL.md:19` · `agents/worker.md:19` |
| R7 | Consult skills × 3 | `get-consult` and `provide-consult` are 8-line redirects to `consulting` |

### Gaps (historical — all closed)

| # | Gap |
|---|---|
| G1 | No authority model anywhere |
| G2 | `standalone` is a phantom role — file exists, no ownership row, no skill index entry, and `Leads with:` is builder's list, so a standalone doing design has no planning guidance |
| G3 | `consultant` is the mirror phantom — ownership row at `AGENTS.md:47`, no role file |
| G4 | Milestone journaling is a dangling reference — `journaling/SKILL.md:14` points at "AGENTS spine / role skills"; neither mentions milestones |
| G5 | Project-specific content in global skills — `test-policy:24-31`, `git-conventions:93-96,143-148` |
| G6 | Stale commit trailer — `git-conventions:40` says `Claude Fable 5` |

---

## 7. Traps

- **Do not add a role for a situation.** Run the four tests in §4.2. Two phantom roles
  already exist from skipping them.
- **Do not add a store to fix rule sprawl.** Sprawl is a garbage-collection failure, not a
  storage failure. A sixth store makes it worse.
- **Do not build the associative memory layer first.** Almost every documented friction
  wants deterministic loading of current truth. Even the historical lessons were consumed
  as *rules*, not retrieved episodes.
- **Do not let a continuity render carry hand-written volatile state.** Anything changing
  more than weekly must be *derived*, or you have built a staleness generator. Cap the
  cold-start bundle (~1.5–2k tokens) or it becomes the transcript dump it was meant to replace.
- **Do not confuse read-only with same-authority.** §4.2 test 1.
- **Do not produce another open-question list.** The failure mode of this whole workstream
  is analysis that never converts. GOL-91 catalogued the adoption failure and then closed
  with 13 deferred questions and no choice made. Close questions; ship the smallest thing.
- **Answer-first applies to this work too.** "What do you think about X?" about the
  substrate is still a question. Propose; do not edit.
- **Every substrate edit is inert until synced and version-bumped.** §1.

---

## 8. Source material

| Source | Where |
|---|---|
| Transcript retrospective — 5 orthogonal lenses | `~/Documents/agentx/retro/transcript-workflow-orthogonal-7fd00ba338eb/` |
| Second independent retrospective — 5 aspects | `~/Documents/agentx/retro/workflow_analysis_orthogonals/` |
| Agent Continuity System — product direction | tracker `GOL-88` |
| Continuity and Workflow Reliability Foundation | tracker `GOL-91` |
| Substrate reorganisation design + 6-wave plan | tracker `GOL-92` |

Both retrospectives were produced independently over the same corpus and converge on the
same five findings. Where they agree, treat it as corroborated.
