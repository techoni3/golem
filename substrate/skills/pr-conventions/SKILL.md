---
name: pr-conventions
description: Branch naming, commit format + trailer, and PR body shape for golem projects. Read when opening a branch, committing, or opening a PR.
---

# pr-conventions

## Branch policy — no implicit branching

Never create a branch on your own initiative. Branch ONLY when the work item or
the human explicitly says to branch. Otherwise, continue on the branch the
session/ticket is already pointed at.

How to know branching is allowed: the ticket body or dispatch brief names a
branch with `branch: <name>` or an equivalent explicit instruction, or Lavee
asks for a branch in chat. Absence of that directive means stay put.

A worktree directive in the dispatch is an explicit branching instruction. Follow
`golem:worktrees` for the branch/worktree lifecycle and hand-off contract.

When branching is explicitly allowed, use `<type>/<kebab-slug>` — type ∈
`feat | fix | refactor | infra | docs | spike`. One branch per tracker ticket,
e.g. `feat/stripe-webhook-handler`.

**Commits:** Conventional — `<type>(<scope>): <imperative subject>`. Subject ≤72 chars,
no trailing period. `scope` optional (affected module: `api`, `db`, `webhooks`). Body
(when needed) explains *why*, not *what*. Small frequent commits beat one large commit.

End every commit message with the trailer:
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Never `--no-verify`. Never amend already-pushed commits.

**PR body** — four sections in order:
```markdown
## Summary
One or two sentences: what this PR does and why it matters.

## What changed
One bullet per logical change. Skip bullets the diff already makes obvious.

## Test plan
- [ ] `<exact test command>` passes.
- [ ] Manual: <steps the diff's tests don't cover>.

## Notes for review
Known limitations, deferred follow-ups, trade-offs. Empty if none.
```
PR title = `<type>(<scope>): <subject>` matching the most representative commit.
End the PR body with:
```
🤖 Generated with {{#if claudecode}}[Claude Code](https://claude.com/claude-code){{/if}}{{#if opencode}}[opencode](https://opencode.ai){{/if}}
```
One ticket per PR — never bundle multiple tracker tickets into one PR.
