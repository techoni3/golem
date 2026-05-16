---
name: golem-improve-codebase-architecture
description: Tech Architect's iterative refinement procedure — review the code-tree against ARCH and surface architectural drift, missing invariants, or refactor candidates. Use when an architecture-classified fix lands or when periodic architecture review is invoked.
expects:
  - The current state of the code-tree (src/), ARCH.md, ADRs, recent journal entries flagging architectural friction.
  - A trigger: a Diagnoser verdict classified as `architecture`, or an orchestrator request for periodic review.
produces:
  - A list of architectural findings with severity (high | medium | low).
  - For each high finding: a proposed ADR or revised ADR, plus dev stories in the tracker if remediation requires code work.
category: sop
---

# golem-improve-codebase-architecture

The Tech Architect's procedure for systematically refining a project's architecture rather than reacting one fix at a time. Catches drift between ARCH.md and the actual code-tree, surfaces invariant violations, and identifies refactors that would prevent recurring bug classes.

Triggered by:
- A Diagnoser verdict of `architecture`.
- An orchestrator request after multiple `code` fixes in adjacent modules (signal that the design may be wrong).
- A user request for periodic architecture review.
- Meta-agent flagging architectural drift across the journal.

## What this skill produces

- A findings document (in `docs/agent-notes/architecture-review-<date>.md` or appended to the relevant ADR's review section).
- For each high-severity finding: either a new ADR (proposed) or a revision to an existing ADR with `Superseded by` set.
- Dev stories filed in the tracker for remediation work.

This skill does **not** rewrite code. The findings flow into tracker stories the development team executes.

## Procedure

### Step 1 — Form the lens

Read in order:
1. **ARCH.md** — the documented intent.
2. **ADRs** with status Accepted — the locked-in decisions.
3. **CONTEXT.md** — boundaries and invariants.
4. **`docs/repo-map.md`** — the current shape.
5. **Recent journal `notes` and `substrate_signals`** — friction signals.

Form a working hypothesis: where might intent and reality have diverged?

### Step 2 — Walk the code-tree against ARCH

For each module / layer named in ARCH:
- Does the corresponding code exist? Is it where ARCH says?
- Does the module honour the boundaries declared in CONTEXT?
- Are the invariants enforced (in code, by tests, or by lint rules)?

Note divergences as findings. Categorise:
- **Drift.** Code grew an unintended responsibility. (e.g. ARCH says "API layer is thin"; in practice handlers contain business logic.)
- **Boundary violation.** A module imports across a boundary it shouldn't. (e.g. domain types imported into infra.)
- **Missing invariant enforcement.** ARCH declares an invariant; nothing in code stops a violation.
- **Stale ADR.** The decision still in ARCH no longer matches reality; either reality is wrong, or the ADR needs superseding.

### Step 3 — Walk recurring fix patterns

For each of the last ~10 fix tickets, ask: *if the architecture had been different, would this fix not have been needed?* Repeated `yes` for tickets in adjacent code is a strong "the design is wrong" signal.

Note as findings:
- **Recurring class of bug.** Suggests a missing invariant or wrong abstraction.
- **Unusual difficulty per fix.** Symptom of tangled dependencies; suggests a refactor candidate.

### Step 4 — Severity-rank findings

For each finding:
- **High** — actively causing bugs, hindering features, or violating an explicit ARCH invariant. Demands an ADR + remediation tickets soon.
- **Medium** — drift that's not yet causing pain but would compound. Worth filing a remediation ticket; not an emergency.
- **Low** — observed but cheap to leave. Note for the next review.

### Step 5 — Propose ADRs and stories

For each high finding:
- Draft an ADR (status: Proposed) capturing the decision needed. The Tech Architecture Reviewer iterates with you until the ADR is sound, then it's Accepted.
- File one or more dev stories in `tracker/triage/` referencing the ADR. The orchestrator routes them.

For each medium finding:
- File a remediation story (no ADR needed unless a decision is implicit). Mark `category: refactor` in the ticket frontmatter.

For each low finding:
- Append to the architecture-review note. Don't file a ticket; it'd be noise.

### Step 6 — Update ARCH.md

Where the review surfaced facts that ARCH should already have stated (an invariant, a boundary, a stack constraint), update ARCH inline. Note the update in the review doc.

### Step 7 — Hand off

Submit the review doc + ADRs + tickets to the orchestrator for routing. Append a hand-off log entry on each created ticket pointing back at the review doc.

## Anti-patterns

- **Big-bang re-architecture.** Findings are remediated incrementally. A "rewrite the project" recommendation is rarely the right output of this skill — if you reach for it, the project may need to be re-scoped at the CEO level, not the architect level.
- **Reviewing implementation, not architecture.** This skill asks "are the right boundaries in place?", not "is this code idiomatic?". Code review is the Code Reviewer's job.
- **No prioritisation.** Findings without severity have no actionable shape. Always rank.
- **Skipping the Reviewer iteration on proposed ADRs.** Architect → Reviewer pairs exist to prevent self-approval — an architect cannot accept its own ADR. Even for review-driven ADRs, the Reviewer must co-sign before Accepted.
- **Editing existing Accepted ADRs in place.** ADRs are append-only. Supersede; do not rewrite.

## When this skill is wrong

- The trigger is a single isolated `code` fix. Run `golem-diagnose` and let the Engineer fix it; do not over-architect.
- The project is small (<~1k lines, single contributor) and the architecture review would dwarf the codebase. Note findings inline as agent-notes; skip the ADR ceremony.
- ARCH.md does not yet exist (early bring-up). Author it via the Tech Architect's bring-up sequence first.
