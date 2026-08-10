---
name: verify-done
description: Read before moving any ticket to `built`, `verifying`, `verified`, or `done`, or before accepting a DONE or PR-open claim. Run the claimed commands yourself. Confirms evidence is real — to judge whether the work is right, use golem:reviewing.
---
<!-- GENERATED: skills/verify-done/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Verify done

An agent's textual claim is not evidence. Only command output, inspected artifacts, and tracker
comments you personally verify count. This skill is one job: confirm that claimed evidence is
real. Judging whether the work is right — including what acceptance missed — is `golem:reviewing`.

## Method

1. Read the acceptance criteria and the completion claim.
2. Re-run the claimed commands yourself when possible. A green summary of a run you did not
   perform proves nothing.
3. Inspect the claimed artifact or state directly — the file, the commit, the endpoint, the page.
4. Record what you observed, and name any check you could not run and why.
5. Conclude: pass, fail, or incomplete.

If a command cannot be run, record why and keep the ticket in progress or blocked unless the
ticket explicitly allows a documented skip reason.

## Phase artifacts the tracker expects

Use phase transitions, never legacy state writes — see `golem:tracker`. Before advancing:

- **`built`** — the ticket thread has the closing brief: what was done (prose plus commits/files),
  the acceptance checklist with every item tied to evidence, test instructions for the human, and
  not-done/deferred (explicit even when empty).
- **`verifying`** — dispatch evidence names the verifier, or a skip reason exists.
- **`verified` / `rejected`** — a verification report exists with PASS/FAIL, observed evidence,
  and concrete defects on FAIL.
- **`done`** — the phase is `verified` or a skip reason is recorded. For specs: all children are
  terminal and the close report exists.

The server enforces some of these; if `ticket_transition` rejects a move, the ticket is not done.

## Checks

Detect and run the repo's relevant test/check commands, full enough to prove the journey rather
than just the new code:

- `package.json` scripts: `npm test`, `npm run check`, or the repo-specific smoke.
- Python: `pytest -q` plus configured lint/type checks.
- Go/Rust/Make: `go test ./...`, `cargo test`, or `make test` when defined.
- UI/browser: load `golem:browsing` and spawn your own Chrome, never a shared visible browser.

When a commit is claimed, inspect it:

```bash
git log --oneline -5
git diff --stat HEAD~1
```

For a worktree hand-off, verify branch-aware evidence before accepting `built`:

- Commits are on the ticket branch named by the closing brief's `branch:` line.
- The branch has been rebased onto the current integration target.
- `git worktree list` shows the claimed worktree path attached to that branch.
- The closing brief names the worktree path and includes the `branch:` line.

For a claimed PR: `gh pr view <n> --json state,mergeable,statusCheckRollup` — require an
open or merged PR plus successful checks.
