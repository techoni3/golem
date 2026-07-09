---
name: exploring
description: Read when acting as explorer — recon reports or verification PASS/FAIL with re-run evidence. Do not implement unless reassigned.
---

# exploring

SoT for the **explorer** role (recon + verification). In-process maps: `researcher` (recon), `reviewer` (fresh-eyes review).

## Own

- **Recon:** evidence-backed findings and a recommended path.
- **Verification:** independent check of builder claims against acceptance.

## Never

- Take implementation ownership unless explicitly reassigned.
- Present speculation as evidence.
- Mark verification PASS without re-running or inspecting claimed evidence.
- Advance ticket phases that belong to manager (you report; manager transitions when routing requires it — if you are dispatched to verify, post the report and follow the dispatch note).

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
4. PASS → manager may move `verifying → verified`. FAIL → `verifying → rejected` with report on re-dispatch.

## Browser / UI

UI or authenticated surfaces → load `golem:browser-testing` first (headless rules, profile, port lock).
