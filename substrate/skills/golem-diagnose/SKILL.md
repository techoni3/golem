---
name: golem-diagnose
description: Structured fix-diagnosis routine — reproduce, root-cause, classify, recommend routing. Use when a fix ticket enters a project; the Diagnoser invokes this before any code is touched.
expects:
  - A fix ticket in tracker/triage/ or tracker/open/ with a brief.
  - Read access to the codebase, ARCH.md, ADRs, recent journal entries.
produces:
  - A "Diagnoser verdict" block written into the ticket body, plus frontmatter classification.
  - A routing recommendation: code | architecture | infra.
category: sop
---

# golem-diagnose

The Diagnoser's procedure. Diagnoser-first is a hard rule for fix tickets — fixes do not route on the brief's surface description because surface descriptions misclassify often. This skill is the structured routine that runs before any fix work begins.

## Procedure

### Step 1 — Reproduce

Reproduce the bug locally before touching root cause. Without reproduction:
- The "fix" may chase the wrong symptom.
- The eventual regression test has no anchor.

Acceptable reproductions:
- A failing test (preferred).
- A shell sequence that reliably triggers the bug.
- A manual sequence with deterministic precondition (least preferred; document the manual steps).

If you cannot reproduce in a reasonable bounded effort (~30 min), stop and write the verdict as `unreproducible — needs more signal from user`. Do not proceed.

### Step 2 — Locate root cause

From the reproduction, follow the failure backwards: stack trace → callers → upstream state → triggering condition. Distinguish:
- **Proximate cause** — the line that threw / the assertion that failed.
- **Root cause** — the design or invariant that, if respected, would have prevented the proximate cause.

Both go in the verdict; root cause drives classification.

### Step 3 — Classify

One of three:

- **code** — implementation defect. Logic is wrong, an edge case isn't handled, a library is misused. Routing: development team.
- **architecture** — the design has a structural flaw. The bug is a symptom of a wrong abstraction, missing invariant, or violated boundary. Routing: Tech Architect (new ADR + revised specs + dev stories) before any code.
- **infra** — environment, deployment, CI, secrets, networking, persistence-config. Routing: Cloud DevOps (or Local DevOps if dev-env-only).

**Heuristics:**
- Same class of bug appears repeatedly → architecture, not code.
- Bug only happens in one environment → infra.
- Specific input pattern fails predictably → code.
- Race condition that the design did not consider → architecture.

When in doubt between code and architecture, lean toward **architecture** if a fix would require touching more than one module's boundary.

### Step 4 — Write the verdict

Append a `## Diagnoser verdict` section to the ticket body. Update frontmatter `category: fix` (if not already) and add the classification.

Verdict shape:

```markdown
## Diagnoser verdict

**Reproduction.** <how you reproduced; one paragraph or a code block>

**Proximate cause.** <one or two sentences>

**Root cause.** <one paragraph>

**Classification.** code | architecture | infra

**Suggested routing.** <which persona / team>; <why>.

**Notes for the fixer.** <anything the fixer needs upfront — invariants to preserve, related ADRs, prior similar bugs, files most likely to need changes>.

**Verified by.** <Diagnoser> on YYYY-MM-DD
```

### Step 5 — Hand off

Append a hand-off log entry pointing the TL at the verdict. The TL reads the verdict and routes per `Suggested routing`.

Diagnoser does **not** write the fix. Diagnosis and remediation are separated so the diagnostician's frame doesn't bias the fixer.

## Anti-patterns

- **Skipping reproduction.** A "diagnosis" without reproduction is a guess.
- **Suggesting the fix itself.** The fixer designs the fix. The verdict tells them where to look, not what to write.
- **Conflating proximate and root cause.** "It threw NPE on line 47" is proximate, not root.
- **Hedging the classification.** Pick one. If unsure between code and architecture, lean architecture and let the Tech Architect (and Tech Architecture Reviewer) decide whether the design holds.
- **Re-routing post-verdict.** Once the verdict is written, the TL routes from it. If new info changes the picture, write an addendum verdict; do not edit the original.

## When this skill is wrong

- The ticket is a feature, not a fix. Skip Diagnoser entirely; route through Product Architect.
- The "bug" is actually a missing feature. Reclassify the ticket as a feature.
- The bug is so trivial and well-described that the verdict adds no signal (e.g. "typo in error message"). The TL may still log a one-line verdict for consistency, but the full procedure is over-investment.
