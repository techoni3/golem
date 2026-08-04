# Substrate Events And Bus

Golem keeps two event records:

- Central hook journals at `~/.golem/journals/<project_id>/hook.jsonl` for durable local history.
- The dashboard-owned tracker bus in `~/.golem/tracker.db` for subscriptions, digests, team choreography, and UI refresh.

Hooks remain fail-open. `substrate/hooks/journal-route.sh` always writes the journal line first, then best-effort forwards to `POST /api/bus/ingest`; if the dashboard is down, the event is spooled locally under `~/.golem/spool/`.

## Event Classes

The bus stores events in the tracker `events` table with a global sequence id.

| Class | Sources | Default Subscription |
|-------|---------|----------------------|
| `tracker` | ticket/comment/dispatch/phase/subscription mutations | yes |
| `lifecycle` | `session-start`, `session-end`, `user-prompt`, `stop`, `subagent-stop`, `pre-compact`, `notification` | yes |
| `custom` | hook events that are not recognized lifecycle/activity classes | yes |
| `activity` | `tool-pre`, `tool-post`, `agent-spawn`, `agent-return`, `send-message`, `send-message-post` | no |

Activity is opt-in so normal subscription digests do not flood sessions with tool traces.

## Topics

Tracker events default to `ticket/<display_id>`, for example `ticket/GOL-315`.

Child ticket events mirror onto the parent spec tree topic: `spec/<parent-display-id>/tree`. Managers subscribe to the spec tree to see child `built`, `verified`, `rejected`, and close-out events without polling every child.

Hook ingest uses session/project context from the forwarded payload. Lifecycle roster events update materialized session status and can suspend/reactivate subscriptions:

- `session-end` suspends that session's subscriptions.
- `session-start` reactivates them without advancing their cursor.

## Ingest Contract

`POST /api/bus/ingest` accepts one event or an event batch. Recognized fields include `uuid`/`event_uuid`, `event`, `type`, `session_id`, `project_id`, `cwd`, and arbitrary payload data. Source UUIDs are idempotency keys; duplicates are skipped and do not create duplicate roster events.

Hook names map to bus types with a `hook_` prefix, for example `session-end` becomes `hook_session_end`.

## Subscriptions

`POST /api/bus/subscribe` stores `{session_id, topic, classes, cursor_seq, expires_at, reason}`.

`classes` defaults to `tracker`, `lifecycle`, and `custom`. Pass `activity` explicitly only when tool-level events are needed.

The dispatch drainer delivers subscription digests over the existing channel bridge. A cursor advances only after a successful push. Pending backlog is capped at 500 events per digest; overflow is reported as truncated with an omitted count.

Useful subscriptions:

- Builder/explorer on one assignment: `ticket/<display_id>`.
- Manager on a spec: `spec/<display_id>/tree`.
- Session lifecycle watcher: a session/project lifecycle topic with lifecycle class filtering.

## Retention And Stats

`POST /api/bus/prune` deletes old activity rows first; tracker/lifecycle/custom records are retained unless explicitly pruned by policy. Prune emits a `bus_pruned` event.

`GET /api/bus/stats` reports row counts by class and subscription status. Use it for operational checks, not as the work record.

## Harness Normalization

Claude Code hooks and the opencode shim both normalize into the same script stdin shape: `session_id`, `cwd`, `harness`, optional tool fields, and raw payload. Codex's adapter records only documented hook fields through the canonical locked session-fact writer and marks delivery `pull` with `push: false`; it never parses unstable transcripts. `SubagentStop` records the child observation without changing the parent session's status. The scripts derive project identity from the cwd, write the hook journal, and forward to the bus. Adapters must remain non-blocking and fail-open.

GOL-473–477 add a distinct, Golem-owned Codex App Server path for managed
headless sessions and the private `golem codex` TUI. `lib/codex-supervisor.js` writes the durable thread/process
recovery map, then starts a required Golem MCP child with a supervisor-owned
canonical actor binding. GOL-124 factors the loopback transport and delivery
lifecycle into `lib/typed-worker-endpoint.js`: every typed lease authenticates
the canonical session and owner token, reports a protocol version and live
readiness, bounds envelope bytes, and rejects a stale owner or duplicate
envelope. Dashboard records `claimed → accepted → settled|interrupted|
recovery_required` separately from the legacy transport status. Only
pre-acceptance failure returns work to the shared queue; accepted work is never
automatically replayed. Codex remains one adapter: it claims before `turn/start`
and records a correlated accepted mapping only after the native start result.
An ambiguous start outcome is recovery-required and releases neither the
canonical mapping nor a second delivery attempt. Once the pinned App Server
handshake, MCP status check, typed endpoint, and idle thread are all valid, the
health lease is `delivery_ready:true`.
The same envelope path carries managed-Codex notifications, consults,
subscription digests, and gate resolutions; CC/OC retain their generic
route-specific channel events. Role activation and interrupt/halt are visibly
gated for managed Codex instead of being injected into an in-flight App Server
turn. Schema-known App Server approvals remain pending until an owner-authenticated
local operator makes a one-off decision; only a redacted correlation record is
durable, and stop/restart fails unresolved approvals closed. The managed TUI
instead receives App Server approval requests natively through a single private
Unix-WebSocket bridge; it is the only logical App Server client, and tracker
injection waits for its idle canonical thread. Managed Codex display identity
comes from thread lifecycle/name notifications (with Codex's session index as
an upgrade fallback), and activity comes from thread-status plus turn lifecycle
notifications. The authenticated live health response closes routing immediately
when that thread becomes active or waiting; the canonical supervisor row shadows
the duplicate raw hook row for the same thread. This changes only managed Codex
delivery; ordinary Codex hooks remain pull-only, and CC/OC generic channel
behavior is unchanged.
