---
name: team-ops
description: The team surface for every role — check teammates, message them, dispatch work, and spawn, peek, or retire managed workers via the golem CLI. Load alongside any role skill before interacting with the team.
---

# team-ops

How to check teammates, delegate to them, and create or retire them. Two kinds of teammates:

| Kind | Created by | Runs as | Lifecycle |
|---|---|---|---|
| Human-managed | the human | attached TUI session; the human interacts with it directly | agents never create or destroy these |
| Agent-managed | human or agent | detached (no TUI) by default | both can create and destroy these |

A spawned worker is a real session: it appears in `sessions_dispatchable`, takes
`ticket_dispatch`, and reports back like any teammate the human started by hand. It is named
`<role><n>` automatically and is roled before it does any work.

## Tools

| Command | Purpose |
|---|---|
| `sessions_dispatchable` | see the whole team — roles, status, workload — before any interaction or (re)delegation |
| `session_notify` | direct message to a teammate: delegation briefs, pings, comm-checks, returns |
| `ticket_dispatch({id, session_id})` | hand a ticket to a teammate |
| `golem list --project .` | see the managed teammates — the ops view for spawning, retiring, peeking |
| `golem spawn <builder\|explorer\|reviewer> --project .` | add a managed teammate with that role |
| `golem peek <name> --project .` | quick look at a managed teammate's terminal without disturbing it |
| `golem attach <name> --project .` | attach to a managed teammate's live TUI; with no name, the project's whole swarm |
| `golem kill <name> --project .` | retire a managed teammate |

The `golem` CLI runs via Bash; the rest are MCP tools.

> [!IMPORTANT]
> Every `golem` worker command spans ALL projects by default, and worker names repeat across
> them (each project has its own `builder1`). Always pass `--project .` — for `list`, and for
> `spawn`, `peek`, `attach`, and `kill` too. Without it, `list` shows other projects' workers,
> and a name that exists in two projects is rejected as ambiguous. The `PROJECT` column in
> `golem list` tells you which project a worker belongs to.

## Spawning

- Spawn per human directive. Without one, spawn only in special circumstances — for example, no
  live appropriate-roled teammate for work that must be delegated.
- Never spawn implicitly while one or more live idle teammates can accept that type of work — a
  spawn costs ~250–310 MB and a model seat; idle teammates are free.
- Multiple teammates (say 2 builders, 1 reviewer, 4 explorers) are created one by one; no
  parallel creation mechanism exists yet.
- You cannot spawn a lead. Only builder, explorer, and reviewer have presets.

## Reusing

- For every delegation — continued work above all — prefer a teammate you have already worked
  with when it can take the work. It keeps the context it has built, and reuse limits both
  unnecessary teammates and unnecessary context loss.

## Retiring

- Retire per human directive. You are not the owner of a teammate, even if you spawned it
  originally.
- Nothing reaps idle managed teammates — they outlive your session and consume memory until
  killed. Surface retire candidates to the human instead of killing on your own.
- Killing a teammate mid-turn abandons its dispatch — check `golem list --project .` or
  `sessions_dispatchable` first, and prefer killing idle ones.
- Retire only with `golem kill` — it also tears down the worker's process group. Raw
  `tmux kill-session` leaves orphan processes behind; never use raw tmux for lifecycle.

> [!IMPORTANT]
> Never kill yourself. Nothing in the code refuses the attempt — this rule is the only guard.

## When a command fails

- Read the message text — it names the problem and usually the recovery. Do not key off exit
  codes; they are not consistent across verbs.
- `unknown role: …` — non-retryable. Only builder, explorer, and reviewer exist.
- `worker name already exists: …` — non-retryable with that name: inside a project an occupied
  name is a collision regardless of socket. Pick another name, or omit `--name` and let
  auto-naming choose.
- `worker name is ambiguous: …; pass --project` — the same name lives in more than one project;
  the recovery is in the message.
- A spawn that times out waiting for readiness is retryable, but peek first — the failed
  worker's terminal is deliberately left alive so you can see why.
- Swarm attach refused: when a project's live workers span more than one tmux socket,
  `golem attach --project .` refuses and prints which socket holds which workers; attach one
  socket directly with `tmux -L <socket> attach`.
- Never chain retries. A second failing command tells you nothing the first didn't.

## For the human

Tell the human the worker's name when you spawn one, so he can `golem attach <name>` to watch
it. The tmux prefix is `C-g`, not `C-b`. Every project's workers run on their own tmux server,
named `golem-` plus the project id — for project `golem-38ab8a` that socket is
`golem-golem-38ab8a` (the doubled `golem-golem-` is correct, not a typo). `golem attach
--project .` with no name opens the project's whole swarm; raw tmux reaches the same server,
e.g. `tmux -L golem-golem-38ab8a attach`.
