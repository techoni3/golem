---
name: verify-done
description: Read before moving any ticket to `built`, `verifying`, `verified`, or `done`, or before accepting a DONE or PR-open claim. Run the claimed commands yourself. Confirms evidence is real — to judge whether the work is right, use golem:reviewing.
---
<!-- GENERATED: skills/verify-done/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# verify-done

An agent's textual claim is not evidence. Only command output, inspected artifacts, and tracker comments you personally verify count.

## Required Tracker Artifacts

Use phase transitions, never legacy state writes — see `golem:tracker`.

For a spec, before `designed → planning`, confirm **Gate A** passed: a spec-review verdict from a
reviewer who did not author the design, with every `BLOCKER` resolved or overridden by the human
with a recorded reason.

Before `built`, confirm the ticket thread has the four-part closing brief:

- What was done: prose plus commits/files changed.
- Acceptance checklist: copied from the parent spec or original brief, with every item tied to evidence.
- Testing instructions for the human: exact commands, URLs, or clicks.
- Not-done/deferred: explicit, even when empty.

Before `verifying`, confirm there is manager dispatch evidence naming the verifier or skip reason.

Before `verified` or `rejected`, confirm there is a verification report with PASS/FAIL, evidence, and follow-up defects if any.

Before `done`, confirm the current phase is `verified` or a skip reason is recorded, **and** that
**Gate B** passed: a code-review verdict from a reviewer who did not write the code. Verification
and review are separate gates — a green verification is not a review. For specs, all children must
be terminal and the close/retro artifact must exist.

The server enforces *some* of these artifact classes — closing brief, dispatch evidence, a
verification-shaped comment, and `verified`-or-skip-reason. If `transitionTicket` rejects a move,
the ticket is not done.

**The review gates are session-enforced, not server-enforced.** Nothing rejects a close that
ignored a `BLOCKER`, so a skipped review gate is invisible to the tracker and detectable only in
the thread. That makes it your responsibility, not the server's.

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
ticket as `built`:

- Commits are on the ticket branch named by the closing brief's `branch:` line.
- The branch has been rebased on current `main`.
- `git worktree list` shows the claimed worktree path attached to that branch.
- The closing brief names the worktree path and includes the `branch:` line.

For a claimed PR, verify with `gh pr view <n> --json state,mergeable,statusCheckRollup` and require an open/merged PR plus successful checks.

If a command cannot be run, record why and keep the ticket in progress/blocked unless the ticket explicitly allows a documented skip reason.
