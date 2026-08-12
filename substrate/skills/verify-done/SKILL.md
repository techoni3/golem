---
name: verify-done
description: Read before accepting any DONE, closing-comment, or PR-open claim, or before moving work you own toward done. Confirms claimed evidence is real by re-running it. To judge whether the work is right, use golem:reviewing.
---

# Verify done

An agent's textual claim is not evidence. Only command output, inspected artifacts, and tracker
comments you personally verify count. This skill is one job: confirm that claimed evidence is
real. Judging whether the work is right — including what acceptance missed — is
`golem:reviewing`.

## Method

1. Read the acceptance criteria and the completion claim.
2. Re-run the claimed commands yourself when possible. A green summary of a run you did not
   perform proves nothing.
3. Inspect the claimed artifact or state directly — the file, the commit, the endpoint, the
   page.
4. Record what you observed, and name any check you could not run and why.
5. Conclude: pass, fail, or incomplete. On fail, the defects must be concrete enough to act on.

If a check cannot be run, say so and keep the ticket in its honest state — `review` is for work
whose evidence holds up; a claim that cannot be verified is not finished.

## Checks

Detect and run the repo's real test/check commands, full enough to prove the journey rather than
just the new code:

- `package.json` scripts: `npm test`, `npm run check`, or the repo-specific smoke.
- Python: `pytest -q` plus configured lint/type checks.
- Go/Rust/Make: `go test ./...`, `cargo test`, or `make test` when defined.
- UI/browser: load `golem:browsing` and spawn your own Chrome, never a shared visible browser.

When a commit is claimed, inspect it:

```bash
git log --oneline -5
git diff --stat HEAD~1
```

For a claimed PR: `gh pr view <n> --json state,mergeable,statusCheckRollup` — require an open or
merged PR plus successful checks.
