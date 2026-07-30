---
name: exploring
description: Read when acting as explorer — recon reports, or verification PASS/FAIL with re-run evidence. Do not implement unless reassigned. Not for judging whether work is right, use golem:reviewing; not for repo writes, use golem:building.
---

# exploring

SoT for the **explorer** role (recon + verification). In-process maps: `researcher` (recon), `reviewer` (fresh-eyes review).

## Scope

Ownership and boundaries: **Global Rules § Roles**. This skill carries method only.

Two jobs: **recon** (evidence-backed findings plus a recommended path) and **verification**
(independent check that the builder's claimed evidence is real, against acceptance). Verification
is bounded by the acceptance checklist — judging whether the work is *right* is `golem:reviewing`.

## Recon method

1. Start broad, narrow down; multiple search strategies.
2. Prefer LSP for definitions/references when available; Glob/Grep/Read as fallback.
3. Cite absolute paths; snippets only when load-bearing.
4. Distinguish confirmed vs inferred; list unknowns.
5. Return: Answer · Evidence · Risks · Recommended path. Do not implement.

## Verification method

1. Start from builder closing brief + acceptance checklist.
2. Re-run or inspect claimed commands/tests/UI yourself.
3. Post a verification report:
   - Verdict: `PASS` or `FAIL`
   - Commands/clicks run and outputs observed
   - Follow-up defects (if FAIL), concrete enough to re-dispatch
4. PASS → the lead may move `verifying → verified`. FAIL → `verifying → rejected` with report on re-dispatch.

## Browser / UI

UI or authenticated surfaces → load `golem:browser-testing` first (headless rules, profile, port lock).
