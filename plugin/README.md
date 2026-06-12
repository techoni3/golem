# golem (Claude Code plugin, v4)

A thin orchestration layer over native Claude Code. Zero per-project scaffold —
`cd any-repo && claude` and the mechanics ride along: central journaling, an
auto-populated project registry, ntfy push notifications, three opus
sub-agents, and the golem channel MCP.

## What it does

- **SessionStart** → registers the project in `~/.config/golem/projects.json`
  (auto entry; never overwrites a manual one), records the session in
  `sessions.json`, and sets the session title to the repo's directory name.
- **Lifecycle + tool events** → a single line per event in a central journal at
  `~/.config/golem/journals/<project_id>/hook.jsonl`, carrying `project_id` and
  `project_path` so readers never re-derive. (Legacy guard: a v3-wired repo that
  still has `.claude/hooks/journal-event.sh` keeps owning its own journal — the
  plugin hook exits silently there.)
- **Notification** → pushes the message to your ntfy topic so you get a phone
  ping on needs-input / idle. No-op when no topic is configured.
- **Agents** → `worker`, `reviewer`, `researcher` (all `model: opus`).
- **Channel MCP** (`golem`) → `ack` / `respond` tools + an SSE `/events` stream
  the dashboard subscribes to.

## Install

The repo root doubles as a local marketplace.

```bash
# from anywhere; point at the repo root (the dir holding .claude-plugin/)
claude plugin marketplace add /Users/laveesingh/Documents/software/experiments/golem
claude plugin install golem@golem-local --scope user
```

Or interactively inside a session: `/plugin marketplace add <repo-root>` then
`/plugin install golem@golem-local`.

Fresh clone only: `node_modules/` is gitignored, so run
`npm install --prefix plugin/mcp/channel` once before installing — the plugin
cache copies the channel server's deps from disk.

Verify: `claude plugin list` (look for `golem` enabled) and
`claude plugin validate <repo-root>/plugin`.

Update after edits: updates are VERSION-GATED — bump `version` in
`.claude-plugin/plugin.json` first, then `claude plugin update golem@golem-local`
(the cache won't recopy at an unchanged version). New sessions pick it up;
running sessions need `/reload-plugins`.

## Project identity

`project_id = <dirname-slug>-<first 6 hex of sha256(absolute project path)>`,
derivable by any script from the project root path alone. Project root is
resolved by walking up from the session cwd to the nearest `.git` or `CLAUDE.md`
(fallback `$CLAUDE_PROJECT_DIR`).

## Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `GOLEM_NTFY_TOPIC` | ntfy.sh topic for push notifications | falls back to `~/.config/golem/ntfy_topic` file; unset → notifications are a silent no-op |
| `XDG_CONFIG_HOME` | base for the `golem/` config/registry dir | `~/.config` |
| `GOLEM_CHANNEL_PORT` | channel HTTP port (`0` = random free port) | `7421` |
| `GOLEM_CEO_SESSION_ID` | session id the channel registers under for dashboard routing | `CLAUDE_CODE_SESSION_ID` fallback |
| `GOLEM_CHANNEL_ALLOWED_SENDERS` | comma list of accepted `X-Sender` values | `dashboard,cli,curl` |

`CLAUDE_PLUGIN_ROOT` is provided by Claude Code and resolves hook/MCP paths.

## File map

```
plugin/
  .claude-plugin/plugin.json   # manifest: name "golem", version 4.0.0
  hooks/hooks.json             # event wiring (refs scripts via ${CLAUDE_PLUGIN_ROOT})
  hooks/session-register.sh    # SessionStart: registry upsert + session title
  hooks/journal-route.sh       # all events → central journal (+ legacy guard)
  hooks/notify.sh              # Notification → ntfy push (backgrounded)
  agents/worker.md             # implements one PLAN.md item, reports evidence
  agents/reviewer.md           # fresh-context diff review, findings only
  agents/researcher.md         # read-only investigation, structured summary
  mcp/channel/index.js         # golem channel MCP server (copied from substrate)
  mcp/channel/node_modules/    # bundled deps (@modelcontextprotocol/sdk)
  .mcp.json                    # wires the channel MCP via ${CLAUDE_PLUGIN_ROOT}
```

Central state lives under `~/.config/golem/` (`projects.json`, `sessions.json`,
`channels.json`, `journals/<project_id>/hook.jsonl`, optional `ntfy_topic`) —
zero repo footprint.

## Notes & caveats

- **MCP path variable:** `${CLAUDE_PLUGIN_ROOT}` is documented as supported in
  in-plugin `.mcp.json` (Plugins reference → Environment variables), so the
  channel is wired rather than skipped. `NODE_PATH` points at the bundled
  `node_modules` so the SDK resolves from the plugin cache copy.
- **Session pid:** the SessionStart hook payload carries no session pid, and
  `$PPID` in a hook is the immediate shell, not the claude session. `sessions.json`
  is keyed by `session_id`; `hook_ppid` is recorded best-effort only.
- **Headless mode:** in `claude -p`, SessionStart fires (registry + journal get
  written), but interactive UI affordances (session title, `/plugin`) don't apply.
