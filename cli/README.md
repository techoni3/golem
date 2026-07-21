# golem CLI

Minimal Node CLI for the golem v4 harness. (The v3 bash CLI was retired in v4.)

## Install

From the repo root:

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
delegates only the new harness resolution surface to its compiled registry.
There is intentionally no `golem launch` command.

`golemc` and `golemx` remain one-hop compatibility shims for `golem claude`
and `golem opencode`; they print a deprecation/remediation line and refuse a
second compatibility hop. They never replace native `claude`, `opencode`, or
`codex` commands.

## Removed v3 commands

`install`, `cleanup`, `reinstall`, `session`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
