# REPO-MAP.md
> Last verified: 2026-07-30 @ 6fa1d90 — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source; `plugin/` is its generated CC render, never hand-edited.
  `instructions/AGENTS.md` § Roles is the single source of role ownership; cards and skills point
  at it, never restate it.
- `.claude/skills/` — repo-only, not shipped; `substrate-doctrine` is a must-load before editing
  instructions, roles, or skills.
- `cli/` `lib/` — entry point; runtime, role, compiler, managed-harness helpers.
- `dashboard/server/` — Fastify API and tracker owner. `dashboard/web/` → `dashboard/dist/`.
- `mcp/channel/` — channel server. `shims/{opencode,codex}/` — harness events onto hooks.
- `test/` — journey tests.

## Key modules
### `dashboard/server/` — `index.js`, `tracker-db.js`, `phase-machine.js`, `comment-dispatch.js`
- Agents use HTTP/MCP, never direct DB writes. Phase is truth; `state` derives from it.
- `planning → planned` needs children **and** waves — a single child still needs `wave: 1`.
- Dispatch is durable-first, rolled back to `undispatched` on an undelivered push. The reaper
  suspends subscriptions for sessions off the roster.
### `lib/session-role.js`
- `BUILTIN_ROLES` is the only place role names are hardcoded. `ROLE_MIGRATIONS` retires a name by
  mapping it forward; the registry self-prunes on next `readRoleRegistry()`.
### `substrate/hooks/tracker-context.sh`
- Builds the SessionStart payload — role card, roster, LSP, recently-closed pointers, recent
  commits. All derived; fail-open per field; per-field and aggregate caps. Also via `project_context`.
- Its node block sits inside a command substitution: a bare dollar-paren pair or a lone apostrophe
  in a JS comment breaks it, with an EOF error pointing at the last line.

## Data flow
Hooks/shims write `~/.golem/` registries; the dashboard owns routes. Native rows mean presence,
dispatchable rows mean readiness.

## Gotchas
- Root instructions render as a marked block (`golem:instructions:begin`) into each harness's
  global file; text outside the markers is the human's. `pi` has none.
- Claude runs cached render bytes: sync **and** version bump **and** `/reload-plugins`. The render
  updating is not the plugin updating.
- Role cards render for cc, codex, opencode (not pi); agents only for cc and opencode — codex
  ships none despite `capabilities.json` claiming `subagents: true`.
- opencode is bound to this checkout; its `plugin[]` names the shim by absolute path.
- Bare Codex is pull-only; `golem codex` is private. Raw role/interrupt/halt stay gated.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill / plugin / instructions | `substrate/`, `lib/compiler/` | `golem sync --target cc --out ./plugin --check` |
| Sessions / hooks | `substrate/hooks/`, shims | fresh session |
| Cross-harness delivery | supervisor, `mcp/channel/`, OC shim | `node test/cross-harness-matrix.test.mjs` |
