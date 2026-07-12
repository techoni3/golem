# Pi native adapter spike

Tested 2026-07-13 in an isolated `HOME`, `GOLEM_HOME`, and `XDG_CONFIG_HOME`.

- Pi executable: not installed (`command -v pi` and `pi --version` failed).
- Node: `v22.22.3`.
- Current authoritative API source: `earendil-works/pi-mono` coding-agent
  `extensions.md` and `session-format.md` (consulted 2026-07-13).
- Extension load path: global `~/.pi/agent/extensions`, project `.pi/extensions`,
  package `pi.extensions`, or isolated `pi -e ./path.ts`; `/reload` reloads
  discovered extensions.
- Canonical identity: `ctx.sessionManager.getSessionId()`, never file recency.
- Relevant documented events: `session_start` (`startup`, `reload`, `new`,
  `resume`, `fork`), `session_info_changed`, `agent_start`, `agent_settled`,
  `tool_call`, and `session_shutdown`.
- Delivery finding: `pi.sendUserMessage()` and command-context
  `ctx.sendUserMessage()` are in-process APIs. No documented external endpoint
  was found for addressing an already-running idle TUI. Because Pi was absent,
  native load/event/idle-delivery execution was not possible in this host.
- Result: **Tier B**. The portable extension claims a durable, session-addressed
  JSONL inbox on the next real input and transforms that input with the queued
  text. It explicitly advertises `push_delivery: false`.

Dashboard ticket dispatches address the canonical Pi UUID and durably append one
JSONL record before reporting `{ queued: true, delivered: false }`. The extension
atomically renames the inbox before reading, so concurrent producers recreate a
separate inbox. Valid records are delivered per-line; malformed records are
preserved in `.dead-letter.jsonl`, and unexpected claim-processing failures
restore the claimed bytes for retry without replacing concurrent appends.

The journey test proves rendering is isolated and portable, records the runtime
probe result, and refuses to infer Tier A from the existence of an in-process API.
