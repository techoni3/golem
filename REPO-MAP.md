# REPO-MAP.md
> Last verified: 2026-07-15 @ b1b4a31 — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source of truth.
- `plugin/` — generated CC render; never hand-edit.
- `cli/` — thin `golem` command entry point.
- `lib/` — runtime, role, compiler, lint, LSP, and managed-harness helpers.
- `dashboard/server/` — Fastify API and `tracker.db` owner.
- `dashboard/web/` → `dashboard/dist/` — pinned React production artifact.
- `mcp/channel/` — per-session HTTP/MCP channel.
- `shims/opencode/` — maps events into hook/session registries.
- `test/` — journey tests.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; envelope health is read-only and fact changes rebroadcast.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` derives from it; assists suggest but never dispatch.
### `dashboard/server/native-sessions.js`
- Merges native registries with facts; hooks/shims register, while Codex owns its headless/TUI thread name/status map and `session-facts.js` owns freshness/leases. A healthy managed Codex lease collapses its duplicate raw hook row.
### `lib/codex-supervisor.js` + `lib/codex-tui-bridge.js` + `lib/codex-app-server-contract.js`
- Pinned stdio App Server owner; its private one-TUI Unix-WebSocket bridge preserves native approvals while typed delivery targets only an idle canonical thread.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, and contextualizes; prompts add passive deltas.
### `mcp/channel/index.js`
- Exposes briefs, roles, replies, consults, gates, and tracker tools.

## Data flow
Hooks/shims write `~/.golem/`; dashboard owns envelopes; Codex owns the lease plus envelope→turn/approval map. Its private TUI socket has one client; false-ready is unreachable; CC/OC raw channels remain.

## Constraints & gotchas
- Claude runs cached render bytes; sync + update + `/reload-plugins` after edits.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Ordinary/arbitrary remote Codex TUIs are Tier B pull-only; `golem codex` is the one private managed TUI bridge and raw role/interrupt/halt remain gated.

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
