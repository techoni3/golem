---
name: code-survey
description: Read when surveying a codebase to ground a design — feasibility, blast radius, touch points, and greenfield versus brownfield. Produces a report attached to the spec. Load when answering a lead's grounding questions. Not for web research, use golem:exploring; not for implementing, use golem:building.
---

# code-survey

A survey answers four questions and nothing else:

1. **Is this feasible as described**, and what in the code says otherwise?
2. **What does it touch** — modules, entry points, contracts, data paths?
3. **How far does a change here reach** — who consumes what you would change?
4. **Greenfield or brownfield** — is there existing machinery to extend, or is this new ground?

## Who runs this, and why it matters

Normally **a builder**, during a lead's grounding phase, before any slice exists.

**Who reads this decides how you write it, so establish that first.**

*If you will build what you surveyed* — a live builder session that stays for the slice — the report
is a **note to your future self**. Record the thing that will save you an hour when you start, not a
tour of the architecture.

*If you will not* — and on the default in-process route you will not, because those agents are
single-shot and self-clean — **the reader is a stranger**, and a terse self-note is worthless to
them. Write it to survive the boundary: state the constraint in full, cite the paths, and spell out
what you would otherwise have left implicit because you expected to be the one reading it.

Guessing wrong in the second direction is much cheaper than guessing wrong in the first. When
unsure, write for the stranger.

An explorer may also load this for a code question that no build follows. It never carries a survey
into implementation, because it never implements.

## Method

**Start from the entry point, not the grep hit.** Find where the behaviour actually begins — a route,
a CLI verb, a hook, an event handler — and trace forward. A grep for a symbol name tells you where a
word appears; tracing tells you what runs.

**Prefer LSP** for definitions, references, and signatures when it is available. Glob/Grep/Read are
the resilient fallback, not a reason to skip it. "Find references" answers the blast-radius question
directly and is hard to reproduce by search.

**Read the tests as a specification.** They state intended behaviour more precisely than the code and
much more precisely than the docs.

**Check the docs last and trust them least.** Code outranks docs. When they disagree, that
disagreement is itself a finding worth reporting.

## Depth bar

A survey that only lists file paths has not done the job. Before reporting:

- Every claim traces to something you actually read. Cite `path:line`.
- Name the **constraints you found**, not just the structure — the invariant that will bite, the
  contract with more consumers than expected, the migration that has to go first.
- Distinguish what you **verified** from what you **infer**. An inference presented as fact is worse
  than an admitted unknown, because the lead will design on top of it.
- If the design as described will not work, say so plainly and say what evidence shows it. That is
  the most valuable thing a survey can return, and the whole reason it happens before decomposition.

## Report

Attach it to the spec as a supporting document — always, even when the finding is "this is
straightforward." A survey that lives only in a session transcript is a survey that will be redone.

State: what you looked at, what you found, what constrains the design, what you could not determine,
and — if you will be building this — what you want to remember when you start.

## Gotchas

- **Do not implement, and do not tidy up on the way through.** A survey that leaves edits behind has
  quietly become an unreviewed build.
- **Do not scope-negotiate in the report.** Report what the code says; the lead decides what to do
  about it.
- **"I could not determine X" is a real finding.** Surfacing an unknown before the design is cheap;
  discovering it mid-build is not.
