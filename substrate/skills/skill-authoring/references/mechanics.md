# Mechanics — format, limits, portability

Exact fields and numbers. Everything here is from published specifications or vendor
documentation; where something is undocumented this file says so rather than guessing, because a
fabricated limit poisons everything built on it.

## Loading model

1. The harness discovers each skill's **name and description** and places that metadata in the
   startup system prompt.
2. The user's request is matched against that metadata.
3. On a match, the agent reads the **full `SKILL.md`**.
4. It reads **only the reference files** the task needs.
5. It executes scripts, or follows the instructions, to do the work.

| Level | Content | Cost | Paid |
|-------|---------|------|------|
| L1 | `name` + `description` | ~100 tokens per skill | Always — every session, every installed skill |
| L2 | `SKILL.md` body | Under ~5,000 tokens recommended | Only after activation |
| L3+ | `references/`, `assets/`, templates, data | Zero until read | Only when needed |
| Scripts | `scripts/` | Source is **not** loaded to execute — only output costs context | On output |

"Zero until read" is not free execution: file contents and script output consume the active
context once they arrive.

## Directory layout

| Path | Status | Role |
|------|--------|------|
| `skill-name/SKILL.md` | **Required** | Metadata is discoverable; body read on activation. Directory name **must** equal frontmatter `name` |
| `skill-name/scripts/` | Optional | Executed when needed; source need not enter context |
| `skill-name/references/` | Optional | Read on demand. Relative paths, one level deep |
| `skill-name/assets/` | Optional | Templates, images, data |
| Other directories | Allowed | Host-dependent; do not assume portability |

Nothing bundled is auto-discovered. **An unreferenced `scripts/` or `examples/` directory is dead
weight** — link every bundled file from `SKILL.md`.

## Frontmatter

| Field | Required | Type | Limit / grammar |
|-------|----------|------|-----------------|
| `name` | **Yes** | String | 1–64 chars; lowercase alphanumeric + hyphens; no leading, trailing, or consecutive hyphens; equals parent directory |
| `description` | **Yes** | String | 1–1024 chars, non-empty. What it does **and** when to use it |
| `license` | No | String | Short name or pointer |
| `compatibility` | No | String | 1–500 chars. Environment and dependency requirements |
| `metadata` | No | String→string map | No fixed keys; semantics are **not** portable |
| `allowed-tools` | No, experimental | Space-separated string | Host support varies |

A client may ignore an optional field even in a formally valid document. Verify host support
before depending on one.

## What is deliberately not specified

Worth knowing, because a lot of confident writing pretends otherwise:

- **No specified matching algorithm, threshold score, trigger telemetry, false-negative recovery,
  or portable way to force activation.** "It didn't trigger" is an observed outcome, not proof the
  description violated a formal matcher.
- No universal package registry, marketplace protocol, version field, signature, or update
  semantics.
- No hard maximum on installed skills or total metadata budget.
- No standard way for a skill to request credentials, network access, or human approval.
- **No specification of an agent/subagent/persona file format at all.** Every harness's agent file
  is host-specific.

## Cross-harness portability

| Harness | Unit and location | Routing fields | Trigger |
|---------|-------------------|----------------|---------|
| **Agent Skills spec** | `skill-name/SKILL.md` + optional `scripts`/`references`/`assets` | `name`, `description` required | Host's choice |
| **Claude Code skill** | `~/.claude/skills`, `.claude/skills`, plugin skills | SKILL.md metadata | Auto-match, plus explicit `/name` |
| **Claude Code subagent** | Managed → session → project → user → plugin agent dirs; closest wins | `name`, `description` required; `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `isolation` optional | Description-routed delegation or explicit |
| **Codex skill** | Skill directory with SKILL.md; plugin-packageable | Minimal `name`/`description` | Explicit request or applicability |
| **Codex `AGENTS.md`** | Global + repo + nested; closer overrides | No frontmatter schema | Ambient by scope — **not a skill** |
| **Codex custom agent** | `~/.codex/agents`, `.codex/agents` | `name`, `description`, `developer_instructions` | Applicability + explicit spawn |
| **OpenCode skill** | `.opencode/skills`, config dir, and compatible `.claude`/`.agents` paths | Recognises `name`, `description`, `license`, `compatibility`, `metadata` | Native skill tool exposes metadata; body read on demand |
| **OpenCode agent** | `opencode.json` or Markdown agent files | `description` required; `mode`, `model`, `prompt`, `permission`, `steps` | Description delegation or `@` mention |
| **Cursor rule** | `.cursor/rules/*.mdc` | `description`, `globs`, `alwaysApply` | Always / glob-attached / agent-requested / manual |
| **MCP prompt** | Server prompt definition | `name`, `description`, typed arguments | **User-selected**, never model-matched |

**Portable:** the SKILL.md shape, description-as-router, progressive disclosure as a cost strategy,
and every principle in the parent skill.

**Implementation detail — never hardcode into a portable skill:** trigger mechanics, token budgets,
agent and persona file formats, packaging, distribution, and permission models.

> [!WARNING]
> OpenCode **silently ignores frontmatter keys it does not recognise.** A skill authored against
> one harness's extended fields degrades quietly rather than loudly. Keep portable skills to the
> fields in the table above.

## Subagent operational limits (Claude Code)

Discovery precedence: managed settings → session `--agents` → project → user → plugin, with nested
project directories walked and the closest definition winning.

- `skills:` injects the **full contents** of the named skills at startup, not just descriptions.
  This is a real context cost, paid on every spawn.
- Defaults: 200 subagents per session, 20 concurrent.
- A subagent **cannot spawn another subagent** unless nesting depth is explicitly configured.

## Known documentation inconsistencies

Do not build tooling that depends on either reading; treat the current specification as canonical:

- Metadata budget appears as "approximately 100 tokens" in current platform documentation and as
  "approximately 100 words" in the shipped skill-creator source.
- Body budget appears as "~5,000 tokens" in the current specification and as "5,000 words" in an
  older first-party PDF guide, which also suggests evaluating 20–50 skills while current docs
  discuss 100+.
