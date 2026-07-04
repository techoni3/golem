# opencode harness (P4, TKT-0576)

golem's substrate compiler renders to more than one agentic harness. Alongside
the Claude Code adapter (`--target cc`), there is an **opencode** adapter
(`--target opencode`). It is **additive and off by default** — a fresh install
never touches opencode until you opt in via the harness toggle, so it can't
break the CC path.

## Enabling

The toggle lives in `~/.golem/config.json` (created on demand; absent → all
non-default harnesses disabled):

```json
{
  "harnesses": {
    "claudecode": { "enabled": true },
    "opencode":   { "enabled": true, "modelMap": {}, "testedVersion": null }
  }
}
```

With `opencode.enabled = false` (the default), `golem sync --target opencode`
reports the harness as **disabled and skips** — it is never treated as drift.
`golem doctor` shows the same disabled status.

Then render:

```bash
golem sync --target opencode
```

## What it renders

opencode reads golem's pieces from **two** locations (unlike the CC plugin,
which is one bundle), plus a managed config merge:

| Piece  | Rendered to | How opencode finds it |
|--------|-------------|-----------------------|
| Agents | `~/.config/opencode/agent/<name>.md` | opencode's **fixed** global agent dir — there is no config key to add extra agent search paths, so the files must live there physically. |
| Skills | `~/.golem/renders/opencode/skills/<name>/SKILL.md` | that dir is appended to the `skills.paths` array in `opencode.jsonc`. |
| MCP    | `mcp.golem` in `opencode.jsonc` | a `local` server pointing at the repo's `mcp/channel/index.js` (referenced by absolute path — no copy, unlike the CC plugin bundle). |

Both render passes use the same engine (lockfile / tamper-detection / orphan
pruning) as the CC target, keyed independently by output dir.

## Dialect translation

Agent **frontmatter** is *translated*, not copied — a Claude Code agent's
`tools:` + `model:` frontmatter is invalid under opencode:

- `mode: subagent` (all three golem agents are subagents).
- `permission: { edit: deny }` for read-only agents (reviewer, researcher);
  writers (worker) get no permission block. This mirrors the one
  security-meaningful boundary — read-only agents cannot edit — rather than
  attempting a full 1:1 tool-map.
- `model` is **omitted** so the opencode session's own default model is
  inherited. (The typical opencode setup runs GPT auth with no Anthropic
  models available, so pinning `model: opus` would break the agent. Fill in
  `harnesses.opencode.modelMap` later if you want explicit per-agent models.)

Agent and skill **bodies** are copied but run through the compiler's
`{{#if opencode}}` / `{{#if claudecode}}` templating, so the two CC-specific
bits render their opencode variant:

- `skills/journaling` — the "mechanical journaling is automatic via plugin
  hooks" note becomes "needs Claude Code hooks; under opencode `hook.jsonl` is
  not auto-written" (opencode has no golem lifecycle hooks).
- `skills/pr-conventions` — the `🤖 Generated with [Claude Code]` PR trailer
  becomes `[opencode]`.

Rendering the CC branch and dropping the opencode branch leaves every existing
substrate file **byte-identical** to its pre-templating form, so the CC render
is unaffected.

## Config merge safety

`opencode.jsonc` is merged with `jsonc-parser` (comment-preserving), touching
**only** the two managed keys `mcp.golem` and `skills.paths` — your own keys,
comments, and formatting survive, and `skills.paths` is appended to (never
overwritten). Every write is guarded: the file is backed up, written, then
validated with the real `opencode debug config`; on validation failure the
previous file is restored and the sync fails loudly. (This follows the P3
lesson: validate against the actual tool, not just the published schema.) On
success the backup is removed.

## Version pinning & doctor

A clean, validated sync pins `harnesses.opencode.testedVersion` to the running
`opencode --version`. `golem doctor` warns on skew (rendered against one
version, a different one installed) and reports opencode render drift.

## Caveats

- `mcp.golem` references the repo checkout by absolute path; if you move the
  golem repo, re-run `golem sync --target opencode` to refresh the path.

## Project-scoped renders

P6 adds project-scoped substrate artifacts. A canonical substrate file can opt in
with `scope: project` in frontmatter; default is `scope: global`. Global opencode
sync ignores project-scoped files. Project sync renders only those files:

| Piece  | Project render path |
|--------|---------------------|
| Agents | `<project>/.opencode/agents/<name>.md` |
| Skills | `<project>/.opencode/skills/<name>/SKILL.md` |

Session registration triggers the check for opencode sessions through the P5
shim: `session.created` calls `session-register.sh` with `harness:"opencode"`,
and the script runs `golem sync --check --project <root> --harness opencode`.
Dirty renders run detached; failures log to `~/.golem/logs/sync-on-register.log`
and never block session start.

Current artifact-set decision for P6: no real project-scoped substrate content is
shipped yet. The mechanism is verified with scratch-only fixtures so golem does
not start writing generated files into real user repos before an explicit policy
decision.

## Dispatch bridge

P5.5 makes live opencode sessions dispatchable without forking the dashboard
dispatch path. The opencode shim owns a tiny localhost bridge because it is the
only process with both the active `ses_*` id and opencode's SDK `client`; the MCP
channel server remains the dashboard-facing endpoint so existing `/events`,
`ack`, `respond`, consult, and tracker tools keep using one channel protocol.

Runtime flow:

- `session.created` starts/updates `~/.golem/opencode-bridges.json` with the
  `ses_*` id, opencode process pid, bridge port, cwd, and status.
- On plugin startup, the shim also seeds bridge/session rows from opencode's
  `client.session.list()` + `client.session.status()` result. This covers
  resumed sessions where opencode does not immediately emit `session.created` or
  `session.updated`; an idle resumed session must become dispatchable without a
  manual ping/pong poke.
- The MCP channel process is a child of the opencode process, so its heartbeat
  resolves the matching bridge by `process.ppid`, registers its own HTTP port in
  `~/.golem/channels.json` under that `ses_*` id, and marks the row
  `harness:"opencode"`.
- Dashboard dispatch still POSTs to the registered channel server. For opencode
  parents, the channel server forwards the push to the shim bridge; the shim
  injects the canonical `<channel source="golem" kind="...">...</channel>` text
  into the live session with `client.session.prompt(...)`.
- `session.idle`, `session.status`, `chat.message`, and tool events update the
  bridge and `sessions.json` status so `sessions_dispatchable` can show idle/busy
  and queue `when_idle` dispatches the same way it does for Claude Code sessions.
  `session.status` carries `status` as an OBJECT (`{type:"idle"|"retry"|"busy"}`);
  the shim collapses it to the plain string the dashboard compares against
  (`retry` counts as `busy`).
- The shim also records the active opencode model in `~/.golem/sessions.json`
  from opencode's runtime state file (`~/.local/state/opencode/model.json`,
  `recent[0].modelID`). Model changes are refreshed immediately on shim-visible
  session/chat/tool/status activity and by the 30s heartbeat while a session is
  otherwise idle; the dashboard then publishes the next `native-sessions-update`
  snapshot on its 3s native-session refresh.
- `session.updated` (parentID-guarded) refreshes the registry `name` from
  `info.title` — the only real-time source of the session title (auto-generated
  after the first message, updated on rename). Events from child/subagent
  sessions can only update existing rows, never insert, so they cannot create
  phantom sessions or dispatch endpoints.

The bridge is fail-open: HTTP or SDK errors are logged to
`~/.golem/logs/opencode-shim.log` and must not crash or stall opencode.
