---
name: golem-pr-creation
description: Branch naming, commit conventions, and PR body shape for golem projects. Use when opening a PR after work on a ticket is complete and verification has passed.
expects:
  - A working branch with at least one commit.
  - Verification has passed (golem-verification-before-completion).
  - The ticket id and title are known.
produces:
  - A pushed branch with conventional commit messages and a PR opened on origin.
category: sop
---

# golem-pr-creation

The mechanical steps to land work as a reviewable PR. Used by the Engineer at the end of every ticket.

## Branch naming

`<category>/<ticket-id>-<kebab-slug>`

- `category`: one of `feat`, `fix`, `infra`, `docs`, `spike` (matches ticket frontmatter `category`, with `feat` aliasing `feature`).
- `ticket-id`: e.g. `tkt-0042`.
- `slug`: short kebab-case (≤6 words) — the same slug as the ticket's filename.

Examples:
- `feat/tkt-0042-stripe-webhook-handler`
- `fix/tkt-0073-idempotent-payment-processing`
- `infra/tkt-0019-staging-env-vars`

One branch per ticket. Sub-tickets get their own branches (and PRs) unless the parent ticket explicitly bundles them.

## Commit messages

Conventional commits, one focused commit per logical change. The agent commits frequently within a session — small commits beat large ones for review.

Format: `<type>(<scope>): <imperative subject>`

- `type`: `feat | fix | refactor | test | docs | chore | infra`.
- `scope`: usually the affected module (`api`, `db`, `webhooks`, `tests`). Optional.
- `subject`: imperative, ≤72 chars, no period.

Body (when needed): one or two paragraphs explaining *why*, not *what* — the diff shows what.

Reference the ticket in the body: `Refs: TKT-0042`.

Do **not**:
- Use `--no-verify` to skip pre-commit hooks. They exist for a reason; if a hook fails, fix the cause.
- Amend already-pushed commits.
- Include co-author trailers unless explicitly requested.

## Pre-PR checklist

Before opening the PR, confirm:

1. `golem-verification-before-completion` has passed.
2. Tests exist and pass for the change (Test Spec Writer + Test Writer have run).
3. The ticket's hand-off log has an "Engineer hand-off" entry.
4. `repo-map.md` is updated if a structural change landed.
5. ADRs are referenced if the change touches an architectural decision.

If any of these is missing, do not open the PR. Address the gap first.

## PR body

The PR body has four sections, in order:

```markdown
## Summary

One paragraph. What this PR does, in one or two sentences. Why it
matters (link to the ticket if rationale is there).

Refs: TKT-NNNN

## What changed

Bulleted list of meaningful changes — one bullet per logical unit.
Skip bullets for trivial changes already covered by the diff (e.g.
test files for a new feature don't need their own bullet).

## Test plan

Bulleted, checkbox-style. The Reviewer uses these to verify locally.

- [ ] `pytest tests/api/test_webhooks.py -q` passes.
- [ ] Manual: <steps to verify behaviour the test doesn't cover>.

## Notes for review

Anything the reviewer should know up front: known limitations,
deferred follow-ups, trade-offs taken. Empty if there's nothing.
```

## Procedure

1. Confirm branch is up to date with the base (rebase or merge per project convention; default rebase).
2. Run lint + tests one last time.
3. Push the branch.
4. Open the PR with the body shape above. Title: `<type>(<scope>): <subject>` matching the most representative commit.
5. Append a hand-off log entry in the ticket: link to PR, summary line.
6. Move the ticket to `tracker/review/` (TL does this; surface the request in the hand-off log).

## Anti-patterns

- **Squashing during review.** Squash on merge if at all; preserve the working history during review so the reviewer can read commit-by-commit.
- **Multi-ticket PRs.** One ticket per PR. If the work crossed ticket boundaries, file a sub-ticket retroactively and reference it.
- **PR title in lowercase imperative-but-hedged.** "Maybe fix idempotency" — pick a stance.
- **Empty test plan.** "n/a" is rarely true. If you really cannot test mechanically, say so explicitly: "Verified by manual run; no automated test possible because <reason>."
- **Skipping the ticket update.** The PR exists in two places: GitHub and the ticket's hand-off log. Both must point at each other.

## When this skill is wrong

- You're committing scratch work into a long-running spike branch that will not become a PR. Branch naming and commit conventions still apply, but PR shape does not.
- The work is a docs-only change that deserves a thinner PR body. Trim the sections that do not apply but keep `Summary` and `Refs`.
