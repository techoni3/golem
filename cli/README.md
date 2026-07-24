# golem CLI

Minimal Node CLI for the golem v4 harness. (The v3 bash CLI was retired in v4.)

## Install

Production (Node 24.18+):

```bash
npm install -g @laveesingh/golem
golem help
```

The package postinstall validates the release checksums and
`better-sqlite3@12.11.1`; it never starts a service, writes `GOLEM_HOME`, runs
code generation, or performs a nested npm install. Render integrations
explicitly after installation.

From a source checkout:

```bash
npm link        # makes `golem` available globally
# or, without installing:
npx golem <command>
```

## Surviving commands

| Command | What it does |
| --- | --- |
| `golem codex [preset]` | Launch the qualified managed Codex host. Local/OSS selections fail before spawn with a direct-Codex remedy; the old TUI needs the explicit `--legacy --` escape. |
| `golem opencode [preset]` / `golem claude [preset]` | Resolve the canonical harness preset. Unqualified adapters fail closed before spawn. |
| `golem @preset` | Resolve a globally named preset through the same registry. |
| `golem` | Opens the compact TTY preset picker. In a non-TTY it prints help and never prompts. |
| `golem presets list\|set\|remove\|favorite …` | Review or explicitly save scoped/global presets. Any mutation requires `--apply`; user-owned JSONC is preserved. |
| `golem completions [bash\|zsh\|fish] [--apply]` | Print or install registry-derived completions in a dedicated Golem-owned file. |
| `golem aliases install\|uninstall [--apply]` | Preview or manage optional non-native aliases without editing a shell RC file. |
| `golem dashboard [--public]` | Start the admin dashboard on `http://dashboard.golem.localhost:7420`. Pass extra args through to `npm start`. |
| `golem doctor` | Sanity-check the environment. |
| `golem status [--json]` | Probe the dashboard `/api/health` endpoint and print the canonical URL. |
| `golem help` | Show usage. |

The typed registry lives in `apps/cli/src/registry.ts` and generates parser
metadata and help. `cli/golem.js` remains the compatibility entry point and
loads the relocatable `dist/release/golem-cli.mjs` artifact in an installed
package (with the workspace build as a checkout fallback).
There is intentionally no `golem launch` command.

`golemc` and `golemx` remain one-hop compatibility shims for `golem claude`
and `golem opencode`. They never replace native `claude`, `opencode`, or
`codex` commands.

## Install, update, and rollback

Installation and version selection stay npm-owned; Golem never mutates its own
package from postinstall:

```bash
npm install -g @laveesingh/golem
golem sync --target cc
golem sync --target cc-marketplace

npm install -g @laveesingh/golem@<next-version>
golem sync --target cc
golem sync --target cc-marketplace

npm install -g @laveesingh/golem@<previous-version>
golem sync --target cc --force
golem sync --target cc-marketplace --force
```

Run `golem migrate plan` and use its exact plan hash before a legacy-data apply
or C4 cutover. Package rollback changes executable/render bytes; it never
silently rewrites canonical SQLite data. The dashboard Settings page owns
preview-hashed, explicit LaunchAgent install/status/start/stop/update/rollback
operations.

## Removed v3 commands

`install`, `cleanup`, `reinstall`, `session`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
