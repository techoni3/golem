---
name: consulting
description: Read when asking or answering a peer consult — async fresh eyes, advisory only, not delegation or ticket work.
---
<!-- GENERATED: skills/consulting/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# consulting

SoT for **consults** between live sessions. Not delegation, not a subagent, not tracker work for the asker's lane.

## Ask (`consult_request`)

Use when stuck after a real attempt, when you suspect tunnel vision, or when the user says to consult a named session.

1. Load this skill; call `consult_request` with `to`, `question`, optional `context`.
2. Fire-and-forget — keep working; do not poll. Reply arrives as `consult_reply`.
3. Treat the reply as advice: keep what holds up, discard the rest; you keep final say.
4. Optional nudge: `consult_status`.

Do **not** use consults as cheap task handoff — that is dispatch or an in-process agent.

## Answer (`consult_reply`)

Trigger: channel event `kind=consult` with `consult_id` and `from_session`.

1. `ack` immediately.
2. Investigate independently (code, docs, web) — do not only restate their framing.
3. Look for root causes and blind spots.
4. `consult_reply` with self-contained advice: root cause(s), blind spots, recommended approach, unverified gaps.
5. Return to your own work.

## Never (consultant)

- Edit their repo, open PRs, or "just fix it."
- Create tracker tickets or enter managing/planning/building SOPs for their work.
- Run long execution; keep the consult proportionate.

## Related tools

`consult_request`, `consult_reply`, `consult_status` on the golem channel MCP.
