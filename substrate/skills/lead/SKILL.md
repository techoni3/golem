---
name: lead
description: Guide one workstream from intent through design, build coordination, and close. Use when acting as lead or managing a feature specification. Not for implementation or independent review.
---

# Lead

Keep the human's intent and the reasons for important decisions intact from the first discussion to
the final result. Own one workstream until it closes or you make a clear handoff.

## Workstream method

| Stage | Lead responsibility | Load when needed |
|---|---|---|
| Understand | Establish the goal, constraints, current state, non-goals, and unresolved decisions. | — |
| Ground | Inspect current behavior. Request focused code survey or external research only when it can change the design. Keep useful reports with the specification. | `golem:code-survey` or `golem:exploring` |
| Specify | Write or update one specification. Record the problem, chosen direction, scope, observable acceptance, and the reason for any important rejected option. | — |
| Confirm | Ask the human for decisions that only the human can make. Request independent specification review when the work needs it. | `golem:gates` or `golem:reviewing` |
| Plan | Create the minimum implementation slices. Give each slice its own scope and acceptance, and point it to the parent specification for intent. | `golem:tracker` |
| Coordinate | Route the build, keep dependencies clear, and bring returned findings back into the workstream. Recontextualize the human before asking for a decision. | `golem:live-team` only for a user-authorized live handoff |
| Reconcile | Confirm the implementation evidence and independent code judgment. Integrate the accepted work through the repository's normal path. | `golem:verify-done`, `golem:reviewing`, and `golem:git-conventions` |
| Close | Confirm the result against the specification. Update documentation only when the work made it false. Record the durable outcome and explain what changed, whether it worked, and what remains. | `golem:docs-maintenance` or `golem:tracker` when applicable |

Adapt the depth to the work. A small, clear feature does not need several research reports or many
slices. A decision with material product or technical consequences needs enough evidence and
rationale for a new reader to understand it.

## Specification content

A useful specification lets another agent build without reconstructing the design conversation.
Include:

- the problem and desired result;
- relevant current behavior and constraints;
- the chosen direction and its important trade-offs;
- scope and non-goals;
- observable acceptance;
- unresolved decisions or dependencies.

Record a rejected option only when its rejection explains an important choice. Do not add options
to make the document look complete.

## Boundaries

- Use `golem:building` when you implement a slice. This skill does not replace the builder method.
- Use an independent reviewer for review. Do not judge work that you authored.
- Keep tracker phases, review criteria, verification checks, merge procedure, and live-session
  transport in the skills that own them. Load those skills instead of recreating their procedures.
- Do not create extra slices, reports, branches, agents, or documentation unless they improve the
  requested result or another applicable instruction requires them.
