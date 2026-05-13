---
name: golem-verification-before-completion
description: Anti-vibe-coding gate before declaring a ticket done — runs lint, types, tests, and a manual verification pass against the acceptance criteria. Use right before opening a PR.
expects:
  - The ticket's acceptance criteria are spelled out in the ticket body.
  - The project's run commands (lint, test, type-check) are listed in CLAUDE.md.
produces:
  - A verification result: pass | fail. On fail, a list of failures with paths.
  - A "verification" line in the ticket's hand-off log.
category: sop
---

# golem-verification-before-completion

The gate that prevents "the agent thinks it's done; the code is broken" — the most expensive failure mode. Without this gate, the only line of defence is the Code Reviewer, which catches issues a cheap automated pass would have caught for free.

Invoked by the Engineer immediately before `golem-pr-creation`.

## What "done" requires

A ticket is done when **all four** are true:

1. The acceptance criteria are observably met.
2. Lint and type-check pass with no new errors.
3. The full test suite passes (not just the new tests).
4. There are no obvious regressions: behaviours adjacent to the change still work.

Anything less means the ticket is not done. There is no "almost done".

## Procedure

### Step 1 — Re-read the acceptance criteria

Open the ticket. Read the acceptance criteria. For each criterion, ask: *what observable behaviour proves this?* If you can't name one, the criterion is too vague — escalate to the TL before claiming done.

### Step 2 — Run lint

Use the project's lint command (from CLAUDE.md → Run commands → lint). Run it on the full project, not just changed files — the change may have broken something elsewhere.

If lint fails:
- New errors → fix.
- Pre-existing errors unrelated to your change → record in the ticket's hand-off log; do not fix unless explicitly part of the ticket. Verification still passes if the new diff added zero new errors.

### Step 3 — Run type-check

Same shape as lint. Use the project's type-check command. If it doesn't exist, skip.

### Step 4 — Run the full test suite

Not just the new tests. The full suite. Two reasons:
- The change may have broken adjacent behaviour.
- The new test may pass for the wrong reason; running with the rest catches harness-level mistakes.

If any test fails:
- New test failure related to your change → fix the code (or fix the test if the test was wrong, but explain why).
- Pre-existing flake → re-run; if it stabilises, note in hand-off log; if it doesn't, escalate as a separate ticket.

### Step 5 — Manual verification of acceptance criteria

For each criterion that lint+tests don't directly cover:
- Run the actual behaviour (curl an endpoint, exercise the UI, run the CLI).
- Confirm the observable matches the criterion.
- Note the verification step in the hand-off log so the Reviewer can re-run.

### Step 6 — Adjacent regression check

For each module touched, ask: *what other features depend on this code?* Run those features (or their tests) explicitly. The list of "what depends on this" lives in `docs/repo-map.md` and the import graph; consult both.

### Step 7 — Record the verification

Append to the ticket's hand-off log:

```
### YYYY-MM-DD · Engineer (verification)
- Acceptance: <criterion 1> → <how verified>
- Acceptance: <criterion 2> → <how verified>
- Lint: pass
- Type-check: pass
- Tests: <N> passed, <M> skipped, 0 failed
- Adjacent: ran <feature X>, <feature Y>; behaviour unchanged
- Result: pass
```

If the result is `fail`, the ticket stays in `tracker/in-progress/` until verification passes. Do not open the PR.

## Anti-patterns

- **Running only the new tests.** They might pass against the change while unrelated tests are now broken.
- **"It compiles, ship it".** Compilation is not verification.
- **Eyeballing the diff.** Diff review is not verification — it's review. Verification is running the thing.
- **Skipping when "obvious".** Obvious changes break in non-obvious ways. Five minutes of verification is cheaper than a Reviewer round-trip.
- **Suppressing lint warnings to make it pass.** If a warning is genuinely unrelated, document it and leave; do not silence.
- **Hand-waving the manual verification.** "Looks good" is not a verification line. Name the steps.

## When this skill is wrong

- The ticket is a spike, explicitly marked as such, where the deliverable is "what we learned" rather than working code. Write the spike outcome instead.
- The ticket is `category: docs` and has no behaviour to verify — verification reduces to "lint passes" + "the doc is published".
- The change is genuinely too small to warrant the full procedure (e.g. a typo in a string literal). The hand-off log should still note that verification was abbreviated and why.
