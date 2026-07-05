---
name: worktrees
description: Worktree lifecycle for parallel builder dispatches: setup, provisioning, isolated checks, hand-off, manager reconcile, cleanup, and stale-worktree hygiene. Read when a ticket or dispatch brief includes a worktree directive.
---
<!-- GENERATED: skills/worktrees/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# worktrees

Use this skill only when the ticket or dispatch brief explicitly directs a
worktree. Ad-hoc worktrees are still prohibited unless the human or orchestrator
explicitly asks for one.

## Contract

- One ticket = one branch = one worktree.
- Branch: `<type>/gol-<n>-<kebab-slug>` (`fix` for fixes, otherwise `feat`).
- Directory: `.worktrees/GOL-<n>-<slug>/` inside the repo.
- Builders work in the worktree; the orchestrating manager/planner reconciles on
  main. Builders never merge their own worktree branch into main.

## Builder Setup

Run from the main checkout unless the dispatch gives an absolute path:

```bash
git worktree add .worktrees/GOL-<n>-<slug> -b <type>/gol-<n>-<slug> main
cp -Rc node_modules .worktrees/GOL-<n>-<slug>/node_modules
cp -Rc mcp/channel/node_modules .worktrees/GOL-<n>-<slug>/mcp/channel/node_modules
```

If a dependency directory does not exist, do not install packages just for the
worktree. Record the missing directory and use the repo's existing setup path if
the ticket explicitly requires it.

## Builder Rules

- Edit and commit only inside the worktree path.
- Use conventional commits on the ticket branch.
- Before hand-off, run `git rebase main` from inside the worktree and resolve
  your own conflicts there.
- Run self-contained checks only: unit tests, `node --check`, static checks, and
  temp-DB scripts that do not touch shared state.

Prohibited inside a worktree:

- `golem sync` or any render that writes shared plugin/global outputs.
- Restarting the shared dashboard or claiming fixed/shared runtimes such as port
  7420, docker stacks, named volumes, or container names.
- Editing the main checkout.
- Mutating `~/.golem` as part of ticket code.
- Installing new packages unless the ticket explicitly requires it.

## Hand-Off

The closing brief must include a standalone branch line:

```text
branch: <type>/gol-<n>-<slug>
```

Also include the worktree path, commits, checks run from inside the worktree, and
any conflicts resolved during `git rebase main`. Move the ticket to review/built
only after the four-part closing brief exists.

## Manager/Planner Reconcile

Only the orchestrating non-builder reconciles; never a builder.

From the main checkout, serialize one branch at a time:

```bash
git merge --no-ff <type>/gol-<n>-<slug>
```

After merge:

- If `substrate/`, `mcp/channel/`, or compiler/render behavior changed, run
  `golem sync --target cc` and `golem sync --target cc --out ./plugin --force`;
  bump the root version when plugin behavior changed.
- If dashboard server behavior changed, restart the dashboard from the main
  checkout after the merge.
- Verify integrated behavior on main with canonical runtimes.
- Clean up:

```bash
git worktree remove .worktrees/GOL-<n>-<slug>
git branch -d <type>/gol-<n>-<slug>
```

## Conflict Bounce

If `git merge --no-ff` conflicts, abort the merge and bounce the ticket back to
the builder with the conflict output. The builder rebases in the worktree and
hands off again. Managers/planners do not resolve builder conflicts for them.

## Stale-Worktree Hygiene

- `golem doctor` lists stale or fully merged `.worktrees/*` entries; it does not
  auto-remove them.
- Before creating a new worktree, run `git worktree list` and avoid reusing an
  existing ticket directory or branch name.
- Remove only worktrees and branches that belong to the ticket you are landing,
  unless the human explicitly asks for broader cleanup.
