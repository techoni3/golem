---
name: git-conventions
description: Read when opening a branch, writing a commit, opening a PR, or when a ticket or dispatch brief includes an explicit worktree directive. Covers the branch + commit + PR contract and the worktree lifecycle that kicks in only under an explicit directive.
---
<!-- GENERATED: skills/git-conventions/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# git-conventions

Two surfaces share this skill: the **branch + commit + PR contract** everyone
follows, and the **worktree lifecycle** that kicks in only when a ticket or
dispatch brief explicitly directs a worktree. Ad-hoc worktrees are still
prohibited without an explicit directive.

## Branch policy — no implicit branching

Never create a branch on your own initiative. Branch ONLY when the work item
or the human explicitly says to branch. Otherwise, continue on the branch the
session/ticket is already pointed at.

How to know branching is allowed: the ticket body or dispatch brief names a
branch with `branch: <name>` or an equivalent explicit instruction, or the
human asks for a branch in chat. Absence of that directive means stay put.

A worktree directive in the dispatch is an explicit branching instruction.
Follow the [Worktree Lifecycle](#worktree-lifecycle) section below.

When branching is explicitly allowed, use `<type>/<kebab-slug>` — type ∈
`feat | fix | refactor | infra | docs | spike`. One branch per tracker ticket,
e.g. `feat/stripe-webhook-handler`.

## Commits

Conventional — `<type>(<scope>): <imperative subject>`. Subject ≤72 chars,
no trailing period. `scope` optional (affected module: `api`, `db`,
`webhooks`). Body (when needed) explains *why*, not *what*. Small frequent
commits beat one large commit.

End every commit message with a `Co-Authored-By:` trailer naming the model that wrote it, plus any
session trailer your harness specifies. Use the exact strings your harness gives you — do not copy
a model name from this file, it will be stale.

Never `--no-verify`. Never amend already-pushed commits.

## PR body

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

PR title = `<type>(<scope>): <subject>` matching the most representative
commit. End the PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

One ticket per PR — never bundle multiple tracker tickets into one PR.

## Worktree lifecycle (only under an explicit worktree directive)

When the ticket or dispatch brief explicitly directs a worktree, follow this
section end to end. Without that directive, do NOT create one — work on the
current branch in the main checkout.

### Contract

- One ticket = one branch = one worktree.
- Branch: `<type>/<ticket>-<kebab-slug>` (`fix` for fixes, otherwise `feat`).
- Directory: `.worktrees/<TICKET>-<slug>/` inside the repo.
- Builders work in the worktree; the orchestrating non-builder reconciles on
  main. Builders never merge their own worktree branch into main.

### Builder setup

Run from the main checkout unless the dispatch gives an absolute path:

```bash
git worktree add .worktrees/<TICKET>-<slug> -b <type>/<ticket>-<slug> main
```

Then reuse the main checkout's installed dependencies rather than installing fresh — copy-on-write
(`cp -Rc`) each dependency directory the build needs. The repo's own `AGENTS.md` names which ones.

If a dependency directory does not exist, do not install packages just for the worktree. Record the
missing directory and use the repo's existing setup path only if the ticket explicitly requires it.

### Builder rules

- Edit and commit only inside the worktree path.
- Use conventional commits on the ticket branch.
- Before hand-off, run `git rebase main` from inside the worktree and resolve
  your own conflicts there.
- Run self-contained checks only: unit tests, `node --check`, static checks,
  and temp-DB scripts that do not touch shared state.

Prohibited inside a worktree:

- Any render, codegen, or sync that writes shared outputs outside the worktree.
- Restarting shared services, or claiming fixed ports, docker stacks, named
  volumes, or container names.
- Editing the main checkout.
- Mutating shared state outside the repo as part of ticket code.
- Installing new packages unless the ticket explicitly requires it.

The repo's own `AGENTS.md` names the specific shared runtimes and render
commands to avoid.

### Hand-off

The closing brief must include a standalone branch line:

```text
branch: <type>/<ticket>-<slug>
```

Also include the worktree path, commits, checks run from inside the worktree,
and any conflicts resolved during `git rebase main`. Move the ticket to
review/built only after the four-part closing brief exists.

### Reconcile

Only the orchestrating non-builder reconciles; never a builder.

From the main checkout, serialize one branch at a time:

```bash
git merge --no-ff <type>/<ticket>-<slug>
```

After merge:

- Run any post-merge render, codegen, or service restart the repo requires — its `AGENTS.md` names
  these. Skipping them is the classic "it works in the branch" failure.
- Verify integrated behavior on main with canonical runtimes.
- Clean up:

```bash
git worktree remove .worktrees/<TICKET>-<slug>
git branch -d <type>/<ticket>-<slug>
```

### Conflict bounce

If `git merge --no-ff` conflicts, abort the merge and bounce the ticket back
to the builder with the conflict output. The builder rebases in the worktree
and hands off again. The reconciling session does not resolve builder conflicts
for them.

### Stale-worktree hygiene

- `golem doctor` lists stale or fully merged `.worktrees/*` entries; it does
  not auto-remove them.
- Before creating a new worktree, run `git worktree list` and avoid reusing
  an existing ticket directory or branch name.
- Remove only worktrees and branches that belong to the ticket you are
  landing, unless the human explicitly asks for broader cleanup.
