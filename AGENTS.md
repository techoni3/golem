# Golem — root workspace

This directory is the golem root: the source repo for the **golem v4 Claude Code plugin**, the **dashboard + tracker**, and the thin **`golem` CLI**. It is also a local plugin marketplace (`.claude-plugin/marketplace.json`).

## Layout

| What | Where |
|------|-------|
| v4 plugin source | `plugin/` — agents (`worker`/`reviewer`/`researcher`), 9 `golem:*` skills, hooks, channel MCP |
| Dashboard + tracker (SQLite, REST, web UI) | `dashboard/` — start with `golem dashboard` |
| `golem` CLI | `cli/golem.js` (`npm link` surfaces it; verbs: `dashboard`, `doctor`, `status`, `help`) |
| Project namespaces | `golem-projects/<name>/` (independent repos, gitignored) |
| Local marketplace manifest | `.claude-plugin/marketplace.json` |
| Runtime state (outside the repo) | `~/.config/golem/` — `projects.json`, `sessions.json`, `channels.json`, `journals/<project_id>/`, `tracker.db`, `gates/` |

## Journaling

The plugin hooks journal every tool call + lifecycle event to **central** `~/.config/golem/journals/<project_id>/hook.jsonl` — zero repo footprint. Project root is resolved by walking up from `$PWD` to the nearest `AGENTS.md` or `.git`, so this file also acts as the root-workspace marker; sub-agents inherit routing via the same `$PWD`-walk.

## Installing the plugin

```bash
claude plugin marketplace add /Users/laveesingh/Documents/software/experiments/golem
claude plugin install golem@golem-local --scope user
```

Updates are version-gated: bump `version` in `plugin/.claude-plugin/plugin.json`, then `claude plugin update golem@golem-local` + `/reload-plugins`. See `plugin/README.md` for the channel-consumer launch (`golemc`) and the full setup.