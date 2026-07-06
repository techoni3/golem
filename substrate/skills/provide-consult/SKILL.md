---
name: provide-consult
description: Read when a `<channel kind="consult">` event arrives. You are the fresh pair of eyes: investigate the peer's problem independently (code, web, docs), return root causes + blind spots + a concrete proposal via `consult_reply`. Advisory only — never edit their repo.
---

# provide-consult

A peer session is stuck and asked **you** for a fresh pair of eyes. Your job is to
be exactly that: an independent investigator who looks at their problem without
their assumptions, finds the root cause and the blind spots, and hands back a
clear proposal. You are an **advisor**, not a worker.

## Trigger

An inbound channel event:

```
<channel source="golem" kind="consult" consult_id="cns-…" from_session="<asker-id>" from_name="<asker>">…</channel>
```

The body carries the problem, any context, and the exact `consult_reply` call to
use. Read it fully before doing anything.

## What to do

1. **Acknowledge fast.** Call `ack({ kind: "consult", summary: "<one line: picking up <asker>'s consult on X>" })` so the dashboard shows you've got it.
2. **Understand the problem** as stated — the symptom, what they tried, what they're really asking.
3. **Investigate independently.** This is the whole point — don't just reason from
   their framing. Pull on the threads they may have missed:
   - Read the actual code/state they pointed at (and its neighbours). If it's in a
     repo you can reach, look; if not, reason from the snippets they gave.
   - Web research (`WebSearch` / `WebFetch`) for the library/API/error — current
     docs and known issues, not memory.
   - Spawn your own researcher/subagent if it helps you investigate faster.
   - Actively look for **blind spots**: the wrong layer, a faulty assumption, a
     simpler root cause, an architectural smell driving the symptom.
4. **Form a proposal** — your honest fresh perspective: the likely root cause(s),
   what they may be tunnel-visioned past, and a concrete recommended approach.
   Disagreeing with their framing is *valuable*, not rude — say so plainly, with
   evidence.

## Boundaries (important)

- **Advisory only.** Do **not** edit their repo, open PRs, or "just fix it."
- Do **not** create tracker tickets or enter the `golem:work-loop` for their work.
- Do **not** spin up long-running execution. Investigate enough to give a
  well-grounded opinion, then reply. Keep it proportionate.
- Stay anchored to *their* question — don't redesign their whole system unasked.

## Reply

Deliver your proposal with the **`consult_reply`** MCP tool, using the
`to_session` and `consult_id` from the consult event:

```
consult_reply({
  to_session: "<from_session from the event>",
  consult_id: "<consult_id from the event>",
  text: "<root cause(s) + blind spots + concrete recommended approach>"
})
```

Make `text` self-contained and decision-ready: lead with the suspected root cause,
name the blind spot, give the recommended approach and why, and flag anything you
couldn't verify. It's advice — frame it as such; the asker weighs it and keeps the
final say.

Then **return to whatever you were doing.** A consult is a side errand, not a
takeover of your session.

## Related

- `golem:get-consult` — the other side: how a session asks for a consult.
