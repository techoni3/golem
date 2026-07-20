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
| `golem codex [preset]` | Resolve the managed Codex preset; `--dry-run --json` is deterministic and preserves `--` passthrough. Bare `golem codex` remains the legacy managed TUI path. |
| `golem opencode [preset]` / `golem claude [preset]` | Resolve the canonical harness preset. Unqualified adapters fail closed before spawn. |
| `golem @preset` | Resolve a globally named preset through the same registry. |
| `golem dashboard [--public]` | Start the admin dashboard on `http://dashboard.golem.localhost:7420`. Pass extra args through to `npm start`. |
| `golem doctor` | Sanity-check the environment. |
| `golem status [--json]` | Probe the dashboard `/api/health` endpoint and print the canonical URL. |
| `golem help` | Show usage. |

The typed registry lives in `apps/cli/src/registry.ts` and generates parser
metadata and help. `cli/golem.js` remains the compatibility entry point and
delegates only the new harness resolution surface to its compiled registry.
There is intentionally no `golem launch` command.

## Removed v3 commands

`install`, `cleanup`, `reinstall`, `session`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
