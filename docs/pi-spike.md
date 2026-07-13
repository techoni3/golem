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

Dashboard ticket dispatches address the canonical Pi UUID and atomically publish
one immutable file per message before reporting `{ queued: true, delivered:
false }`. Consumers rename individual files from `pending/` to `processing/`, so
an acknowledged producer can never target an unlinked inode. Pi moves accepted
messages to `acks/`; only the dashboard’s subsequent ack settlement marks the
queue, envelope, passive lease, and comment dispatch delivered. Malformed files
are preserved under `dead-letter/`.

Queue publication is claimed atomically before filesystem publication and uses
the queue id as the message filename. Replays therefore resolve to the same
file, while overlapping ticks cannot publish twice or cancel after publication.
Ack claims survive restarts; settlement checkpoints each idempotent stage in the
claim file and deletes it only after queue, envelope, passive, and comment facts
all complete. Malformed claims are quarantined for inspection.

The journey test proves rendering is isolated and portable, records the runtime
probe result, and refuses to infer Tier A from the existence of an in-process API.
