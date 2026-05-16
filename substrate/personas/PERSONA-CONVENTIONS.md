# golem persona conventions

How every golem persona file is written. `substrate/personas/golem-ceo.md` is the reference implementation; this document generalises its conventions to the sub-agent personas in `substrate/agents/golem-*.md`. Read this before writing or editing any persona.

## Principles

1. **Self-contained for a fresh, context-free session.** A persona is loaded into an agent with no memory of prior runs that sees nothing but its persona file, the prompt passed to it, and whatever it reads from disk. The persona + `golem-handoff-protocol` + the skills the persona names are the *complete* instruction set. Write so that agent never has to guess.
2. **Completeness is the bar; length is not.** Never compress to a line target. Cut redundancy and restated mechanics; never cut a decision the agent must make. If a fresh session would be unsure what to do next, the persona is incomplete — that failure outranks any length concern.
3. **Decision inline, execution in skills.** State *what* the role does and *when*. For *how*, name a skill and its load trigger. Never restate a skill's procedure in the persona.
4. **Reference `golem-handoff-protocol`, never restate it.** The closing reflex, sub-agent isolation, the no-user-fallback rule, team/`SendMessage` mechanics, the productive-turn-1 rule — all live there. Personas point to it; they do not re-explain it.
5. **Tables for structured choices, prose for judgement, diagrams only for genuinely graph-shaped flow.** Most sub-agent personas need no diagram.
6. **One tiered guardrails block** — not scattered "NON-NEGOTIABLE" paragraphs and a separate "what you do NOT do" dump.

## Frontmatter

`name`, `description`, `tools` only. **No `hooks:` block** — hooks are wired in the project `.claude/settings.json` that the Substrator lays down; a `hooks:` block in persona frontmatter is dead duplication. Strip it wherever it appears.

`tools`: leaf personas get `Read, Write, Edit, Bash` (plus `WebFetch, WebSearch` for the ideation trio and meta); team members additionally get `SendMessage`.

## Shared skeleton (all archetypes)

1. **Title + opening frame** (2–3 sentences): the role in one line, then the fresh-session frame — *"You are a fresh, context-free session. Your inputs are this persona file, the prompt passed to you, `golem-handoff-protocol`, and the skills named below — that is the complete instruction set. Read what you need from disk."*
2. **`## On entry`**: call `Skill(skill: "golem-handoff-protocol")` first; read the prompt passed to you and the file paths it names. (Archetype-specific additions below.)
3. **`## Mandate`**: what *done* looks like for this role — observable outcomes, not procedure.
4. **`## Inputs & outputs`**: one table — `reads / writes / never touches`. Merges the old `Expects` + `Produces` + `Touches` sections.
5. **`## Playbook`**: the role-specific *judgement* — heuristics, passes, axes, classification logic. Execution *procedures* are replaced by skill-load triggers.
6. **`## Skills`**: a `skill → load when` table.
7. **`## Hand-off`**: describe the required fields of the hand-off log entry in prose. No verbatim markdown template.
8. **`## Guardrails`**: tiered (below).

## Guardrail tiers

Lower tier wins on conflict.

- **Tier 0 — substrate integrity.** The closing reflex (`golem-summarise-session`) is the final tool call before yielding. If blocked on a missing secret / credential / API key, return a `blocked` artefact whose hand-off log names the *key names* and a suggested git-ignored target file — **never the values**. This is what lets the orchestrator raise an input gate (`golem-gates`).
- **Tier 1 — hand-off correctness.** Leaf: write the artefact to disk and return; never address the user. Team member: every loop turn ends with a `SendMessage` (or, on convergence, a hand-off log entry + closing reflex); never end a turn idle.
- **Tier 2 — role boundary.** The "never touches" list for this role.
- **Tier 3 — discipline.** Bash hygiene; no fabricated content; evidence over guessing.

## Archetype A — leaf one-shot

`golem-substrator`, `golem-ux-designer`, `golem-local-devops`, `golem-cloud-devops`, `golem-documentarian`, `golem-diagnoser`, `golem-scout`, `golem-prospector`, `golem-smelter`.

- `## On entry` adds: *"You were dispatched as a one-shot by the orchestrator. Produce your artefact, then return — you spawn no one."*
- `## Playbook` references the role's procedure skill instead of inlining it: Substrator → `golem-project-bootstrap` / `golem-retrofit`; Documentarian → `golem-context-update` + `golem-repo-map-update`; Diagnoser → `golem-diagnose`; the ideation trio → `golem-ideation`.
- **Recurring leaves** (`golem-local-devops`, `golem-cloud-devops`, `golem-documentarian`) run at bring-up *and* per continuation ticket — give both entry shapes.
- **Ideation trio** (`golem-scout` → `golem-prospector` → `golem-smelter`) are chained: each reads the prior's artefact at a named path and writes to `docs/ideation/`; they touch no tracker, specs, or code.

## Archetype B — iterative team member

`golem-product-architect`, `golem-product-architecture-reviewer`, `golem-tech-architect`, `golem-tech-architecture-reviewer`, `golem-test-spec-writer`, `golem-test-writer`, `golem-engineer`, `golem-code-reviewer`.

- `## On entry` adds: *"You were spawned with a `name` and a `team_name`; your teammates are &lt;names/roles&gt;. The orchestrator passed the ticket's absolute path in your prompt — read it first, and append your hand-off log entries there."*
- **`## Turn 1` — mandatory section.** Explicit productive turn-1 work. **No teammate may have "wait for SendMessage" as its turn-1 action** — on the synchronous backend that terminates the teammate before any message arrives. Reviewers do the **pre-bake review** (read the available baseline, `SendMessage` a pre-bake verdict so feedback is waiting when the author's v1 lands). Writers and the Engineer do a real read + plan + `SendMessage`. Honour any turn-1 instruction the spawn prompt carries.
- **`## The loop`**: a brief cadence note only. Reference `golem-handoff-protocol` for `SendMessage` shape and the ~3-round cap — do not restate them.
- **Convergence**: signal it by writing the hand-off log entry + closing reflex. The orchestrator runs team teardown — the teammate does not.

## Archetype C — out-of-band leaf

`golem-meta` only. Do **not** skeleton it like archetype A.

- Frame: runs *outside* any project journey — no project claim, no `cd`, no ticket, no tracker, no team. Triggered by the user or a cron.
- `## Inputs & outputs`: reads across all projects' journals and the substrate's own persona/skill files; writes proposals only to `substrate/meta-reports/`.
- Guardrails Tier 2: proposals only — never edits substrate persona/skill/hook files, never enters a project, never touches `~/.claude/`.
- No `SendMessage`, no team mechanics, no `## Turn 1` section.

## Global fixes — apply to every file

- Replace every stale **"TL"** with "the orchestrator" or "the CEO". The CEO and TL roles are merged into a single main-thread orchestrator — there is no separate TL.
- **Delete** the `## What this persona does NOT do` section — fold genuine role boundaries into Guardrails Tier 2; the rest was duplicating `## Touches`.
- Collapse the `## Critical rules` block (restated handoff mechanics) into the `## On entry` line plus Guardrails.
- Strip opaque internal references (`D-003`, `D-016`, `D-017`, `§7.1.2`, `§8.3`, and similar) — restate the underlying rule in plain language (e.g. "self-approval is forbidden — a separate reviewer co-signs").
- Strip the `hooks:` frontmatter block wherever it appears.
- Replace verbatim hand-off memo templates with a prose description of the entry's required fields.
