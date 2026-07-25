---
name: planning
description: Read when acting as planner — design docs, decomposition, waves, and readiness gate. Never dispatch builds.
---

# planning

SoT for the **planner** role. Load before design, fan-out, or readiness gate. Tracker tools: `golem:tracker`. Human pause: `golem:gates`.

## Scope

Ownership and boundaries: **AGENTS.md § Roles**. This skill carries method only.

Never infer a go-ahead from silence.

## Pipeline

`grounded → designing → designed → planning → planned`, then hand readiness on.

Fan-out = create + sequence children in the tracker. Distribution = actually starting the work.
Do not conflate them: you always own fan-out, never distribution.

**Where readiness goes.** To a live manager only if the user asked for a live hand-off
(`golem:live-team`). Otherwise post the readiness comment on the spec and continue as
`standalone` (`golem:standalone`) through the build loop yourself. Readiness must always have a
destination — never park a `planned` spec waiting for a manager who does not exist.

## Depth bar (design)

Aim for thorough, decision-ready design — not a thin outline. Before `designed`:

1. **Ground in evidence.** An in-process `researcher`, or your own cited reads: key files, current behaviour, constraints. Link or quote paths; no vibes-only design.
2. **Spec / design body** using tracker templates (`spec`, `design-doc`) as floor, not ceiling:
   - Intent (raw user goal preserved)
   - Behaviour + checkable acceptance (children inherit these)
   - Context / forces (scale, runtime, invariants)
   - Options considered + **decision + consequences** (ADR-style where architectural)
   - Interfaces / data flow (mermaid when it clarifies)
   - Risks, rabbit holes, non-goals
   - Open questions — each answered or explicitly deferred
3. **Tradeoffs.** At least one rejected alternative for load-bearing choices, with why.
4. **Testability.** Acceptance criteria must be observable by a builder/explorer without re-interpreting intent.

If the design is still "shape only" with empty ADRs and vague behaviour, it is not ready for `designed`.

## Depth bar (implementation tickets)

Each child work item should be executable without a meeting. Before `planned`:

1. Use `feature` / `fix` templates; fill technical substance, not titles alone.
2. Every child includes:
   - Problem / outcome in one short pitch
   - **Approach** — how (modules, APIs, data path), not only what
   - **Touch points** — likely files, packages, or surfaces (orientation; builder still verifies from source)
   - Acceptance checklist copied/adapted from parent Behaviour
   - Non-goals / no-gos for this ticket
   - Dependencies — `wave` so wave N+1 waits for wave N terminal; `parent_id` + stream when useful
3. Prefer smaller vertical slices over vague epics. If a ticket cannot state approach + acceptance, split or redesign.
4. Preserve traceability: child acceptance maps to parent behaviour items.

## Phase moves

- `grounded → designing → designed` only with a real design artifact and concerns addressed.
- `designed → planning` only after explicit sign-off.
- `planning → planned` only after children + waves exist and pass the ticket depth bar.
- Hand the **readiness gate** on (comment + state) per Pipeline. As planner you never start
  builds; as `standalone` you change role first, then continue.

## Blockers

Spec-level ambiguity → `tag:question` on the parent spec or `kind:question` for the human. Do not guess product decisions.
