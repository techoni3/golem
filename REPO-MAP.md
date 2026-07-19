# REPO-MAP.md
> Last verified: 2026-07-18 @ 2dfcdf7 — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source; design labs stay isolated.
- `plugin/` — generated CC render; never hand-edit.
- `cli/` — `golem` command entry point.
- `lib/` — runtime, role, compiler, and managed-harness helpers.
- `dashboard/server/` — Fastify API and tracker owner.
- `dashboard/web/` → `dashboard/dist/` — React production artifact.
- `mcp/channel/` — channel server.
- `shims/opencode/` — maps events into registries.
- `test/` — journey tests.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; uniquely resolves project names; agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` derives from it; assists suggest but never dispatch.
### `dashboard/server/native-sessions.js`
- Merges registries with facts; Codex owns thread name/status/model and `session-facts.js` owns freshness/leases. A healthy lease collapses its raw hook duplicate.
### `lib/codex-supervisor.js` + `lib/codex-tui-bridge.js`
- Pinned App Server owner; the private TUI bridge preserves native approvals and targets only idle canonical threads.
### `shims/codex/hook.mjs` + `lib/session-registry.js`
- Codex SessionStart registers project/session; every documented hook records a fact.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, and contextualizes; prompts add passive deltas.

## Data flow
Hooks/shims write registries in `~/.golem/`; project detail reads only that roster. Dashboard owns envelopes/qualified routes. Managed Codex uses typed turns; CC/OC retain `/role`. Native and dispatchable rows separate channel presence from delivery readiness.

## Constraints & gotchas
- Claude runs cached render bytes; sync + update + `/reload-plugins` after edits.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Ordinary Codex TUIs are Tier B pull-only; `golem codex` is private. Raw role/interrupt/halt stay gated.
- Agents and project sessions share capped 520px H1 passport cards; never make their grid tracks `1fr`.

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
