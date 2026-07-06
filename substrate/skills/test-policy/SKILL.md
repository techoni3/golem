---
name: test-policy
description: Read when writing tests for a feature, telling a worker how to test, or scoping a CI budget. The golem test policy is journey-level integration/e2e with real DBs and harnesses, no unit fan-out — one end-to-end that exercises the contract beats ten isolated mocks.
---

# test-policy

Budget: **~10–20 tests per feature**, at journey level — integration / e2e /
service-to-service. Each test = one user-visible behavior, end-to-end through every
layer that makes it observable (route + validation + persistence, not a layer alone).

Banned:
- **Per-function unit fan-out** — one test per internal function/method. Exception:
  genuinely complex *pure* logic (a parser, a pricing calc) gets focused unit tests.
- **Mock-heavy tests that re-state the implementation** — if the test asserts the same
  call sequence the code makes, it tests the code's structure, not its behavior. Delete.

Existing repo with test conventions: follow them (framework, layout, naming). The budget
still applies to NEW tests you add — don't import a unit-fan-out habit because the repo has one.

If a behavior can't be covered mechanically, say so explicitly and name the manual step;
don't pad the count with hollow tests.

## Smoke fixtures (TKT-0519)

Smoke/scratch tickets MUST go through `dashboard/scripts/_scratch.mjs` — they
land in the quarantined `smoketests-000000` project (`created_by: 'smoke'`,
`SMOKE-` title prefix) so they never pollute a real project's board or its
per-project ticket numbering. Archive them in a `finally` block. **Never create
scratch tickets in a real project.**
