# Golem

Golem is a local-first orchestration layer for agentic coding harnesses. It
adds shared roles, a SQLite-backed tracker and dashboard, session discovery,
durable dispatch, lifecycle journals, and evidence-based verification without
replacing the coding harness itself.

One canonical [`substrate/`](substrate/) renders into the native surfaces each
harness supports. The dashboard owns tracker state; hooks, shims, and MCP tools
connect live sessions to it.

## What you get

- Manager, planner, builder, and explorer roles, plus focused subagents where
  the harness supports them.
- Tickets, dependencies, phases, comments, gates, and an auditable event ledger.
- Addressed work delivery with honest per-harness delivery semantics.
- Cross-session consultation and optional ntfy notifications.
- Central local journals and registries with no required per-project footprint.
- Drift-checked harness renders that protect hand-edited managed output.

The dashboard must be running for tracker tools and dispatch. Harness hooks are
fail-open, so a dashboard outage does not block a coding session.

## Harness support

| Harness | Support | Delivery contract |
| --- | --- | --- |
| **Codex** | **Tier A — recommended** | `golem codex` opens the normal interactive Codex TUI through Golem's private App Server bridge. It provides durable typed delivery into the canonical thread when idle, native resume, lifecycle facts, and Codex-owned sandbox and approvals. This is Golem's most complete managed integration. |
| Claude Code | Tier A | `golem claude` opens native Claude Code with the rendered plugin's addressed-push channel. Plain `claude` sessions can pull work but do not receive channel pushes. |
| OpenCode | Tier A | Rendered agents, skills, instructions, MCP configuration, and addressed delivery through the live OpenCode shim bridge. |
| Pi | Tier A worker | Managed native launch, shared durable live delivery, native Golem tools/resources, recovery visibility, and truthful dashboard state. |
| Gemini CLI | Unsupported | No adapter or release contract is shipped. |

A separately launched bare `codex` process remains a compatibility path with
rendered skills, hooks, and MCP pull. Launch with `golem codex` for the Tier A
experience. See the [Codex contract](docs/codex.md) for the detailed boundary
and mechanical evidence.

## Requirements

- Node.js 20 or newer and npm. Pi requires Node.js 22.19 or newer.
- At least one supported coding harness installed separately.
- Git for source development.

## Install

Install the package that provides the `golem` executable:

```sh
npm install -g @laveesingh/golem
golem doctor
```

From a source checkout:

```sh
npm ci
npm link
golem doctor
```

The package is `@laveesingh/golem`; the rendered harness plugin is named
`golem`.

## Quick start with Codex

Start the dashboard in one terminal:

```sh
golem dashboard
```

Open <http://dashboard.golem.localhost:7420>, then start Codex from a project in
another terminal:

```sh
cd /path/to/project
golem codex
```

`golem codex` creates or resumes one canonical tracker session and runs the
normal Codex TUI. The TUI keeps ownership of model selection, turns, sandboxing,
and approval decisions; Golem supplies the private bridge and delivers queued
work only when the thread is idle.

Useful variants:

```sh
golem codex --session <canonical-id>
golem codex --cwd /path/to/project -- --model <model>
```

Run `golem codex --help` for wrapper details. Golem reserves Codex's `--remote`
and `-C`/`--cd` options because they define the managed bridge and canonical
project directory.

## Other harnesses

### Claude Code

Render and install the workspace plugin:

```sh
golem sync --target cc
golem sync --target cc-marketplace
claude plugin marketplace add ~/.golem/renders/cc-marketplace
claude plugin install golem@golem-workspace --scope user
```

Launch a push-capable session:

```sh
golem claude
golem claude -- --model <model>
```

`golem claude` passes native Claude Code arguments through and owns the
development-channel selection. The equivalent raw fallback is:

```sh
claude --dangerously-load-development-channels plugin:golem@golem-workspace
```

A plain `claude` session still has Golem's tools, but it must pull work. After
an update, re-sync, run `claude plugin update golem@golem-workspace`, and use
`/reload-plugins` in sessions that are already open.

### OpenCode

OpenCode is opt-in. Enable it in `~/.golem/config.json`:

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

Then render and launch:

```sh
golem sync --target opencode
opencode
```

Sync merges only Golem-managed entries into `opencode.jsonc` and validates the
result with the installed OpenCode binary when available.

### Pi

```sh
# Local Ollama daemon
golem pi --provider ollama --model laguna-xs-2.1:q4_K_M

# Direct Ollama Cloud (authenticate once with /login ollama-cloud)
golem pi --provider ollama-cloud --model deepseek-v4-flash
```

The managed launcher pins Pi 0.80.10, syncs and loads the canonical render,
keeps Pi profile/session state under `GOLEM_HOME`, supports `--resume <id>`,
preserves native arguments after `--`, and installs the pinned
`@ifi/pi-provider-ollama@0.5.1` package into its private profile on first use.
Both `ollama/...` local models and `ollama-cloud/...` direct cloud models are
available in the same `/model` picker; later launches reuse the installed package.
Non-Ollama custom providers still use the selective source `models.json` bridge.
Pi registers a typed live endpoint, shared tracker/project tools, Golem-owned
authority and builder/explorer/reviewer role context, progressive skills, and
bounded project context. The legacy next-input spool is migration-read-only.

The supported package is `@earendil-works/pi-coding-agent@0.80.10` on Node.js
22.19 or newer. Pi extensions run with the user's full host authority; project
trust is not a sandbox. A failure before native prompt acceptance is replayable,
while a crash after acceptance is shown as outcome-unknown and requires explicit
correlated recovery or redispatch. Pi lead/standalone orchestration, native
subagents, and bundled browser/LSP features remain deferred.

If `GOLEM_HOME` is set, replace `~/.golem` in these examples with that path.

## Workflow

The tracker is the source of truth for cross-session work:

```text
queued -> building -> built -> verifying -> verified -> done
```

- Managers intake, route, reconcile, and close.
- Planners design, decompose, and establish readiness.
- Builders implement one assigned ticket and report tested evidence.
- Explorers investigate or independently verify.

Sessions register their project, harness, role, and delivery capability. The
dashboard routes work only through a supported path: managed Codex delivery,
Claude channels, the OpenCode bridge, or Pi's shared typed-worker endpoint. It never reports a
queued message as delivered merely because the target exists.

For architecture and source ownership, use [`REPO-MAP.md`](REPO-MAP.md) rather
than this README as the repository map.

## Dashboard and CLI

The dashboard is the tracker database's single writer and serves the ticket
board, session roster, chat, dispatch controls, REST API, and WebSocket updates.

```sh
golem dashboard
golem dashboard:restart
golem status
```

It binds to `127.0.0.1:7420` by default. `golem dashboard --public` binds to
`0.0.0.0`, but the dashboard has no authentication; do not expose it to an
untrusted network.

| Command | Purpose |
| --- | --- |
| `golem codex` | Open the Tier A managed interactive Codex TUI. |
| `golem claude` | Open native Claude Code with Golem's addressed-push channel. |
| `golem codex-supervisor ...` | Run or inspect the headless Codex App Server mode. |
| `golem dashboard` | Start the dashboard in the foreground. |
| `golem dashboard:restart` | Replace the registered dashboard with a detached instance. |
| `golem status [--json]` | Report dashboard health and its canonical URL. |
| `golem doctor` | Check dependencies, state, renders, integrations, and dashboard reachability. |
| `golem sync ...` | Render or check `cc`, `cc-marketplace`, `opencode`, `codex`, and `pi` outputs. |
| `golem role <role\|clear>` | Set or clear a session's manager, planner, builder, or explorer role. |
| `golem sessions dedup [--apply]` | Inspect or reconcile duplicate named session rows. |
| `golem migrate-home` | Back up and migrate legacy state to `~/.golem`. |

`golem help` documents command options. Common render checks are:

```sh
golem sync --check --all
golem sync --target opencode --check
golem sync --target cc --out ./plugin --check
```

Edit `substrate/`, not generated `plugin/`. Use `--force` only after reviewing
a tamper warning.

## Local state and safety

Mutable state normally lives in `~/.golem/`:

- `tracker.db` — tickets, comments, phases, events, and active message envelopes.
- `projects.json` and `sessions.json` — discovered projects and session roster.
- `journals/<project_id>/hook.jsonl` — lifecycle and tool-event history.
- `renders/` and `substrate.lock` — generated harness output and drift metadata.
- `dashboard.json`, endpoint leases, and harness bridge registries — live routing.
- `gates/`, `ticket-assets/`, `spool/`, and `logs/` — supporting local state.

`GOLEM_HOME` overrides the state root. Existing XDG/legacy installations remain
compatible and can be moved explicitly with `golem migrate-home`.

Golem has no built-in analytics or telemetry. Journals and tracker data may
contain prompts, model output, tool arguments, paths, and other sensitive local
context. Protect the state directory and read [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](SECURITY.md) before exposing services or sharing diagnostics.

## Development

```sh
npm ci
npm test
npm run dashboard:build
npm run test:release
git diff --check
```

Run `npm run test:dashboard:browser` for dashboard-facing changes. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules,
[`REPO-MAP.md`](REPO-MAP.md) for code ownership, and
[`substrate/README.md`](substrate/README.md) for deeper plugin/runtime details.

## License

[MIT](LICENSE)
