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
- opencode's agent dir is global; there is currently no project-scoped render.
