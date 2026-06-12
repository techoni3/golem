---
name: verify-done
description: Evidence commands that prove a work item is actually done before checking its box — run after a worker subagent returns. Use before marking any PLAN.md item complete or accepting a "done"/"PR is open" claim.
---

# verify-done

An agent's textual claim ("done", "tests pass", "PR is open", "approved") is NOT
evidence. Only command output you ran yourself is. Run the relevant checks below.

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

If any check fails or the command can't be run, the item is NOT done — return it to
the worker with the failing output.
