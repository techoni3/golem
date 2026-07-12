# Golem

Golem is a local orchestration plugin, tracker/dashboard, and CLI for Claude
Code and OpenCode. It requires Node.js 20 or newer. Claude Code is the supported
plugin/channel surface; OpenCode supports rendered agents, skills, and MCP
configuration. The npm package is `@laveesingh/golem`; the rendered harness
plugin remains named `golem`.

## Install and render

```sh
npm install -g @laveesingh/golem
golem sync --target cc
golem sync --target cc-marketplace
claude plugin marketplace add ~/.golem/renders/cc-marketplace
claude plugin install golem@golem-workspace --scope user
```

OpenCode users run `golem sync --target opencode`. See
[`substrate/README.md`](substrate/README.md) for channel launch and update
details. Roll back by uninstalling the marketplace plugin or installing a
previous npm version, rendering again, and reloading the harness.

## Local data and permissions

Golem is local-first. Mutable state is under `$GOLEM_HOME` when set, otherwise
`$XDG_CONFIG_HOME/golem`, `~/.golem`, or the legacy `~/.config/golem` (in that
order). It includes project/session metadata, SQLite tracker data, message
channels, gates, logs, and journals that may contain prompts, tool arguments,
paths, and model output. Renders are written below that state directory; an
OpenCode render also updates its user config and agent directory. Plugin hooks
observe session/tool lifecycle events. Channel consumers and the dashboard
listen locally unless configured otherwise. Optional ntfy notifications send
notification text to the configured ntfy service/topic; leave the topic unset
to disable them. Golem adds no analytics or telemetry.

Review generated changes before granting harness permissions. Do not expose the
dashboard or channel ports to untrusted networks. Privacy and retention details
are in [`PRIVACY.md`](PRIVACY.md).

## Development and help

Use `npm ci`, then `npm test`. Tests must isolate `GOLEM_HOME`,
`XDG_CONFIG_HOME`, and ports; never point development runs at live state.
Contributions, support, and security reporting are covered by
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

Licensed under the [MIT License](LICENSE).
