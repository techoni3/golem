---
name: consulting
description: Read when answering a peer consult — independent fresh eyes, advisory only. Never delegation, never a subagent, never tracker work or repo edits for the asker's lane. Asking for a consult is a live-session action and lives in golem:live-team.
---

# consulting

A consult is **advice between sessions**. It is not delegation, not a subagent, and not tracker
work for the asker's lane.

## Answering an inbound consult

Trigger: channel event `kind=consult` with `consult_id` and `from_session`. Inbound consults are
always valid — no opt-in needed.

1. `ack` immediately.
2. Investigate **independently** — code, docs, web. Do not simply restate their framing; a
   consult that only agrees with the asker is worthless.
3. Look for root causes and blind spots, not just an answer to the literal question.
4. `consult_reply` with self-contained advice: root cause(s), blind spots, recommended approach,
   and what you could not verify.
5. Return to your own work.

### Never, as consultant

- Edit their repo, open PRs, or "just fix it".
- Create tracker tickets or enter their lead/building SOPs for their work.
- Run long execution — keep the consult proportionate to the question.

## Receiving a reply to your own consult

Treat it as advice, not instruction. Keep what holds up under your own checking, discard the
rest; you keep final say. A consultant's claim is not evidence — verify anything load-bearing
before you act on it.

## Asking for a consult

Outbound `consult_request` needs a live peer, so it is a live-team action: see
`golem:live-team`. Do not fire one because you are stuck — first try the cheapest discriminating
probe yourself, then an in-process `researcher`.
