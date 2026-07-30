---
name: journaling
description: Read when appending a milestone to a project journal, locating `~/.golem/journals/<project_id>/hook.jsonl`, or formatting a hook entry. Hooks journal every tool call already — add milestones, not noise. Not for architecture docs, use golem:docs-maintenance.
---

# journaling

Journals live OUTSIDE the repo at `~/.golem/journals/<project_id>/`:
`hook.jsonl` (mechanical) and `summary.jsonl` (semantic). Both append-only JSONL.

{{#if claudecode}}**Mechanical journaling is automatic** via plugin hooks — never write `hook.jsonl`
lines by hand. The model's ONLY write is appending milestone lines — see When, below.{{/if}}{{#if opencode}}**Mechanical journaling needs Claude Code hooks** — under opencode there are no
golem lifecycle hooks, so `hook.jsonl` is NOT auto-written and no project entry is
auto-registered. Derive `project_id` with the fallback below and append milestone
lines only (see When, below); skip `hook.jsonl` entirely.{{/if}}

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
