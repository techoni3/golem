---
name: git-conventions
description: Read when opening a branch, writing a commit, opening a PR, rewriting history, or acting on an explicit worktree directive. Covers the branch, commit, and PR contract plus the worktree lifecycle. Not needed for read-only git status, log, or diff.
---
<!-- GENERATED: skills/git-conventions/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Git conventions

Two surfaces share this skill: the **branch + commit + PR contract** everyone follows, and the
**worktree lifecycle** that applies only when a ticket or dispatch brief explicitly directs a
worktree. Ad-hoc worktrees are prohibited without an explicit directive.

## Branch policy — no implicit branching

Never create a branch on your own initiative. Branch only when the work item or the human
explicitly says to branch; otherwise continue on the branch the session or ticket is already
pointed at. The directive looks like `branch: <name>` in the ticket body or dispatch brief, an
equivalent explicit instruction, or the human asking in chat. A worktree directive is an explicit
branching instruction — follow the worktree lifecycle below.

When branching is allowed, use `<type>/<kebab-slug>` — type ∈
`feat | fix | refactor | infra | docs | spike`. One branch per tracker ticket.

## Spec branches and merge ownership

A workstream owner may open one branch for a whole spec. When a spec branch is open, it is the
integration target: work items are cut from it, rebased onto it, and merged into it — not into
`main`.

The merge rule has two levels and no exceptions:

- **The builder merges its own work item into the spec branch** once the closing brief is posted.
  Work items integrate continuously, which keeps siblings from diverging; an item held back until
  the end is a conflict someone chose to defer. Under a worktree directive, the builder rebases
  onto the spec branch inside the worktree and merges from there.
- **The owner alone lands the spec branch on `main`**, after verification and the one-pass code
  review. `main` is never a builder's to touch. The owner resolves only cross-item conflicts —
  a builder resolves its own rebase conflicts.

When no spec branch is open, the integration target is `main` itself: the builder merges nothing
and stops at handoff, and the owner reconciles.

## Commits

Conventional — `<type>(<scope>): <imperative subject>`. Subject ≤72 chars, no trailing period.
`scope` optional (affected module). The body, when needed, explains *why*, not *what*. Commit at
coherent boundaries — a unit of work per commit, not a squashed day and not per-keystroke noise.

End every commit message with a `Co-Authored-By:` trailer naming the model that wrote it, plus
any session trailer your harness specifies. Use the exact strings your harness gives you — do not
copy a model name from this file; it will be stale.

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

PR title = `<type>(<scope>): <subject>` matching the most representative commit. End the PR body
with the generated-with line your harness specifies. One ticket per PR — never bundle multiple
tracker tickets into one PR.

## Worktree lifecycle (only under an explicit worktree directive)

When the ticket or dispatch brief explicitly directs a worktree, follow this section end to end.
Without that directive, do not create one.

### Contract

- One ticket = one branch = one worktree.
- Branch: `<type>/<ticket>-<kebab-slug>` (`fix` for fixes, otherwise `feat`).
- Directory: `.worktrees/<TICKET>-<slug>/` inside the repo.
- The builder works in the worktree, rebases onto the integration target, and merges its own
  branch into it (the two-level rule above). The owner lands `main`.

### Builder setup

Run from the main checkout unless the dispatch gives an absolute path. Cut the worktree from the
integration target — the spec branch when one is open, otherwise `main`:

```bash
git worktree add .worktrees/<TICKET>-<slug> -b <type>/<ticket>-<slug> <integration-target>
```

Then reuse the main checkout's installed dependencies rather than installing fresh —
copy-on-write (`cp -Rc`) each dependency directory the build needs. The repo's own `AGENTS.md`
names which ones. If a dependency directory does not exist, do not install packages just for the
worktree; record the gap and use the repo's setup path only if the ticket requires it.

### Builder rules

- Edit and commit only inside the worktree path.
- Use conventional commits on the ticket branch.
- Before merging, `git rebase <integration-target>` from inside the worktree and resolve your own
  conflicts there.
- Run self-contained checks only: unit tests, `node --check`, static checks, and temp-DB scripts
  that do not touch shared state.

Prohibited inside a worktree:

- Any render, codegen, or sync that writes shared outputs outside the worktree.
- Restarting shared services, or claiming fixed ports, docker stacks, named volumes, or container
  names.
- Editing the main checkout, or mutating shared state outside the repo as ticket code.
- Installing new packages unless the ticket explicitly requires it.

The repo's own `AGENTS.md` names the specific shared runtimes and render commands to avoid.

### Hand-off

The closing brief must include a standalone `branch: <type>/<ticket>-<slug>` line, the worktree
path, the commits, the checks run from inside the worktree, and any conflicts resolved during the
rebase. Move the ticket to `built` only after the closing brief exists and the merge into the
integration target is done.

### Owner: landing and cleanup

The owner verifies the integrated behavior on the integration target, runs any post-merge render,
codegen, or service restart the repo requires (its `AGENTS.md` names these — skipping them is the
classic "it works in the branch" failure), lands the spec branch on `main`, then cleans up:

```bash
git worktree remove .worktrees/<TICKET>-<slug>
git branch -d <type>/<ticket>-<slug>
```

Cross-item merge conflicts on the spec branch are the owner's to resolve. A builder's own rebase
conflicts bounce back to that builder with the conflict output.

### Stale-worktree hygiene

- `golem doctor` lists stale or fully merged `.worktrees/*` entries; it does not auto-remove.
- Before creating a new worktree, run `git worktree list` and avoid reusing an existing ticket
  directory or branch name.
- Remove only worktrees and branches that belong to the ticket you are landing, unless the human
  explicitly asks for broader cleanup.
