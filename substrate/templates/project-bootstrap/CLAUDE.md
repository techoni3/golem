# {{PROJECT_NAME}}

Loaded by every Claude Code session in this project. Stays the index, not the encyclopaedia: facts here exist nowhere else in the project. Target ~50–100 lines.

## What this project is

<!-- 2-3 sentences. The product / system the agents are building. Replace this. -->
{{PROJECT_NAME}} — bootstrapped {{DATE}}. Edit this section once Tech Architect picks the stack and Product Architect lands the first specs.

## Active stack

- primary: {{STACK_PRIMARY}}
- key tech: <!-- e.g. FastAPI, SQLAlchemy, Alembic, Pytest -->

## Active skills

<!-- Skills the personas reference habitually in this project. Add as
     bring-up / first stories settle the stack. All skill names use the
     `golem-` prefix. -->

- golem-handoff-protocol
- golem-pr-creation
- golem-using-git-worktrees
- golem-verification-before-completion
- golem-tdd
- golem-diagnose
- golem-summarise-session

## Universal rules for every persona

These bind every persona running in this project. Persona files repeat them, but they live here too so they're loaded even when context is sparse.

1. **Read `golem-handoff-protocol` on entry.** Call `Skill(skill: "golem-handoff-protocol")` before doing anything else. It defines the architecture (main-thread orchestrator + leaf sub-agents + iterative agent teams), Agent / SendMessage / team_name mechanics, closing reflex, and no-user-fallback rule.
2. **Closing reflex is mandatory.** The final tool call of every turn MUST be `Skill(skill: "golem-summarise-session", ...)`. Without it the journal misses the session and the SessionEnd hook backfills a degraded marker.
3. **The user is not a downstream persona.** Under `/golem`, a turn ending with "what would you like next?" instead of running the next step is a **failed turn**. The user opted into autonomy by invoking the command. Sub-agents and teammates address the orchestrator (via artefacts on disk + return / SendMessage), never the user.
4. **The disk is your memory.** Every invocation is a fresh agent. Continuity comes from CLAUDE.md, CONTEXT.md, ARCH.md, the tracker, the journal, and agent-notes — not in-process memory.
5. **Only the orchestrator (`/golem` in main thread) transitions tracker state.** Other personas append to hand-off logs (always allowed) but do not move tickets between states.
6. **Sub-agents cannot spawn other sub-agents.** Claude Code strips the `Agent` tool from spawned sub-agents (GH issue #4182). All spawning happens from the main thread under `/golem`. Teammates in an agent team can `SendMessage` each other but cannot add new teammates or spawn sub-agents.

## Pointers

| What | Where |
|------|-------|
| Architecture | docs/ARCH.md |
| Domain language | CONTEXT.md |
| Repo map | docs/repo-map.md |
| Conventions | docs/conventions/ |
| ADRs | docs/adr/ |
| Agent-notes | docs/agent-notes/ |
| Tracker | tracker/ |
| Journal (local-only) | journal/ |

## Run commands

<!-- Filled by Local DevOps at bring-up. Single canonical command per task. -->

- install: <!-- e.g. uv sync -->
- dev: <!-- e.g. uvicorn app.main:app --reload -->
- test: <!-- e.g. pytest -q -->
- lint: <!-- e.g. ruff check . -->
- build: <!-- e.g. uv build -->

## Project-specific operating notes

<!-- Short bullets for anything non-obvious that doesn't fit elsewhere.
     Cap ~10. Drop into ARCH or conventions if a bullet starts to need
     paragraphs. -->

- <!-- e.g. background jobs run in worker.py, not in the request path -->

## Hooks wired

`.claude/settings.json` wires:

- **SessionStart / UserPromptSubmit / SessionEnd** → `journal-event.sh` (mechanical journal at `journal/hook.jsonl`).
- **SessionEnd** → `journal-summarise.sh` (degraded marker if `golem-summarise-session` reflex didn't fire).
- **PreToolUse(Bash)** → `git-guardrails.sh` (blocks force-push, hard-reset, clean -fd, branch -D, commit --no-verify).
- **PostToolUse(Edit|Write)** → `lint-format.sh` (defers to `.claude/lint-format-runner.sh`; Local DevOps fills that in).
