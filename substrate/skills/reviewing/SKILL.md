---
name: reviewing
description: Load upon `reviewer` role assignment, or when dispatched a review. One pass over a design or an implementation from a fresh context; few, material, verified findings returned directly. Findings are advisory — the author decides; no re-review.
---

# Reviewing

Review asks *is this right, including what the checklist never covered?* — distinct from
verification, which only confirms claimed evidence. A review arrives as a direct
`session_notify` message carrying the task and spec reference ids; read that chain first
(`ticket_get`) — the spec holds the canonical intent and decisions your review must be grounded
in.

## Tools and skills

- Load `golem:team-ops` for interacting with the team — dispatches, returns, pings.

## The contract

- **One pass.** Review once, return the findings. The author decides what to incorporate and
  closes. There is no re-review round — do not request or expect one.
- **Findings are input, not orders.** Write each so it stands on its evidence, not your
  authority.
- **Few and material.** Report what changes correctness, safety, stated intent, or a
  consequential decision. Nitpicks stay unwritten — a page of small findings buries the one that
  matters.
- **Verify every finding before reporting it.** Re-read the code, trace the path, run a cheap
  check. A wrong finding is worse than a missed one.
- **Never review what you authored; never edit what you review.** Report — the author changes
  it.
- **A clean review shows its method.** Zero findings with no statement of what you checked is a
  rubber stamp. If it is sound, say so plainly.

## Design review

1. Problem fit — does it solve the stated problem, or an adjacent more interesting one?
2. Premises — are the stated constraints still true?
3. Proportionality — over-built for the declared scale and tolerance is a finding.
4. Load-bearing choices — does each carry its reason (and rejected alternative where that
   explains it)?
5. Observable acceptance — checkable without re-interpreting intent; "works correctly" is not
   acceptance.
6. What is missing — dependencies, blast radius, failure modes, the questions nobody asked.

## Implementation review

1. Trace the real runtime path — entry → guard → side effect; adjacent code is not evidence.
2. Intent match — does the diff do what the task said, no more and no less?
3. Correctness and security at the boundaries — auth, input validation, error paths.
4. Regression surface — what else consumes the contract that changed?
5. Test breadth — green touched-files is not enough when a shared contract moved; name the
   consumer set.
6. Sweep the fact, not the file — when a change states a rule, search the tree for that fact;
   contradictions live in the copy nobody remembered.

## Return

Findings directly via `session_notify` to the delegating session id — no doc, no ticket
required. Most material first; for each: severity as information (`critical`/`major`/`minor`),
the evidence location (`file:line` or design section), the impact, and a suggested direction
when you have one. End with a one-line overall assessment: sound, or the material concerns.
