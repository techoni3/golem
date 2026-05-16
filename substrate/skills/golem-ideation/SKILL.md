---
name: golem-ideation
description: Run the golem ideation pipeline inside a project namespace — Scout then Prospector then Smelter, sequential one-shot sub-agents writing to docs/ideation/. Use when entering journey node A.1 after the project namespace has been bootstrapped.
category: substrate
---

# golem-ideation

The CEO's ideation procedure for journey node A.1. Takes a raw idea or hypothesis and runs three sequential leaf sub-agents — Scout → Prospector → Smelter — to produce a feasibility-ranked pick (or a deliberate no-pick).

## Why a golem-native skill, not `idea-pipeline`

There is an existing `idea-pipeline` skill in `~/.claude/skills/`. It is **not** adopted here, deliberately:

- It dispatches `idea-scout` / `idea-critic` / `market-analyst` / `feasibility-judge` — non-golem agents that persist to **Notion databases**. The golem ideation agents are `golem-scout` / `golem-prospector` / `golem-smelter` and persist to **disk** under `docs/ideation/`, inside the project's journalled, agent-noted, tracker-backed namespace.
- `idea-pipeline` runs its four agents **concurrently as background pollers**. golem ideation runs **sequentially** as leaf one-shots — each reads the prior artefact off disk, so Prospector must see Scout's output and Smelter must see both.

`idea-pipeline` remains valid for ad-hoc Notion-based discovery; `golem-ideation` is the substrate-integrated path the CEO uses at A.1.

## Precondition

The project namespace already exists (provisioned via `golem-project-bootstrap`), the project is registered and claimed, and the CEO's cwd is inside the project root. Ideation runs **inside** the project — there is no separate `golem-ideas/` workspace.

## The pipeline — three sequential one-shots

Each is a plain `Agent(...)` leaf dispatch (no `team_name`). Dispatch one, wait for return, `Read` its artefact, then dispatch the next. All artefacts land in `docs/ideation/`.

**1. Scout — scan the candidate space.**

```
Agent(
  subagent_type: "golem-scout",
  description: "Scan idea candidates for <topic>",
  prompt: <topic + project path + "Find 5-8 candidate ideas in this space. Write docs/ideation/scout-<date>.md.">
)
```

**2. Prospector — market research on Scout's picks.**

```
Agent(
  subagent_type: "golem-prospector",
  description: "Market research on Scout candidates",
  prompt: <project path + "Read docs/ideation/scout-<date>.md. Research market size, competitors, demand signals. Write docs/ideation/prospector-<date>.md.">
)
```

**3. Smelter — feasibility assessment and the final pick.**

```
Agent(
  subagent_type: "golem-smelter",
  description: "Feasibility + final idea pick",
  prompt: <project path + "Read docs/ideation/scout-<date>.md and prospector-<date>.md. Assess build feasibility, rank, name a single pick (with MVP scope) or a deliberate no-pick. Write docs/ideation/smelter-pick-<date>.md.">
)
```

Pass absolute paths in every prompt. Read each artefact after the Agent call returns before dispatching the next — the hand-off is on disk, not in context.

## Branching on the Smelter outcome

| Smelter outcome | CEO next step |
|---|---|
| **Pick** (a named idea + MVP scope) | Write the **G1 approval gate** (`golem-gates`), then close with the reflex and yield. **Do not auto-continue to B.2.** G1 is on by default — choosing which idea to commit build effort to is a human decision, not an orchestration one. The journey resumes at B.2 when G1 is approved (via the §0.2 gate scan); a denied/redirected G1 ends the journey. |
| **No pick**, or the brief asked for ideation only | Write `docs/agent-notes/ideation-shelved-<date>.md`, run the closing reflex. The project namespace stays as a record. |

G1 always fires on a pick — it is not suppressible by posture. The posture only changes its *flavour*: with `stop-after: ideation`, G1 is a **terminal** gate (approval confirms the recorded outcome; the journey does not continue to B.2). With default or `gates:` posture, G1 is a **pause** gate (approval resumes the journey at B.2). See `golem-gates` for both behaviours.

## Anti-patterns

- **Running the three agents concurrently.** Prospector needs Scout's file; Smelter needs both. Sequential is mandatory.
- **Wrapping any of them in a `TeamCreate`.** They are leaf one-shots — no `team_name`.
- **Writing ideation artefacts outside `docs/ideation/`.** Keeps the audit trail in one place.
- **Creating a `golem-ideas/` directory.** Ideation lives inside the project namespace.
