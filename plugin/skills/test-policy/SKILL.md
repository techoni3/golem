---
name: test-policy
description: The test budget and what counts for golem features — journey-level integration/e2e, no unit fan-out. Read when writing tests for a feature or telling a worker how to test.
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
