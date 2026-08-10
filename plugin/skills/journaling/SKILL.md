---
name: journaling
description: Read when locating or interpreting the golem hook journal at `~/.golem/journals/<project_id>/hook.jsonl`. Hooks write it; agents read it and never write it by hand. Not for project memory or architecture docs, use golem:docs-maintenance.
---
<!-- GENERATED: skills/journaling/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Journaling

Journals live outside the repo at `~/.golem/journals/<project_id>/hook.jsonl` — append-only
JSONL, machine-local, one line per tool call and lifecycle event, written by hooks.

**Agents never write this file.** Hooks own telemetry; tracker comments own work history; the
repo's `docs/memory.jsonl` owns what a session learned (`golem:docs-maintenance`). A lesson
recorded in the hook journal is invisible to the repo, never swept, and carries no evidence
field — it is the wrong place for anything a future session needs.

Not every harness writes the journal (Claude Code and opencode do; Codex records session facts
only), so never assume a complete tool-call history exists to read back.

## Locating the journal (read-only)

`project_id`: look it up in the registry — the SessionStart hook already registered the project,
and the registry is authoritative (legacy projects have non-derived ids):

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PID=$(jq -r --arg p "$ROOT" '.projects[] | select(.path==$p) | .id' ~/.golem/projects.json)
```

Line schema: `{ts, event, session_id, project_id, project_path, cwd, payload}`.
