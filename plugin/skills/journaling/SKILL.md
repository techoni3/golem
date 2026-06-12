---
name: journaling
description: Central journal paths and milestone append format for golem projects. Read when appending a milestone line, or reading/locating a project's journal.
---

# journaling

Journals live OUTSIDE the repo at `~/.config/golem/journals/<project_id>/`:
`hook.jsonl` (mechanical) and `summary.jsonl` (semantic). Both append-only JSONL.

**Mechanical journaling is automatic** via plugin hooks — never write `hook.jsonl`
lines by hand. The model's ONLY write is appending milestone lines (see work-loop).

`project_id`: look it up in the registry — the SessionStart hook already registered
this project, and the registry is authoritative (legacy projects have non-derived ids):

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PID=$(jq -r --arg p "$ROOT" '.projects[] | select(.path==$p) | .id' ~/.config/golem/projects.json)
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
  >> ~/.config/golem/journals/"$PID"/hook.jsonl
```
