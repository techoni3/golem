# REPO-MAP.md
> Last verified: 2026-07-10 @ 44bd061 — maintained via golem:docs-maintenance.
> Includes current working-tree behavior not yet represented by that commit.

## Directory structure
- `substrate/` — plugin source of truth.
- `plugin/` — generated CC render; never hand-edit.
- `cli/` — thin `golem` command entry point.
- `lib/` — runtime, role, compiler, lint, LSP helpers.
- `dashboard/server/` — Fastify API and `tracker.db` owner.
- `dashboard/web/` — no-bundler React globals.
- `mcp/channel/` — per-session HTTP/MCP channel.
- `shims/opencode/` — maps events into hook/session registries.
- `test/` — journey tests for CLI/compiler enforcement paths.
- `golem-projects/` — repos.
- `.worktrees/` — gitignored; explicit dispatches only.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; envelope health is read-only and fact changes rebroadcast.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` derives from it.
- Schema v10 phases through v15 cursors.
- Assists suggest; never dispatch.
### `dashboard/server/native-sessions.js`
- Merges hook-written `sessions.json` with harness registries.
- Hooks/shims own registration; dashboard may materialize bus status into existing rows.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, and contextualizes; prompts add passive deltas.
### `substrate/instructions/`
- Managed global AGENTS blocks preserve user text.
### `substrate/skills/`
- Role SOPs are the single source of truth for each role.
### `substrate/roles/`
- Shallow role cards injected at SessionStart.
### `mcp/channel/index.js`
- Exposes briefs, roles, replies, consults, gates, and tracker tools.

## Data flow
Hooks/shims write `~/.golem/`; dashboard owns `tracker.db`. Envelope health derives from facts. Passive slots land on real turns or successful envelopes; subscription digests are quiet by default.

Visual deep dive: [session architecture](docs/session-architecture.html). Separate OpenCode/Claude Code startup, hooks, delivery, envelopes, and closing-brief flows.

## Constraints & gotchas
- Claude installs from `~/.golem/renders/cc-plugin` but runs cached plugin bytes; sync + update + `/reload-plugins` after edits.
- Dashboard `.jsx` files are globals; duplicates shadow by load order.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Worktree builders self-check; manager/planner reconciles.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill/plugin | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | smoke/check scripts |
| Sessions | `substrate/hooks/`, shims | fresh session |
| Instructions | `substrate/instructions/`, `lib/compiler/` | temp-HOME sync smoke |
