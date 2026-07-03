# Substrate events — the normalized hook contract (ADR-7, P5)

golem journals and self-registers a session through a small set of **hook
scripts** (`substrate/hooks/*.sh`). Those scripts were written for Claude
Code's hook payloads, but nothing about them is CC-specific: they read a tiny
JSON object on stdin and append a line to a central journal. P5 (TKT-0577)
makes a second harness — opencode — feed the *same* scripts by normalizing its
native events into the shape the scripts already parse.

This doc is the contract between "some harness's event bus" and "golem's hook
scripts". It is the proto-HCP (Harness Compatibility Protocol) surface from
ADR-7: add a harness by writing an adapter that emits these events, not by
touching the scripts.

## The normalized event

Conceptually every harness event golem cares about normalizes to:

```
{
  schema_version: 1,
  harness:     "claudecode" | "opencode",
  event_kind:  <one of the vocabulary below>,
  session_id:  <stable session id>,
  project_root:<abs path; the scripts re-derive project_id from it>,
  ts:          <ISO-8601 UTC>,
  payload:     <the raw harness event, opaque to the scripts>
}
```

`event_kind` vocabulary (the CC hook names, kept as the canonical set):

| event_kind | when | script invocation |
|---|---|---|
| `session-start` | a new top-level session begins | `session-register.sh` then `journal-route.sh session-start` |
| `user-prompt` | the user submits a prompt | `journal-route.sh user-prompt` |
| `tool-pre` | before a tool runs | `journal-route.sh tool-pre` |
| `tool-post` | after a tool runs | `journal-route.sh tool-post` |
| `agent-spawn` | a subagent/task starts | `journal-route.sh agent-spawn` |
| `agent-return` | a subagent/task returns | `journal-route.sh agent-return` |
| `stop` | the assistant turn finishes | `journal-route.sh stop` |
| `pre-compact` | context compaction starts | `journal-route.sh pre-compact` |
| `session-end` | the session ends | `journal-route.sh session-end` |
| `notification` | a user-facing notification | `journal-route.sh notification` (+ `notify.sh`) |

## The two concrete shapes

The normalized event is realized as two on-the-wire shapes, both keyed off the
fields above:

**1. Script stdin** (what the harness adapter writes to each script's stdin):

```json
{ "session_id": "...", "cwd": "<project_root>", "harness": "opencode",
  "tool_name": "bash", "tool_input": { "command": "..." } }
```

- `session_id` + `cwd` are the only fields every script needs; `cwd` is what
  `project_root()` walks up from to find the `.git`/`CLAUDE.md` marker and
  derive `project_id`.
- `harness` is additive: absent ⇒ `session-register.sh` defaults it to
  `claudecode`. It lands in the `sessions.json` entry so the dashboard can tell
  the harnesses apart.
- `tool_name` / `tool_input` are included on tool events; they end up inside the
  journal line's `payload`.

**2. Journal line** (what `journal-route.sh` appends to
`~/.golem/journals/<project_id>/hook.jsonl`):

```json
{ "ts": "...", "event": "tool-pre", "session_id": "...", "cwd": "...",
  "project_id": "...", "project_path": "...", "payload": "<stringified stdin>" }
```

This line schema is unchanged from CC — an opencode line is distinguished only
by `harness:"opencode"` inside its `payload` (and the matching `sessions.json`
entry).

## Harness adapters

- **Claude Code** — the harness delivers these events natively via
  `substrate/hooks/hooks.json`; no adapter, the scripts run directly.
- **opencode** — `shims/opencode/index.js` (a plugin on opencode's event bus)
  maps `session.created`→`session-start`, `chat.message`→`user-prompt`,
  `tool.execute.before/after`→`tool-pre/tool-post` (the `task` tool →
  `agent-spawn`/`agent-return`), `session.idle`→`stop`,
  `session.compacted`→`pre-compact`. `session-end` has no reliable opencode
  event (`session.deleted` does not fire on normal exit) and degrades
  gracefully. Session-start context injection uses opencode's
  `experimental.chat.system.transform` hook rather than CC's `additionalContext`
  stdout. See `docs/opencode.md` for the P4 rendering that installs the shim.

Adapters MUST be non-blocking and fail-open: a slow or broken script can never
stall or crash the harness session (the opencode shim shells out
fire-and-forget and logs failures to `~/.golem/logs/opencode-shim.log`).

## Project-scoped sync on session-start

`session-register.sh` also owns P6 project-scoped substrate sync. After the
registry upserts, it runs a fast check:

```bash
golem sync --check --project <project_root> --harness <cc|opencode>
```

Exit `0` is the no-op clean path. Exit `1` means drift; the hook launches the
full `golem sync --project ... --harness ...` render detached and writes output
to `~/.golem/logs/sync-on-register.log`. Any other error is logged and ignored
so session start remains fail-open.

The opencode shim does not duplicate this logic: its `session.created` handler
passes `harness:"opencode"` to the same `session-register.sh`, so both harnesses
share the registration and sync path.
