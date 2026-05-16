---
name: golem-using-git-worktrees
description: How to use git worktrees for parallel agent work without branch-switching contention. Use when the orchestrator wants to dispatch multiple AFK-safe tickets concurrently.
expects:
  - A project repo with at least one branch.
  - A target directory the worktree can live in (sibling to the project, by convention).
produces:
  - A working git worktree at the target path with a fresh branch checked out.
category: sop
---

# golem-using-git-worktrees

Worktrees let multiple sub-agents work on different tickets in parallel without each one having to branch-switch (which is slow, cache-busting, and conflict-prone). Each worktree is its own working directory backed by the same `.git` store.

The orchestrator uses this skill when dispatching two or more AFK-safe tickets simultaneously.

## Layout convention

```
~/Documents/software/experiments/golem/golem-projects/
├── playtest-tool/                 # main worktree (the one with .git)
└── playtest-tool.worktrees/
    ├── tkt-0042-stripe-webhook/   # one worktree per active parallel ticket
    └── tkt-0044-emoji-tagging/
```

Worktrees live in a sibling `<project>.worktrees/` directory. Each subdir is named `<ticket-id>-<slug>` matching the branch name (without the category prefix).

## Procedure: create a worktree

From the main worktree:

```bash
BRANCH="feat/tkt-0042-stripe-webhook"
SLUG="tkt-0042-stripe-webhook"
WORKTREE_DIR="../$(basename "$PWD").worktrees/$SLUG"

git fetch origin
git worktree add -b "$BRANCH" "$WORKTREE_DIR" origin/main
```

After creation:
- `cd "$WORKTREE_DIR"`. The Engineer (or whoever) does its work here.
- Hooks wired in `.claude/settings.json` apply automatically (the worktree shares the project's `.claude/`).

## Procedure: remove a worktree

After the PR has been merged or abandoned:

```bash
git worktree remove "../$(basename "$PWD").worktrees/$SLUG"
git branch -d "$BRANCH"   # only if merged; -D would force
```

Do not delete the directory by hand — `git worktree remove` updates the worktree registry; manual `rm -rf` leaves stale entries that surface as confusing errors later.

## Coordination rules

- **One ticket per worktree.** Do not multi-task within a worktree.
- **AFK-safe only.** Tickets with `afk_safe: false` must run sequentially in the main worktree under user supervision.
- **No worktree on tickets with sequential gates.** If `parent_ticket` is still in-progress, the dependent runs in the main worktree (sequential).
- **The orchestrator is the only persona that creates worktrees.** Engineers do not self-fork into a worktree.
- **Never share state across worktrees mid-work.** Each is its own session; cross-worktree communication happens through git (push, pull) or through the ticket's hand-off log, not through shared scratch files.

## Anti-patterns

- **Two worktrees on the same branch.** Git refuses; do not work around it. If two agents need to collaborate on one branch, they're on the same ticket and one worktree.
- **Worktrees inside the main repo's working directory.** Sibling, not nested. Nested worktrees confuse `.gitignore` and editor file-watchers.
- **Forgetting to remove on merge.** Stale worktrees accumulate, eat disk, and pollute `git worktree list`. Remove on every merge.
- **Using worktrees to "save state" while exploring.** Worktrees are for parallel work, not for exploration snapshots. Use a topic branch for that.
- **Skipping the journal/handoff log.** Each worktree is a session; the closing reflex still runs and the hand-off log still gets an entry.

## When this skill is wrong

- Only one ticket is in-flight. Use the main worktree.
- Two tickets touch the same files. Worktrees won't help; you'd just trade branch-switch contention for merge conflicts. Run sequentially.
- The project is a brief exploration / spike with no long-lived branches. Worktrees are over-investment.
