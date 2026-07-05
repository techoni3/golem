---
name: verify-done
description: Evidence commands that prove a work item is actually done before advancing its tracker ticket — run after a worker subagent returns. Use before moving any ticket to review/built/verified/done or accepting a done/PR-open claim.
---
<!-- GENERATED: skills/verify-done/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

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

For a claimed PR, verify with `gh pr view <n> --json state,mergeable,statusCheckRollup` and require an open/merged PR plus successful checks.

If a command cannot be run, record why and keep the ticket in progress/blocked unless the ticket explicitly allows a documented skip reason.
