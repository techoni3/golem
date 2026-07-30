---
name: journaling
description: Read when appending a milestone to a project journal, locating `~/.golem/journals/<project_id>/hook.jsonl`, or formatting a hook entry. Hooks journal every tool call already — add milestones, not noise. Not for architecture docs, use golem:docs-maintenance.
---
<!-- GENERATED: skills/journaling/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# journaling

Journals live OUTSIDE the repo at `~/.golem/journals/<project_id>/hook.jsonl` — append-only JSONL,
machine-local, one line per tool call and lifecycle event.

> [!IMPORTANT]
> **This is telemetry, not the project's memory.** What a session *learned* belongs in
> `docs/memory.jsonl` in the repo, which `golem:docs-maintenance` owns — it carries an evidence
> field, it is swept and promoted, and a colleague not running golem can read it. This file has
> none of those properties. A lesson recorded here is invisible to the repo and never swept.
> Milestones here mark that something happened; memory records what it taught you.

**Never write `hook.jsonl` lines by hand.** Where it is written at all, it is written by hooks; the
model's ONLY write is appending milestone lines. See When, below.

Which harness writes it differs, and the difference is real:

| Harness | `hook.jsonl` | How |
|---|---|---|
| Claude Code | ✅ automatic | native lifecycle hooks run `journal-route.sh` |
| opencode | ✅ automatic | `shims/opencode/index.js` bridges the plugin event bus onto the same scripts — `session.created` → `session-register.sh` + journal, `tool.execute.before`/`after` → tool-pre/post, `session.idle` → stop, `session.compacted` → pre-compact, `session.deleted` → session-end |
| Codex | ❌ not written | lifecycle hooks fire, but `shims/codex/hook.mjs` records session facts and registration only — `journal-route.sh` does not ship in that bundle |

So under Codex the mechanical stream is absent while milestones still work. Append milestone lines
exactly as below; do not assume a tool-call history exists to read back.

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
# The directory is created by journal-route.sh, which only Claude Code and
# opencode run — under Codex nothing has created it, so the append would fail
# with "No such file or directory" on a project that has never journalled.
mkdir -p ~/.golem/journals/"$PID"
printf '{"ts":"%s","event":"milestone","session_id":"%s","project_id":"%s","text":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CLAUDE_CODE_SESSION_ID:-}" "$PID" \
  "$(jq -Rn --arg t "ITEM TEXT" '$t')" \
  >> ~/.golem/journals/"$PID"/hook.jsonl
```
