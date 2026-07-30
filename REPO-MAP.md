# REPO-MAP.md
> Last verified: 2026-07-30 @ e27857e — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source. `instructions/AGENTS.md` § Roles is the single source of role
  ownership; role cards and role skills point at it, never restate it.
- `plugin/` — generated CC render; never hand-edit.
- `.claude/skills/` — repo-only skills (not shipped). `substrate-doctrine` is the must-load before
  editing instructions, roles, or skills.
- `cli/` — `golem` entry point. `lib/` — runtime, role, compiler, managed-harness helpers.
- `dashboard/server/` — Fastify API and tracker owner. `dashboard/web/` → `dashboard/dist/`.
- `mcp/channel/` — channel server. `shims/{opencode,codex}/` — map harness events onto hooks.
- `test/` — journey tests.

## Key modules & entry points
### `dashboard/server/` — `index.js`, `tracker-db.js`, `phase-machine.js`, `comment-dispatch.js`
- Agents use HTTP/MCP, never direct DB writes. Phase is source of truth; `state` derives from it.
- `planning → planned` needs children **and** waves — a single child still needs `wave: 1`.
- Dispatch is durable-first, rolled back to `undispatched` on an undelivered push. The reaper
  suspends subscriptions for sessions absent from the roster — only a graceful `SessionEnd` did that.
### `lib/session-role.js`
- `BUILTIN_ROLES` is the only place role names are hardcoded. `ROLE_MIGRATIONS` retires a name by
  mapping it forward; the registry self-prunes on the next `readRoleRegistry()`.
### `substrate/hooks/tracker-context.sh`
- Builds the SessionStart payload: role card, roster, LSP, recently-closed pointers, last 40 commits.
  All derived, so it cannot go stale; fail-open. Same payload on demand via the `project_context`
  MCP tool, which shells out here rather than reimplementing it.
- Its node block sits inside a command substitution: a bare dollar-paren pair or a lone apostrophe
  in a JS comment breaks the script, with an EOF error pointing at the last line.

## Data flow
Hooks/shims write `~/.golem/` registries; the dashboard owns routes. Native vs dispatchable rows
separate presence from readiness.

## Constraints & gotchas
- Root instructions render as a marked block (`<!-- golem:instructions:begin -->`) into each
  harness's global file. Text outside the markers is the human's. `pi` has no instruction surface.
- Claude runs cached render bytes: sync **and** version bump **and** `/reload-plugins`. The render
  updating is not the installed plugin updating.
- Role cards render for cc, codex, opencode. Agents render for cc and opencode only — codex ships
  none despite `capabilities.json` advertising `subagents: true`.
- opencode is bound to this checkout; its `plugin[]` names the shim by absolute path.
- Bare Codex is pull-only; `golem codex` is private. Raw role/interrupt/halt stay gated.
- Passport cards cap at 520px; never use `1fr` tracks.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill / plugin / instructions | `substrate/`, `lib/compiler/` | `golem sync --target cc --out ./plugin --check` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | `npm run dashboard:build` |
| Sessions / hooks | `substrate/hooks/`, shims | fresh session |
| Cross-harness delivery | supervisor, `mcp/channel/`, OC shim | `node test/cross-harness-matrix.test.mjs` |
