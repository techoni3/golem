# golem (Claude Code plugin, v4)

A thin orchestration layer over native Claude Code. Zero per-project scaffold —
`cd any-repo && claude` and the mechanics ride along: central journaling, an
auto-populated project registry, ntfy push notifications, three opus
sub-agents, and the golem channel MCP.

## What it does

- **SessionStart** → registers the project in `~/.config/golem/projects.json`
  (auto entry; never overwrites a manual one) and records the session in
  `sessions.json`. It does **not** auto-name the session: `/rename` is the single
  source of the name (auto-titling clobbered it on every `/resume`).
- **Lifecycle + tool events** → a single line per event in a central journal at
  `~/.config/golem/journals/<project_id>/hook.jsonl`, carrying `project_id` and
  `project_path` so readers never re-derive. (Legacy guard: a v3-wired repo that
  still has `.claude/hooks/journal-event.sh` keeps owning its own journal — the
  plugin hook exits silently there.)
- **Notification** → pushes the message to your ntfy topic so you get a phone
  ping on needs-input / idle. No-op when no topic is configured.
- **Agents** → `worker`, `reviewer`, `researcher` (all `model: opus`).
- **Channel MCP** (`golem`) → `ack` / `respond` tools + an SSE `/events` stream
  the dashboard subscribes to, **plus the tracker tools** and the
  **session-to-session consult tools** (see below).
- **Consult tools** (on the same `golem` MCP) → `consult_request`, `consult_reply`,
  `consult_status`. One live session asks ANOTHER for a fresh pair of eyes on a
  hard problem (a second opinion, not delegation) over the channel transport —
  fully async, the asker never blocks. See the `golem:get-consult` /
  `golem:provide-consult` skills and the section below.
- **Tracker tools** (on the same `golem` MCP) → live sessions read/write the
  cross-project ticket tracker — the source of truth for work, **replacing
  PLAN.md**. These are thin HTTP clients of the dashboard's REST API (the
  dashboard owns the SQLite DB; single writer), so **the dashboard must be
  running** (`golem dashboard`) for them to work. Tools: `ticket_list`,
  `ticket_get`, `ticket_create`, `ticket_update`, `ticket_comment`,
  `ticket_dispatch`, `stream_create`, `stream_list`, `sessions_dispatchable`.
  Identity is injected — `ticket_list mine:true` finds your work, and `project`
  defaults to your current project. See the `golem:tracker` skill.

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

To activate the v4.1 tracker tools in an already-running session:

```bash
claude plugin update golem@golem-local   # recopies the v4.1.0 plugin into the cache
```

then `/reload-plugins` inside the session. New sessions get them automatically.
The tracker tools target the live dashboard, so make sure `golem dashboard` is
running (they read its URL from `~/.config/golem/dashboard.json`).

### Receiving dispatched tickets (channel consumer)

A plain `claude` session loads the tracker **tools** but is NOT a channel
**consumer** — so when you "Dispatch" a ticket to it from the dashboard, the
pushed brief is delivered to the session's channel server (HTTP 202) but
[silently dropped](https://code.claude.com/docs/en/channels-reference#notification-format)
by Claude Code. The session can still *pull* its work (`ticket_list mine:true`),
but to have dispatches *push* in, launch it as a channel consumer:

```bash
claude --dangerously-load-development-channels plugin:golem@golem-local
```

(There's a `golemc` shell alias for this.) The first run per project shows a
one-time consent prompt. `--dangerously-load-development-channels` is required
during the channels research preview because a self-hosted marketplace plugin
isn't on Anthropic's allowlist; on Team/Enterprise an admin can instead add
`{ "marketplace": "golem-local", "plugin": "golem" }` to `allowedChannelPlugins`
in managed settings and use `--channels plugin:golem@golem-local`. Either way a
per-session launch flag is required — there is no settings.json toggle that
auto-consumes channels.

## Session-to-session consult

A live session can ask **another** live session for a *fresh pair of eyes* on a
hard problem — a second opinion, not delegation, and not a subagent (the peer
keeps its own context, often on a different backend: claude or an ollama model
like glm-5.2). It rides the same channel transport as dispatch:

1. The asker calls **`consult_request({ to, question, context })`** — `to` is the
   peer's `/rename` name (resolved via `claude agents --json` ∩ live channels) or
   a `session_id`. The tool POSTs to the peer's channel **`/consult`** route and
   returns a `consult_id` immediately. **The asker never blocks.**
2. The consult arrives at the peer as `<channel kind="consult" consult_id=…
   from_session=…>`. Its `golem:provide-consult` skill investigates independently
   (code, web), forms a proposal, and calls **`consult_reply({ to_session,
   consult_id, text })`**.
3. The reply POSTs to the asker's channel **`/consult/reply`** route and pushes in
   as `<channel kind="consult_reply" consult_id=…>` — like a subagent result
   landing. The asker (`golem:get-consult`) weighs it as advice and keeps the
   final say. `consult_status` nudges a pending consult without blocking.

Both routes are gated by `X-Sender: consult` (in the default allow-list).
Requirements:

- **v4.3.0+ on both ends** — the `/consult` routes and `consult_*` tools ship in
  this version. A running session needs `claude plugin update golem@golem-local`
  then `/reload-plugins` to pick them up; new sessions get them automatically.
- **Both ends must be channel _consumers_.** A plain `claude` session can *send* a
  consult (it has the tools) but will **not receive** the pushed `consult` request
  or `consult_reply` — Claude Code silently drops channel notifications unless the
  session was launched as a consumer (`claude --dangerously-load-development-channels
  plugin:golem@golem-local`, i.e. the `golemc` alias). So the consultant must be a
  consumer to get the request, **and the asker must be a consumer to get the reply.**

Consult traffic also surfaces in the dashboard chat (a short audit marker on each
session's lane).

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
| `GOLEM_CEO_SESSION_ID` | explicit override for the id the channel registers under | unset → derived **logical** id (see below) |
| `GOLEM_CHANNEL_ALLOWED_SENDERS` | comma list of accepted `X-Sender` values | `dashboard,cli,curl,consult` |

`CLAUDE_PLUGIN_ROOT` is provided by Claude Code and resolves hook/MCP paths.

## File map

```
plugin/
  .claude-plugin/plugin.json   # manifest: name "golem", version 4.1.0
  hooks/hooks.json             # event wiring (refs scripts via ${CLAUDE_PLUGIN_ROOT})
  hooks/session-register.sh    # SessionStart: registry upsert + session title
  hooks/journal-route.sh       # all events → central journal (+ legacy guard)
  hooks/notify.sh              # Notification → ntfy push (backgrounded)
  agents/worker.md             # implements one tracker ticket, reports evidence
  agents/reviewer.md           # fresh-context diff review, findings only
  agents/researcher.md         # read-only investigation, structured summary
  skills/tracker/SKILL.md      # golem:tracker — tracker is the source of truth for work
  skills/get-consult/SKILL.md  # golem:get-consult — ask a peer session for a fresh pair of eyes
  skills/provide-consult/SKILL.md # golem:provide-consult — answer a peer's consult
  mcp/channel/index.js         # golem channel MCP — ack/respond + tracker + consult tools, /consult routes
  mcp/channel/tracker-client.js# HTTP client of the dashboard tracker REST API
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
