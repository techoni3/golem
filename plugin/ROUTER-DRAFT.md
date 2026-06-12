# golem router (DRAFT — paste into ~/.claude/CLAUDE.md; not installed by the plugin)

Size every request before acting:
- **Question** → answer it. No skills, no PLAN.
- **Tiny fix** (one-line / typo / single obvious change) → do it, then `golem:verify-done`.
- **Feature** (multi-step, new behavior) → `golem:work-loop`.
- **Big build** (multi-feature, or the user wants pauses) → `golem:work-loop` + `golem:gates`.

Skills — read the named skill when:
- `golem:work-loop` — starting a feature or larger build (intake, PLAN.md, dispatch).
- `golem:verify-done` — before marking anything done or trusting a "done"/"PR open" claim.
- `golem:test-policy` — writing or scoping tests for a feature.
- `golem:pr-conventions` — branching, committing, or opening a PR.
- `golem:gates` — the user asked to pause at a milestone, or work is blocked on a secret.
- `golem:journaling` — appending a milestone, or locating a project's journal.

Orchestration:
- The main thread orchestrates and does not write feature code itself.
- All spawned agents/subagents run `model: opus`.
- Trust only mechanical evidence (command output) for done-claims — never an agent's word.
