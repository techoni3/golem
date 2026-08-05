# REPO-MAP.md
> Last verified: 2026-08-05 @ 5276e81 — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source; `plugin/` is its generated CC render, never hand-edited. Roles
  have one source: `instructions/AGENTS.md`; cards and skills point to it.
- `.claude/skills/` — repo-only doctrine for instructions, roles, and skills.
- `cli/` `lib/` — entry point; runtime, role, compiler, managed-harness helpers.
- `dashboard/server/` — Fastify API and tracker owner. `dashboard/web/` → `dashboard/dist/`.
- `mcp/channel/` — channel server. `shims/{opencode,codex}/` — harness events onto hooks.
- `test/` — journey tests.

## Key modules
### `dashboard/server/`
- Agents use HTTP/MCP, never direct DB writes. Phase is truth; `state` derives from it; planned
  work needs children and waves. Typed accepted non-2xx is durable work; mismatches remain retryable.
- Ticket rows and retries share one typed lifecycle and per-session FIFO. Acceptance retains exact
  owners; only an authenticated terminal callback settles queue/passive/comment state.
### `lib/session-role.js`
- `BUILTIN_ROLES` is the hardcoded role source; migrations map a retired name forward.
### `lib/typed-worker-endpoint.js`, `lib/typed-delivery-tombstones.js`
- Shared protocol validates authenticated, versioned envelopes; rich supervisor history is never the
  replay ledger. Terminal tracker retirement prunes lifecycle detail only after a non-evicting
  compact rejection is durable; wire expiry is renewable. Retries reserve before transport,
  arbitrate with ticket rows, and typed capability survives lease rebind; legacy
  Pi requires an explicit Tier-B fact.
### `substrate/hooks/tracker-context.sh`
- Builds bounded, derived SessionStart/project-context payloads. Its Node block is in command
  substitution: a bare dollar-paren pair or apostrophe in a JS comment breaks the shell.

## Data flow
Hooks/shims write `~/.golem/` registries; dashboard owns routes; native rows mean presence,
dispatchable rows mean readiness.

## Gotchas
- Root instructions render as marked blocks; text outside is human-owned. `pi` has none.
- Claude runs cached render bytes: sync + version bump + `/reload-plugins`; render is not install.
- Role cards render for cc, codex, opencode (not pi); agents only for cc and opencode — codex
  ships none despite `capabilities.json` claiming `subagents: true`.
- opencode is bound to this checkout; its `plugin[]` names the shim by absolute path.
- Bare Codex is pull-only; `golem codex` is private; raw role/interrupt/halt stay gated.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill / plugin / instructions | `substrate/`, `lib/compiler/` | `golem sync --target cc --out ./plugin --check` |
| Sessions / hooks | `substrate/hooks/`, shims | fresh session |
| Cross-harness delivery | supervisor, `mcp/channel/`, OC shim | `node test/cross-harness-matrix.test.mjs` |
