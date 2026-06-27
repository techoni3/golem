# Golem Root — substrate workspace

This directory is `$GOLEM_ROOT` — the cwd that `golem session` anchors to and the home of the substrate itself. It is both:

- The **substrate repo** (own git history) — `substrate/`, `dashboard/`, `project_management/`, `bin/`, `scripts/`.
- A **journalled CEO workspace** — `journal/` collects every tool call the CEO and its sub-agents make from this directory.

## Why this file exists

The substrate's hook scripts (`.Codex/hooks/journal-event.sh`) walk up from `$PWD` looking for a `AGENTS.md` or `.git` directory to mark the project root. This file is that marker for the root workspace.

## What gets journaled here

Every tool call (`Read / Write / Edit / Bash / Skill / Agent / SendMessage`) the CEO session makes while its `$PWD` is inside this directory and not inside any project subtree lands in `journal/hook.jsonl`. When the CEO `cd`s into a specific project under `golem-projects/`, journalling routes to that project's own `journal/hook.jsonl` instead. Sub-agents inherit this routing automatically (the `$PWD`-walk picks the nearest `AGENTS.md` above them).

## Pointers

| What | Where |
|------|-------|
| CEO persona | `substrate/personas/golem-ceo.md` |
| Substrate harness | `substrate/` |
| Projects | `golem-projects/<name>/` |
| Dashboard | `dashboard/` (run `golem dashboard`) |
| Channel server | `substrate/channels/golem/` (auto-spawned by CEO session) |
| `golem` CLI | `substrate/bin/golem` (symlinked to `~/.local/bin/golem` by `golem install`) |

## Hooks wired

`.Codex/settings.json` wires only the journaling hooks here — no lint / git-guardrails, since the CEO's job at this level is orchestration, not source-code editing. Per-project `.Codex/settings.json` files inside `golem-projects/<name>/` carry their own stack-aware lint and guardrail wiring.

## Ideation

There is **no separate `golem-ideas/` workspace**. Ideation runs inside a regular project namespace under `golem-projects/<name>/` after the substrator has laid down the harness, so Scout / Prospector / Smelter all get the same journalling, agent-notes, and tracker infrastructure as any other agent.
