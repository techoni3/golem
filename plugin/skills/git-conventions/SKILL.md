---
name: git-conventions
description: Load when opening a branch, writing a commit, opening a PR. Not needed for read-only git status, log, or diff.
---
<!-- GENERATED: skills/git-conventions/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Git conventions

## Worktree guidance

- Do not use git worktrees, unless explicitly asked by human, in which case follow human's directive.

## Branch guidance

Guidelines and instructions around this are usually explicitly provided by human. But regardless,
here's a general idea:

- Prefer to work on current branch, don't branch out implicitly. Unless explicitly asked by human.
- Case 1 (default): I usually have one allocated development branch, where all commits go, and at
  feature and spec boundaries, a PR is created to main (or staging) and upon merge dev branch is
  resynced to continue clean for the next work.
- Case 2 (per spec): This can happen when explicitly asked by the user or current branch is just
  too messy to work with. Then we create a new branch per spec, and merge at spec boundaries.
- Naming: When a branch out is allowed/requested, use `<type>/<kebab-slug>` - type ∈
  `feat | fix | refactor | infra | docs`; kebab-slug should not exceed 3 words and be intuitively named


## Commit guidance

- Commit at coherent boundaries - a granular unit of work per commit.
- Boundaries like fixes, features, tickets, subtasks etc are good candidate examples.
- Message - `<type>(<scope>): <imperative subject>`. Subject ~100 chars, descriptive enough one-liner.
  `scope` - optional (affected module).
  `body` - full description of what changed and why.
- Leave out and preserve unrelated changes made by human or other agents. In case of uncertainty or
  confusion, ask human.

## PR Conventions

Four sections in order:

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
