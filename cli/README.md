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
| `golem dashboard [--public]` | Start the admin dashboard on `http://dashboard.golem.localhost:7420`. Pass extra args through to `npm start`. |
| `golem doctor` | Sanity-check the environment, including external repo-map tooling (`uvx`/`pipx` + pinned `aider-chat`). |
| `golem map [path] [--force] [--budget <tokens>] [--focus <file|symbol:name>] [--json]` | Generate an aider-backed repo map under `~/.golem/repomap/<project_id>/<commit>.md` and record project LSP capability. Focused maps print without replacing the cached full map. |
| `golem status [--json]` | Probe the dashboard `/api/health` endpoint and print the canonical URL. |
| `golem help` | Show usage. |

## Removed v3 commands

`install`, `cleanup`, `reinstall`, `session`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
