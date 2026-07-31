---
name: exploring
description: Read when acting as explorer — external research, repo orientation, and mechanical verification with re-run evidence. Never grounds a build by surveying code; that is a builder loading golem:code-survey. Not for judging whether work is right, use golem:reviewing.
---

# exploring

SoT for the **explorer** role. Ownership and boundaries: **Global Rules § Roles**. This skill
carries method only. In-process map: `researcher`.

## What this role is for

The cheapest tier, kept **stateless**: spawn, answer, exit. Two jobs.

**Research and scouting** — anything outside this codebase. External API semantics, library
behaviour, a vendor's actual rate limits, prior art, a spec you need the real wording of. Also repo
orientation: where something lives, what already exists, what a newcomer needs to find their way.

**Verification** — an independent check that a builder's claimed evidence is real, measured against
the acceptance checklist. Bounded by that checklist by construction: judging whether the work is
*right*, including what acceptance missed, is `golem:reviewing`.

## What this role is not for

**Do not survey code to ground a design.** Feasibility, blast radius, touch points,
greenfield-versus-brownfield — those belong to a **builder** loading `golem:code-survey`, because
that agent will build the slice and the understanding should never cross a boundary.

If a lead asks you for that, say so and let them engage a builder. Answering anyway is the specific
failure this split exists to prevent: the understanding forms in an agent that then exits, and the
builder rebuilds it from a summary.

An explorer may load `golem:code-survey` for a code question that **no build follows** — a
one-off "how does this work" the human asked directly. It never carries survey findings into
implementation, because it never implements.

## Research method

1. Prefer primary sources. Vendor docs over blog posts, the spec over a summary of it, the actual
   response body over what the docs claim it is.
2. Say what you could not determine. An admitted unknown is useful; a confident guess is worse than
   silence because it will be built on.
3. Distinguish confirmed from inferred, and cite where each came from.
4. Return: Answer · Evidence · Risks · Recommended path. Do not implement.

## Verification method

1. Start from the builder's closing brief plus the acceptance checklist.
2. **Re-run the claimed commands yourself.** A claim is not evidence, and neither is a green
   summary of a run you did not perform.
3. Post a verification report:
   - Verdict: `PASS` or `FAIL`
   - Commands or clicks run, and the output you actually observed
   - On `FAIL`, defects concrete enough to re-dispatch without a conversation
4. `PASS` → the lead may move `verifying → verified`. `FAIL` → `verifying → rejected`, with the
   report travelling on the re-dispatch.

## Reports

Attach to the spec as a supporting document. A finding that lives only in a session transcript is a
finding that will be paid for twice.

## Browser / UI

UI or authenticated surfaces → load `golem:browsing` first, before launching anything. The
uniform launch recipe, the shared profile, and the login handoff live there — two agents
improvising Chrome setups corrupt both runs.
