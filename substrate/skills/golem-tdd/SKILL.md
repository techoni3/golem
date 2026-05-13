---
name: golem-tdd
description: Red/green/refactor with the vertical-slice rule. Use when implementing new behaviour where tests can drive the design — drives the Test Spec Writer → Test Writer → Engineer hand-off.
expects:
  - A ticket with concrete acceptance criteria (Product Architect specs landed; grill done if needed).
  - A test runner wired in the project (CLAUDE.md → Run commands → test).
produces:
  - Failing tests authored by Test Writer (against specs from Test Spec Writer), then code from Engineer that makes them pass.
category: sop
---

# golem-tdd

The TDD discipline as practised in golem. Two rules carry weight:

1. **Test Spec Writer / Test Writer drive; Engineer follows.** The Engineer cannot author the failing test or its spec — that's anti-reward-hacking (§8.3 of the design). The Engineer's job is to make the existing failing tests pass.
2. **Vertical slices.** Each red→green cycle delivers one observable behaviour end-to-end, not one layer at a time. A passing test for a controller without the underlying repository is hollow; a passing test for a repository without the controller route is unobservable. Slices cross all the layers needed to make the behaviour real.

Owned by the **TL** (orchestration) and the **Test Writer** (technique). The Engineer references this skill as context but does not drive the loop.

## The loop

```
Test Spec Writer       writes specs from acceptance criteria
       ↓
Test Writer            writes failing tests against specs
       ↓
Engineer               makes the tests pass with the smallest code that does so
       ↓
Test Spec Writer +     pre-commit pass: do the specs still hold? do new tests
Test Writer            need to be added now that the impl revealed an edge case?
       ↓
Code Reviewer          reviews PR against ticket spec, ARCH, ADRs, conventions
```

The pre-Engineer pass is mandatory in v1 (Modus Operandi deferred per design D-003).

## Step-by-step

### Step 1 — Test Spec Writer (from acceptance criteria)

Inputs: the ticket's acceptance criteria, the relevant CONTEXT entries, ARCH, and any product specs.

Output: a numbered list of test scenarios, each with:
- **Given.** Preconditions / fixtures.
- **When.** The action under test.
- **Then.** The observable outcome.
- **Notes.** Edge cases, error paths, performance assertions.

Specs are in the ticket body under `## Test specs` or in a separate file referenced from the ticket. They are prose, not code.

### Step 2 — Test Writer (red)

Inputs: the spec list. Stack-specific test skill (e.g. `golem-pytest-fastapi`).

Output: failing tests at the smallest scope that exercises the behaviour end-to-end (vertical slice). One test per spec, named to match.

The tests **must** fail before any production code is written. If a test passes immediately, either:
- The test is wrong (does not actually exercise the behaviour).
- The behaviour already exists and the spec is redundant.

### Step 3 — Engineer (green)

Inputs: the failing tests, ticket, CONTEXT, ARCH, conventions.

Output: the smallest code change that makes the tests pass. No speculative generality. No layer-only changes that don't affect a test's outcome.

The Engineer does **not**:
- Edit tests (except to fix a test that exercises the wrong thing — and only with a hand-off log entry justifying the change, since edits to tests are smell).
- Add tests. New tests are Test Writer's concern.
- Add scenarios beyond what the failing tests demand.

### Step 4 — Refactor

After green, refactor for clarity / structure with the test suite as a safety net. Tests should still pass after refactor with no edits to tests.

### Step 5 — Pre-commit pass

Test Spec Writer re-reads specs against the implementation; Test Writer adds tests for any edge case the implementation surfaced (e.g. "now that I see the impl uses a queue, we need a back-pressure test").

This pass is part of the commit cycle, before the PR is opened.

## Vertical slice rule

A "vertical slice" means one user-observable behaviour, end-to-end, including all the layers that make it observable.

- Good slice: "POST /puzzles creates a puzzle and returns 201 with the puzzle id" — covers route, validation, repository, persistence.
- Not a slice: "the repository can save a puzzle" — invisible to the user; only justifies code if a slice depends on it.
- Not a slice: "the route handles errors" — too generic; pick a specific error case.

The test that fails first should fail because the *behaviour* is missing, not because a *layer* is missing. If a test fails for a layer-only reason ("module not found"), step back and write a slice test instead.

## Anti-patterns

- **Engineer writing tests.** Reward-hacking risk. Tests come from Test Spec Writer / Test Writer.
- **Layer-by-layer "TDD".** Three passing repository tests with no controller test is not a vertical slice; the user can't see anything yet.
- **Skipping the red.** "I'll write the code and the test together." No — the red phase proves the test exercises the behaviour.
- **Testing implementation details.** Tests should fail when behaviour changes, not when internals change. Internals refactor freely; behaviour is the contract.
- **Bypassing pre-commit Test Spec/Writer.** The post-implementation review by Test Spec/Writer often surfaces real gaps the original specs didn't anticipate.

## When this skill is wrong

- The ticket is exploratory (a spike) where the deliverable is "what works". TDD constrains exploration; relax it for spikes and write the throwaway as a learning artefact.
- The change is genuinely test-irrelevant (renaming a function used in zero call-sites; updating a comment). The full TDD loop is over-investment.
- The behaviour is already covered end-to-end by existing tests, and the change is a refactor. Run the existing suite as the safety net; no new tests needed unless the refactor surfaces an uncovered edge.
