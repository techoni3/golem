# Legacy audit and migration plan

GOL-39 introduces the read-only C0 compatibility audit. `packages/compat` accepts an explicit home path and reads only with `lstat` plus no-follow file handles; it never opens a writable SQLite connection, creates locks, evaluates configuration, follows links, or creates runtime state.

The audit inventories the GOL-13 registry, state, journal/spool/gate/role, config, render, and tracker-file surfaces. Every readable source has a SHA-256 fingerprint; `tracker.db` additionally receives a bounded no-follow SQLite header inspection, never a writable open. Missing inputs are ignored, malformed/permission/symlink inputs are quarantined, and good sources continue to be inventoried. Output paths are `$GOLEM_HOME`-relative and values are redacted.

The plan is canonically sorted and hashes its planner version, source manifest, findings, proposed actions, backup/disk requirements, compatibility window, and rollback artifact. `attach` requires exact project/session/harness evidence; path/name/PID/recency, unsafe roots, conflicts, and unresolved facts are review-only. Terminal evidence is retained as history. There is no apply/import operation in this wave.

Run `npm run migration:plan -- --home <home> --json` for JSON, or omit `--json` for a concise human summary. The J7 fixture corpus in `test/migration/replay.mjs` proves current/old/malformed homes produce repeatable redacted output and preserve every input byte, mtime, mode, and SQLite metadata.
