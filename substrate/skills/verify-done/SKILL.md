---
name: verify-done
description: Evidence commands that prove a work item is actually done before advancing its tracker ticket — run after a worker subagent returns. Use before moving any ticket to review/done or accepting a "done"/"PR is open" claim.
---

# verify-done

An agent's textual claim ("done", "tests pass", "PR is open", "approved") is NOT
evidence. Only command output you ran yourself is. Run the relevant checks below.

**Closing brief before review** — before a tracker ticket advances to `review`,
confirm its ticket thread contains a closing comment with all four required
parts:

- What was done — prose plus commits/files changed.
- Acceptance checklist — from the parent spec Behaviour section captured at
  fan-out, or from the original brief for spec-less fixes; every item checked
  with mechanical evidence.
- Testing instructions for the human — exact commands, URLs, or clicks.
- Not-done/deferred — explicit, even when the answer is "nothing".

If the closing brief is missing or any section lacks evidence, the ticket is NOT
ready for `review`; leave it `in_progress` or send it back with the missing
contract called out.

**Tests** — detect and run the repo's test command, full suite not just new tests:
- `package.json` scripts.test → `npm test` (or `pnpm test` / `yarn test`)
- `pyproject.toml`/`pytest.ini`/`tests/` → `pytest -q`
- `Cargo.toml` → `cargo test` · `go.mod` → `go test ./...` · `Makefile` test target → `make test`
Lint/types likewise if the repo defines them (e.g. `ruff`, `tsc --noEmit`).

**Commits exist** (the change is real, not just described):
```bash
git log --oneline -5 && git diff --stat HEAD~1
```

**PR, when one is claimed** (`<n>` = PR number):
```bash
gh pr view <n> --json state,mergeable,statusCheckRollup
```
Done requires `state:"OPEN"` (or `"MERGED"`), `mergeable:"MERGEABLE"`, and every
`statusCheckRollup` entry `conclusion:"SUCCESS"`. Anything else is not done.

If any check fails or the command can't be run, the ticket is NOT done — leave it in
progress (or move it to `blocked`) and return it to the worker with the failing output.
