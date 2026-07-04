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
