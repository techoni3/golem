# Golem · Substrate v1

The substrate is the global, project-agnostic layer of golem. It contains personas, skills, hook scripts, and the project-bootstrap template. Edited rarely. Used by every project.

Authoritative design: [`../project_management/design/design_v1.md`](../project_management/design/design_v1.md).

## Layout

```
substrate/
├── agents/                    # leaf sub-agent personas: golem-<name>.md → ~/.claude/agents/
├── personas/                  # main-thread personas: golem-<name>.md → ~/.claude/personas/
├── bin/golem                  # unified CLI (install / session / dashboard / doctor / …)
├── channels/golem/            # custom MCP channel server (spawned by Claude Code as a child)
├── commands/                  # slash commands: golem.md → ~/.claude/commands/
├── skills/
│   └── golem-<name>/          # one dir per skill, with SKILL.md inside
├── hooks/                     # shell scripts (journal-event, journal-summarise, git-guardrails, lint-format)
└── templates/
    └── project-bootstrap/     # the Substrator agent copies this into new projects in-session
```

## The CLI

Everything is one command: `golem`. Run `golem help` for the full list. The five verbs you'll use:

| Command | What it does |
| --- | --- |
| `golem install` | One-time setup. Symlinks personas/agents/skills/commands into `~/.claude/*`, symlinks `golem` into `~/.local/bin/`, writes `$GOLEM_ROOT/.mcp.json`, runs `npm install` in the dashboard and channel-server. Idempotent. |
| `golem reinstall` | `cleanup` then `install`. Use after moving the substrate dir. |
| `golem cleanup [--purge]` | Reverse `install`. Only removes things `install` created (symlinks pointing into this substrate, our `.mcp.json` if unmodified). `--purge` also removes `node_modules`. |
| `golem session [--new] [brief…]` | Start (or `--continue` resume) the interactive CEO Claude Code session. Trailing args are delivered as the first message. |
| `golem dashboard` | Start the dashboard on `http://localhost:4173`. |
| `golem doctor` | Sanity-check the environment (symlinks present, PATH wired, `.mcp.json` correct, deps installed, channel server reachable). |

### First-time install

```sh
# Clone the repo, then from anywhere:
./golem/substrate/bin/golem install
```

After that, `golem` is on your PATH (via `~/.local/bin/golem`). If `~/.local/bin` is not on your PATH yet, the installer prints the export line to add to your shell rc.

Targets created:

- `~/.claude/agents/golem-<name>.md` → `substrate/agents/golem-<name>.md`
- `~/.claude/personas/golem-<name>.md` → `substrate/personas/golem-<name>.md`
- `~/.claude/skills/golem-<name>/` → `substrate/skills/golem-<name>/`
- `~/.claude/commands/golem.md` → `substrate/commands/golem.md`
- `~/.local/bin/golem` → `substrate/bin/golem`
- `$GOLEM_ROOT/.mcp.json` (registers the channel server with Claude Code)

All target dirs are flat — Claude Code discovery is one-level. The `golem-` prefix is the namespace inside the flat tree, and is mandatory (entries without it are skipped).

### Day-to-day

```sh
# Terminal A
golem session                  # interactive CEO session (resumes the last one)
golem session "<brief>"        # same, with an initial brief
golem session --new            # force a fresh session (after persona edits)

# Terminal B
golem dashboard                # http://localhost:4173 — orchestrator panel pushes
                               # briefs/interrupts/halts/gate verdicts into the CEO
```

## Personas vs agents

- **`agents/`** — leaf sub-agent personas. Spawned via the `Agent` tool from a main thread. Cannot recurse.
- **`personas/`** — main-thread personas, loaded at session start via `claude --append-system-prompt-file <path>`. The CEO persona (`golem-ceo.md`) is the orchestrator that dispatches everything else.

The CEO session anchors cwd to `$GOLEM_ROOT` (default `~/Documents/software/experiments/golem`) so `--continue` consistently picks up the same thread. Claude Code freezes the system prompt at session creation — persona edits only take effect on `golem session --new`.

## Channels — push briefs and interruptions into a running CEO

Channels ([research preview](https://code.claude.com/docs/en/channels)) let an external system push events into the live CEO session. The default setup attaches our own MCP channel server ([`channels/golem`](channels/golem)) which the dashboard talks to. You can also attach stock channel plugins (Telegram, Discord, iMessage, fakechat) alongside:

```sh
# One-time: install the marketplace and the plugins you want
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install fakechat@claude-plugins-official      # localhost demo on :8787
claude plugin install telegram@claude-plugins-official      # needs bot token
claude plugin install imessage@claude-plugins-official      # macOS only

# Then list them in GOLEM_CEO_CHANNELS (default is "server:golem"):
export GOLEM_CEO_CHANNELS="server:golem plugin:fakechat@claude-plugins-official"
golem session
```

Each push into a channel arrives in the CEO session as a `<channel source="..." kind="...">` tag. See `channels/golem/README.md` for the custom server's protocol.

## Bootstrap a new project

The Substrator agent does this in-session — there is no separate shell script. Hand it a brief like *"bootstrap a new project at ~/Documents/software/experiments/golem/golem-projects/foo, stack: ts-cli"* and it will copy `templates/project-bootstrap/` in, substitute placeholders, wire hooks, and run the first commit.

## Hooks

Hooks are **not** installed globally. They wire per project at bootstrap time via `templates/project-bootstrap/.claude/settings.json`. The hook scripts are copied (not symlinked) into each project's `.claude/hooks/` so projects are self-contained.

## Naming conventions

- Sub-agent files: `substrate/agents/golem-<name>.md` (kebab-case `<name>`).
- Skill dirs: `substrate/skills/golem-<name>/` with `SKILL.md` at the root.
- The `golem-` prefix is mandatory — `golem install` skips entries that lack it.
