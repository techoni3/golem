---
name: code-survey
description: Read when surveying a codebase to ground a design — feasibility, blast radius, touch points, and greenfield versus brownfield. Produces a report attached to the spec. Not for web research, use golem:exploring; not for implementing, use golem:building.
---
<!-- GENERATED: skills/code-survey/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Code survey

A task method for grounding a design in the code as it actually is. A survey answers four
questions and nothing else:

1. **Is this feasible as described**, and what in the code says otherwise?
2. **What does it touch** — modules, entry points, contracts, data paths?
3. **How far does a change reach** — who consumes what would change?
4. **Greenfield or brownfield** — is there existing machinery to extend, or is this new ground?

Whoever grounds the build runs it — usually the session that will build (the lead building
in-session, or an engaged builder). An explorer runs it only for a code question no build follows.

## Write for the reader

Establish who will read the report before writing it. If you will build what you surveyed, record
what will save you an hour when you start. If anyone else might read it — and on any delegated or
multi-session route they will — write for a stranger: state each constraint in full, cite the
paths, and spell out what you would otherwise leave implicit. When unsure, write for the stranger;
guessing wrong in that direction costs a few extra lines, guessing wrong in the other costs the
finding.

## Method

- **Start from the entry point, not the grep hit.** Find where the behavior begins — a route, a
  CLI verb, a hook, an event handler — and trace forward. A grep tells you where a word appears;
  tracing tells you what runs.
- **Prefer LSP** for definitions, references, and signatures when available. "Find references"
  answers the blast-radius question directly and is hard to reproduce by search.
- **Read the tests as a specification.** They state intended behavior more precisely than the code
  and much more precisely than the docs.
- **Check the docs last and trust them least.** When docs and code disagree, that disagreement is
  itself a finding worth reporting.

## Depth bar

A survey that only lists file paths has not done the job. Before reporting:

- Every claim traces to something you actually read. Cite `path:line`.
- Name the **constraints you found**, not just the structure — the invariant that will bite, the
  contract with more consumers than expected, the migration that must go first.
- Distinguish what you **verified** from what you **infer**. An inference presented as fact is
  worse than an admitted unknown, because the design will be built on it.
- If the design as described will not work, say so plainly and cite the evidence. That is the most
  valuable thing a survey can return, and the whole reason it happens before decomposition.

## Report

Attach it to the spec as a supporting document — always, even when the finding is "this is
straightforward." A survey that lives only in a session transcript will be redone. State: what you
looked at, what you found, what constrains the design, and what you could not determine.

## Boundaries

- Do not implement, and do not tidy up on the way through — a survey that leaves edits behind has
  quietly become an unreviewed build.
- Do not scope-negotiate in the report. Report what the code says; the workstream owner decides
  what to do about it.
- "I could not determine X" is a real finding. Surfacing an unknown before the design is cheap;
  discovering it mid-build is not.
