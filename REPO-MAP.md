# REPO-MAP.md
> Last verified: 2026-07-16 @ cb3c409 — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source of truth; design labs are isolated until chosen.
- `plugin/` — generated CC render; never hand-edit.
- `cli/` — thin `golem` command entry point.
- `lib/` — runtime, role, compiler, and managed-harness helpers.
- `dashboard/server/` — Fastify API and `tracker.db` owner.
- `dashboard/web/` → `dashboard/dist/` — pinned React production artifact.
- `mcp/channel/` — per-session HTTP/MCP channel.
- `shims/opencode/` — maps events into hook/session registries.
- `test/` — journey tests.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; project names resolve only when unique; fact changes rebroadcast.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` derives from it; assists suggest but never dispatch.
### `dashboard/server/native-sessions.js`
- Merges registries with facts; Codex owns managed thread name/status/model while `session-facts.js` owns freshness/leases. A healthy lease collapses its raw hook duplicate.
### `lib/codex-supervisor.js` + `lib/codex-tui-bridge.js` + `lib/codex-app-server-contract.js`
- Pinned stdio App Server owner; its private one-TUI bridge preserves native approvals while typed delivery targets only an idle canonical thread.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, and contextualizes; prompts add passive deltas.
### `mcp/channel/index.js`
- Exposes briefs, roles, replies, consults, gates, and tracker tools; CC readiness requires initialized, eligible Channels.

## Data flow
Hooks/shims write `~/.golem/`; dashboard owns envelopes and routes only readiness-qualified endpoints. Managed Codex uses durable typed turns; CC/OC retain `/role`.

## Constraints & gotchas
- Claude runs cached render bytes; sync + update + `/reload-plugins` after edits.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Ordinary remote Codex TUIs are Tier B pull-only; `golem codex` is the private managed bridge. Raw role/interrupt/halt stay gated.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill/plugin | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | `npm run dashboard:build`, isolated browser journey |
| Sessions | `substrate/hooks/`, shims | fresh session |
| Cross-harness delivery | supervisor, `mcp/channel/`, dashboard, OC shim | `node test/cross-harness-matrix.test.mjs` |
| Managed Codex controls | supervisor, tracker envelopes, dashboard | `node test/codex-control-plane.test.mjs` |
| Managed Codex TUI | supervisor, `codex-tui-bridge.js`, CLI | `node test/codex-tui-bridge.test.mjs` |
| Instructions | `substrate/instructions/`, `lib/compiler/` | temp-HOME sync smoke |
