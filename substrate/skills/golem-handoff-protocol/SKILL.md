---
name: golem-handoff-protocol
description: How orchestration actually works in golem — the main thread is the orchestrator (loaded via /golem); sub-agents are pure leaves; iterative loops run as agent teams. Defines the Agent tool, SendMessage, team_name, the closing reflex, and the rules every persona obeys. Read this every turn before doing anything else.
category: substrate
---

# golem-handoff-protocol

The mechanics every persona uses, plus the architectural facts that constrain them. This is the source of truth. Read it on every entry into any persona. Persona files describe *what* each role does; this skill is *how* the work is actually dispatched.

## The architecture (load-bearing)

**The main thread is the orchestrator.** When the user invokes `/golem`, the merged orchestrator persona is injected into the main thread. The main thread, with full `Agent` tool access, then drives everything.

There is no separate CEO sub-agent. There is no separate TL sub-agent. Both roles live in the main thread under `/golem`. This is the architectural fix for Claude Code's sub-agent recursion constraint.

**Sub-agents (`~/.claude/agents/golem-*.md`) are pure leaves.** They:
- Cannot spawn other sub-agents (the `Agent` tool is stripped from spawned sub-agents per Claude Code's nesting policy — GH issue #4182).
- Cannot use `SendMessage` unless they were spawned as part of an agent team.
- Produce artefacts (specs, code, verdicts, sweep notes) on disk and return.

**Iterative loops are agent teams.** When two or more personas need to exchange messages while retaining their own context (Architect↔Reviewer, the TDD/dev-team trio), the main thread spawns them as a **team** with a shared `team_name`. Inside a team, teammates use `SendMessage` to iterate without main-thread mediation. Teams have a "no nested teams" rule — teammates cannot spawn additional teammates or sub-agents.

In short:
- **One-shot leaf work** → `Agent(subagent_type: "...", ...)` (no `team_name`).
- **Iterative loop** → `Agent(subagent_type: "...", name: ..., team_name: ..., ...)` for each member; teammates `SendMessage` each other.
- **High-level orchestration** → main thread (under `/golem`).

## Sub-agent isolation (the central fact)

A spawned sub-agent or teammate sees **only**:
- Its persona file (system prompt).
- The `prompt` string passed to the Agent tool.
- Tools listed in its persona's `tools:` frontmatter (with `Agent` stripped if it was declared).

It does **not** see:
- The main thread's conversation history.
- Any context the main thread loaded.
- Other sub-agents' context.
- Anything on disk it doesn't read itself.

Every implication below follows from this fact.

## The closing-reflex contract

Every persona's **final** tool call before yielding control MUST be:

```
Skill(skill: "golem-summarise-session", args: <one-line session summary>)
```

This applies to:
- The main thread under `/golem` — closes with the reflex when the autonomy loop terminates.
- Every sub-agent — closes before returning to the main thread.
- Every teammate in an agent team — closes before yielding back to the main thread.

Without the reflex, the semantic journal misses the session, and the SessionEnd hook backfills a degraded `missing-reflex` marker.

If the work returned no useful artefact (error, escalation), still close with the reflex — record the outcome as `blocked` or `abandoned` and yield.

## The no-user-fallback rule

**The user is not a downstream persona.**

For the **main thread under `/golem`**: a turn that ends with "what would you like to do next?" instead of either (a) spawning the next sub-agent / team, (b) walking the next tracker step, or (c) writing an explicit escalation memo and yielding — is a **failed turn**. The user opted into autonomy by invoking `/golem`.

For **sub-agents and teammates**: a turn that ends with "next steps for the orchestrator" instead of producing the artefact and yielding cleanly is a failed turn. The orchestrator reads the artefact — you don't address it directly.

Legitimate turn endings:
1. **Leaf sub-agent**: artefact written + closing reflex + yield.
2. **Teammate**: SendMessage to next teammate (or, on convergence, hand-off log entry + closing reflex + yield).
3. **Main thread (`/golem`)**: next sub-agent / team spawned, or autonomy loop terminated (all work done or blocked) + closing reflex + yield.

## Sequential one-shot hand-off (Option 1)

Used when the main thread spawns a leaf persona that produces and returns. Example: Substrator at bring-up; Diagnoser per fix; Documentarian post-merge; Scout/Prospector/Smelter in ideation; UX Designer; Local DevOps; Cloud DevOps.

```
Agent(
  subagent_type: "golem-<receiver>",
  description: "<3-5 word task>",
  prompt: <FULL hand-off content verbatim, with absolute paths to project / workspace / ticket / specs>
)
```

**Rules:**
- The `prompt` carries *everything* the receiver needs. Do not assume the receiver will "see" anything else.
- Always pass absolute paths.
- Do not summarise to make it shorter; pass full hand-off content. A leaf persona that re-derives the brief from a partial summary will drift.
- After return, write a hand-off log entry on the relevant ticket capturing what was sent and what came back.

## Iterative team hand-off (Option 2)

Used when two or more personas need to retain context across messages. Example: Product Architect ↔ Product Architecture Reviewer; Tech Architect ↔ Tech Architecture Reviewer; the TDD/dev-team trio (Test Spec Writer → Test Writer → Engineer → Code Reviewer).

**Step 1 — main thread provisions the team, then attaches members.** A team is a real registry entry: it has a config file and a shared task-list directory. Passing `team_name: "x"` on an Agent call does **NOT** auto-create the team — `SendMessage` between members will silently fail to route until the team exists. The required sequence is `TeamCreate` first, then one `Agent` call per member with the same `team_name` and a unique `name`:

```
TeamCreate(
  team_name: "specs-tkt-0042",
  description: "PA ↔ PAR loop — product specs for TKT-0042"
)

Agent(
  subagent_type: "golem-product-architect",
  name: "pa",
  team_name: "specs-tkt-0042",
  description: "Author specs for TKT-0042",
  prompt: <initial brief: ticket pointer, product specs path, hand-off context>
)

Agent(
  subagent_type: "golem-product-architecture-reviewer",
  name: "par",
  team_name: "specs-tkt-0042",
  description: "Review specs for TKT-0042",
  prompt: <initial brief: same shape, plus pointer to the Architect's draft path>
)
```

After the team converges, follow the **closing-sequence checklist** (see §"Team supervision" below) — `SendMessage` shutdown_request to every teammate, wait for `isActive: false`, THEN call `TeamDelete()`. `TeamDelete` alone does NOT kill tmux-backed teammate processes; orphans accumulate otherwise.

**Productive turn 1 is mandatory.** Every teammate's spawn prompt MUST describe concrete work the teammate can produce on turn 1 — a write, a read+SendMessage, anything observable. **Never** instruct a teammate to "wait for the first SendMessage" as its turn-1 action. Claude Code may pick a synchronous backend for the spawn, in which case `end_turn` after a no-work turn terminates the teammate and the loop silently dies (the field-observed PA↔PAR v1 failure mode). The canonical pattern is the **PAR pre-bake review**: the Reviewer reads available baseline (existing specs, related docs, the brief itself) and SendMessages the Architect a pre-bake verdict on turn 1, so by the time the Architect finishes v1 there's already feedback waiting in its inbox.

**`team_name` MUST be project-namespaced.** Use `specs-<project_id>`, `arch-<project_id>`, `tdd-<project_id>-tkt-<ticket_id>` patterns. `~/.claude/teams/<name>/` is a machine-global namespace; two CEOs running on different projects with un-namespaced `team_name` collide.

**Leaf one-shots never use `TeamCreate`.** Substrator, UX Designer, Local DevOps, Cloud DevOps, Documentarian, Diagnoser, Scout / Prospector / Smelter — these are single-agent dispatches and must be spawned as plain `Agent(subagent_type: ..., description: ..., prompt: ...)` with **no** `team_name`. Wrapping a one-shot in a team adds bookkeeping for nothing.

**Step 2 — teammates iterate via SendMessage.** Inside the team, either teammate uses:

```
SendMessage(
  to: "<teammate-name>",
  message: <iteration content: pointer to revised draft, asks, or verdict>
)
```

Each addressee retains its context across messages, so the Reviewer can iterate on v3 of a draft without re-reading v1+v2 from scratch.

**Step 3 — convergence.** When the loop produces an artefact (specs Accepted, PR ready, etc.), the team yields back to the main thread. The main thread records the outcome and routes the next step.

**Cap iterative loops at ~3 rounds.** If not converging, escalate to the main thread — the disagreement is structural and a higher-level decision is needed.

**Teammates cannot spawn anything.** No `Agent` tool, no nested teams. They can only `SendMessage` other named teammates in the same team and use the leaf-level tools they were given (Read/Write/Edit/Bash, plus stack-specific ones).

## Team supervision (the orchestrator is the team lead)

A team that's spawned-and-forgotten is flying blind. Claude Code's `Agent(team_name=…)` silently picks between two backends:

- **Synchronous subagent** — `Agent()` blocks until the agent yields. `end_turn` = termination. A teammate told to "wait" on turn 1 will be terminated before it ever receives a SendMessage.
- **Tmux-backed teammate** — `Agent()` returns immediately ("Spawned successfully ... will receive instructions via mailbox"). The teammate is alive in a tmux pane; `end_turn` is true idle; SendMessage wakes it.

The orchestrator discriminates by inspecting tool-return text immediately after every team-spawn Agent call. On the tmux backend, **start a `Monitor` watching the team** before continuing.

**Canonical Monitor invocation:**

```
Monitor(
  description: "team supervision: <team_name>",
  command: "bash $GOLEM_ROOT/substrate/scripts/team-monitor.sh <team_name>",
  timeout_ms: 3600000,
  persistent: false
)
```

Each stdout line from the script becomes a fresh conversation turn for the orchestrator. The script emits exactly these signals:

| Signal | Orchestrator action |
|---|---|
| `monitor: armed for <team>`              | Log; team is being supervised |
| `inbox <member>+1 <from>: <body>`        | Log; normal hand-off |
| `verdict <member>: approve|request-changes|block` | Read the hand-off log; convergence imminent |
| `isActive <member>: true → false` (no verdict) | Suspected synchronous-backend termination — re-spawn or escalate |
| `stall <member>: mtime stale Ns` (first) | `SendMessage` polite "still working?" nudge |
| `stall <member>: ...` (second)           | Treat as hard stall — `respond` escalation memo |
| `team-config-missing`                    | Premature TeamDelete or corruption — escalate |
| `converged <team>`                       | Run the closing-sequence checklist below |

If **no Monitor events arrive for ≥ 10 min** during a known-live team, suspect Monitor died. `Read` the team config + a transcript to verify; restart Monitor if needed.

**Closing-sequence checklist (F5 prevention, mandatory).** After every iterative-team convergence, BEFORE `TeamDelete()`:

1. `SendMessage({to: <each-teammate>, message: {type: "shutdown_request"}})`.
2. Wait for `shutdown_response` (or Monitor confirming all `isActive: false`).
3. `Read ~/.claude/teams/<team_name>/config.json`; verify every member has `isActive: false`.
4. `TeamDelete()`.
5. `Bash(command: "ps -ef | grep agent-id-…")` — expected empty. If a teammate's tmux process is still alive, `Bash(command: "tmux -L claude-swarm-<pid> kill-session")`.

`TeamDelete` alone removes team config + inboxes but does NOT kill teammate processes — orphan tmux panes consume CPU/memory indefinitely if you skip the shutdown_request step.

**Tool-return-text pattern matching is fragile.** Discriminating tmux vs synchronous backend by string prefix is what the docs allow today; expect to revisit if Claude Code changes the surface.

## Prompt shape — what to put in the `prompt`

A receiver's `prompt` should contain:

1. **Verbatim hand-off content.** No summarisation.
2. **Absolute paths** to: project root, ticket file, relevant specs / ADRs / agent-notes, journal directory.
3. **Brief restatement** in one sentence — gives the receiver a one-line anchor.
4. **What you expect back.** "Return when specs are written and Reviewer-approved" or "Return with a verdict in the ticket's hand-off log."
5. **Failure-mode instruction.** "If you cannot proceed, write an escalation memo to <path> and yield with a `blocked` summary."

For teammates, also include:
6. **Who else is in the team.** Names of other teammates (e.g. "Reviewer is named `par`").
7. **First action.** "Wait for SendMessage from `tsw` before writing tests" or "Send v1 to `par` once drafted."

## Skill invocation (the Skill tool)

When a persona's playbook says "invoke skill `golem-X`" — that means a real call:

```
Skill(skill: "golem-X", args: <whatever the skill's frontmatter expects>)
```

Auto-matching from system reminders is unreliable for niche substrate skills. Always invoke explicitly when the playbook calls for it.

## Disk is the orchestrator's memory

Each main-thread `/golem` invocation is a fresh agent. There is no persistent in-process memory. Continuity comes from:

- `CLAUDE.md` — entry-point context.
- `CONTEXT.md`, `docs/ARCH.md` — domain and architecture.
- `tracker/` — work state.
- `journal/summary.jsonl` — recent session outcomes.
- `docs/agent-notes/` — pending observations not yet swept.
- ADRs — accepted technical decisions.

On entry, `/golem` re-loads this state. The same applies to sub-agents — they read whatever they need from disk; nothing carries over from prior invocations of the same persona.

## Failure-mode handling

When a tool call fails (Agent returns an error, SendMessage target unreachable, etc.):

1. Do **not** silently swallow.
2. Write a hand-off log entry on the relevant ticket capturing the failure.
3. Either retry once with corrected inputs, or escalate.
4. Close with the reflex; record outcome as `blocked` with a note pointing at the failure.

For teammates: a teammate that hits an unrecoverable error should `SendMessage` the orchestrator-facing "yield" message (typically the loop's designated returner — the Reviewer in PA↔PAR, the Code Reviewer in dev team) explaining the issue, then close with the reflex. The team yields back; main thread reads the failure note.

## Quick reference table

| Persona shape | How invoked | Tools available |
|---|---|---|
| Top-level orchestrator (CEO+TL merged) | `/golem` slash command (main thread) | All tools — Agent, Skill, Read/Write/Edit/Bash, Bash, etc. |
| Leaf one-shot (Substrator, Scout, Prospector, Smelter, UX, Local/Cloud DevOps, Diagnoser, Documentarian, Meta-agent) | `Agent(subagent_type: ...)` from main thread | Read, Write, Edit, Bash (+ WebFetch/WebSearch for ideation/meta) |
| Team teammate (Architects, Reviewers, Engineer, Test Spec/Writer, Code Reviewer) | `Agent(subagent_type: ..., name: ..., team_name: ...)` from main thread | Read, Write, Edit, Bash, SendMessage |

## Anti-patterns

- **Narrating routing back to the user from `/golem`.** "I would now hand this off to the TL" without any Agent call. The orchestrator runs the full chain.
- **A sub-agent attempting to spawn another sub-agent.** Tool is stripped; the call will error. Sub-agents are leaves.
- **Summarising the hand-off content into a shorter prompt.** The receiver loses fidelity.
- **Spawning a teammate without a `team_name`.** They cannot reach each other via SendMessage.
- **Spawning teammates with a shared `team_name` but skipping `TeamCreate` first.** The team registry is empty, SendMessage routes nowhere, and the loop stalls with both teammates going idle after spawn. `TeamCreate` MUST precede the Agent calls for iterative-loop spawns.
- **Wrapping a leaf one-shot in `TeamCreate`.** A single-agent dispatch (Substrator, UX Designer, Documentarian, Diagnoser, etc.) is a plain `Agent(...)` call with no `team_name` and no preceding `TeamCreate`.
- **Instructing a teammate to "wait for the first SendMessage" as its turn-1 action.** On the synchronous backend this terminates the teammate before any message arrives; on the tmux backend it's wasted cycles. Every spawn prompt must produce real turn-1 work (the PAR pre-bake-review pattern).
- **Calling `TeamDelete` without first sending `shutdown_request`.** Tmux-backed teammates do not exit on `TeamDelete` — orphan processes accumulate. The closing-sequence checklist is mandatory.
- **Un-namespaced `team_name`.** `~/.claude/teams/<name>/` is machine-global. Two CEOs running un-namespaced teams collide.
- **Spawning an iterative team without subsequently starting a `Monitor`.** Flying blind on supervision; F2/F3/F4 failures go undetected.
- **Skipping the closing reflex** because "this turn was short".
- **Assuming the spawned agent will "look at" the orchestrator's recent decisions.** It can't — give it pointers to disk.
- **Mixing Option 1 and Option 2 for the same role.** Iterative-loop personas always team-spawn. Leaf personas never.
- **Yielding mid-autonomy-loop because "the next step seems risky".** Either it's actionable → run it; or it's blocked → write an escalation memo and yield. No third option.
