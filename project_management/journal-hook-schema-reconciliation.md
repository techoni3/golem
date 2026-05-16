# Journal-hook schema reconciliation (task #51)

Date: 2026-05-16

## Problem

Three copies of `journal-event.sh` existed with two different schemas:

- `.claude/hooks/journal-event.sh` (root workspace, **actually wired**) — old schema.
- `substrate/templates/project-bootstrap/.claude/hooks/journal-event.sh` (bootstrap template, **actually wired into every new project**) — old schema, byte-identical to the wired root copy.
- `substrate/hooks/journal-event.sh` — a richer `schema:1` variant, described in its own header as "canonical for the dashboard's consumption" but wired NOWHERE and consumed by NOTHING.

## Investigation findings

**Schema diff.** The old schema writes one JSONL line `{ts, event, session_id, cwd, payload}` (plus `exit_reason` on `subagent-stop`), where `payload` is the raw Claude Code hook JSON kept as an escaped string. The `schema:1` variant instead flattens everything to top-level keys (`tool_name`, `tool_input`, `tool_response`, `subagent_type`, `team_name`, `file_path`, `command`, `skill_name`, `hook_event_name`, …), adds a `schema: 1` tag, and drops the `payload` string entirely.

**What the dashboard consumes.** `dashboard/server/journal.js` `normalizeEvent()` reads `ev.payload`, `JSON.parse`s it, and flattens the inner fields onto the event. It depends entirely on the old schema's stringified `payload`. A `schema:1` line has no `payload` string, so `normalizeEvent` would return the event un-flattened and every `tool_name` / `subagent_type` / `tool_input` would be `undefined` — the dashboard would silently render nothing. Grep for `schema` in `dashboard/server/` returns nothing; no consumer of `schema:1` exists anywhere.

**How hooks are deployed.** `golem install` symlinks `agents/`, `skills/`, `commands/`, `personas/`, and `bin/golem` into `~/.claude/` and `~/.local/bin`. It does **not** touch hook scripts at all. New projects get hooks by `tar`-copying `substrate/templates/project-bootstrap/.claude/` (per the `golem-project-bootstrap` skill). The root workspace `.claude/hooks/journal-event.sh` is a **real file** (not a symlink), a hand-maintained copy. So `substrate/hooks/` was never a deployment source — it was orphaned reference material.

**Other hook scripts.** `git-guardrails.sh`, `lint-format.sh`, `journal-summarise.sh` were already byte-identical across `substrate/hooks/`, the bootstrap template, and (for `journal-summarise.sh`) the root `.claude/hooks/`. No drift there. The root `.claude/hooks/` correctly omits `git-guardrails.sh` / `lint-format.sh` because the root `.claude/settings.json` deliberately does not wire lint/guardrails for the CEO workspace — that is intentional settings-level scoping, not script drift.

## Decision

The `schema:1` variant is unused, never-wired aspiration. The old schema is what is wired AND consumed. Reconciled **downward**: overwrote `substrate/hooks/journal-event.sh` with a byte-for-byte copy of the wired root `.claude/hooks/journal-event.sh` (which already carries the F2 `exit_reason` instrumentation). `substrate/hooks/` is now the single source of truth and is byte-identical to both the wired root copy and the bootstrap template.

A real schema migration (flattened `schema:1` across the hook + `journal.js` + every consumer) is a separately-sized task and was deliberately not attempted here.

## Changed

- `substrate/hooks/journal-event.sh` — replaced the `schema:1` variant with the wired old-schema version. Now byte-identical to `.claude/hooks/journal-event.sh` and `substrate/templates/project-bootstrap/.claude/hooks/journal-event.sh`. Bash-3.2-safe (`bash -n` clean), still exits 0 unconditionally.

No other files changed; the other three hook scripts were already single-sourced.
