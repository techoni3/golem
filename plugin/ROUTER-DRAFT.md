# golem router (DRAFT — paste into ~/.claude/CLAUDE.md; not installed by the plugin)

Size every request before acting:
- **Question** → answer it. No skills, no tickets.
- **Tiny fix** (one-line / typo / single obvious change) → do it, then `golem:verify-done`.
- **Feature** (multi-step, new behavior) → role skill (`golem:managing` / `planning` / `building` / `exploring`) per AGENTS spine.
- **Big build** (multi-feature, or the user wants pauses) → same + `golem:gates`.

Skills — read the named skill when:
- `golem:managing` / `planning` / `building` / `exploring` — role SOPs for feature-sized work (see AGENTS skill index).
- `golem:tracker` — reading/creating/transitioning tracker tickets (the source of truth for work; replaces PLAN.md).
- `golem:verify-done` — before marking anything done or trusting a "done"/"PR open" claim.
- `golem:test-policy` — writing or scoping tests for a feature.
- `golem:git-conventions` — branching, committing, opening a PR, or following a worktree directive in a dispatch brief.
- `golem:gates` — the user asked to pause at a milestone, or work is blocked on a secret.
- `golem:journaling` — appending a milestone, or locating a project's journal.

Orchestration:
- The main thread orchestrates and does not write feature code itself.
- All spawned agents/subagents run `model: opus`.
- Trust only mechanical evidence (command output) for done-claims — never an agent's word.
