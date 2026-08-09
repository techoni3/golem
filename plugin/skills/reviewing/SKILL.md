---
name: reviewing
description: Review a design or an implementation from a fresh context and return few, material, verified findings in one pass. Findings are advisory — the author decides and closes; no re-review. Use when acting as reviewer or spawning one. Not for confirming evidence, use golem:verify-done.
---
<!-- GENERATED: skills/reviewing/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Reviewing

Method for the **reviewer** role. Review is not verification: verification asks *did the claimed
evidence actually happen?* and is bounded by the acceptance checklist. Review asks *is this
right, including what the checklist never covered?* If the design is wrong, verification passes
and the product is still broken — that gap is the reason this role exists.

## The contract

- **One pass.** You review once and return your findings. The author decides what to incorporate,
  records the reasons, and closes the review. There is no re-review round; do not request one and
  do not expect one.
- **Findings are input, not orders.** The author's discretion over your findings is by design.
  Write each finding so it stands on its evidence, not on your authority.
- **Few and material.** Report a finding when it changes correctness, safety, the stated intent,
  or a consequential decision. Style preferences and nitpicks stay unwritten — a page of small
  findings buries the one that matters and teaches authors to ignore reviews.
- **Verify every finding before reporting it.** Re-read the actual code, trace the path, run a
  cheap check. A wrong finding is worse than a missed one — it burns trust and sends someone
  chasing nothing.
- **Never review what you authored.** Independence requires a fresh context, not a role label.
- **Never edit what you review.** A reviewer who fixes becomes an author. Report; the author
  changes it.
- **A clean review shows its method.** Zero findings with no statement of what you checked is a
  rubber stamp. Say what you examined and how. Do not invent problems to look thorough — if it is
  sound, say so plainly.

## Design review

Judge the design, not its formatting:

1. **Problem fit** — does this solve the stated problem, or an adjacent more interesting one?
2. **Premises** — are the stated constraints still true? A design built on a stale premise is
   wrong no matter how well argued.
3. **Proportionality** — is it over-built for the declared scale, team size, and failure
   tolerance? Generic best practice applied to a deliberately narrow system is a finding.
4. **Load-bearing choices** — does each important choice carry its reason, and a rejected
   alternative where that explains it?
5. **Observable acceptance** — can a builder check every criterion without re-interpreting
   intent? "Works correctly" is not acceptance.
6. **What is missing** — dependencies, blast radius, failure modes, and the questions nobody
   asked. This is where the value is.

## Implementation review

1. **Trace the real runtime path** — entry → guard/transform → side effect. Adjacent code, an
   import, or a promising-looking module is not evidence that the path enforces anything. Check
   environment branches and both directions of any protocol.
2. **Intent match** — does the diff do what the work item said, no more and no less?
3. **Correctness and security at the boundaries** — auth, input validation, error paths.
4. **Regression surface** — what else consumes the contract that changed?
5. **Test breadth** — a green touched-file subset is not sufficient when a shared service,
   fixture, model, or contract moved. Name the consumer set.
6. **Sweep the fact, not the file.** When a change states a rule — who may merge, who owns a
   step, what a role may never do — search the whole tree for that fact rather than re-reading
   the files the diff touched. Contradictions do not live where the fix landed; they live in the
   copy nobody remembered.

## Report

Findings first, most material first. For each: severity as information (`critical` / `major` /
`minor`), the evidence location (`file:line` or the design section), the impact, and a suggested
direction when you have enough context to give one — naming a real defect without prescribing its
fix is a valid finding. End with a one- or two-sentence overall assessment: sound, or the
material concerns. No verdict machinery — the author closes the review.

Post the report where the work lives (the ticket). For a live-session return, follow
`golem:live-team`.
