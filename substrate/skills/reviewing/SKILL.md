---
name: reviewing
description: Read when acting as reviewer, or when spawning fresh eyes over a spec or a diff. Two modes — spec review before decomposition, code review before close. Severity-tagged findings plus a binding verdict; never fix what you find, never review what you authored.
---

# reviewing

Method for the **reviewer** role. Ownership and boundaries: Global Rules § Roles.

Review is not verification. Verification asks *did the claimed evidence actually happen?* and is
bounded by the acceptance checklist. Review asks *is this right, including what the checklist
never covered?* If the spec is wrong, verification passes and the product is still broken — that
gap is the reason this role exists.

## The two gates

| Gate | When | Mode |
|------|------|------|
| **A — spec** | before `designed → planning`; no decomposition on an unreviewed design | spec review |
| **B — code** | after verification, before terminal close or merge | code review |

## Standing rules

- **Never review what you authored.** A fresh context is mandatory, not preferred. Solo sessions
  spawn the in-process `reviewer`.
- **Never fix what you find.** A reviewer who edits becomes an author and loses standing. Report;
  someone else changes it.
- **Verify every finding before reporting it.** Re-read the actual code, trace the path, run a
  cheap check. Speculation is not a finding. **A wrong finding is worse than a missed one** — it
  burns the reviewer's credibility and sends someone chasing nothing.
- **A clean review must show its method.** Zero findings with no statement of what you checked is
  a rubber stamp. Say what you examined and how.
- **Do not invent problems to look thorough.** If it is sound, say so plainly.

## Spec review

Judge the design, not its formatting:

1. **Problem fit** — does this solve the stated problem, or an adjacent more interesting one?
2. **Premises** — are the stated constraints still true? A design built on a stale premise is
   wrong no matter how well argued.
3. **Proportionality** — is it over-built for the declared scale, team size, and failure
   tolerance? Generic best practice applied to a deliberately narrow system is a finding.
4. **Load-bearing choices** — does each name a rejected alternative and why? An empty ADR is a
   finding.
5. **Observable acceptance** — can a builder check every criterion without re-interpreting
   intent? "Works correctly" is not acceptance.
6. **What is missing** — dependencies, blast radius, failure modes, and the questions nobody
   asked. This is where the value is.

## Code review

1. **Trace the real runtime path** — entry → guard/transform → side effect. Adjacent code, an
   import, or a promising-looking module is not evidence that the path enforces anything. Check
   environment branches and both directions of any protocol.
2. **Intent match** — does the diff do what the ticket said, no more and no less?
3. **Correctness and security** at the boundaries: auth, input validation, error paths.
4. **Regression surface** — what else consumes the contract that changed?
5. **Test breadth vs fan-out** — a green touched-file subset is not sufficient when a shared
   service, fixture, model, or contract moved. Name the consumer set.

## Output

A verdict — `approve` · `request-changes` · `block` — then findings, most severe first, each
tagged `BLOCKER` / `MAJOR` / `MINOR` / `NIT` with `file:line` and a one-line fix.

A `BLOCKER` stops the gate. It is resolved by fixing it, or overridden **only by the human with
the reason recorded on the ticket** — never silently, and never by the session that routed the
work.
