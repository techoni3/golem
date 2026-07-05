# Dashboard Runtime Notes

## Substrate Settings

The dashboard exposes a substrate control surface at `/settings`. It is backed by
server routes in `dashboard/server/substrate.js` and browser code in
`dashboard/web/src/settings-page.jsx`.

Routes:

- `GET /api/substrate/config` returns harness settings from `~/.golem/config.json`.
- `PUT /api/substrate/config` accepts partial harness updates and preserves unknown config keys.
- `GET /api/substrate/status` returns global and per-project render status cells:
  `in_sync`, `drifted`, `disabled`, or `error`.
- `POST /api/substrate/sync` runs a synchronous v1 render for one target or all known targets and returns per-target results.

The settings page contains three extension sections:

- Harness switches, driven by config entries rather than hard-coded page state.
- Substrate sync matrix, grouped by artifact type and harness.
- A reserved work-loop settings section for future controls.

The sync route uses the same compiler engine and adapters as `golem sync`, so
dashboard and CLI status should agree. opencode config validation still delegates
to `opencode debug config` when the binary is available.

## Tracker Comment Dispatch

Tracker schema version 7 adds per-comment dispatch state for spec review loops.
`dashboard/server/tracker-db.js` owns the migration and exposes the fields through
the existing ticket payloads; comments now carry `dispatch_state` with the loose
convention `undispatched`, `dispatched`, `addressed`, or `n/a`.

Dispatch attempt history lives in `comment_dispatches`, one row per comment and
target session. `dashboard/server/comment-dispatch.js` is the service layer for
batch enqueue, delivery marking, addressed recomputation, and startup sweeps.
Human-authored open comments default to `undispatched`; agent/session-authored
comments default to `n/a`. A target session reply anchored to the same block, or
a fallback ticket state change by that session, marks matching dispatch rows as
`addressed` and recomputes the source comment state.

Wave 2 adds the dashboard UI and REST wrappers over the same service:

- `POST /api/comments/:id/dispatch` dispatches one comment as a mini-brief to the
  spec's assigned session, or to an explicit `session_id` when the spec is
  unassigned.
- `POST /api/tickets/:id/comments/batch-dispatch` dispatches every
  `undispatched` comment on a spec in one brief with one shared `batch_id`.

The spec ticket drawer shows an `undispatched: N` badge, dispatch-state chips on
comment cards for non-`n/a` states, and spec-only composer actions: plain Save,
Save & dispatch, and Save & batch-dispatch. Plain Save never enqueues dispatch
rows; the dispatch actions call the server wrappers, which enqueue through
`comment-dispatch.js`, push via the existing channel bridge, and broadcast
updated comment payloads so chips flip live when replies mark work addressed.

Spec ticket dispatches use a full-context brief builder (`buildSpecBrief`) via
the same `/api/tickets/:id/dispatch` and dispatch-queue paths. Work-item briefs
keep the original concise assignment text; spec briefs include the spec body,
all active comments whose `dispatch_state` is `undispatched` or `dispatched`,
and one-line child work-item summaries with display id, title, state, and wave.
This makes re-dispatching a spec to a fresh session a complete handoff without
transcript archaeology.

The dispatch drainer is wave-aware for queued child tickets. If a queued ticket
has both `parent_id` and `wave`, it only delivers when its wave equals the
minimum open sibling wave under the same parent (`state NOT IN ('done',
'archived')`). Higher-wave rows remain pending, are logged once as wave-held,
emit a queue update signal, and are skipped before offline-expiry logic so they
do not expire as unreachable while an earlier wave is still open. Non-wave rows
behind a held row can still deliver normally.

Spec finalisation uses `POST /api/tickets/:id/validate-finalisation`, which is
spec-kind only and returns `{result:'pass'|'concerns'|'fail', notes:[]}`. The
lean readiness heuristic checks `## 2. Behaviour` H3 headings / major bullets
against child work item title/body text, and checks `## 5. Open questions`
entries for an explicit answered/decision/deferred marker. The spec drawer shows
a Finalise button only for spec tickets in `in_progress`; pass moves the spec to
`review`, while concerns/failures post a `risk` comment and leave state unchanged.

## Phase Machine And Event Bus

Tracker schema version 10 adds `tickets.phase`; version 11 adds hook-ingest UUID
idempotency; version 12 adds dispatch-queue workspace fields. `dashboard/server/phase-machine.js` is the workflow source of truth.
The DB layer derives board `state` from phase and rejects illegal transitions or
missing artifacts such as closing briefs, manager dispatch evidence, verification
reports, child waves, and spec close requirements.

Tracker mutations emit bus events on `ticket/<display_id>`. Child ticket events
mirror to `spec/<parent-display-id>/tree`, which is the manager subscription
surface for via-manager verification. Hook ingest writes lifecycle/activity/custom
events through `/api/bus/ingest`; subscriptions are managed through
`/api/bus/subscribe`, `/api/bus/unsubscribe`, and `/api/bus/subscriptions`.

The project team API returns `assists.suggested_manager` and
`assists.suggested_explorer`, both chosen from live same-project role sessions by
least in-progress work then pending queue. The create-ticket drawer uses the same
manager-default intent by preselecting a live manager in the Assignee/dispatch
dropdown when the user has not chosen another target. These are defaults and
suggestions, never gates; explicit selections always win.

## Tracker Waves

Tracker schema version 8 adds nullable `tickets.wave` for spec fan-out ordering.
`NULL` means the ticket is not wave-managed; otherwise the value must be a
positive integer. `createTicket` and `updateTicket` validate this invariant, and
REST/MCP ticket create/update pass the field through so planners can assign
dependency waves while creating child work items. The v8 migration backfills
GOL-158 children from `[W1]`, `[W2]`, and `[W3]` title prefixes.
