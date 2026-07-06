---
name: verify-done
description: Read before moving any ticket to `review`, `built`, `verified`, or `done`, or before accepting a worker's "DONE" or "PR open" claim. Run the claimed evidence commands yourself; mechanical outputs (exit codes, test counts, log lines) are the only valid proof of completion.
---

# verify-done

An agent's textual claim is not evidence. Only command output, inspected artifacts, and tracker comments you personally verify count.

## Required Tracker Artifacts

Before `built` or `review`, confirm the ticket thread has the four-part closing brief:

- What was done: prose plus commits/files changed.
- Acceptance checklist: copied from the parent spec or original brief, with every item tied to evidence.
- Testing instructions for the human: exact commands, URLs, or clicks.
- Not-done/deferred: explicit, even when empty.

Before `verifying`, confirm there is manager dispatch evidence naming the verifier or skip reason.

Before `verified` or `rejected`, confirm there is a verification report with PASS/FAIL, evidence, and follow-up defects if any.

Before `done`, confirm the current phase is `verified` or a skip reason is recorded. For specs, all children must be terminal and the close/retro artifact must exist.

The server enforces the same artifact classes for phase transitions. If `transitionTicket` rejects a move, the ticket is not done.

## Checks

Detect and run the repo's relevant test/check commands, full enough to prove the journey rather than just new code:

- `package.json` scripts: `npm test`, `npm run check`, or the repo-specific smoke.
- Python: `pytest -q` plus configured lint/type checks.
- Go/Rust/Make: `go test ./...`, `cargo test`, or `make test` when defined.
- UI/browser: use the repo headless helper, not a shared visible browser.

Also inspect recent commits when a commit is claimed:

```bash
git log --oneline -5
git diff --stat HEAD~1
```

For a worktree hand-off, also verify branch-aware evidence before accepting the
ticket as built/review-ready:

- Commits are on the ticket branch named by the closing brief's `branch:` line.
- The branch has been rebased on current `main`.
- `git worktree list` shows the claimed worktree path attached to that branch.
- The closing brief names the worktree path and includes the `branch:` line.

For a claimed PR, verify with `gh pr view <n> --json state,mergeable,statusCheckRollup` and require an open/merged PR plus successful checks.

If a command cannot be run, record why and keep the ticket in progress/blocked unless the ticket explicitly allows a documented skip reason.
