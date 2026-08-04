# REPO-MAP.md
> Last verified: 2026-08-04 @ 903b01a — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source; `plugin/` is its generated CC render, never hand-edited. Roles
  have one source: `instructions/AGENTS.md`; cards and skills point to it.
- `.claude/skills/` — repo-only doctrine for instructions, roles, and skills.
- `cli/` `lib/` — entry point; runtime, role, compiler, managed-harness helpers.
- `dashboard/server/` — Fastify API and tracker owner. `dashboard/web/` → `dashboard/dist/`.
- `mcp/channel/` — channel server. `shims/{opencode,codex}/` — harness events onto hooks.
- `test/` — journey tests.

## Key modules
### `dashboard/server/` — `index.js`, `tracker-db.js`, `typed-delivery.js`, `phase-machine.js`, `comment-dispatch.js`
- Agents use HTTP/MCP, never direct DB writes. Phase is truth; `state` derives from it; planned
  work needs children and waves. Dispatch is durable-first. Correlated accepted non-2xx typed
  replies are durable work; mismatches remain retryable.
### `lib/session-role.js`
- `BUILTIN_ROLES` is the hardcoded role source; migrations map a retired name forward.
### `lib/typed-worker-endpoint.js`, `lib/typed-delivery-tombstones.js`
- Shared native-worker protocol validates authenticated, versioned envelopes. Bounded supervisor
  history is not the replay ledger: compact SQLite tombstones preserve immutable first acceptance
  until explicit tracker-terminal retirement; wire expiry is renewable. An ambiguous immediate
  typed push queues that original envelope for duplicate-safe shared retry, while typed capability
  stays sticky across lease reloads. Legacy pre-upgrade pending identities atomically reissue on
  the shared queue after the replay fence.
### `substrate/hooks/tracker-context.sh`
- Builds bounded, derived SessionStart/project-context payloads. Its Node block is in command
  substitution: a bare dollar-paren pair or apostrophe in a JS comment breaks the shell.

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
