# Golem

Golem is a local-first orchestration layer for agentic coding harnesses. It
combines a substrate compiler, native harness integrations, a SQLite-backed
tracker and dashboard, and a thin `golem` CLI. It adds repeatable roles,
evidence-based work phases, session discovery, dispatch, lifecycle journals,
and cross-session coordination without replacing the coding harness itself.

The npm package is named `@laveesingh/golem`. The plugin rendered from that
package is named `golem`. These names are related but are not interchangeable in
install commands.

## Contents

- [What Golem does](#what-golem-does)
- [What Golem does not do](#what-golem-does-not-do)
- [Harness support](#harness-support)
- [Prerequisites](#prerequisites)
- [Install the CLI](#install-the-cli)
- [Quick start](#quick-start)
- [Harness setup](#harness-setup)
- [Dashboard](#dashboard)
- [CLI reference](#cli-reference)
- [Core concepts](#core-concepts)
- [Architecture and data flow](#architecture-and-data-flow)
- [State and configuration](#state-and-configuration)
- [Privacy, security, and network boundaries](#privacy-security-and-network-boundaries)
- [Development and release checks](#development-and-release-checks)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing, support, security, and license](#contributing-support-security-and-license)

## What Golem does

- Renders one canonical `substrate/` into the artifact set each harness adapter
  actually supports, rather than pretending every harness has the same surface.
- Provides manager, planner, builder, and explorer operating roles. Tier A
  renders also include focused worker, reviewer, and researcher subagents.
- Tracks tickets, comments, dependencies, phases, dispatches, and quiet event
  subscriptions in a dashboard-owned SQLite database.
- Discovers projects and live sessions, records canonical session facts, and
  routes addressed work according to each harness's real delivery capability.
- Journals lifecycle and tool events under a central local state directory with
  no required per-project journal footprint.
- Supports gates, asynchronous peer consultation, passive ticket updates, and
  optional ntfy notifications.
- Makes completion evidence explicit: builders hand off tested work, and a
  separate verification phase can accept or reject it.
- Detects render drift and refuses to overwrite tampered managed output unless
  the user explicitly passes `--force`.

The dashboard must be running for tracker MCP tools and dispatch. Harness hooks
remain fail-open: they write local lifecycle records first and do not block a
coding session when the dashboard is unavailable.

## What Golem does not do

- It does not replace Claude Code, OpenCode, Codex CLI, Pi, their model
  providers, or their authentication and permission systems.
- It is not a hosted service and has no built-in analytics or telemetry.
- It does not claim push delivery where a harness has no verified external
  turn-injection API.
- It does not support Gemini CLI.
- It does not restore removed v3 commands such as `install`, `session`,
  `project`, `dispatch`, or `ack`.
- It does not make generated `plugin/` files authoritative. Maintainers edit
  `substrate/` and render from it.

## Harness support

Support tiers describe shipped and mechanically exercised behavior, not future
intent.

| Harness | Tier | Shipped contract |
| --- | --- | --- |
| Claude Code | Tier A | Rendered plugin with agents, skills, hooks, MCP tools, lifecycle facts, and addressed push for sessions launched as channel consumers. A plain `claude` session can use tracker tools and pull work but does not consume pushed channel notifications. |
| OpenCode | Tier A | Rendered agents, skills, and instructions plus a managed MCP entry and runtime shim. While the OpenCode process and shim bridge are live, addressed work is injected with the OpenCode SDK. |
| Codex CLI | Tier B for an ordinary TUI; Tier A for Golem-managed App Server modes | Rendered skills, documented lifecycle hooks (including observation of native `SubagentStop`), marketplace metadata, and a bundled MCP server. The adapter does not render Golem AGENTS.md or worker/reviewer/researcher definitions. An ordinary `codex` TUI remains explicit pull only and is never reported as pushed. A version-gated headless supervisor and private `golem codex` TUI bridge receive durable ticket/control envelopes only while their bound MCP is active and canonical thread is idle. |
| Pi | Tier B | Portable rendered extension, lifecycle facts, and durable next-input pickup. Queued work is added to the next real user input and acknowledged when agent processing starts. There is no advertised live-idle push. |
| Gemini CLI | Unsupported | No adapter or release contract is shipped. |

Source-checkout evidence and limitations are recorded in the
[Codex support matrix](https://github.com/laveesingh/golem/blob/main/docs/codex.md),
and [Pi adapter spike](https://github.com/laveesingh/golem/blob/main/docs/pi-spike.md).
These `docs/` files are historical repository research, not operational
authority, and are not included in the npm package.

## Prerequisites

- Node.js 20 or newer and npm for the CLI, dashboard, Claude Code, OpenCode,
  and Codex paths.
- Node.js 22.19 or newer for Pi.
- At least one supported harness installed separately.
- Git for a source checkout and normal contribution workflows.
- A local machine where loopback ports can be opened. The dashboard defaults to
  `127.0.0.1:7420`; channel servers default to kernel-assigned loopback ports.

Run `node --version`, `npm --version`, and the selected harness's version
command before setup. `golem doctor` checks the installed Golem environment.

## Install the CLI

### Global package path

Install the package that provides the `golem` executable:

```sh
npm install -g @laveesingh/golem
golem help
```

This command documents the package install path; this README does not assert
that any particular registry publication or GitHub release has occurred.

### Source-checkout path

```sh
git clone https://github.com/laveesingh/golem.git
cd golem
npm ci
npm link
golem help
```

`npm ci` runs the package postinstall, which restores the channel MCP's locked
production dependencies. `npm link` exposes this checkout's `cli/golem.js` as
the global `golem` command. Without linking, run commands from the checkout as
`node cli/golem.js <command>`.

The relocatable MCP artifact is built and pack-verified alongside this current
channel closure. It is a future cutover candidate; rendered `.mcp.json` keeps
starting `mcp/channel/index.js` until the later lifecycle-adapter journey proves
registration, addressed delivery, and uncorrelated reply parity.

## Quick start

1. Install the CLI by one of the paths above.
2. Start the dashboard in one terminal:

   ```sh
   golem dashboard
   ```

3. Open <http://dashboard.golem.localhost:7420>.
4. In another terminal, follow one harness setup below.
5. Start the harness in the repository where you want to work. Session hooks or
   shims register the project and session automatically.
6. Confirm the local services and environment:

   ```sh
   golem status
   golem doctor
   ```

For Claude Code, the shortest complete setup is the four render/install
commands in the next section followed by a channel-consumer launch.

## Harness setup

Resolve the active Golem home once in the shell used for setup. This matches
`lib/golem-home.js`, including fresh installations that still fall back to
`~/.config/golem`:

```sh
GOLEM_DIR="${GOLEM_HOME:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/golem}}"
[ -n "$GOLEM_DIR" ] || { [ -d "$HOME/.golem" ] && GOLEM_DIR="$HOME/.golem" || GOLEM_DIR="$HOME/.config/golem"; }
export GOLEM_DIR
```

The commands below use `$GOLEM_DIR` instead of assuming the migrated path.

### Claude Code: Tier A

#### Install

Render the workspace plugin and its local marketplace, then install the
rendered plugin:

```sh
golem sync --target cc
golem sync --target cc-marketplace
claude plugin marketplace add "$GOLEM_DIR/renders/cc-marketplace"
claude plugin install golem@golem-workspace --scope user
```

Verify the installation:

```sh
claude plugin list
claude plugin validate "$GOLEM_DIR/renders/cc-plugin"
```

The package name is `@laveesingh/golem`, the rendered plugin is `golem`, and the
generated marketplace is `golem-workspace`. The plugin runs from the render and
Claude Code's plugin cache, not directly from `substrate/`.

#### Launch a push-capable session

To receive addressed dispatches and consults, launch Claude Code as a channel
consumer:

```sh
claude --dangerously-load-development-channels plugin:golem@golem-workspace
```

The repository documentation calls a local shell alias for that command
`golemc`, so installations that define the alias can launch with:

```sh
golemc
```

`golemc` is not a `golem` CLI subcommand. The full `claude` command above is the
portable form. During the channels research preview, the first run per project
shows a consent prompt. Team and Enterprise administrators can allow
`{ "marketplace": "golem-workspace", "plugin": "golem" }` in managed
`allowedChannelPlugins` and launch with:

```sh
claude --channels plugin:golem@golem-workspace
```

A per-session channel launch flag is still required. A plain `claude` session
has the MCP tools and can pull assigned work, but Claude Code drops pushed
channel notifications for a session that is not a channel consumer.

#### Update and reload

After updating the installed package or source checkout, render the new plugin
bytes and refresh Claude Code's cached copy:

```sh
golem sync --target cc
golem sync --target cc-marketplace
claude plugin update golem@golem-workspace
```

Then run this slash command inside each already-running Claude Code session:

```text
/reload-plugins
```

The plugin version comes from the root `package.json`. For source development,
bump that version before the update; Claude Code will not recopy an unchanged
version. New sessions load the updated plugin without `/reload-plugins`.

### OpenCode: Tier A

OpenCode support is opt-in. In `$GOLEM_DIR/config.json`, enable the harness
while preserving any existing keys:

```json
{
  "harnesses": {
    "opencode": {
      "enabled": true,
      "modelMap": {},
      "testedVersion": null
    }
  }
}
```

Then render and launch OpenCode:

```sh
golem sync --target opencode
opencode
```

If the harness remains disabled, sync exits successfully after reporting that
it skipped the render. When enabled, sync:

- writes agents to OpenCode's fixed global agent directory;
- writes Golem skills below the Golem render directory;
- maintains marked global instructions;
- merges only Golem's `mcp.golem`, `skills.paths`, and plugin entry into
  `opencode.jsonc`; and
- validates the merged config with `opencode debug config` when the binary is
  available, restoring the previous file if validation fails.

The MCP and shim entries use absolute paths into the installed package or source
checkout. The config merge updates `mcp.golem`, but appends the Golem skill and
plugin entries rather than pruning old ones. After moving an installation, edit
`opencode.jsonc`: remove obsolete Golem paths from `skills.paths` and obsolete
Golem `file://` entries from `plugin`, then re-run sync and restart OpenCode.
The shim creates the live loopback bridge used for Tier A addressed delivery.
`golemc` launches Claude Code, not OpenCode.

### Ordinary Codex CLI: Tier B, pull only

Render the Codex marketplace, add it, and install/enable its `golem` plugin:

```sh
golem sync --target codex
codex plugin marketplace add "$GOLEM_DIR/renders/codex"
codex plugin add golem@golem-workspace --json
```

Launch Codex and use `/hooks` to review and trust the non-managed generated
hooks. The adapter records only documented hook inputs and does not parse the
unstable transcript format. Its generated bundle contains rendered skills,
documented hooks, marketplace metadata, and the bundled MCP server. The
`SubagentStop` hook observes native subagent completion; the bundle does not
define Golem's worker, reviewer, or researcher agents and does not render a
Golem AGENTS.md.

Its `SessionStart` hook also resolves the shared project root from the
documented CWD and additively upserts `projects.json` and `sessions.json`.
That makes an ordinary Codex session discoverable as a dashboard project even
when it starts in a nested directory; an existing manual project name and kind
are preserved. Later lifecycle hooks continue to record facts only. This local
best-effort registration does not change Codex's Tier B delivery boundary.

Codex's shipped contract is explicit pull. Use the bundled Golem MCP tools to
list current tickets, optionally scoped by project, then inspect assignments to
find relevant work. The default generated Codex MCP launch does not supply a
caller session identity, so do not use `ticket_list` with `mine: true` by
default; `mine: true` requires a separate identity-aware MCP launch that the
generated Codex plugin does not provide. Ordinary Codex CLI has no documented
out-of-band turn injection or queued next-turn pickup API, and its CLI does not
expose a generic MCP tool-call command. A dashboard dispatch can therefore be
queued for pull but is never reported as pushed or next-turn delivered.

### Managed Codex App Server: Tier A

This foreground mode is a separate, Golem-owned headless harness. It is gated
to the pinned Codex CLI/schema pair and owns exactly one canonical App Server
thread:

```sh
golem codex-supervisor run --session <canonical-id> --cwd <project-path>
```

While its bound MCP is active and the thread is idle, the tracker can deliver
tickets plus notifications, consults, subscription digests, and gate
resolutions as durable typed envelopes. Codex can dispatch to live Codex,
Claude Code, and OpenCode sessions through the normal tracker tools. Role
activation and interrupt/halt are intentionally shown as actionable managed
Codex gates rather than injected into a live turn.

App Server approval is never automatic. An authorized local operator lists the
redacted pending requests, inspects one live request, then makes an explicit
one-off decision:

```sh
golem codex-supervisor approvals --session <canonical-id>
golem codex-supervisor approvals --session <canonical-id> --id <approval-id>
golem codex-supervisor approvals --session <canonical-id> --id <approval-id> --decision approve
```

Stopping or restarting the supervisor fails pending approvals closed. Do not
replay a recovery-pending envelope; create a new explicit dispatch after
reviewing the supervisor record. A Codex version or schema fingerprint change
is a hard stop until the contract is reviewed and the Codex journeys pass.

### Managed Codex TUI: Tier A

For a normal interactive terminal that shares the exact tracker-delivery
thread, run this from the project directory:

```sh
golem codex
```

It creates a canonical session, runs a pinned App Server on stdio, and launches
the normal Codex TUI through one private Unix-socket WebSocket bridge. The TUI
remains the sole App Server client: it owns model, sandbox, approvals, and
normal turns; Golem verifies its bound MCP only after TUI initialization and
injects a durable tracker turn only when that canonical thread is idle. A
dashboard dispatch with `when_idle` stays queued while a human turn is active.
Use `--session <canonical-id>` or `--cwd <path>` for advanced targeting, and
place ordinary Codex arguments after `--`. A stored explicit session resumes
its recorded thread through native `codex resume`; it is never silently
replaced. Do not pass `--remote` or `-C`/`--cd`; Golem reserves the bridge and
canonical working directory. TUI exit, SIGTERM, or App Server loss removes the
lease, App Server, and socket; Ctrl-C belongs to the TUI's active turn.

### Pi: Tier B, next-input pickup

Render the portable extension:

```sh
golem sync --target pi
```

Load it without changing the Pi profile, using the `$GOLEM_DIR` resolved at the
start of this section:

```sh
pi -e "$GOLEM_DIR/renders/pi/golem.ts"
```

The extension uses Pi's canonical `ctx.sessionManager.getSessionId()` identity.
Dashboard dispatch writes durable, session-addressed inbox entries. On the next
real user input, Pi claims queued text and adds it to that input; only the
subsequent observable `agent_start` acknowledges processing. Golem does not
advertise delivery into an already-idle Pi TUI.

### Gemini CLI

Gemini CLI is unsupported. There is no sync target, adapter, or compatibility
claim.

## Dashboard

The dashboard is the tracker database's single writer and serves the REST API,
WebSocket updates, session roster, ticket board, comments, dispatch controls,
and the production web UI.

### Start, restart, and inspect

```sh
golem dashboard
golem status
golem status --json
```

`golem dashboard` runs in the foreground. To stop the recorded running instance
and start a detached replacement:

```sh
golem dashboard:restart
```

For a custom-port instance on the default loopback host, repeat the same `PORT`
so restart derives the correct probe URL and launches the replacement there:

```sh
PORT=7430 golem dashboard:restart
```

Set `GOLEM_DASHBOARD_URL` as well only when the running instance uses a custom
URL or host that cannot be derived from `PORT`.

The canonical local URL is <http://dashboard.golem.localhost:7420>, with
<http://127.0.0.1:7420> as the loopback fallback. `*.localhost` normally
resolves to `127.0.0.1` without a hosts-file change.

The server uses `HOST=127.0.0.1` and `PORT=7420` by default. It does not walk to
a different port when 7420 is occupied. It may replace only the previous Golem
dashboard PID recorded in `dashboard.json`; it refuses to kill an unrelated
listener.

### Public binding warning

```sh
golem dashboard --public
```

`--public` binds `0.0.0.0`. The dashboard has no authentication. Any reachable
client can read local project, session, ticket, chat, and path data, and can
invoke mutation, dispatch, and session-driving APIs. Do not use `--public` on an
untrusted LAN or expose the dashboard to the internet. Prefer the default
loopback bind.

The packaged [`dashboard/server/index.js`](dashboard/server/index.js) is the
current operational source for bind, restart, API, and tracker behavior.

## CLI reference

`golem help` is generated from the typed registry; compatibility commands remain
served by the root entry point while harness resolution uses one parser and
metadata table.

| Command | Purpose |
| --- | --- |
| `golem codex [preset]` | Resolve the managed Codex preset; bare `golem codex` retains the managed TUI compatibility path. |
| `golem opencode [preset]` / `golem claude [preset]` | Resolve canonical harness presets; unqualified adapters fail before spawn. |
| `golem @preset` | Resolve a globally named preset through the same registry. |
| `golem dashboard [--public]` | Start the dashboard in the foreground. |
| `golem dashboard:restart [--public]` | Stop the registered dashboard and start a detached replacement. |
| `golem status [--json]` | Probe dashboard health and print its URL. |
| `golem doctor` | Check Node/npm, dependencies, state migration, tracker DB, render drift, enabled OpenCode integration, LSP capability, worktrees, and dashboard reachability. |
| `golem sync ...` | Render or check harness output. Targets are `cc`, `cc-marketplace`, `opencode`, `codex`, and `pi`. |
| `golem role <role\|clear> [--session <id-or-name>]` | Set or clear `builder`, `explorer`, `manager`, or `planner` for a session. |
| `golem sessions dedup [--apply]` | Group rows by non-empty name and keep the freshest live row, or the freshest ended row when none are live. Dry-run by default; `--apply` marks every other un-ended duplicate ended. Unnamed rows are untouched. |
| `golem migrate-home` | Explicitly back up and move the resolved legacy/XDG config path (normally `~/.config/golem`) to `~/.golem`, leave a compatibility symlink, and restart the dashboard. |
| `golem help` | Print usage. |

`--dry-run`, `--explain`, `--json`, `--model`, `--backend`, `--preset`, and
`--cwd` are shared harness options. Exact native arguments after `--` are
preserved. There is intentionally no `golem launch` command.

Useful render forms:

```sh
golem sync --target cc
golem sync --target opencode --check
golem sync --check --all
golem sync --target cc --out ./plugin --check
```

`--check` reports drift without writing and exits 0 when clean or 1 when
drifted. `--force` permits replacement of managed output detected as tampered;
review the output before using it. `--project <root>` handles only canonical
project-scoped artifacts, and no real project-scoped artifact set currently
ships.

See the packaged [`cli/golem.js`](cli/golem.js) source for the current command
implementation. Source-checkout notes may describe older command surfaces and
are not operational authority.

## Core concepts

### Substrate and renders

`substrate/` is the source of truth for agents, skills, roles, instructions,
hooks, and plugin metadata. `golem sync` translates it into harness-native
output. `plugin/` is a committed Claude Code render used for parity and
rollback; hand edits there are overwritten.

### Projects and sessions

Project identity is deterministic:

```text
<lowercase-directory-slug>-<first-6-hex-of-sha256(absolute-project-path)>
```

Hooks and shims walk upward from the working directory to the nearest `.git` or
`CLAUDE.md` to find a project root. Session facts, endpoint leases, harness
identity, names, and liveness are reconciled in local registries. A user-chosen
Claude Code `/rename` is a display/targeting name; the canonical logical session
ID remains the durable identity.

### Tracker and phases

The dashboard owns `tracker.db`; agents use dashboard REST or MCP tools and do
not write SQLite directly. Tickets replace `PLAN.md` as the cross-project work
source of truth. Phase-backed work normally moves through:

```text
queued -> building -> built -> verifying -> verified -> done
```

Rejected verification returns work for correction. Blocking questions and
decisions have their own ticket kinds and phase rules. Comments hold progress,
mechanical evidence, review findings, and four-part closing briefs.

### Roles and ownership

- Managers intake, ground, route verification, reconcile, and close.
- Planners design, decompose, sequence, and establish readiness.
- Builders implement one assigned ticket and hand off at `built`.
- Explorers investigate or independently verify with reproduced evidence.

Parallel builders use one explicit worktree each. A builder does not merge its
own worktree into main; the coordinating session reconciles it.

### Delivery modes

Delivery is a capability, not a generic promise. Claude Code channel consumers
and live OpenCode bridges support addressed push. Codex requires explicit MCP
pull. Pi uses a durable next-input inbox. The dashboard records queued,
delivered, and acknowledged states according to those distinct contracts.

## Architecture and data flow

```text
                    golem sync
substrate/ -------------------------------> harness-native renders
    |                                       |  Claude Code plugin
    |                                       |  OpenCode config + shim
    |                                       |  Codex marketplace
    |                                       |  Pi extension
    |                                       v
    |                               native harness sessions
    |                                       |
    |                             hooks / shims / MCP
    |                                       |
    v                                       v
roles + policy                    local registries + journals
                                            |
                                            v
                                  dashboard REST + WebSocket
                                            |
                               single-writer SQLite tracker
                                            |
                       dispatch queue + subscriptions + gates
                          /                 |                 \
             channel consumer      OpenCode bridge       Pi inbox
                    |                    |                    |
                    +--------------------+--------------------+
                                         |
                                addressed session work
```

The key boundary is deliberate: hooks and harness shims produce facts;
`dashboard/server/` owns mutable tracker state; `mcp/channel/` exposes thin
agent-facing tools and per-session delivery; `dashboard/web/` is the React UI.
The source checkout maintains a
[repository map](https://github.com/laveesingh/golem/blob/main/REPO-MAP.md) and
[event-bus contract](https://github.com/laveesingh/golem/blob/main/docs/substrate-events.md).
Neither file is included in the npm package.

## State and configuration

### Golem home resolution

All new code resolves the mutable Golem home in this order:

1. `GOLEM_HOME` when set.
2. `$XDG_CONFIG_HOME/golem` when `XDG_CONFIG_HOME` is set.
3. `~/.golem` when it exists as a real directory.
4. Legacy `~/.config/golem` otherwise.

`golem migrate-home` is an explicit, backup-first migration from the legacy
path. It is never run automatically.

### Important local files

Paths below are relative to the resolved Golem home.

| Path | Contents |
| --- | --- |
| `config.json` | Harness switches and Golem runtime options. |
| `projects.json` | Auto-discovered and manual project registry. |
| `sessions.json` | Session roster, names, roles, status, and project links. |
| `session-facts.json`, `endpoint-leases.json` | Canonical harness observations and live endpoint leases. |
| `channels.json`, `opencode-bridges.json` | Per-session channel and OpenCode bridge discovery. |
| `dashboard.json` | The dashboard's self-registered URL, host, port, and PID. |
| `tracker.db` | Dashboard-owned SQLite tickets, comments, phases, events, and subscriptions. |
| `journals/<project_id>/hook.jsonl` | Durable lifecycle and tool-event history. |
| `renders/` and `substrate.lock` | Harness output and drift/tamper metadata. |
| `gates/`, `ideas/`, `ticket-assets/` | Human gates, idea records, and uploaded ticket images. |
| `pi-inbox/` | Pi's durable per-session next-input queue and acknowledgements. |
| `spool/` | Best-effort bus events retained while the dashboard is unavailable. |
| `logs/` | Dashboard, sync-on-register, and shim diagnostics. |

Journals can contain prompts, tool arguments, paths, and model output. Durable
journals and tracker records persist until the user removes them. Transient
session/endpoint registrations and in-memory or file log buffers can be pruned,
expired, capped, or rotated by their runtime owners.

### Common environment overrides

| Variable | Effect |
| --- | --- |
| `GOLEM_HOME` | Highest-priority mutable state root. |
| `XDG_CONFIG_HOME` | Redirects Golem's legacy/XDG root and OpenCode config paths. |
| `GOLEM_TRACKER_DB` | Overrides the SQLite tracker path. |
| `GOLEM_ASSETS_DIR` | Overrides ticket asset storage. |
| `GOLEM_PROJECTS_ROOT`, `GOLEM_IDEAS_ROOT` | Override dashboard discovery roots. |
| `GOLEM_ROOT` | Workspace metadata exposed through the dashboard `/api/meta` response. The current runtime does not use it to select the CLI installation root or locate sessions. |
| `HOST`, `PORT` | Override dashboard bind host and port. |
| `GOLEM_DASHBOARD_URL` | Tells CLI/hook integrations which dashboard URL to use where supported. |
| `GOLEM_CHANNEL_PORT` | Pins a channel port; unset defaults to `0`, an ephemeral loopback port. |
| `GOLEM_CHANNEL_ALLOWED_SENDERS` | Comma-separated accepted channel `X-Sender` values. |
| `GOLEM_NTFY_TOPIC` | Primary ntfy topic. Falls back to `$GOLEM_DIR/ntfy_topic`; notifications are disabled only when both are absent or empty. |

Prefer temporary `GOLEM_HOME`, `XDG_CONFIG_HOME`, database paths, and non-default
ports in tests so development never touches live state. Source-checkout-only
dashboard background is available in the
[dashboard README](https://github.com/laveesingh/golem/blob/main/dashboard/README.md),
but current source behavior takes precedence where that document has drifted.

## Privacy, security, and network boundaries

- Golem has no built-in analytics or telemetry.
- The dashboard binds to loopback by default. The per-session channel server and
  OpenCode bridge also bind to `127.0.0.1`.
- The dashboard has no authentication. `--public` exposes local project,
  session, ticket, chat, and path data plus mutation, dispatch, and
  session-driving APIs to the network.
- Channel sender filtering is an application allow-list, not a reason to expose
  local channel ports to untrusted networks.
- Hooks, shims, and MCP servers execute with the permissions of the local user.
  Inspect generated files and harness permission prompts before trusting them.
- Golem writes user-level harness configuration: Claude Code instructions and
  plugin renders, plus OpenCode agents, instructions, and managed config keys.
- Optional ntfy notifications post the message to `https://ntfy.sh/<topic>` and
  send `golem: <project-directory>` as the title. They are disabled only when
  both `GOLEM_NTFY_TOPIC` and `$GOLEM_DIR/ntfy_topic` are absent or empty.
- npm, GitHub, the selected harness, and model providers have their own network
  and privacy policies. Golem does not proxy or replace them.
- Protect the resolved Golem home. Do not publish journals, tracker databases,
  channel messages, secrets, or identifying local paths in bug reports.

Read [`PRIVACY.md`](PRIVACY.md) for privacy and support cautions and
[`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

## Development and release checks

Install exact dependencies from a source checkout:

```sh
npm ci
```

Run checks relevant to the change:

```sh
npm test
npm run dashboard:build
npm run test:dashboard:browser
npm run test:release
npm pack --dry-run --json
git diff --check
```

The release smoke packs and installs the package under isolated state, renders
and asserts the Claude Code, marketplace, Codex, and Pi outputs, and invokes
OpenCode sync. OpenCode is skipped unless that harness is enabled, so the smoke
exercises packed installation and enabled targets rather than proving that every
target rendered. The dashboard browser journey uses an isolated Chrome instance
and dashboard port. The
[release-readiness document](https://github.com/laveesingh/golem/blob/main/docs/release-readiness.md)
is a historical record for version 5.0.16, not current 5.1.0 evidence, and is not
included in the npm package.

`npm run check` runs JavaScript syntax checks and `golem sync --check --all`.
That render check inspects configured global and known-project renders, so do
not point it at live state from an isolation test. Use explicit temporary homes
and ports when exercising runtime paths.

For substrate changes, edit `substrate/`, not `plugin/`, and verify the committed
Claude Code render round-trip:

```sh
golem sync --target cc --out ./plugin --check
```

If output intentionally changes, render it according to the contribution
instructions and include source and generated output together. Do not run sync,
dashboard restart, or other shared-state commands from a parallel worktree.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `substrate/` | Source of truth for roles, agents, skills, instructions, hooks, and plugin metadata. |
| `plugin/` | Generated Claude Code render; do not hand-edit. |
| `cli/golem.js` | Thin command entry point. |
| `apps/cli/src/` | Typed Commander registry, deterministic formatters/errors, and harness resolution boundary. |
| `lib/` | State resolution, compiler, adapters, roles, lint, identity, and runtime helpers. |
| `dashboard/server/` | Fastify REST/WebSocket service and sole SQLite tracker owner. |
| `dashboard/web/` | React source for the dashboard. |
| `dashboard/dist/` | Pinned production dashboard bundle. |
| `mcp/channel/` | Per-session HTTP/MCP channel and tracker client. |
| `shims/opencode/` | OpenCode lifecycle and addressed-delivery bridge. |
| `shims/codex/` | Codex documented-hook adapter. |
| `shims/pi/` | Pi portable extension source. |
| `test/` | Journey tests for session facts, harnesses, compiler enforcement, and release packaging. |
| `docs/` | Support evidence, architecture notes, and release-readiness records. |
| `golem-projects/` | Local project namespaces; independent repositories and gitignored here. |
| `.worktrees/` | Gitignored worktrees created only by explicit dispatch. |

The source-checkout-only
[repository map](https://github.com/laveesingh/golem/blob/main/REPO-MAP.md)
provides additional maintainer orientation. The setup and behavior in this root
README and current packaged source take precedence over older component notes.

## Troubleshooting

### A render is stale or was edited

Inspect without writing:

```sh
golem sync --check --all
```

Re-run sync for the affected target. Golem refuses a hand-edited managed output
instead of silently replacing it; inspect the reported file before deciding
whether `--force` is appropriate. For Claude Code, sync is not enough: update
the cached plugin and use `/reload-plugins` in existing sessions. After moving
an OpenCode-backed installation, first remove obsolete Golem entries from
`skills.paths` and `plugin` in `opencode.jsonc`; then re-sync and restart.

### The dashboard is stale or unreachable

```sh
golem status
golem dashboard:restart
```

Detached restart logs are written below the resolved `logs/` directory. Tracker
MCP failures are expected while the dashboard is down because the dashboard is
the database's single writer. Lifecycle hooks continue best-effort local
journaling and can spool bus events.

### Port 7420 is occupied

The dashboard refuses to kill a process that is not the PID recorded in
`dashboard.json`. Stop the unrelated listener or choose an intentional port.
For a custom-port instance on loopback, repeat the same port for status and
restart:

```sh
PORT=7430 golem dashboard
PORT=7430 golem status
PORT=7430 golem dashboard:restart
```

For a custom URL or host that cannot be derived from `PORT`, also set a matching
`GOLEM_DASHBOARD_URL` for status, restart, and other integrations. Do not pin
`GOLEM_CHANNEL_PORT` for normal multi-session use; ephemeral channel ports avoid
collisions.

### Claude Code does not receive a dispatch

Confirm that the plugin is enabled and the session was launched with `golemc`
or the full `--dangerously-load-development-channels` command. A plain session
can pull tickets but cannot receive pushed channel notifications. After an
update, run `claude plugin update golem@golem-workspace` and `/reload-plugins`.

### OpenCode is skipped or does not register

Confirm `harnesses.opencode.enabled` is `true` in the resolved `config.json`,
then run:

```sh
golem sync --target opencode
opencode debug config
```

Restart OpenCode after syncing. Check `logs/opencode-shim.log`: no `[init]`
means the shim did not load; `[init]` without `[session.created]` means no
session was created; `[session.created]` without `[registered]` points to the
adjacent registration error. If the MCP reports ambiguous sibling identity,
restart the affected OpenCode session or update and re-sync Golem.

### Codex work never appears as pushed

That is the Tier B contract. Review/trust hooks with `/hooks`, verify the plugin
is enabled, list current or project-scoped tickets, and inspect assignments. Do
not use `mine: true` with the default generated MCP because it supplies no caller
identity. Do not wait for push or next-turn injection.

### Pi work remains queued

Confirm Pi is running with the rendered extension and Node.js 22.19 or newer.
Pi picks up addressed work only on the next real user input. It is not a
live-idle push adapter. Queue diagnostics are retained below
`pi-inbox/<session-id>/`, including dead-letter entries rather than silently
discarding malformed files.

### A resumed or renamed session has the wrong identity

Use the harness's canonical identity rather than process ID or file recency.
Claude Code derives the logical session ID from its parent session record and
uses `/rename` only as a name. OpenCode requires a live shim bridge, Codex uses
documented hook session IDs, and Pi uses its session manager UUID. Run
`golem doctor`, restart/re-sync the affected harness, and inspect the session
facts and harness-specific logs before deleting registry rows.

## Contributing, support, security, and license

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change.
- Use [GitHub Issues](https://github.com/laveesingh/golem/issues) for sanitized,
  reproducible bugs, support questions, and proposals.
- Report vulnerabilities privately as described in
  [`SECURITY.md`](SECURITY.md), never in a public issue containing an exploit,
  secret, journal, database, or identifying path.
- Golem is licensed under the [MIT License](LICENSE).
