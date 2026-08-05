# Pi native adapter spike

> Historical Wave-0 evidence. As of GOL-126, Pi 0.80.10 is installed and the shipped extension
> registers the shared authenticated typed-worker endpoint. The next-turn spool described below is
> retained only as a migration reader for already-published records; it is no longer the intended
> delivery path for a typed-capable Pi session. Product tier remains B until tools/resources,
> managed launch, dashboard cutover, and release proof land.

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
The TrackerDB claim is a compare-and-swap lease with an owner token; only that
owner can advance to `next_turn`, and another dashboard process can recover only
after expiry. Publication uses an exclusive hard-link into an immutable
`published/` store, then links into `pending/`; moving the consumer link cannot
make a retry recreate it.
Ack claims survive restarts; settlement checkpoints each idempotent stage in the
claim file and deletes it only after queue, envelope, passive, and comment facts
all complete. Malformed claims are quarantined for inspection.

Crash recovery also repairs a missing pending link from the immutable canonical
file unless that message is verifiably processing or acknowledged. Pi drains
orphaned `processing/` entries before new pending work. Dashboard pickup
settlement uses an exclusive filesystem lease directory per ack; a second
dashboard cannot settle concurrently and may take over only after lease expiry.

Ack ownership is now one atomically linked lease file—there is no empty-lock
window. Stale takeover verifies the claimed inode before unlinking and only the
contender that exclusively links its replacement proceeds. Pi retains accepted
messages in `processing/` until the subsequent observable `agent_start`; a
crash before that event therefore replays rather than falsely acknowledging.

Any publication failure releases both the process-local guard and the
owner-matched TrackerDB publishing lease back to pending. Non-owners cannot
release it, and the same dashboard process can retry immediately without
waiting for lease expiry.

For Pi, `setDispatched` (and therefore `dispatched_at`) is deferred until the
deterministic inbox publication is accepted. A failed generation can retry on
the next tick without mistaking its own timestamp for a superseding dispatch;
a genuinely newer redispatch still has a later timestamp and cancels the old
queue generation through the existing stale-row guard.

The journey test proves rendering is isolated and portable, records the runtime
probe result, and refuses to infer Tier A from the existence of an in-process API.
