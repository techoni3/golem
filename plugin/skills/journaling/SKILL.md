---
name: journaling
description: Read when appending a milestone to a project journal, locating `~/.golem/journals/<project_id>/hook.jsonl`, or formatting a hook entry. Hooks journal every tool call already — add milestones, not noise. Not for architecture docs, use golem:docs-maintenance.
---
<!-- GENERATED: skills/journaling/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# journaling

Journals live OUTSIDE the repo at `~/.golem/journals/<project_id>/`:
`hook.jsonl` (mechanical) and `summary.jsonl` (semantic). Both append-only JSONL.

**Mechanical journaling is automatic on every harness** — never write `hook.jsonl` lines by hand.
The model's ONLY write is appending milestone lines; see When, below.

Claude Code and Codex fire golem's lifecycle hooks natively. opencode reaches the same scripts
through `shims/opencode/index.js`, which bridges its plugin event bus onto them —
`session.created` → `session-register.sh` + journal, `tool.execute.before`/`after` → tool-pre/post,
`session.idle` → stop, `session.compacted` → pre-compact, `session.deleted` → session-end. So
`hook.jsonl` is written and the project entry is registered there too.

## When

Append a milestone at a **spec closure** or a genuine **wave boundary** — a point a future session
would need to know about. Never per tool call (the hooks already do that), never per ticket (the
tracker already does that), and never as a substitute for a ticket comment.

One line, plain language, understandable without the surrounding conversation.

## Locating the journal

`project_id`: look it up in the registry — the SessionStart hook already registered
this project, and the registry is authoritative (legacy projects have non-derived ids):

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PID=$(jq -r --arg p "$ROOT" '.projects[] | select(.path==$p) | .id' ~/.golem/projects.json)
```

Fallback only if the lookup is empty (must match the hook's derivation exactly):

```bash
SLUG=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
HASH=$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-6)
PID="${SLUG}-${HASH}"
```

hook.jsonl line schema: `{ts, event, session_id, project_id, project_path, cwd, payload}`.

Milestone line schema: `{ts, event:"milestone", session_id, project_id, text}`.

Append a milestone (one line, no array wrapper, newline-terminated):

```bash
printf '{"ts":"%s","event":"milestone","session_id":"%s","project_id":"%s","text":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CLAUDE_CODE_SESSION_ID:-}" "$PID" \
  "$(jq -Rn --arg t "ITEM TEXT" '$t')" \
  >> ~/.golem/journals/"$PID"/hook.jsonl
```
