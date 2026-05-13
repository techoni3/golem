# Golem · Design v1

> **Companion:** [`../agent_specs/02_revision_v1.md`](../agent_specs/02_revision_v1.md) (intent doc + canonical agent roster)
> **v0 archive:** [`../../archive/v0/`](../../archive/v0/)

This is the singular design doc for golem v1. Read top-to-bottom; later sections assume earlier ones.

---

## 1. Why golem exists

Frontload taste, opinions, and SOPs into durable artefacts — personas, skills, hooks, project conventions — so that everyday software work, from raw idea to deployed product, runs with high autonomy. The user files briefs; the substrate carries them through ideation, design, build, review, and deploy without the user driving each step.

What golem is not:
- Not a team product. Single-user, single-machine, local-first.
- Not a SaaS, not a hosted runtime, not a cloud orchestrator.
- Not a UI. v1 runs entirely through Claude Code as the harness.

**First principle: assume no human in the loop.** Everywhere a typical workflow has a human (PM, TL, reviewer, ops), golem either has a persona for it or has decided that step doesn't apply. The CEO and TL personas exist specifically to absorb the routing and management responsibilities the user would otherwise carry.

**Corollary: every persona must have sharp boundaries and an inspectable contract.** Without a human to glue handoffs, the contracts have to do that work. Boundaries are load-bearing; ambiguity in a persona's mandate is a runtime bug, not a documentation bug.

---

## 2. Core concepts

The smallest set of terms required to read the rest of the doc.

**Substrate.** The global, project-agnostic layer. Lives under the user's home (`~/.claude/agents`, `~/.claude/skills`) plus the golem repo it's installed from. Contains personas, skills, hook scripts, install/bootstrap scripts. Edited rarely, used by every project.

**Project harness.** The per-project layer. Initialised by the Substrator agent when a new project is bootstrapped. Contains CONTEXT, ARCH, conventions, repo-map, ADRs, agent-notes, tracker, journal directories, `.claude/settings.json` wiring the hooks. Lives inside the project repo.

**Persona / agent.** A polyglot agent definition at the substrate level. Frontmatter + prose body. Specialised at runtime by the project harness — the same Engineer persona becomes a FastAPI engineer in a FastAPI project and a Next.js engineer in a Next.js project, depending on which skills the project's CLAUDE.md activates.

**Skill.** A unit of activatable behaviour. Three categories: **technical** (e.g. `python-fastapi-codestyle`), **substrate** (e.g. `journaling`, `tracker-update`), **SOP** (e.g. `diagnose`, `pr-creation`). Each lives as a directory with a `SKILL.md` containing frontmatter (name, description with "Use when…", expects, produces) and a body.

**Skill activation.** Two complementary mechanisms: (a) **declarative** — the project's CLAUDE.md lists active skills under a known section; (b) **reflexive** — a skill's frontmatter `Use when…` pattern matches the current context and Claude Code progressive-disclosure-loads it. Activation is conceptual, not a hard contract; both signals contribute.

**Trace.** Everything written by the substrate during a session for later reference: ADRs, agent-notes, journals (mechanical hook events + semantic summaries). Read by Documentarian post-merge and Meta-agent on cadence; **not** read by working agents at runtime.

---

## 3. The conceptual flow

End-to-end picture in prose. Diagrams are canonical (Appendix A); this section makes the doc readable without them.

### 3.1 The three entry branches

Every user brief lands at the CEO. The CEO classifies the brief into one of three branches:

1. **Fresh idea / raw brief** — expresses an intent or hypothesis but is not yet a buildable product. Routes into the Ideation pipeline (§3.2).
2. **Established idea, no project yet** — concrete enough to start building. Routes into new-project bring-up (§3.3).
3. **Continuation in an existing project** — a feature request, fix, or modification. Routes to that project's TL (§3.4).

Branch classification is the CEO's only judgement call. Everything downstream follows from it. (Modus Operandi was originally set here too; deferred to v2 — see §4.)

### 3.2 Ideation pipeline

When the brief is a fresh idea, the CEO enters the Ideation phase. Inside Ideation:

1. CEO creates a project directory to hold all upcoming ideation work — research notes, candidate ideas, market research, the eventually-picked one. This directory is not yet a code project; it's a workspace.
2. CEO decides whether the brief is raw enough to need broad scouting (delegate to Scout) or already specific enough to skip directly to market research (delegate to Prospector).

**Scout** runs broad signal-gathering — communities, marketplaces, forums, search trends, competitor landscapes — and produces a candidate list of raw product ideas with citations. No filtering for viability.

**Prospector** picks up Scout's candidates (or the CEO's direct hand-off when Scout was skipped) and runs market research — size, competition, distribution, willingness-to-pay — converting buildable candidates into business cases.

**Smelter** runs feasibility assessment across Prospector's business cases (build effort, differentiation, go-to-market, fit-with-our-stack) and picks the single most valuable idea worth pursuing. The pick is justified, not just selected.

Smelter hands the chosen idea back to the CEO. The CEO then re-enters as branch 2 (§3.3) — the natural progression continues into project bring-up.

### 3.3 New-project bring-up

Once the CEO has an established idea, it provisions the project directory (or reuses the one Ideation created) and hands off to a Project TL. The TL is the long-running, project-context-loaded driver. From here the CEO is no longer in the picture for this project unless a new top-level brief arrives.

The TL's bring-up sequence:

1. **Substrator** — initialises the agentic harness inside the project directory: CONTEXT (or CONTEXT + CONTEXT-MAP if pre-split, see §7.1.2), ARCH stub, ADR template + 0001-stack-choice ADR (proposed), conventions, repo-map stub, journal hooks, tracker, `.claude/settings.json`. No source code.
2. **Product Architect** — turns the business idea into product specs (user journeys, features, acceptance criteria). Iterates with the Product Architecture Reviewer until specs are sound.
3. **UX Designer** — turns product specs into design specs (component breakdowns, layouts, interaction states, copy directions). Only runs when needed; for non-UI projects the TL skips this step.
4. **Tech Architect** — turns product specs into technical specs, picks the stack, scaffolds the project per the stack, and writes the work decomposition into the tracker as dev stories. Iterates with the Tech Architecture Reviewer.
5. **Local DevOps** — sets up the local development environment as the first batch of stories, dictates the dev-env terms inside CONTEXT and ARCH so the rest of the team follows them.
6. **Development team** — Engineer + Test Spec Writer + Test Writer + Code Reviewer take dev stories from the tracker. Engineer writes code; pre-commit triggers the test-spec-writer then the test-writer; PRs accumulate over N commits; Code Reviewer runs at PR time.
7. **Cloud DevOps** — first-time infra/CI provisioning at first PR. Then re-runs on every PR merge. Owns rollbacks. Considers infra updates from the TL only.

Substrate-level concerns (Substrator, Tech Architect's scaffold, Local DevOps's dev-env stories, Cloud DevOps's first-time infra) only happen once per project. After that, the loop is feature/fix → tracker → development team → review → merge → CD.

### 3.4 Continuation flow

When the CEO routes a brief into an existing project, the TL receives it and:

- **Feature** — adds to tracker. Routes through Product Architect (extend specs) → UX Designer (if UI changes) → Tech Architect (architecture deltas + new dev stories) → development team. Substrator and project scaffold are skipped — the project is already bootstrapped.
- **Fix** — adds to tracker. **Diagnoser runs first** to reproduce, locate root cause, and classify the fix as code / architecture / infra. The TL routes the fix based on Diagnoser's verdict: code → development team; architecture → Tech Architect (new ADR + revised specs + dev stories) → development team; infra → Cloud DevOps (or Local DevOps if dev-env-only).

Brownfield uses the same orchestration shape as greenfield, with skip-conditions for the bring-up steps. There is no separate brownfield TL — one TL persona, one set of routing rules, with the project's bootstrap state determining which stages skip.

### 3.5 Maintenance loops

Two persistent loops run **off the request path**:

- **Documentarian** — sweeps post-merge. Reads the merged diff, journal entries from the just-finished session, and any new agent-notes. Rewrites cross-cutting state (CONTEXT, ARCH, conventions, repo-map). Promotes recurring agent-notes into normative docs. Does not touch source code, tests, or ADRs.
- **Meta-agent** — runs on cadence (or user trigger) across projects. Reads journals globally, proposes new skills, retires stale ones, flags persona drift, surfaces patterns that should update the global personas or skill catalog. Lives outside any single project's request flow.

Both run after the per-request orchestration completes. **Working agents do not read trace artefacts at runtime.** That's a deliberate constraint: it keeps the request path lean and gives the Documentarian and Meta-agent meaningful work.

---

## 4. Modus Operandi — deferred to v2

**Status: deferred.** Originally planned as the operating-mode lever (Quick / Defer / Thorough), Modus Operandi has been pulled out of v1 to keep the substrate small enough to ship and dogfood. See [`v2_notes.md` § N-001](v2_notes.md) for the deferral rationale, the v1 fallback behaviour, the v2 scope when revisited, and open questions.

**v1 fallback: a single mode equivalent to Thorough.** Every persona shown in the diagrams runs as part of every request, with the obvious skips already documented elsewhere (UX Designer skipped for non-UI projects per §3.3; Substrator and Tech Architect's scaffold step skipped for brownfield per §3.4). No short-circuits, no deferred follow-ups, no per-mode branching.

Wherever the rest of this document would otherwise have referenced "Modus", "Quick", "Defer", or "Thorough", treat it as: the full flow runs.

---

## 5. Agent roster

### 5.1 Source of truth

The canonical roster — names, one-line descriptions, sections — lives in [`../agent_specs/02_revision_v1.md` § "The agents roster"](../agent_specs/02_revision_v1.md). This doc references that table rather than duplicating it; the spec doc carries intent, this doc carries design.

Summary count: **20 personas across 8 sections** — Routing & Orchestration (CEO, TL); Ideation (Scout, Prospector, Smelter); Substrate (Substrator); Product (Product Architect, Product Architecture Reviewer, UX Designer); Technical Architecture (Tech Architect, Tech Architecture Reviewer); DevOps (Local DevOps, Cloud DevOps); Development (Engineer, Test Spec Writer, Test Writer, Code Reviewer); Diagnostics (Diagnoser); Maintenance (Documentarian, Meta-agent).

### 5.2 Persona authoring conventions

Each persona is a single Markdown file at the substrate level (`substrate/agents/<name>.md`), installed via symlink to `~/.claude/agents/<name>.md`.

File shape:

```markdown
---
name: <persona-name>
description: <one-line description used by Claude Code for routing>
tools: <comma-separated tool list — Read, Write, Edit, Bash, etc.>
---

# <Persona Name>

## Mandate
One-paragraph statement of what this persona owns and what it doesn't.

## Expects
Bulleted list of inputs: artefacts the persona needs in context to operate
(e.g. "an open ticket in tracker/open/", "ARCH.md", "Diagnoser verdict for fix tickets").

## Produces
Bulleted list of outputs: artefacts the persona creates or mutates
(e.g. "commits on a feature branch", "ADR entries", "tracker state transitions").

## Touches
Files / directories the persona is authorised to write. Anything outside this list
requires explicit hand-off to another persona.

## Skill playbook
Conditional invocations. List each skill the persona uses with the trigger condition,
because progressive disclosure is unreliable in practice — explicit playbooks make
behaviour deterministic. Format: "On <situation> → invoke <skill>."

Example for the Engineer:
- On entering a ticket → invoke `golem-grill` if acceptance criteria are vague.
- Before writing code → ensure failing tests exist (Test Spec/Writer hand-off).
- Before opening a PR → invoke `golem-verification-before-completion`, then `golem-pr-creation`.
- Before yielding control → invoke `golem-summarise-session` (closing reflex).

## Hand-off
Prose paragraph describing what the persona leaves for the next persona — a "memo"
pattern. Includes journal entries, tracker updates, in-context briefing.

## What this persona does NOT do
Explicit anti-list. Same-level boundary statements as the Mandate, but inverted.
This is what prevents scope creep at runtime.
```

The **Touches** + **Does NOT do** pair is the boundary contract. Sharp boundaries are load-bearing because there is no human to renegotiate them.

### 5.3 Polyglot vs. specialised

Personas are written polyglot at the global level. The Engineer persona file does **not** mention FastAPI, Next.js, Django, or any specific stack. It describes engineering — what good code is, how to commit incrementally, what to do when blocked.

Specialisation happens at runtime through skills:
- Project's CLAUDE.md declares: `stack: python-fastapi`.
- The CLAUDE.md "Active skills" section names: `python-fastapi-codestyle`, `alembic-sqlalchemy`, `pytest-fastapi`.
- When the Engineer is invoked in this project, those skills load into context alongside the persona.
- The result is an Engineer persona that behaves as a FastAPI specialist for the duration of the session.

Drop the same Engineer into a Next.js project and a different skill set loads. Same persona file, different specialisation.

### 5.4 Per-persona deep dive

Personas whose role is non-obvious from the roster table get expanded here. Personas with clear roles (Engineer, Code Reviewer, Tech Architect, etc.) are sufficient with the roster description alone.

#### CEO

- Enters at every brief. The only persona that owns routing.
- Decisions: branch classification (§3.1), whether Ideation is needed.
- Artefacts produced: a brief-classification journal entry, the project directory creation (for new projects), the TL hand-off memo.
- Does NOT: do any of the work itself. Does NOT enter projects after hand-off — short-lived per request.

The "two CEO boxes" in the Project Development diagram represent the **same persona invoked at different points in the flow** (entry routing, then project provisioning), not two instances. One persona file, two invocation contexts.

#### TL

- Long-running per-project driver. Loaded with project context (CLAUDE.md, CONTEXT, ARCH, recent tracker state) at the start of each session in that project.
- Owns: tracker maintenance, who-runs-next decisions, escalation back to the CEO if the work expands beyond the original brief.
- Artefacts produced: tracker state transitions, ticket creation from briefs, hand-off memos to the next persona, journal entries summarising session progress.
- Does NOT: write code, write specs, write tests, scaffold projects. The TL is purely orchestration.

The TL is **one persona**, instantiated per project at session time with project context — not a separate persona file per project. The "project-specific TL" language in the flow diagram refers to context-loading, not file generation.

#### Substrator

- Runs once per project, at bring-up. After bring-up, idle until a major substrate evolution is needed (e.g. promoting CONTEXT to a multi-file structure when it grows past the size threshold — §7.1.2).
- Owns: the substrate-level harness inside a project. Initial CONTEXT, ARCH stub, ADR template, conventions, repo-map stub, hook wiring, tracker bootstrap.
- Hand-off: produces a "substrate ready" memo for the TL with pointers to every artefact created.
- Does NOT: write source code, scaffold the application, decide stack (Tech Architect does), write product or technical specs.

#### Diagnoser

- Runs first when a fix ticket enters the project. **Diagnoser-first is a hard rule** — fixes do not route based on the brief's surface description because surface descriptions misclassify often.
- Output: a verdict — `{ reproduction_steps, root_cause, classification: code | architecture | infra, suggested_routing }`. Written into the ticket's frontmatter and hand-off log.
- The TL reads the verdict and routes accordingly.
- Does NOT: write the fix. Diagnosis and remediation are separated so the diagnostician's frame doesn't bias the fixer.

#### Documentarian

- Post-merge sweep agent. Triggered by a merge event hook (or manually).
- Reads: merged diff, journal entries since last sweep, agent-notes added during the session, current state of CONTEXT / ARCH / conventions / repo-map.
- Writes: revised CONTEXT / ARCH / conventions / repo-map. Promotes recurring agent-notes into normative docs and deletes the source notes.
- Does NOT: touch source code, tests, ADRs (per-decision artefacts the Architect owns), or anything that mutates the meaning of an existing ADR.

The Documentarian solves the cross-cutting-state problem: any single PR may shift architecture or conventions, but no single coding agent has the panoramic view to update CONTEXT and ARCH consistently. The Documentarian gets that view from the merged state.

#### Meta-agent

- Substrate-evolution agent. Runs on cadence (e.g. weekly) or on explicit user trigger across projects.
- Reads: journals across all golem-bootstrapped projects on the user's machine, the global skill catalog, the global persona files.
- Writes: **proposals** — new skills to author, stale skills to retire, persona drift signals, patterns warranting updates to the global substrate. Proposals land in a `meta-proposals.md` at the substrate level for user review.
- Does NOT: auto-apply changes to personas or skills. Substrate evolution is gated through user review — the Meta-agent proposes, the user accepts.

This is the **one place where user review is required** and "no human in the loop" doesn't hold. Substrate edits affect every future project; user gate is correct.

---

## 6. Skills catalog

### 6.1 The three categories

**Technical skills.** Stack- or library-specific operating knowledge. Examples: `python-fastapi-codestyle`, `django-orm`, `alembic-sqlalchemy`, `nextjs-app-router`, `react-server-components`, `aws-ecs`, `stripe`, `supabase-rls`. Each is a body of conventions, gotchas, and preferred patterns for one technology — the polyglot persona becomes proficient when the skill loads.

**Substrate skills.** Operating knowledge for golem's own substrate components. Examples: `agent-notes` (when and how to write a note vs. update CONTEXT directly), `repo-map-update`, `journaling` (semantic summary structure), `tracker-update` (state transitions, frontmatter rules), `context-update`. These are how-to-operate-the-harness skills, not how-to-write-code.

**SOP skills.** Reusable procedural recipes. Examples: `diagnose` (the structured diagnosis routine the Diagnoser runs), `grill` (interview-the-brief-to-fill-context routine), `pr-creation` (branch naming, commit message, PR body), `using-git-worktrees`, `improve-codebase-architecture`, `verification-before-completion`. These are workflows, not technologies.

The categories are **not enforced via filesystem** — they're a cognitive map for the user when authoring. Skills live flat under `substrate/skills/` regardless of category, with the category implied by the skill's frontmatter (`category:`) and naming.

### 6.2 Activation mechanism

**Declarative-primary, with reflexive fallback acceptable.** Progressive disclosure / reflexive activation is real but unreliable in practice — it depends on the skill's `description` matching the model's framing of the current situation, which is fuzzy and silent when it misses. We do not bet the flow on it; we bet the flow on declarative listing + explicit invocation.

**How it actually works under the Claude Code runtime** (verified against current docs):

- All skills installed at `~/.claude/skills/<skill-name>/SKILL.md` are discovered at session start. Their `name` and `description` frontmatter are loaded into context for matching purposes; the full SKILL.md body is **not** loaded until invoked.
- Skill discovery is **flat at one level**. `~/.claude/skills/golem-tdd/SKILL.md` works; `~/.claude/skills/golem/tdd/SKILL.md` does not. Subdirectories below the skill directory are fine for examples/templates the SKILL.md references, but the skill-name level itself is flat.
- "Active skills" in CLAUDE.md is a **convention we adopt**, not a runtime feature. The runtime does not pre-load skills based on this list. What CLAUDE.md gives us is a project-stable hint to the working agent: "in this project, you should be invoking these skills habitually."

**Declarative mechanism (primary).** The project's CLAUDE.md has an "Active skills" section. Example:

```markdown
## Active skills

- golem-python-fastapi-codestyle
- golem-alembic-sqlalchemy
- golem-pytest-fastapi
- golem-stripe
- golem-pr-creation
- golem-diagnose
- golem-using-git-worktrees
```

The personas' "Skill playbook" sections (§5.2) reference these by name with explicit triggers. The agent invokes them via the SKILL system as needed.

**Reflexive fallback.** Because frontmatter loads anyway, if the user's brief surfaces something CLAUDE.md didn't anticipate ("add a Stripe checkout"), the matching skill's description may still get picked up via standard Skill-tool matching. We accept this as a useful fallback without designing around it.

**Frontmatter authoring rule.** Keep `description` short and trigger-shaped: "<one line of what it does>. Use when <concrete situation>." This serves both the human author scanning the catalog and the runtime matching pass.

**Namespacing.** All golem-authored skills are prefixed `golem-` (e.g. `golem-tdd`, `golem-journaling`, `golem-pr-creation`) so they don't collide with the user's other skill collections at `~/.claude/skills/`.

### 6.3 Authoring conventions

Each skill is a directory under `substrate/skills/`, with a `SKILL.md` at the root and optional supporting files.

```
substrate/skills/<skill-name>/
├── SKILL.md
├── examples/        (optional)
└── templates/       (optional)
```

SKILL.md frontmatter:

```yaml
---
name: <skill-name>
description: <one-line description with "Use when…" clause>
expects: <bulleted list of context the skill assumes>
produces: <bulleted list of outputs the skill yields>
category: technical | substrate | sop
---
```

Body sections (loose, not enforced):

- **When to invoke this skill** — concrete triggers.
- **The procedure** — the actual how-to. Numbered steps where order matters; bullets where it doesn't.
- **Anti-patterns** — what to avoid, how to recognise misuse.
- **When this skill is wrong** — bail-out conditions.

Authoring rules:
- **One skill per concern.** If the body does two things, split it.
- **Skills should be pithy.** The default load is the full SKILL.md into context; if it's 800 lines, the agent's context is gone before it has done any work. Aim for **100–300 lines**.
- **Progressive disclosure for depth.** Long examples and edge cases go in supporting files referenced from SKILL.md, not in SKILL.md itself.
- **Stack skills live or die with their stack.** Retire ruthlessly when a stack is no longer used (Meta-agent flags this).

### 6.4 Initial skills shortlist for v1

The minimum set to run the flow end-to-end on the first dogfood project. Final list emerges from the first project; this is the seed.

All skills are prefixed `golem-` per §6.2 namespacing.

**SOP skills:**
- `golem-diagnose` — Diagnoser's procedure.
- `golem-grill` — interview-the-brief-to-fill-context routine. Used by Product Architect and Tech Architect on entry.
- `golem-pr-creation` — branching, commit messages, PR body.
- `golem-using-git-worktrees` — for parallel agent work.
- `golem-verification-before-completion` — anti-vibe-coding gate before declaring a ticket done.
- `golem-tdd` — red/green/refactor with vertical-slice rule. (Ownership question: §8.3.)
- `golem-improve-codebase-architecture` — Tech Architect's iterative refinement skill.

**Substrate skills:**
- `golem-journaling` — semantic summary structure for session-end entries.
- `golem-agent-notes` — when to write a note vs. update CONTEXT.
- `golem-tracker-update` — state transitions, frontmatter rules.
- `golem-context-update` — Documentarian's rewrite procedure.
- `golem-repo-map-update` — regeneration cadence and shape.
- `golem-summarise-session` — the chosen mechanism for the journal-summarise problem (§7.2.4).

**Technical skills:**
- **Built on dogfood demand, not pre-stocked.** First project picks a stack; technical skills for that stack are authored as part of bring-up. Pre-stocking technical skills before a real project demands them is over-investment.

### 6.5 Stack archetypes for upfront support

The stacks we want to handle out of the gate. Determines priority order for technical skill authoring.

Initial archetypes (open list; finalise during first dogfood):
- **Python web service** — FastAPI + SQLAlchemy + Alembic + Pytest.
- **Next.js full-stack** — Next.js App Router + TypeScript + Supabase or Postgres + Vitest.
- **Python script / CLI** — small tools, no web layer.
- **TypeScript CLI** — node-based small tools.

We do not pre-author technical skills. The first real need drives the first authored version, which becomes the reusable skill on subsequent projects in the same stack. The Meta-agent's job is to spot when an authored-once skill has become reusable enough to live at the global level.

---

## 7. Substrate components

### 7.1 Context docs

Project-specific knowledge artefacts. Distinct from the substrate-level skills and personas (which are global).

#### 7.1.1 CLAUDE.md

The entrypoint every agent loads on entry to the project. Design constraints:

- **Cannot be too prose-heavy.** Loaded by every agent every session. Token cost is paid 20× per active project per day.
- **Cannot be too thin.** Misses essential instructions; personas drift.
- **Cannot duplicate persona/skill content.** Personas already say how the agent operates in general; skills already say how to handle specific cases. CLAUDE.md adds the **project-specific layer** on top.

Proposed shape (target ~50–100 lines):

```markdown
# <project-name>

## What this project is
2-3 sentences. The product / system the agents are building.

## Active stack
- primary: <stack-archetype>
- key tech: <list>

## Active skills
- <list of skill names — drives declarative activation §6.2>

## Pointers
| What | Where |
|------|-------|
| Architecture | docs/ARCH.md |
| Domain language | CONTEXT.md |
| Conventions | docs/conventions/ |
| ADRs | docs/adr/ |
| Repo map | docs/repo-map.md |
| Tracker | tracker/ |

## Run commands
- install: <cmd>
- dev: <cmd>
- test: <cmd>
- lint: <cmd>
- build: <cmd>

## Project-specific operating notes
A few short bullets on anything non-obvious that doesn't fit elsewhere
("we deploy on tag, not on merge", "background jobs run in worker.py",
"we use feature flags via X"). Kept under 10 bullets.
```

What CLAUDE.md does **NOT** contain:
- Persona descriptions (in global persona files).
- Skill bodies (in skill files, loaded by activation).
- Architecture details (in ARCH.md).
- Domain definitions (in CONTEXT.md).
- ADR content.
- Run-history or session state.

**Single-source rule:** every fact in CLAUDE.md exists nowhere else in the project. If it's also in ARCH or CONTEXT, remove it from CLAUDE.md. CLAUDE.md is the **index**, not the encyclopaedia.

#### 7.1.2 CONTEXT.md (and the merge with CONTEXT-MAP)

**Decision: merge CONTEXT.md and CONTEXT-MAP.md into a single CONTEXT.md by default.** Reasoning:

- v0 split them because the mattpocock pattern modeled "vocabulary" vs. "boundaries" as separate.
- In practice, the boundary diagram and the vocabulary list refer to the same entities; reading them apart loses the connection.
- Token cost is paid per file load; one file is cheaper than two when both are needed together.

CONTEXT.md shape:

```markdown
# Domain Context

## Vocabulary
Definitions of the project's ubiquitous-language terms. One per heading or bullet.

## Entities and boundaries
Mermaid diagram + prose of the system's bounded contexts and their relationships.

## Invariants
Rules that hold across the system. Things a coding agent must not violate.

## Open ambiguities
Terms or boundaries we have not yet pinned down. Tracked here so they don't get
silently resolved differently in different commits.
```

**Size-based split rule.** When CONTEXT.md grows past **~500 lines** (configurable), the Substrator (or Documentarian on its sweep) splits it into CONTEXT.md (vocabulary + invariants) + docs/CONTEXT-MAP.md (entity/boundary diagram and prose). The split is a **maintenance event**, not the default state.

#### 7.1.3 ARCH.md

The architecture-level document. What's in:
- Stack choice and version pins (mirrored from the first ADR).
- Service / module boundaries (high-level shape; details in CONTEXT-MAP if split).
- Cross-cutting infrastructure decisions (auth, persistence, caching, queueing).
- Performance / scale invariants where they constrain code (e.g. "all API endpoints P95 under 200ms").
- External dependencies and SLAs.

What's **NOT** in ARCH.md:
- ADRs themselves — ADRs are per-decision; ARCH.md is the synthesis.
- Domain vocabulary — that's CONTEXT.md.
- Code structure — that's repo-map.md.
- Run commands — that's CLAUDE.md.

Read by: any agent working on architecture-affecting changes (Tech Architect, Tech Architecture Reviewer, Engineer when scope is non-trivial). Mutated by: Tech Architect on architectural changes (creates ADR + revises ARCH); Documentarian on cross-cutting state drift.

#### 7.1.4 README.md

**Human-only.** Agents do not read README.md as part of any flow. Maintained for the user / collaborators / future-self when opening the repo without Claude Code.

Substrator stubs it at bring-up; the Documentarian may update it when project shape changes meaningfully (renamed product, new top-level features). Otherwise hands-off.

#### 7.1.5 Conventions

Project-wide normative rules that don't fit ARCH (which is about *what is built*) or CONTEXT (which is about *what things mean*). Conventions are about *how we do things in this codebase*. Examples:

- "Tests live next to the code, not in a separate `tests/` directory."
- "All external HTTP calls go through the `http_client` module, never directly via `requests`/`fetch`."
- "Pydantic models are frozen by default; use `BaseModel(frozen=True)`."
- "We don't add new top-level dependencies without an ADR."

Lives at `docs/conventions/` as multiple small files (one category per file: `testing.md`, `http.md`, `models.md`, etc.), not one monolithic file. Read by: Engineer, Code Reviewer, Test Spec Writer. Mutated by: Documentarian on sweep when a new convention emerges; Tech Architect when an ADR introduces one.

Conventions are **distinct from skills** because they are project-specific. A skill like `python-fastapi-codestyle` is global (applies anywhere FastAPI is used). A convention is local (applies in this project, may differ in another).

#### 7.1.6 repo-map.md

The agent's table of contents. A flat or shallowly-nested map of the repo: directory → purpose → key files. Lets an agent answer "where would I find X?" without grepping the whole tree.

Shape:

```markdown
# Repo Map

## src/
The application code.

### src/api/
HTTP layer. Endpoints, request/response models.
- src/api/routes/ — endpoints grouped by resource.
- src/api/middleware/ — auth, logging, rate-limit.
- src/api/schemas/ — pydantic request/response models.

### src/services/
Business logic.

### src/db/
Persistence. Models, migrations, repository functions.

## tests/
[…]
```

Three maintenance modes:
- **At bring-up** — Substrator generates a stub from the Tech Architect's scaffold.
- **On structural changes** — Engineer or Tech Architect updates the affected section in the same commit that introduces the change.
- **On Documentarian sweep** — full regeneration (or diff-and-update) post-merge for changed paths.

Read by: every agent that needs to navigate the repo. Smaller agents (Reviewer, Test Writer) often read repo-map first, then the specific files they need.

#### 7.1.7 Top-level vs. docs/ placement

**Decision:** keep the truly load-bearing files at the top level so they're obviously discoverable when first opening the repo; move the rest into `docs/` to keep the top lean.

Top-level (always):
- `README.md` — humans expect it.
- `CLAUDE.md` — Claude Code expects it at top level.
- `CONTEXT.md` — loaded by every agent operating on domain.

`docs/` (everything else):
- `docs/ARCH.md`
- `docs/CONTEXT-MAP.md` (only if split)
- `docs/repo-map.md`
- `docs/conventions/`
- `docs/adr/`
- `docs/agent-notes/`

CLAUDE.md's "Pointers" section maps logical names to filesystem paths, so agents don't need to know the placement convention. If we move a file later, only CLAUDE.md changes — agents read the pointer.

### 7.2 Agents trace

Trace artefacts capture what the substrate did during sessions, for later reference.

#### 7.2.1 ADRs

Architecture Decision Records. One per decision. Lives at `docs/adr/<NNNN>-<slug>.md`.

Format:
```markdown
# <NNNN>: <Title>

## Status
Proposed | Accepted | Superseded by ADR-XXXX | Rejected

## Context
What's the situation prompting this decision?

## Decision
What did we decide? In imperative voice.

## Consequences
- Positive: …
- Negative / trade-off: …

## Alternatives considered
- <alternative>: rejected because …
```

Authored by the agent making the decision — most often Tech Architect, sometimes Product Architect (e.g. an ADR about a product approach), occasionally CEO (e.g. "we will not pursue Idea X because…"). The relevant Reviewer co-signs.

ADRs are **append-only**. A decision later reversed gets a new ADR superseding the old one; the old ADR's status becomes "Superseded by ADR-XXXX" but its body is never rewritten. The decision history matters more than the current state — that's what ARCH.md is for.

#### 7.2.2 Agent-notes

Short-lived learned notes. Append-only by working agents during a session. Lives at `docs/agent-notes/<slug>.md`.

Format:
```markdown
# <Topic>

**Last verified**: YYYY-MM-DD
**Verified by**: <agent or human>

<one-paragraph note. What did we learn? Where does it apply?>
```

When to write a note:
- Discovered a non-obvious gotcha that would help the next agent.
- A pattern is emerging but isn't yet clear enough for a normative doc.
- An assumption you made should be checked next time before relying on it.

When **NOT** to write a note:
- It's already in CONTEXT, ARCH, or an ADR (write there instead).
- It's specific to one ticket and won't recur (it goes in the ticket's hand-off log instead).
- It's a TODO for yourself — use the tracker.

**Promotion path:** Documentarian sweeps notes on cadence. When a note recurs across multiple sessions or proves load-bearing, it's promoted into a normative doc (CONTEXT, ARCH, conventions) and the source note is deleted. The source-of-truth has moved.

#### 7.2.3 Journals

**Two-journal architecture**, kept from v0:

**Mechanical journal — `journal/hook.jsonl`.** One JSONL line per Claude Code event. Written by the journal-event hook on SessionStart, SessionEnd, and other configured events.

```json
{"ts": "2026-05-05T14:30:00Z", "event": "session-start", "session_id": "abc123", "cwd": "/path/to/project", "payload": {…}}
```

Read by: nobody at runtime. Read post-merge by Documentarian, on cadence by Meta-agent.

**Semantic journal — `journal/summary.jsonl`.** A single append-only JSONL file. One line per session, written at session end via the closing reflex (§7.2.4). Captures intent, outcome, decisions, deviations.

Why JSONL over per-session YAML files:
- **Append-only is the natural shape.** The journal is a log; one append per session is one O(1) operation. No directory listing required to read in order.
- **Cheap to scan.** Documentarian and Meta-agent grep / parse linearly without enumerating files.
- **One file is one git diff.** Reviewers see a single new line per session in the diff, not a new file each time.
- **No file-name collisions.** Per-session files keyed on `session_id` work, but mean N files per active project per day in the gitignored journal dir.

Schema (one JSON object per line):

```json
{
  "ts": "2026-05-05T15:45:00Z",
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "recipe": "patch",
  "brief": "Add Stripe webhook handler for invoice.paid",
  "path_chosen": "<one-line summary>",
  "outcome": "shipped|blocked|abandoned|partial",
  "human_interventions": ["<list of points where the user intervened>"],
  "substrate_signals": ["<flags for Meta-agent — drift, friction, etc.>"],
  "notes": "Free-form prose. What surprised us, what we'd do differently."
}
```

The semantic journal is the hard one — see §7.2.4.

#### 7.2.4 The journal-summarise problem

**Open question.** The semantic journal needs to be written by an agent at session end, but:

- The agent that just finished doing the work has the context to summarise — but its session is ending; we can't run a tool call after SessionEnd in Claude Code in a way that retains in-context state.
- The Documentarian doesn't have the in-session context — it sweeps post-merge with only the merged state and the mechanical journal.
- A separate "summariser agent" run after the working session has the same problem — it doesn't have the working agent's full session context.

You confirmed all three v0 candidates were non-viable for the same reason: only the working agent has the rich state, and its session is ending.

**Tentative direction (subject to validation):** treat journal summarisation as a **reflex skill the working agent invokes as its final act**, before yielding control. Concretely:

- A `golem-summarise-session` substrate skill (§6.4) lives at the substrate level.
- Every persona's "Skill playbook" section (§5.2) names `golem-summarise-session` as the closing reflex.
- The persona invokes `golem-summarise-session` after its last work tool call, appending one JSON line to `journal/summary.jsonl`.
- If the session ends abnormally (crash, user kill), no line is appended. The Documentarian backfills a degraded summary line from the mechanical journal at next sweep.

This is **option 1** from your three options, with **option 3** (Documentarian backfill) as graceful degradation. It's brittle — every persona has to remember to invoke the reflex — but it's the only option that captures in-session context. We accept the brittleness and add belt-and-braces (the reflex is in the persona file's body as a non-skippable closing instruction).

**Tracked in §12 (Q-001).** Resolution will come from first dogfood — if reflexes are reliably invoked, ship as-is; if not, we revisit.

#### 7.2.5 Read paths

Who reads what, when:

| Artefact | Read at runtime by | Read post-merge by | Read on cadence by |
|---|---|---|---|
| ADRs | Tech Architect, Tech Arch Reviewer, Code Reviewer | Documentarian | Meta-agent |
| Agent-notes | Working agents (relevant ones, via grep or CLAUDE.md hint) | Documentarian | Meta-agent |
| Mechanical journal | nobody | Documentarian | Meta-agent |
| Semantic journal | nobody | Documentarian | Meta-agent |
| Tracker | TL (always); other agents (assigned tickets only) | Documentarian (state transitions) | Meta-agent |
| CONTEXT, ARCH, conventions, repo-map | All agents who touch domain / architecture | Documentarian (rewrites) | Meta-agent |

**Working agents do not read other agents' journals at runtime.** The trace is for cross-session reflection, not in-session collaboration. In-session collaboration happens through the **ticket's hand-off log** (§8.2).

### 7.3 Project tracker

#### 7.3.1 Storage decision

**Decision: stay with markdown files + frontmatter.** Reasoning:

- **Self-describing** — the tracker is part of the substrate and lives by the same principles as the rest.
- **Inspectable** — `ls tracker/open/` and `cat tracker/open/<slug>.md` are the read tools.
- **Diff-friendly** — state transitions show up cleanly in git history (file moves preserved as renames).
- **No new dependency** — sqlite3 would mean an extra runtime, schema migrations, and a query layer we'd have to write tooling for.

**Concern (yours, fair):** token cost when frequently editing large markdown trees with many tickets.

**Mitigations:**
- Tickets are **one file each**, not concatenated. Editing one ticket loads one file.
- The board view (§7.3.3) is **generated, not maintained** — an `INDEX.md` derived from the directory tree, regenerated on demand by a small skill or hook, not edited inline.
- We **measure** during first dogfood. If token cost is genuinely problematic, we revisit (§12 Q-003). Premature optimisation toward sqlite is over-engineering against unverified pain.

#### 7.3.2 Schema

One file per ticket. Filename: `tracker/<state>/<NNNN>-<kebab-slug>.md`.

Frontmatter:
```yaml
---
id: TKT-0042
title: "Add Stripe webhook handler for invoice.paid"
state: triage | open | in-progress | review | blocked | done
category: feature | fix | infra | docs | spike
created: 2026-05-05
updated: 2026-05-05
related_adrs: [ADR-0007]
parent_ticket: TKT-0040       # if this is a sub-ticket
labels: [stripe, webhooks]
afk_safe: true                # OK to run in parallel via worktree
---
```

Body:
```markdown
# <Title>

## Brief
Original brief from the user (or from the parent ticket).

## Acceptance criteria
What does done look like?

## Hand-off log
Append-only narrative. Each persona appends a brief note: what they did,
what they leave for the next persona, links to PRs/commits/ADRs/notes.

## Diagnoser verdict (if fix ticket)
Filled by Diagnoser. Reproduction, root cause, classification, suggested routing.
```

State machine:
```
triage → open → in-progress → review → done
                   ↑              ↓
                   └─ blocked ←──┘
```

- New tickets land in `triage/`. The TL moves them to `open/` after creating any sub-tickets and confirming the brief is actionable.
- `in-progress` is at most one ticket per persona instance (Engineer can have one in-progress per worktree).
- `blocked` requires a reason in the hand-off log. The TL re-enters blocked tickets when the blocker clears.
- `done` is final; reopening creates a new ticket linked back via `parent_ticket`.

File moves between state directories happen on transition. Git tracks the move as a rename, preserving history.

#### 7.3.3 Board view

`tracker/INDEX.md`. **Generated, not maintained.** Content:
- Counts per state.
- A table per active state listing tickets with title, category, updated date.
- A footer with "Last regenerated: <ts>".

Regenerated by:
- A `tracker-board-update` skill the TL runs at session start.
- A post-state-change hook that re-runs regeneration after any tracker file move.

The TL **does not edit** INDEX.md directly. Editing INDEX.md is forbidden — it is always derived.

#### 7.3.4 AFK / HITL flags

In v0 the tracker had `afk_safe` and HITL labels because the user might be away during long-running agent work. With the no-human-in-the-loop premise, these are partially redundant:

- **`afk_safe`** — keep, with redefinition. Now means "this ticket is OK to run in parallel via worktree without sequential gates" — useful for the TL when picking the next ticket. Default is `true` unless the ticket touches an invariant or has a `parent_ticket` still in-progress.
- **HITL** — drop. There's no user gate to flag.

User-confirmation events still happen in narrow cases (Meta-agent proposals, novel substrate-evolution choices, irreversible destructive actions). Those are not tracker-level flags; they're per-action confirmation gates handled by the agent making the call.

### 7.4 Hooks

#### 7.4.1 The minimum set

For v1, hooks stay minimal. Anything beyond this list is deferred per your instruction.

| Hook | Event | Purpose |
|---|---|---|
| `journal-event` | SessionStart, SessionEnd, UserPromptSubmit | Append a JSONL entry to `journal/hook.jsonl`. |
| `journal-summarise` | SessionEnd | Trigger the chosen summarise approach (§7.2.4). |
| `git-guardrails` | PreToolUse (Bash) | Block force-push, hard reset, `clean -fd`, `branch -D`, `checkout .`, `restore .`, `commit --no-verify`. Exit 2 to signal block. |
| `lint-format` | PostToolUse (Edit, Write) | Run formatter/linter on changed files. Project-stack-specific; chosen at bring-up by Local DevOps. |

#### 7.4.2 Hook event matrix

Each hook listens to specific Claude Code events. The matrix:

| Hook | SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | SessionEnd |
|---|---|---|---|---|---|
| journal-event | ✓ | ✓ | | | ✓ |
| journal-summarise | | | | | ✓ |
| git-guardrails | | | ✓ (Bash matcher) | | |
| lint-format | | | | ✓ (Edit/Write matchers) | |

#### 7.4.3 Project-level vs. global wiring

Hooks are **NOT installed globally**. They are wired per project in the project's `.claude/settings.json`, which the Substrator generates at bring-up. The hook scripts themselves are **copied** (not symlinked) from `substrate/templates/project-bootstrap/.claude/hooks/` into the project's `.claude/hooks/`, so they're self-contained.

Reasoning: hooks are tied to project semantics (lint-format depends on stack; journal paths are project-relative). Global hooks would have to know about every project's stack and structure — not worth the indirection.

#### 7.4.4 Out of scope for v1

Per your instruction, no additional hooks. Items considered and explicitly deferred:
- Filesystem dangerous-ops guards beyond git.
- Post-Edit auto-staging.
- repo-map regeneration on file create/delete.
- SessionStart context loader (loading additional context based on brief shape).
- UserPromptSubmit triage detector (auto-classifying briefs before the CEO sees them).

These may earn their place later but require evidence of friction first.

---

## 8. Wiring & mechanisms

### 8.1 Skill activation in practice

Worked example: the Engineer becomes a FastAPI engineer in a FastAPI project.

1. User opens Claude Code in `~/code/sudoku-api`. The TL persona picks the next ticket from the tracker.
2. Tracker says: "implement POST /puzzles endpoint per ADR-0003".
3. TL hands off to the Engineer with a memo (ticket + ADR pointer + acceptance criteria).
4. Engineer's persona file loads (substrate-level, polyglot).
5. Project's CLAUDE.md loads. Its "Active skills" section names: `golem-python-fastapi-codestyle`, `golem-alembic-sqlalchemy`, `golem-pytest-fastapi`, `golem-pr-creation`, `golem-tdd`, `golem-verification-before-completion`. The Engineer references these skills explicitly per its Skill playbook (§5.2).
6. The Engineer now has: a polyglot persona + a declared FastAPI skill set + project-specific CONTEXT.md + project-specific ARCH.md + the ticket's hand-off memo. The "Engineer in a FastAPI project" specialisation is the **sum of these context layers**, not a different persona.
7. The Engineer reads the ticket, expects the failing tests already produced by the Test Spec/Writer hand-off (§8.3), implements, invokes `golem-verification-before-completion`, hands off to `golem-pr-creation` to open the PR, invokes `golem-summarise-session` as the closing reflex.

Drop the same Engineer persona into `~/Documents/software/experiments/golem-projects/blog-frontend` (a Next.js project) and the CLAUDE.md declares `golem-nextjs-app-router`, `golem-react-server-components`, `golem-tailwind-design-tokens`, `golem-vitest-rtl`. Same persona file, different specialisation.

### 8.2 Inter-agent handoff contract

A handoff is the moment one persona finishes and another picks up. Without a human to glue this, the contract is explicit.

**The leaving persona writes:**
1. A hand-off entry in the ticket's "Hand-off log" section. Plain prose: "I did X. Y is left for the next persona. Watch out for Z."
2. Updated tracker frontmatter (state, updated, any new related_adrs).
3. Any artefacts produced (PR link, ADR file, agent-note file) referenced by path.
4. Optionally, a journal entry if the work is non-trivial.

**The arriving persona reads:**
1. The ticket's frontmatter and full body.
2. The hand-off log (most-recent entry first).
3. Referenced artefacts.
4. Project-level standing context (CLAUDE.md, CONTEXT.md, ARCH.md) — these are not handoff-specific.

The TL is the synchronisation point. The TL reads the same hand-off log to decide who runs next. The TL **does not bypass** the contract — every transition writes a hand-off entry, even when the TL is just routing.

### 8.3 The Test Spec Writer / Test Writer / Engineer / TDD-skill quartet

**Open question.** Concerns the relationship between Engineer, Test Spec Writer, Test Writer, and the `tdd` skill.

**Tensions:**
- The `tdd` skill says "write a failing test first" — but the Engineer can't write the test (anti-reward-hacking constraint).
- The Test Spec Writer / Test Writer normally trigger pre-commit on the Engineer's code. Pre-commit is *after* the Engineer has written code, not before.
- If Test Spec / Test Writer trigger before code (TDD-style), they need the brief and acceptance criteria — they don't see the Engineer's code yet.

**Candidate resolutions:**

**A. TDD as a Test-Spec-Writer-driven loop, not Engineer-driven.** TL routes the ticket to the Test Spec Writer first (writes specs from acceptance criteria), then Test Writer (writes failing tests against specs), then Engineer (makes them pass). Pre-commit hook is unchanged — re-runs Test Spec/Writer to check the engineer's commit didn't break the spec. The `golem-tdd` skill belongs to the TL (orchestration) and the Test Writer (technique).

**B. Engineer writes a "spec proxy" failing test.** The Engineer writes a dummy capturing what success looks like, hands off, and the Test Spec Writer / Test Writer rewrite it properly. **Risk:** re-introduces reward-hacking via the proxy.

**Tentative direction: A.** The pattern is "Test Spec Writer → Test Writer → Engineer → pre-commit Test Spec Writer + Test Writer → Code Reviewer". Without Modus Operandi in v1, every ticket runs the full pre-Engineer pass.

The `golem-tdd` skill itself lives at the substrate level. Its body describes the red/green/refactor loop and the vertical-slice rule. Both the TL (for orchestration) and the Test Writer (for technique) reference it. The Engineer does **not** reference `golem-tdd` directly — its job is to make tests pass, not to drive the TDD loop.

**Tracked in §12 (Q-002).** Resolution comes from first dogfood ticket that involves TDD.

### 8.4 Reviewer feedback loop

Code Reviewer's verdict has three values: **approve**, **request-changes**, **block**.

- **Approve.** TL transitions ticket to `done`. PR merges (Cloud DevOps watches the merge, runs CD).
- **Request-changes.** TL transitions ticket back to `in-progress`. Hand-off log gets a Reviewer entry detailing the requested changes. Engineer picks up. Cycle repeats.
- **Block.** TL transitions ticket to `blocked`. Hand-off log captures the blocking reason. Reasons that earn `block` (vs. `request-changes`):
  - The change conflicts with ARCH/ADR and needs re-architecture.
  - The change requires a deferred ticket from another stream first.
  - The brief itself is wrong and needs CEO re-routing.

**The TL is the only persona that mutates ticket state.** The Reviewer writes a verdict in the hand-off log; the TL acts on it.

### 8.5 The Substrator → Tech Architect handoff

The boundary between substrate and code-tree.

**Substrator finishes when:**
- CONTEXT.md exists with vocabulary stubs and an empty boundaries section.
- docs/ARCH.md exists with stack stub.
- docs/adr/0001-stack-choice.md exists (Proposed status; body to be filled by Tech Architect after stack choice).
- Conventions, repo-map, agent-notes directories exist with their respective README explainers.
- Tracker is initialised with **three pre-loaded stories**:
  1. "Set up local dev environment" → Local DevOps.
  2. "Author 0001 stack ADR" → Tech Architect.
  3. "Scaffold the application per stack" → Tech Architect (depends on 2).
- `.claude/settings.json` wires hooks; `.claude/hooks/` contains hook scripts.
- README.md is stubbed for humans.

Substrator hands off to **TL** (not directly to Tech Architect). TL reads the substrator's hand-off memo and the tracker, sees the three pre-loaded stories, and dispatches.

**Tech Architect's scaffold output goes into `src/`** (or whatever the stack convention is). It does not modify substrate-level files except:
- Updating ARCH.md with concrete stack decisions.
- Promoting `docs/adr/0001-stack-choice.md` from Proposed to Accepted.
- Updating CLAUDE.md's "Active stack" and "Active skills" sections.

After Tech Architect's scaffold, the project is ready for feature work.

### 8.6 Session model and hand-off mechanism

Personas don't run in a vacuum — they run inside Claude Code's session model. This section pins down which Claude Code mechanism every hand-off uses, so the implementation isn't ambiguous.

**Two hand-off shapes are supported. Sub-flow choses which.**

**Option 1 — Sub-agent call (sequential, single-shot).** The orchestrator (CEO or TL) invokes the next persona via the Agent tool with a `subagent_type` matching the persona file. The sub-agent runs to completion in an isolated context, returns its result, and is gone. The orchestrator reads the result from the ticket's hand-off log + any artefacts written, then routes the next sub-agent.

Used for **all sequential hand-offs** where the previous persona doesn't need to see follow-up work:
- CEO → Scout / Prospector / Smelter (each runs once, returns its output, done).
- CEO → TL (TL is long-lived per project; first invocation is a sub-agent call into a project session).
- TL → Substrator (one-shot bring-up).
- TL → Local DevOps / Cloud DevOps (each ticket is one-shot).
- TL → Diagnoser (returns verdict; Diagnoser is done).
- TL → Documentarian (post-merge sweep; one-shot).
- Engineer → pre-commit Test Spec Writer / Test Writer (these run on the Engineer's commit, not in dialogue).

**Option 2 — Agent team with iterative SendMessage (persistent context).** Two or more sub-agents are spawned into the same "team" once and then exchange messages via SendMessage. Each addressee retains its own context across messages — so a Reviewer can iterate on an Architect's spec without the Architect having to re-load context every round.

Used for **iterative loops** where roles need to retain memory of the dialogue:
- Product Architect ↔ Product Architecture Reviewer (iterate until specs are sound).
- Tech Architect ↔ Tech Architecture Reviewer (iterate until architecture is sound).
- Engineer ↔ Test Spec Writer ↔ Test Writer (TDD loop per §8.3, where the test agents and the engineer go back and forth on the same ticket).
- Engineer ↔ Code Reviewer (request-changes loop per §8.4, when revisions cycle within the same PR).

**Option 3 — Independent disconnect-and-respawn — rejected.** "Spawn a fresh sub-agent each turn and have it reconstruct context from the tracker / journal" is conceptually clean but breaks down on iterative work: every round pays full re-load cost, and subtle in-context state (e.g. a Reviewer's mid-thought) is lost. For sequential one-shots, Option 1 already covers this; for iterative loops, the cost is prohibitive.

**Caveat (validation needed during first dogfood).** The cross-message context retention behaviour of agent teams' SendMessage is **inferred** from documented behaviour but not explicitly guaranteed in the public Claude Code docs. We design as if "an already-spawned teammate retains its context across SendMessage rounds" holds. If first dogfood shows it does not, we fall back to Option 1 for all hand-offs and accept the re-load cost on iterative loops, with explicit context-passing in the message body. Tracked in §12 (Q-009).

**Hand-off contract is the same in both options.** §8.2's contract (hand-off log entry, frontmatter update, artefact paths, journal entry) applies regardless of mechanism. The difference is only how the next persona is reached.

---

## 9. Project lifecycle

End-to-end walkthroughs.

### 9.1 Greenfield: fresh idea → ideated → bootstrapped → first feature shipped

User: "I think there's an opportunity in tools for indie game devs around playtesting. Want to explore."

1. CEO reads the brief, classifies as fresh idea. Creates `~/Documents/software/experiments/golem-ideas/playtesting-tools/` workspace.
2. CEO delegates to Scout: "scan indie gamedev communities, existing playtesting tools, recent threads, marketplace gaps."
3. Scout returns 12 candidate ideas with citations.
4. CEO delegates to Prospector: market research on the 12.
5. Prospector returns 4 business cases (others scored low on viability).
6. CEO delegates to Smelter: feasibility assessment, pick one.
7. Smelter picks "asynchronous playtest video collection + structured feedback for solo devs". Reasoning attached.
8. CEO re-enters as branch 2 (established idea). Provisions `~/Documents/software/experiments/golem-projects/playtest-tool/` as the project directory. Hands off to TL.
9. TL delegates to Substrator. Substrator initialises CONTEXT, ARCH stub, conventions, repo-map, tracker, hooks.
10. TL delegates to Product Architect → Reviewer iteration. Specs land.
11. TL delegates to UX Designer (UI is core). Design specs land.
12. TL delegates to Tech Architect → Reviewer iteration. Stack chosen (Next.js + Supabase). ADR-0001 accepted. Project scaffolded. Dev stories written into tracker.
13. TL delegates to Local DevOps. Local dev env stories executed first.
14. TL begins dispatching feature stories: Engineer + Test Spec Writer + Test Writer + Code Reviewer.
15. First PR merges. Cloud DevOps provisions infra and CI on this first merge.
16. Documentarian sweeps post-merge. Promotes any agent-notes that recurred.

### 9.2 Brownfield: feature into existing project

User (in `~/Documents/software/experiments/golem-projects/playtest-tool/`): "Add a way for devs to tag clips with a single emoji reaction so testers can sort feedback."

1. CEO classifies as continuation, forwards to playtest-tool's TL.
2. TL creates ticket TKT-0023 in `tracker/triage/`, transitions to `open/` after sanity-check.
3. TL routes through Product Architect: "extend specs to include emoji-tagging behaviour." Reviewer iterates. Specs updated.
4. TL routes through UX Designer: "design the tagging UI affordance + sort UI for testers." Design specs updated.
5. TL routes through Tech Architect: "spec the data model addition and API changes." ADR-0008 (Proposed → Accepted) for the new data model. Sub-tickets: TKT-0024 (data model), TKT-0025 (API), TKT-0026 (UI), TKT-0027 (e2e).
6. TL dispatches sub-tickets. Engineer + Test agents + Code Reviewer cycle for each.
7. PRs merge. Cloud DevOps deploys.
8. Documentarian sweeps post-merge. Updates CONTEXT (new vocabulary: "tag", "reaction") and ARCH (new endpoint group).

### 9.3 Brownfield: bug fix (Diagnoser-first)

User: "Webhook for `invoice.paid` is sometimes processing the same payment twice."

1. CEO classifies as continuation, forwards to TL.
2. TL creates ticket TKT-0042 in `triage/`. **Diagnoser-first**: routes immediately to Diagnoser without product/arch involvement.
3. Diagnoser reproduces. Verdict: "Webhook handler does not check Stripe's idempotency key; concurrent retries from Stripe's side cause double-processing. Classification: code. Routing: development team."
4. TL transitions ticket to `open/` with Diagnoser verdict in frontmatter.
5. TL dispatches to Engineer with the verdict as hand-off context. Engineer implements idempotency-key check. Pre-commit Test Spec Writer + Test Writer add a regression test. Code Reviewer approves.
6. PR merges. CD runs.
7. Documentarian sweeps. Promotes the fix's pattern into a convention if this is the second time the same class of bug has appeared.

**If the bug had been infra** (e.g. "the staging deploy is failing on migration step"), Diagnoser would classify as `infra` and TL would route to Cloud DevOps instead of Engineer.

**If the bug had been architectural** (e.g. "the webhook handler does too much; we keep adding race conditions because the design is wrong"), Diagnoser would classify as `architecture` and TL would route to Tech Architect (new ADR + revised specs + dev stories) before any code work.

---

## 10. File layout

### 10.1 Substrate repo layout

```
golem/
├── archive/v0/                    # the v0 stuff, kept for reference only
│   ├── design/                    # v0's split design docs
│   ├── substrate/                 # v0's substrate implementation
│   └── research/                  # v0-era research notes
├── project_management/
│   ├── agent_specs/               # WIP intent docs (01_intent_v0.md, 02_revision_v1.md, …)
│   └── design/                    # design docs (this file: design_v1.md, …)
├── substrate/                     # the actual substrate, installed via install.sh
│   ├── agents/                    # one .md per persona (20 files for v1)
│   │                              # source: golem-<name>.md, installed flat to ~/.claude/agents/
│   ├── skills/
│   │   └── golem-<skill-name>/    # one dir per skill, with SKILL.md inside
│   │                              # installed flat to ~/.claude/skills/
│   ├── hooks/                     # shell scripts (journal-event, journal-summarise, git-guardrails, lint-format)
│   ├── templates/
│   │   └── project-bootstrap/     # copied into new projects at bootstrap
│   ├── install.sh                 # symlink personas + skills into ~/.claude/
│   └── bootstrap-project.sh       # manual bootstrap fallback
└── README.md
```

**Install layout (after running `install.sh`):**
- Personas: `~/.claude/agents/golem-<name>.md` (flat — agent discovery is one level).
- Skills: `~/.claude/skills/golem-<skill-name>/SKILL.md` (flat — skill discovery is one level; subdirs allowed only under each skill for examples/templates).

**Why flat with `golem-` prefix.** Per research: skill discovery walks `~/.claude/skills/<name>/SKILL.md` — nested groups like `~/.claude/skills/golem/<name>/SKILL.md` are not picked up. Same flatness applies to agents. The `golem-` prefix gives us a namespace inside the flat tree so golem-authored artefacts don't collide with the user's other skill / agent collections.

**Agent priority (per Claude Code resolution order):** managed > CLI > project (`.claude/agents/` inside a repo) > user (`~/.claude/agents/`) > plugin. Golem personas live at the user level, so a project-level override (a `.claude/agents/golem-engineer.md` inside a specific repo) would win for that repo. We do not currently use project-level overrides; flagging this as available if a project ever needs to specialise.

**Cross-project agent invocation is not supported** by Claude Code. A persona invoked in project A cannot directly reach a persona in project B. The CEO → TL hand-off therefore always happens by the CEO ending its session and the user (or a wrapper) starting a new session in the target project's directory, where the project's TL persona becomes available. This is a v1 constraint, not a flaw — the user's harness already does session-per-project.

The `substrate/` directory is rebuilt fresh in v1 (the v0 substrate is in `archive/v0/substrate/`). The shape is similar but not identical — v1 has the new persona roster (§5) and the skills shortlist (§6.4), not the v0 set.

### 10.2 Project layout (post-Substrator bring-up)

```
<project-name>/
├── README.md                      # human-only
├── CLAUDE.md                      # entrypoint for agents
├── CONTEXT.md                     # domain context (vocabulary + boundaries; split if grows past threshold)
├── docs/
│   ├── ARCH.md
│   ├── CONTEXT-MAP.md             # only present if CONTEXT.md was split
│   ├── repo-map.md
│   ├── conventions/
│   │   ├── README.md
│   │   ├── testing.md
│   │   └── …
│   ├── adr/
│   │   ├── 0000-template.md
│   │   └── 0001-stack-choice.md
│   └── agent-notes/
│       └── README.md
├── tracker/
│   ├── README.md                  # tracker schema doc
│   ├── INDEX.md                   # generated board view
│   ├── triage/
│   ├── open/
│   ├── in-progress/
│   ├── review/
│   ├── blocked/
│   └── done/
├── .claude/
│   ├── settings.json              # hooks wired
│   └── hooks/                     # copies of substrate hooks
├── journal/                       # gitignored
│   ├── hook.jsonl                 # mechanical: one line per Claude Code event
│   └── summary.jsonl              # semantic: one line per session (closing reflex)
├── src/                           # the application code (Tech Architect's scaffold)
└── .gitignore
```

### 10.3 Top-level vs. docs/ — applied

Per §7.1.7 decision: README.md, CLAUDE.md, CONTEXT.md at top. Everything else under `docs/`. CLAUDE.md's "Pointers" table is the index that maps logical names to filesystem paths so the placement is one less thing for agents to memorise.

---

## 11. Decisions log

Append-only. Each entry: number, date, decision, reasoning.

**D-001 — 2026-05-05 — Archive v0 entirely; start v1 from a clean slate.** v1's persona model, flow, and Modus Operandi differ enough from v0 that incremental edits would muddle intent. v0 preserved at `archive/v0/` for reference.

**D-002 — 2026-05-05 — Roster: 20 personas in 8 sections.** Includes CEO and TL explicitly (filling the routing/management gap noted in v0); Substrator as a named persona (was implicit in v0); Engineer as a single polyglot persona (collapsing Frontend/Backend/Fullstack/Integrations); Test Spec Writer + Test Writer kept as two personas separate from Engineer (anti-reward-hacking); Diagnoser, Documentarian, Meta-agent included.

**D-003 — 2026-05-05 — Modus Operandi (Quick / Defer / Thorough) deferred to v2.** Originally planned as core; pulled out of v1 to keep the substrate small enough to ship and dogfood. v1 fallback: full flow runs every time (Thorough-equivalent, with the obvious skip-conditions in §3.3 / §3.4). Detail in [`v2_notes.md` § N-001](v2_notes.md). Reverses the earlier "core, not deferred" decision recorded on the same day.

**D-004 — 2026-05-05 — Skills come in three categories: technical, substrate, SOP.** Activation is declarative-primary via CLAUDE.md "Active skills" + persona Skill playbook (§5.2). Reflexive activation via SKILL.md `description` matching is accepted as a fallback but not relied on — see D-018.

**D-005 — 2026-05-05 — Technical skills are built on dogfood demand, not pre-stocked.** First project picks a stack; technical skills for that stack are authored as part of bring-up.

**D-006 — 2026-05-05 — Project tracker stays markdown-files-with-frontmatter.** Concerns about token cost are noted but unverified; revisit if first dogfood shows real friction. Self-describing wins over schema-database for v1.

**D-007 — 2026-05-05 — CONTEXT.md and CONTEXT-MAP.md merge into one CONTEXT.md by default.** Split is a maintenance event triggered by size threshold (~500 lines), not the default state.

**D-008 — 2026-05-05 — Top-level lean: README, CLAUDE.md, CONTEXT.md at top; rest in docs/.** CLAUDE.md "Pointers" table maps logical names to paths.

**D-009 — 2026-05-05 — Hooks minimum set for v1: journal-event, journal-summarise, git-guardrails, lint-format.** No additional hooks until evidence of friction.

**D-010 — 2026-05-05 — Diagnoser-first for fix tickets.** Fixes do not route based on the brief's surface description.

**D-011 — 2026-05-05 — Substrator vs. Tech Architect boundary: substrate-only vs. code-tree-only.** Substrator initialises CONTEXT/ARCH stubs/conventions/repo-map/tracker/hooks. Tech Architect picks stack, scaffolds the application, writes dev stories. They never overlap.

**D-012 — 2026-05-05 — Single CEO and single TL persona; multiple "boxes" in the flow diagram are the same persona at different invocation points.** No per-project TL persona file.

**D-013 — 2026-05-05 — No human in the loop for routine flow.** Substrate evolution (Meta-agent proposals) is the one place where user gate is required, because substrate edits affect every future project.

**D-014 — 2026-05-05 — UX Designer produces design specs, not visual designs.** No drawing tools in the loop. Output is detailed enough for engineering to build a components storybook directly. Visual design tools (claude-design, google-stitch) deferred indefinitely.

**D-015 — 2026-05-05 — Cloud DevOps takes infra-update requests from the TL only.** Individual engineers cannot trigger infra changes directly.

**D-016 — 2026-05-05 — Local DevOps's first stories seed the tracker before any feature work.** Local dev env setup must precede feature stories; the order is an invariant the TL enforces.

**D-017 — 2026-05-05 — Architecture / Product Reviewers held separate from Architects to prevent self-approval.** Iteration loop is enforced; the Architect cannot approve its own specs.

**D-018 — 2026-05-05 — Skill activation is declarative-primary; reflexive activation accepted as fallback only.** Progressive disclosure / "Use when…" matching is unreliable in practice (silent misses; matching depends on the model's framing). Personas reference skills by name with explicit triggers in their Skill playbook (§5.2). Reflexive matching still happens because frontmatter loads anyway, and we accept that as bonus coverage rather than primary mechanism.

**D-019 — 2026-05-05 — Hand-off mechanism is hybrid: Option 1 (sub-agent calls) for sequential one-shots; Option 2 (agent teams + SendMessage) for iterative loops.** Sequential one-shots: CEO → Scout/Prospector/Smelter, TL → Substrator, TL → Diagnoser, TL → Documentarian, etc. Iterative loops: Architect ↔ Reviewer pairs, Engineer ↔ Test Spec/Writer (TDD), Engineer ↔ Code Reviewer (request-changes). Detail in §8.6. Independent disconnect-and-respawn (Option 3) rejected — too costly on iterative work.

**D-020 — 2026-05-05 — Semantic journal is one append-only JSONL file per project, not per-session YAML files.** Path: `journal/summary.jsonl`. One JSON line per session, written by the closing reflex (§7.2.4). Reasoning: append-only matches the natural shape; one git diff per session; no file-name proliferation; cheap to scan linearly. Detail in §7.2.3.

**D-021 — 2026-05-05 — Namespace convention: all golem-authored substrate artefacts are prefixed `golem-`.** Skills install flat to `~/.claude/skills/golem-<name>/SKILL.md`; agents install flat to `~/.claude/agents/golem-<name>.md`. Skill and agent discovery in Claude Code is flat at one directory level (verified via research) — nesting under a `golem/` directory is not picked up. The prefix gives us a logical namespace inside the flat physical layout. Detail in §6.2 and §10.1.

**D-022 — 2026-05-05 — Inter-agent contract is contract-by-receiver via the receiver's Expects.** Each persona's `Expects` (§5.2 template) declares what it needs in context to operate. The leaving persona's hand-off memo satisfies that contract. We do not maintain a separate cross-cutting contract registry — contracts live with the receiver because the receiver is the authority on what it needs. Compatible with §8.2's hand-off mechanics.

---

## 12. Open questions

Things we know are unresolved as of this version. Each entry: question, why it matters, candidates, tentative direction, decision deadline.

**Q-001 — Journal summarise wiring.** Where: §7.2.4. Why it matters: without a working summary mechanism, the semantic journal is missing and the Documentarian / Meta-agent lose their richest signal. Candidates: (A) pre-SessionEnd reflex skill the working agent invokes; (B) hook-driven summariser sub-agent reading a hand-off memo; (C) Documentarian backfills from mechanical journal. **Tentative: A, with C as fallback for abnormal session ends.** Decision deadline: before first dogfood project ships its first PR.

**Q-002 — TDD skill ownership and test-agent handoff.** Where: §8.3. Why it matters: ambiguity here means the Engineer either gets blocked waiting for tests or accidentally re-introduces reward-hacking. Candidates: (A) Test Spec → Test Writer → Engineer → pre-commit Test agents → Reviewer; (B) Engineer writes proxy tests. **Tentative: A.** With Modus Operandi deferred (D-003), every ticket runs the full pre-Engineer pass; no per-mode branching here in v1. Decision deadline: before first dogfood ticket that involves TDD.

**Q-003 — Project tracker token cost in practice.** Where: §7.3.1. Why it matters: if editing markdown ticket files is genuinely expensive in tokens at the volume the substrate generates, we revisit storage. Candidates: stay markdown (default); migrate to sqlite; hybrid (sqlite for state, markdown for body). **Tentative: measure during first dogfood, then decide.** Decision deadline: end of first dogfood.

**Q-004 — CLAUDE.md final shape and size budget.** Where: §7.1.1. Why it matters: every agent loads it; bloat costs tokens session-wide. Candidates: target ~50 lines; ~100 lines; per-section budget. **Tentative: ~50–100 lines, with per-section soft caps.** Decision deadline: end of first dogfood.

**Q-005 — _moved to v2_.** Was "Modus Operandi defaults and Defer-mode replay." Modus deferred to v2 (D-003) — see [`v2_notes.md` § N-001](v2_notes.md). Slot kept for numbering stability across the doc.

**Q-006 — _moved to v2_.** Was "How does the CEO know the Modus Operandi when no signal is given?" Same rationale as Q-005.

**Q-007 — Reviewer specialisation.** Where: implicit in roster. The Code Reviewer is one persona; do we need a UX-specific reviewer, an infra-specific reviewer, etc.? Why it matters: scope creep risk in Code Reviewer's mandate. Candidates: keep one Reviewer with skill-loadout per project; add specialised reviewers when needed; make Architecture Reviewers also do code review for their domain. **Tentative: keep one Reviewer; add specialisation only on evidence.** Decision deadline: end of first dogfood.

**Q-008 — Resolved by D-018.** Was "Skill activation precedence." Resolved: declarative-primary via CLAUDE.md + persona Skill playbook explicit triggers; reflexive matching accepted as fallback only. See §6.2.

**Q-009 — Agent team SendMessage context retention.** Where: §8.6. Why it matters: Option 2 (iterative loops via SendMessage) assumes an already-spawned teammate retains its context across rounds. This behaviour is inferred from documented patterns but not explicitly guaranteed in Claude Code's public docs. If retention fails, Architect↔Reviewer and Engineer↔Code Reviewer loops degrade to repeated full-context re-loads. Candidates: rely on the inferred behaviour and validate during first dogfood; pre-emptively pass full context every round (the safe-but-expensive option); fall back entirely to Option 1 with explicit context restated in each message body. **Tentative: rely on inferred behaviour; validate during first dogfood; if it fails, fall back to Option 1.** Decision deadline: end of first dogfood.

---

## 13. Out of scope (v1)

Explicitly deferred so they don't leak into design discussions for v1.

### 13.1 UI / visual substrate

A visual interface for interacting with the substrate (n8n-style flow editor, real-time agent status, tracker board view) is appealing but not v1. The current model — Claude Code as the harness, markdown files as the substrate — is sufficient to validate the substrate's ideas. A visual layer is **Phase 2+**, after the substrate has earned its right to exist through dogfood.

### 13.2 Cloud / remote triggers

Triggering golem from non-local sources (webhooks, cron, scheduled tasks) is not v1. v1 is single-user, single-machine, locally-triggered.

### 13.3 Eval / regression harness for the substrate itself

A test harness that runs golem against canonical briefs and scores its output (did the right personas run? did the artefacts get produced?) is valuable in principle but premature now. We don't yet know what "correct" looks like; the dogfood will produce that intuition.

### 13.4 Multi-project meta-coordination beyond Meta-agent

Cross-project orchestration — running the same ticket across multiple repos, sharing context between projects beyond what Meta-agent already does — is not v1. Meta-agent's substrate-evolution role is the only multi-project concern in scope.

### 13.5 Anthropic-API-only mode (no Claude Code)

Running golem outside Claude Code (e.g. as a pure Anthropic SDK agent loop) is not v1. Claude Code is the harness; the substrate's hooks, skills, and personas all assume Claude Code's loading model.

### 13.6 Real visual UX design tools

claude-design, google-stitch, Figma-like generation. UX Designer produces specs only; the engineering team derives a components storybook from the specs. Pixel-perfect visual comping is out of scope.

---

## Appendix A. Diagrams

The two flow diagrams supplied by the user are canonical:
- `project_management/agent_specs/shape_A63cns9AIiANj_HUCNon1 at 26-05-02 19.21.33.png` (composite, original)
- The clearer pair shared on 2026-05-05 (Project Development + Ideation Phase).

### A.1 Conceptual flow — Project Development (textual rendering)

User Brief → CEO (top-level routing). CEO branches:
- **Fresh Idea / Raw Brief** → Ideation Phase (A.2).
- **New Project** → CEO project provisioning (initialise project directory, hand to TL).
- **Patch into existing project** → existing project's TL.

Inside Project Development (new-project bring-up):
- TL initialises project directory.
- TL → **Substrator** (substrate components: journaling, agents/skills/hooks templates, CONTEXT/CONTEXT-MAP/ARCH/ADR/conventions/repo-map init, tracker init).
- TL → **Product Architect** → **Product Architecture Reviewer** (iterate to satisfactory specs).
- TL → **UX Designer** (if UI needed; produces design specs, not visuals — components storybook-ready).
- TL → **Tech Architect** → **Tech Architecture Reviewer** (iterate; scaffold per stack; create dev stories in tracker).
- TL → **Local DevOps** (first stories: set up local dev env; dictate dev-env terms in CONTEXT and ARCH).
- TL → **Development team** (Engineer; pre-commit Test Spec Writer + Test Writer; PR after N commits; Code Reviewer; iterate until approve).
- **Cloud DevOps** (first-time infra/CI; per-PR CD; rollbacks; takes infra requests from TL only).

Patch flow (existing project, brownfield):
- Project TL receives feature or fix; adds to tracker.
- **Feature**: PA → designer (if UI) → TA → dev team.
- **Fix**: Diagnoser → TL routes per classification (code / architecture / infra) → relevant team.

### A.2 Conceptual flow — Ideation Phase (textual rendering)

User Brief → CEO. If fresh idea/raw brief:
- Ideation CEO (continuation of CEO at this stage):
  - Understands stage / what's next.
  - Creates project directory for upcoming work.
  - Delegates to Scout (if needed): broad scouting research.
  - Delegates to Prospector (if scouting not needed): direct market research.
- **Scout** → produces candidate raw ideas → flows to **Prospector** ("requires turning into solid business ideas").
- **Prospector** → produces business cases → flows to **Smelter** ("requires choosing the most valuable").
- **Smelter** → picks the one most valuable → returns to outer CEO.
- Outer CEO triggers New Project with the picked idea.

### A.3 _Removed — Modus Operandi diagram deferred to v2._

Was: a sketch of CEO-level Modus branching (Quick / Defer / Thorough). Now lives with the rest of the Modus design in [`v2_notes.md` § N-001](v2_notes.md). Slot kept for numbering stability.
