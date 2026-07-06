# Global Rules

## No Guessing — Research First (CRITICAL)

**NEVER guess at how a library, API, framework, or configuration works.** If you don't know something, follow this order:

1. **Read the source** — check type definitions, source code in `node_modules/`, or local files
2. **Web search** — look up documentation, GitHub issues, or Stack Overflow for the specific question
3. **Ask the user** — if steps 1-2 don't give a clear answer, ask instead of experimenting

**Never chain speculative fixes.** Each change must be informed by evidence (docs, types, tested behavior), not by trial and error. If a fix doesn't work, stop, research why, then make the next change with understanding — not another guess.

This rule applies to **all agents** (background, team members, subagents). No exceptions.

## Working Model: Size, Then Act (CRITICAL)

Size every request before acting:

- **Question** → answer it. No skills, no plan.
- **Tiny fix** (single obvious change) → do it, then verify with evidence.
- **Feature** (multi-step, new behavior) → read `golem:work-loop` and follow it.
- **Big build** (multi-feature, or the user wants pauses) → `golem:work-loop` + `golem:gates`.

Skills — read the named skill when:

- `golem:work-loop` — starting feature-sized+ work (intake, tracker tickets, dispatch).
- `golem:tracker` — register and track work as tickets; the cross-project tracker (dashboard + `ticket_*` MCP tools) is the source of truth, replacing PLAN.md.
- `golem:verify-done` — before marking anything done or trusting a "done"/"PR open" claim.
- `golem:test-policy` — writing or scoping tests for a feature.
- `golem:pr-conventions` — branching, committing, or opening a PR.
- `golem:gates` — the user asked for a pause point, or work is blocked on a secret.
- `golem:journaling` — appending a milestone, or locating a project's journal.
- `golem:docs-maintenance` — REPO-MAP.md upkeep and architecture-doc hygiene: bootstrap a repo map, update after structural changes, or audit docs against reality.
- `golem:browser-testing` — before ANY browser/CDP/UI-testing work, or when a task needs an authenticated site (shared persistent Chrome profile + headless rules).
- `golem:get-consult` — genuinely stuck (a bug, a blind spot, tunnel vision) and want a fresh pair of eyes from another live session; or the user says "get consult from <session>".
- `golem:provide-consult` — a `consult` channel event arrived: be the fresh pair of eyes — investigate independently and reply with advice (no editing their repo).

## Orchestration:

- Delegate with FOREGROUND, single-shot `Agent`/`Task` calls — they run in-process, return one result, and self-clean. This is the default for any delegation. Spawned agents/subagents default to `model: sonnet` (pass it explicitly — a backgrounded agent otherwise inherits the parent's model).
- Never use teammates, agent teams, or dynamic workflows. On the current Claude Code build, spawning a `name`d agent with `run_in_background: true` and driving it via `SendMessage` IS a team member: a separate `claude` process in a `tmux -L claude-swarm-*` session with `~/.claude/teams/<id>/`, which never self-terminates and leaks until an explicit `shutdown_request`. Avoid that pattern.
- If a background agent is genuinely needed for large, independent, parallel work the main thread can't block on, you OWN its lifecycle: `shutdown_request` it the instant its work is verified done, then confirm the process and its tmux session are gone. Never leave one idle.
- Trust only mechanical evidence (command output you ran) for done-claims — never an agent's report.
- Do not create git worktree `git worktree add` or enter a git worktree `EnterWorktree` on your own initiative. Work directly in the user's current checkout and branch. Create/enter a worktree **only** when the user explicitly asks for it.
- 

## Documentation Hygiene

When a task changes architecture (new models, service patterns, workflows, node interfaces, DB schema), update the corresponding `docs/claude/` file in the same session. Don't defer — stale docs are worse than no docs.

## Response and output style

- Keep your responses compact, concise and short on prose.
- Get to the point instead of writing essays or beating around the bush.
- Do not write a sentence to every tool call.
- Do not sprinkle mini-summaries throughout a lot series of tool calls. Write consolidated respones, per task or checkpoint. Do the investigation and edits across sequential tool calls without prose between them. In the turn end, write useful and summarising briefs.
- Separate the final summary/brief to the user from the sprinkled tool calls and their mini-summaries by a horizontal line of dashes (`-`x100), so its easier for user to focus on what they should read and what to ignore as intermediate steps.
- This only dictates response/output in chat, these rules do not apply while writing docs, code and within tool-calls.
