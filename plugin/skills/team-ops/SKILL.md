---
name: team-ops
description: The team surface for every role — check teammates, message them, dispatch work, and spawn, peek, or retire managed workers via the golem CLI. Load alongside any role skill before interacting with the team.
---
<!-- GENERATED: skills/team-ops/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

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
| `golem list --project .` or `golem list --project <project-name>` | see the managed teammates — the ops view for spawning, retiring, peeking |
| `golem spawn <builder\|explorer\|reviewer> --project . [--profile <name>]` | add a managed teammate with that role; `--profile <name>` overrides its default model for this one spawn |
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

> [!IMPORTANT]
> Returns bind to the envelope: reply to the authenticated sender `session_id` of the exact
> dispatch you are answering — never from memory, never by label, never rediscovered via
> `sessions_dispatchable`. A reused teammate serves several leads; only the envelope says which
> one asked.

## Spawning

- Spawn per human directive. Without one, spawn only in special circumstances — for example, no
  live appropriate-roled teammate for work that must be delegated.
- Reuse first — never spawn while one or more live idle teammates can accept that type of work.
  A spawn costs ~250–310 MB and a model seat; idle teammates are free.
- Choose counts deliberately — spawn for parallelism you will actually use. Three explorers on
  three disjoint research threads is right; three explorers waiting is waste.
- Builders are neither very cheap nor very expensive: 1 for a single connected workstream, 2 for
  two independent ones, more only for genuinely disjoint workstreams. The count is speculation
  until grounding lands — revising it later is normal. More than 1: justify and confirm with the
  human.
- Explorers are relatively cheap: large exploration and research parallelise well across
  several. More than 3 in parallel: justify and confirm with the human.
- Multiple teammates (say 2 builders, 1 reviewer, 4 explorers) are created one by one; no
  parallel creation mechanism exists yet.
- A lead can be spawned when it has a Pi execution preset (default model profile or exec) configured — same as any other role.

## Model profiles

Every role carries a default **model profile** — the provider/model/thinking a spawn uses when
you give no override. `golem spawn <role> --project .` launches on that default.

- Override one spawn with `--profile <name>`: `golem spawn reviewer --profile <name> --project .`
  launches that single worker on the named profile instead of the role default. The role's
  default is untouched — the next plain spawn uses it again.
- Same override for a foreground session: `golem pi --role <role> --profile <name>`. On `golem
  pi` a raw `--provider`/`--model` still wins over `--profile` — the escape hatch for a one-off
  model you have not made a profile for.
- Profiles are created and named in the dashboard **Model Profiles** section (above Roles); a
  role's default profile is set from the same page. `golem list --project .` shows the model each
  worker actually resolved to, so an override is visible there.

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
- `unknown role: …` — non-retryable. The role does not exist in the registry.
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
